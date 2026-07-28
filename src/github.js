// The data layer: everything that talks to GitHub.
//
// The whole efficiency story lives in this file, and it rests on two facts:
//
//   1. Files in `locations/` are IMMUTABLE — the tracker only ever adds new ones
//      — so a filename we've already seen never needs refetching.
//   2. A ping's capture time is in its FILENAME, so a directory listing alone
//      tells us when every run last moved. No file bodies required.
//
// (2) is why one recursive tree request answers everything the UI needs: which
// runs exist, which are live, which is newest, and what's in the one on screen.

import { CONFIG, keysFor, LS_TREE, LS_TREE_ETAG } from './config.js';
import { parseTime, pool, storage } from './util.js';

/** Thrown when GitHub says we've spent our hourly budget. Carries when to retry. */
export class RateLimitError extends Error {
  constructor(retryAt) {
    super('GitHub rate limit reached');
    this.name = 'RateLimitError';
    this.retryAt = retryAt;
  }
}

/**
 * The one API request this app makes: every path under `locations/`, in every
 * run, conditionally.
 *
 * Returns `null` when GitHub answers 304 Not Modified — nothing has changed and
 * no body was transferred. That is the common case between pings.
 *
 * It does NOT keep the request COUNT near zero. GitHub's docs claim a 304 is
 * free; measured, it decrements x-ratelimit-remaining just like a 200 does. So
 * the budget is 60 polls/hour per IP — see the README's rate limit section.
 *
 * The `branch:dir` ref scopes the tree to `locations/`, which both shrinks the
 * response and stops commits to the code busting the ETag.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE FUNCTION TO REPLACE when the repo outgrows the API.         │
 * │ A tree response is capped at 100k entries / 7MB, after which GitHub sets│
 * │ `truncated` and silently drops the rest. The migration is a GitHub      │
 * │ Action that appends each ping into a compact `<run>/index.json`; this   │
 * │ becomes a fetch of those files and everything downstream stays put.     │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * @returns {{entries: Array, truncated: boolean, etag: string|null}|null}
 */
export async function fetchTree(etag) {
  const { owner, repo, branch, dir } = CONFIG;
  const url =
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}:${dir}?recursive=1`;

  const headers = { Accept: 'application/vnd.github+json' };
  if (etag) headers['If-None-Match'] = etag;

  const res = await fetch(url, { headers, cache: 'no-store' });

  if (res.status === 304) return null;

  // No `locations/` yet — an empty directory doesn't exist as far as git is
  // concerned. That's not an error, it's a repo with no pings.
  if (res.status === 404) return { entries: [], truncated: false, etag: null };

  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    throw new RateLimitError(reset || Date.now() + 15 * 60000);
  }
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);

  const body = await res.json();
  return {
    entries: body.tree || [],
    truncated: Boolean(body.truncated),
    etag: res.headers.get('etag')
  };
}

/**
 * Folds a flat tree listing into the shape the rest of the app reads:
 *
 *   { 'vendee-10k': { files: { '<name>.json': '<sha>', … },
 *                     latest: <ms>,
 *                     course: { name: 'course.gpx', sha } | null } }
 *
 * Pure, and the only place the layout of the repo is interpreted.
 *
 * A path with no slash is a file sitting loose in `locations/`, belonging to no
 * run. Runs are the whole model now, so those are dropped rather than shown.
 *
 * A `.gpx` inside a run is that run's course. It is deliberately kept out of
 * `files` and out of `latest`: a course is not a ping, and dropping one into a
 * folder must not make a finished race look live. If a run somehow has several,
 * the alphabetically first wins — arbitrary, but stable across polls.
 */
export function buildIndex(entries) {
  const index = {};
  const record = run => (index[run] ??= { files: {}, latest: -Infinity, course: null });

  for (const entry of entries) {
    if (entry.type !== 'blob') continue;

    const slash = entry.path.indexOf('/');
    if (slash < 1) continue;                          // loose file

    const run = entry.path.slice(0, slash);
    const name = entry.path.slice(slash + 1);
    if (name.includes('/')) continue;                 // nested deeper than a run

    if (/\.gpx$/i.test(name)) {
      const found = record(run);
      if (!found.course || name < found.course.name) found.course = { name, sha: entry.sha };
      continue;
    }

    if (!name.endsWith('.json')) continue;

    // No parsable time means no place on a time-coloured map, and it must not
    // be allowed to drag a run's `latest` around either.
    const t = parseTime(name);
    if (Number.isNaN(t)) continue;

    const found = record(run);
    found.files[name] = entry.sha;
    if (t > found.latest) found.latest = t;
  }

  // A folder holding only a course isn't a run yet — it has no `latest`, so it
  // can't be sorted, marked live, or chosen as the default. Drop it until the
  // first ping lands. (It also keeps `latest` finite, which matters: -Infinity
  // does not survive a round trip through JSON.)
  for (const [run, found] of Object.entries(index)) {
    if (!Object.keys(found.files).length) delete index[run];
  }

  return index;
}

/** The last known index, so the first paint needs no network at all. */
export function cachedIndex() {
  return storage.get(LS_TREE) || {};
}

/**
 * One poll: refresh the index of every run. This is the ONLY rate-limited call
 * in the app, which is why `main.js` puts a throttle around exactly this.
 *
 * @returns {{changed: boolean, index: Object, truncated: boolean}} `changed` is
 *   false on a 304, in which case `index` is the cached one — still usable.
 */
export async function refreshIndex() {
  const tree = await fetchTree(storage.get(LS_TREE_ETAG));
  if (!tree) return { changed: false, index: cachedIndex(), truncated: false };

  const index = buildIndex(tree.entries);

  // Only remember the ETag if the index itself was persisted. Otherwise a reload
  // would send the ETag, get a 304, and have no idea what runs exist.
  if (storage.set(LS_TREE, index)) storage.set(LS_TREE_ETAG, tree.etag);
  else storage.remove(LS_TREE_ETAG);

  return { changed: true, index, truncated: tree.truncated };
}

/** The run to show when the URL doesn't ask for one: whichever moved last. */
export function defaultRun(index) {
  const names = Object.keys(index);
  if (!names.length) return null;
  return names.reduce((a, b) => (index[b].latest > index[a].latest ? b : a));
}

/** Has this run had a ping recently enough to still be underway? */
export function isLive(record, now = Date.now()) {
  return Boolean(record) && now - record.latest < CONFIG.liveMs;
}

/** Reads one run's last known points from the cache, for an instant first paint. */
export function loadCache(run) {
  return run ? storage.get(keysFor(run).points) || {} : {};
}

/**
 * Fetches one location file from raw.githubusercontent.com — the CDN, which is
 * NOT subject to the API's 60 requests/hour limit. A brand-new path can't be
 * stale in the CDN, so there's no freshness concern.
 *
 * The URL is built rather than read off the listing: a tree entry carries only
 * a path. This is byte-for-byte the `download_url` the Contents API returns,
 * `+` in the UTC offset included — raw.githubusercontent.com wants it literal.
 *
 * @returns a point record, or null if the file isn't usable.
 */
export function rawUrl(run, name) {
  const { owner, repo, branch, dir } = CONFIG;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${dir}/${run}/${name}`;
}

