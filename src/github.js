// The data layer: everything that talks to GitHub.
//
// The whole efficiency story lives in this file. Files in `locations/` are
// IMMUTABLE — the tracker only ever adds new ones — which is what makes the
// cache below correct: a filename we've already seen never needs refetching.

import { CONFIG, keysFor, LS_RUNS, LS_RUNS_ETAG } from './config.js';
import { dirFor } from './route.js';
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
 * Lists one repo directory, conditionally.
 *
 * Returns `null` when GitHub answers 304 Not Modified — meaning nothing has
 * changed, no body was transferred, and (per GitHub's docs) the request did not
 * count against the rate limit. That is the common case: most polls cost
 * essentially nothing.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE FUNCTION TO REPLACE when the repo outgrows the API.         │
 * │ A Contents API listing returns at most 1000 entries — about 3.5 days at │
 * │ a 5-minute ping cadence, though splitting pings across runs pushes that │
 * │ out per run. The migration is a GitHub Action that appends each ping    │
 * │ into a compact `<run>/index.json`; this function then becomes a single  │
 * │ conditional fetch of that file and everything else stays put.           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * @returns {{files: Array, dirs: string[], etag: string}|null}
 */
export async function listDir(path, etag) {
  const url = `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`;
  const headers = { Accept: 'application/vnd.github+json' };
  if (etag) headers['If-None-Match'] = etag;

  const res = await fetch(url, { headers, cache: 'no-store' });

  if (res.status === 304) return null;

  // An empty run folder doesn't exist as far as git is concerned. That's not an
  // error, it's just a run with no pings yet.
  if (res.status === 404) return { files: [], dirs: [], etag: null };

  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    throw new RateLimitError(reset || Date.now() + 15 * 60000);
  }
  if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);

  const entries = await res.json();
  return {
    files: entries.filter(e => e.type === 'file' && e.name.endsWith('.json')),
    dirs:  entries.filter(e => e.type === 'dir').map(e => e.name),
    etag:  res.headers.get('etag')
  };
}

/**
 * Fetches one location file from raw.githubusercontent.com — the CDN, which is
 * NOT subject to the API's 60 requests/hour limit. A brand-new path can't be
 * stale in the CDN, so there's no freshness concern.
 *
 * @returns a point record, or null if the file isn't usable.
 */
export async function fetchPoint(entry) {
  const res = await fetch(entry.download_url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${entry.name}: HTTP ${res.status}`);
  const body = await res.json();

  // Only lat/lon are guaranteed. Older files carry msg/img, newer ones btry.
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const t = parseTime(entry.name);
  if (Number.isNaN(t)) return null;

  const point = { name: entry.name, sha: entry.sha, t, lat, lon };
  if (Number.isFinite(body.btry)) point.btry = Number(body.btry);
  if (body.msg) point.msg = String(body.msg);
  if (body.img) point.img = String(body.img);
  return point;
}

/** Reads one run's last known points from the cache, for an instant first paint. */
export function loadCache(run) {
  return storage.get(keysFor(run).points) || {};
}

/** The last known run names, so the picker is populated before any request lands. */
export function cachedRuns() {
  return storage.get(LS_RUNS) || [];
}

/**
 * The runs available to switch between, i.e. the subdirectories of `locations/`.
 *
 * Kept in its own cache namespace because it's the parent listing, and a run's
 * own poll never sees its siblings. Costs one conditional request, so after the
 * first ever load this is a 304 and free.
 *
 * @returns {Promise<string[]>}
 */
export async function listRuns() {
  const cached = storage.get(LS_RUNS) || [];
  const listing = await listDir(CONFIG.dir, storage.get(LS_RUNS_ETAG));
  if (!listing) return cached;

  if (storage.set(LS_RUNS, listing.dirs)) storage.set(LS_RUNS_ETAG, listing.etag);
  else storage.remove(LS_RUNS_ETAG);

  return listing.dirs;
}

/**
 * One poll for one run: list, diff against that run's cache, fetch only what's
 * genuinely new.
 *
 * @param {string|null} run null polls the unsorted feed at the root.
 * @returns {{changed: boolean, cache: Object, dirs: string[]|null}} `changed` is
 *   false on a 304. `dirs` is non-null only when this poll happened to list the
 *   root, in which case the caller gets the run names for free.
 */
export async function sync(run = null) {
  const keys = keysFor(run);
  const cache = loadCache(run);
  const listing = await listDir(dirFor(run), storage.get(keys.etag));

  if (!listing) return { changed: false, cache, dirs: null };

  const fresh = listing.files.filter(e => cache[e.name]?.sha !== e.sha);
  if (fresh.length) {
    const fetched = await pool(fresh, CONFIG.concurrency, e =>
      fetchPoint(e).catch(() => null));   // one bad file must not sink the poll
    for (const p of fetched) if (p) cache[p.name] = p;
  }

  // Mirror deletions, so removing a file upstream removes the dot.
  const live = new Set(listing.files.map(e => e.name));
  for (const name of Object.keys(cache)) if (!live.has(name)) delete cache[name];

  // Only remember the ETag if the points themselves were persisted. Otherwise a
  // reload would send the ETag, get a 304, and render an empty map.
  if (storage.set(keys.points, cache)) storage.set(keys.etag, listing.etag);
  else storage.remove(keys.etag);

  return { changed: true, cache, dirs: run ? null : listing.dirs };
}