export async function fetchPoint(run, name, sha) {
  const url = rawUrl(run, name);

  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const body = await res.json();

  // Only lat/lon are guaranteed. Older files carry msg/img, newer ones btry.
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const point = { name, sha, t: parseTime(name), lat, lon };
  if (Number.isFinite(body.btry)) point.btry = Number(body.btry);
  if (body.msg) point.msg = String(body.msg);
  if (body.img) point.img = String(body.img);
  return point;
}

/**
 * Downloads a run's course file, if it has one. Like every body in this app it
 * comes from the CDN, so a course costs NOTHING against the API budget — the
 * tree response we already have is what told us it exists.
 *
 * The parsed course isn't cached in localStorage on purpose: a long route would
 * dwarf everything else stored there, and the HTTP cache makes the refetch free
 * anyway. What we do keep is the snap result, which is the expensive part.
 *
 * @returns {Promise<{sha: string, text: string}|null>} null when there's no course.
 */
export async function fetchCourse(run, index) {
  const course = index[run]?.course;
  if (!course) return null;

  const res = await fetch(rawUrl(run, course.name), { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${course.name}: HTTP ${res.status}`);
  return { sha: course.sha, text: await res.text() };
}

/**
 * Fills in one run's points from the index: diff against the cache, download
 * only what's genuinely new.
 *
 * Every request this makes goes to the CDN, so it is FREE against the API's
 * hourly budget. That's what lets a run you've never opened load instantly off
 * a cached index — no poll, no throttle, no waiting.
 *
 * @returns {Promise<Object>} name -> point record, for the whole run.
 */
export async function hydrate(run, index) {
  const files = index[run]?.files || {};
  const cache = loadCache(run);

  const fresh = Object.entries(files).filter(([name, sha]) => cache[name]?.sha !== sha);
  if (fresh.length) {
    const fetched = await pool(fresh, CONFIG.concurrency, ([name, sha]) =>
      fetchPoint(run, name, sha).catch(() => null));  // one bad file mustn't sink the poll
    for (const point of fetched) if (point) cache[point.name] = point;
  }

  // Mirror deletions, so removing a file upstream removes the dot.
  for (const name of Object.keys(cache)) if (!(name in files)) delete cache[name];

  if (run) storage.set(keysFor(run).points, cache);
  return cache;
}
