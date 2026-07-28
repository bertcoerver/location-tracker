// Regression tests for the whole point of this app: never refetch what we
// already have, and never spend an API request you don't have to. These run
// against a fake GitHub, so they're offline and fast.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, LS_TREE, LS_TREE_ETAG, keysFor } from '../src/config.js';
import {
  buildIndex, defaultRun, fetchCourse, hydrate, isLive, RateLimitError, refreshIndex
} from '../src/github.js';

// --- fakes -------------------------------------------------------------------

function fakeLocalStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: k => map.delete(k),
    _map: map
  };
}

/**
 * A stand-in for the repo. `files` maps a full repo path to a body object.
 * Serves the two endpoints the app uses: the recursive tree of `locations/`,
 * and raw file bodies.
 */
function fakeGitHub(files) {
  const state = { files: new Map(Object.entries(files)), calls: [] };
  const root = `${CONFIG.dir}/`;

  /** Everything under locations/, in Git Trees shape — paths relative to it. */
  const tree = () => {
    const entries = [];
    const dirs = new Set();

    for (const [full, body] of state.files) {
      if (!full.startsWith(root)) continue;
      const path = full.slice(root.length);
      const slash = path.indexOf('/');
      if (slash > 0) dirs.add(path.slice(0, slash));
      entries.push({ path, type: 'blob', sha: `sha-${path}-${JSON.stringify(body).length}` });
    }
    for (const path of dirs) entries.push({ path, type: 'tree', sha: `tree-${path}` });
    return entries;
  };

  // The ETag changes whenever the tree does — same as GitHub.
  const etagOf = () => `W/"${JSON.stringify(tree().map(e => e.sha))}"`;

  state.fetch = async (url, opts = {}) => {
    const isApi = String(url).includes('api.github.com');
    state.calls.push({ kind: isApi ? 'API' : 'RAW', url: String(url) });

    if (isApi) {
      if (state.rateLimited) {
        return new Response('', {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(state.resetAt / 1000))
          }
        });
      }
      const entries = tree();
      // git has no empty directories, so locations/ itself doesn't exist yet.
      if (!entries.length) return new Response('', { status: 404 });

      const etag = etagOf();
      if (opts.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304 });
      return new Response(JSON.stringify({ tree: entries, truncated: !!state.truncated }),
        { status: 200, headers: { etag } });
    }

    const path = String(url).split(`/${CONFIG.branch}/`)[1];
    if (!state.files.has(path)) return new Response('', { status: 404 });
    const body = state.files.get(path);
    // A string is served as-is: that's how a .gpx is held in these fixtures.
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
  };

  state.reset = () => { state.calls.length = 0; };
  state.counts = () => ({
    api: state.calls.filter(c => c.kind === 'API').length,
    raw: state.calls.filter(c => c.kind === 'RAW').length
  });
  return state;
}

const RUN = 'locations/vendee-10k';

const FILES = {
  [`${RUN}/2026-07-28T11_09_28+02_00.json`]: { lat: 46.5735, lon: -0.7721, msg: null, img: null },
  [`${RUN}/2026-07-28T11_23_25+02_00.json`]: { lat: 46.5735, lon: -0.7722, btry: 53 },
  [`${RUN}/2026-07-28T11_36_00+02_00.json`]: { lat: 46.5735, lon: -0.7721, btry: 51 }
};

let gh;

/** One full cycle: refresh the index, then fill in one run from it. */
async function poll(run) {
  const { index, changed } = await refreshIndex();
  return { index, changed, cache: await hydrate(run, index) };
}

beforeEach(() => {
  globalThis.localStorage = fakeLocalStorage();
  gh = fakeGitHub({ ...FILES });
  globalThis.fetch = (...args) => gh.fetch(...args);
});

// --- the caching contract ----------------------------------------------------

test('cold start costs one API request and downloads every file once', async () => {
  const { changed, cache } = await poll('vendee-10k');

  assert.equal(changed, true);
  assert.equal(Object.keys(cache).length, 3);
  // One, not two: the tree carries the run list and the run's files together.
  assert.deepEqual(gh.counts(), { api: 1, raw: 3 });
});

test('a poll with nothing new costs one conditional request and zero downloads', async () => {
  await poll('vendee-10k');
  gh.reset();

  const { changed, cache } = await poll('vendee-10k');

  assert.equal(changed, false, 'a 304 must report no change');
  assert.equal(Object.keys(cache).length, 3, 'cached points survive the 304');
  assert.deepEqual(gh.counts(), { api: 1, raw: 0 });
});

test('a 304 still yields a usable index, not an empty one', async () => {
  await poll('vendee-10k');

  const { index } = await refreshIndex();

  assert.deepEqual(Object.keys(index), ['vendee-10k']);
  assert.equal(Object.keys(index['vendee-10k'].files).length, 3);
});

test('a new point upstream downloads exactly that one file', async () => {
  await poll('vendee-10k');
  gh.reset();

  gh.files.set(`${RUN}/2026-07-28T12_06_01+02_00.json`, { lat: 46.5736, lon: -0.7720, btry: 49 });
  const { cache } = await poll('vendee-10k');

  assert.equal(Object.keys(cache).length, 4);
  assert.deepEqual(gh.counts(), { api: 1, raw: 1 });
});

test('an edited file is refetched because its sha changed', async () => {
  await poll('vendee-10k');
  gh.reset();

  gh.files.set(`${RUN}/2026-07-28T11_23_25+02_00.json`, { lat: 1, lon: 2, btry: 100 });
  const { cache } = await poll('vendee-10k');

  assert.deepEqual(gh.counts(), { api: 1, raw: 1 });
  assert.equal(cache['2026-07-28T11_23_25+02_00.json'].lat, 1);
});

test('deleting a file upstream drops it from the cache', async () => {
  await poll('vendee-10k');
  gh.files.delete(`${RUN}/2026-07-28T11_09_28+02_00.json`);

  const { cache } = await poll('vendee-10k');

  assert.equal(Object.keys(cache).length, 2);
  assert.ok(!('2026-07-28T11_09_28+02_00.json' in cache));
});

// --- runs --------------------------------------------------------------------

test('a run only sees its own files', async () => {
  gh.files.set('locations/other-race/2026-07-29T09_00_00+02_00.json', { lat: 1, lon: 2 });

  const { index, cache } = await poll('vendee-10k');

  assert.equal(Object.keys(cache).length, 3);
  assert.equal(Object.keys(await hydrate('other-race', index)).length, 1);
});

test('each run caches separately, so switching back costs no downloads', async () => {
  gh.files.set('locations/other-race/2026-07-29T09_00_00+02_00.json', { lat: 1, lon: 2 });

  const { index } = await poll('vendee-10k');
  await hydrate('other-race', index);
  gh.reset();

  const { cache } = await poll('vendee-10k');

  assert.equal(Object.keys(cache).length, 3, 'the other run did not evict this one');
  assert.deepEqual(gh.counts(), { api: 1, raw: 0 });
});

test('opening a run for the first time costs ZERO API requests', async () => {
  // The point of splitting the index from the bodies: the index already lists
  // every run, so a run you've never opened needs only the CDN. Switching runs
  // must never be able to rate-limit you.
  gh.files.set('locations/other-race/2026-07-29T09_00_00+02_00.json', { lat: 1, lon: 2 });

  const { index } = await poll('vendee-10k');
  gh.reset();

  const cache = await hydrate('other-race', index);

  assert.equal(Object.keys(cache).length, 1);
  assert.deepEqual(gh.counts(), { api: 0, raw: 1 });
});

test('loose files in locations/ belong to no run and are never shown', async () => {
  gh.files.set('locations/2026-07-29T10_00_00+02_00.json', { lat: 9, lon: 9 });

  const { index, cache } = await poll('vendee-10k');

  assert.deepEqual(Object.keys(index), ['vendee-10k'], 'a loose file is not a run');
  assert.equal(Object.keys(cache).length, 3);
  assert.ok(!Object.values(index).some(r => '2026-07-29T10_00_00+02_00.json' in r.files));
});

test('a run folder that does not exist yet is empty, not an error', async () => {
  const { index } = await refreshIndex();
  assert.deepEqual(await hydrate('not-yet-run', index), {});
});

test('an entirely empty repo is empty, not an error', async () => {
  gh.files.clear();

  const { index } = await refreshIndex();

  assert.deepEqual(index, {});
  assert.equal(defaultRun(index), null);
});

// --- the index: which run is newest, which are live --------------------------

const TREE = [
  { path: 'old-race', type: 'tree', sha: 't1' },
  { path: 'old-race/2026-07-01T09_00_00+02_00.json', type: 'blob', sha: 'a' },
  { path: 'new-race/2026-07-28T11_00_00+02_00.json', type: 'blob', sha: 'b' },
  { path: 'new-race/2026-07-28T12_00_00+02_00.json', type: 'blob', sha: 'c' }
];

test('buildIndex groups by run and records each run\'s latest ping', () => {
  const index = buildIndex(TREE);

  assert.deepEqual(Object.keys(index).sort(), ['new-race', 'old-race']);
  assert.deepEqual(Object.keys(index['new-race'].files).length, 2);
  assert.equal(index['new-race'].latest, Date.parse('2026-07-28T12:00:00+02:00'));
  assert.equal(index['old-race'].latest, Date.parse('2026-07-01T09:00:00+02:00'));
});

test('buildIndex ignores loose files, subtrees, non-json and unparsable names', () => {
  const index = buildIndex([
    ...TREE,
    { path: '2026-07-28T13_00_00+02_00.json', type: 'blob', sha: 'd' },  // loose
    { path: 'new-race/nested/2026-07-28T14_00_00+02_00.json', type: 'blob', sha: 'e' },
    { path: 'new-race/README.md', type: 'blob', sha: 'f' },
    { path: 'new-race/notes.json', type: 'blob', sha: 'g' }              // no timestamp
  ]);

  assert.deepEqual(Object.keys(index).sort(), ['new-race', 'old-race']);
  assert.equal(Object.keys(index['new-race'].files).length, 2, 'only the two real pings');
  // A name with no time must not be able to drag `latest` to NaN and break the
  // newest-run pick for every other run.
  assert.equal(index['new-race'].latest, Date.parse('2026-07-28T12:00:00+02:00'));
});

test('defaultRun picks the run that pinged most recently', () => {
  assert.equal(defaultRun(buildIndex(TREE)), 'new-race');
});

test('a run is live only if it pinged within the hour', () => {
  const index = buildIndex(TREE);
  const now = Date.parse('2026-07-28T12:30:00+02:00');

  assert.equal(isLive(index['new-race'], now), true, '30 minutes ago');
  assert.equal(isLive(index['old-race'], now), false, 'weeks ago');
  assert.equal(isLive(index['new-race'], now + CONFIG.liveMs), false, 'exactly an hour is stale');
  assert.equal(isLive(undefined, now), false, 'no run selected');
});

// --- the course --------------------------------------------------------------

const GPX = '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>' +
  '<trkpt lat="46.5735" lon="-0.7721"><ele>60</ele></trkpt>' +
  '<trkpt lat="46.5740" lon="-0.7725"><ele>70</ele></trkpt>' +
  '</trkseg></trk></gpx>';

test('a .gpx in a run is that run\'s course, and is not a ping', () => {
  const index = buildIndex([
    ...TREE,
    { path: 'new-race/course.gpx', type: 'blob', sha: 'gpx1' }
  ]);

  assert.deepEqual(index['new-race'].course, { name: 'course.gpx', sha: 'gpx1' });
  assert.equal(Object.keys(index['new-race'].files).length, 2, 'the gpx is not a ping');
  // Dropping a course into a folder must not make a finished race look live.
  assert.equal(index['new-race'].latest, Date.parse('2026-07-28T12:00:00+02:00'));
});

test('a run without a course says so explicitly', () => {
  assert.equal(buildIndex(TREE)['old-race'].course, null);
});

test('the course is found whatever the file is called', () => {
  const index = buildIndex([...TREE, { path: 'new-race/Vendée Loop.GPX', type: 'blob', sha: 'g' }]);
  assert.equal(index['new-race'].course.name, 'Vendée Loop.GPX');
});

test('several courses in one run resolve the same way on every poll', () => {
  // Arbitrary, but it has to be STABLE: a course that changed identity between
  // polls would throw away the snap cache each time.
  const entries = [
    { path: 'new-race/z-route.gpx', type: 'blob', sha: 'z' },
    { path: 'new-race/a-route.gpx', type: 'blob', sha: 'a' }
  ];
  assert.equal(buildIndex([...TREE, ...entries]).course, undefined);
  assert.equal(buildIndex([...TREE, ...entries])['new-race'].course.name, 'a-route.gpx');
  assert.equal(buildIndex([...TREE, ...entries.reverse()])['new-race'].course.name, 'a-route.gpx');
});

test('a folder holding only a course is not yet a run', () => {
  // It has no latest ping, so it can't be sorted, marked live or defaulted to.
  const index = buildIndex([...TREE, { path: 'future-race/course.gpx', type: 'blob', sha: 'g' }]);

  assert.deepEqual(Object.keys(index).sort(), ['new-race', 'old-race']);
});

test('the course downloads from the CDN, so it costs no API request', async () => {
  gh.files.set(`${RUN}/course.gpx`, GPX);
  const { index } = await poll('vendee-10k');
  gh.reset();

  const file = await fetchCourse('vendee-10k', index);

  assert.equal(file.text, GPX);
  assert.deepEqual(gh.counts(), { api: 0, raw: 1 });
});

test('fetchCourse returns nothing for a run that has no course', async () => {
  const { index } = await poll('vendee-10k');
  assert.equal(await fetchCourse('vendee-10k', index), null);
  assert.equal(await fetchCourse('nonexistent', index), null);
});

test('a course that 404s raises rather than pretending there is no course', async () => {
  // Silently falling back to "no course" would hide a broken repo indefinitely.
  const { index } = await poll('vendee-10k');
  index['vendee-10k'].course = { name: 'missing.gpx', sha: 'x' };

  await assert.rejects(() => fetchCourse('vendee-10k', index), /404/);
});

// --- parsing -----------------------------------------------------------------

test('optional fields are carried through and absent ones stay absent', async () => {
  const { cache } = await poll('vendee-10k');

  const withMsg = cache['2026-07-28T11_09_28+02_00.json'];
  assert.equal(withMsg.btry, undefined, 'a null msg/img file has no battery');

  const withBtry = cache['2026-07-28T11_23_25+02_00.json'];
  assert.equal(withBtry.btry, 53);
  assert.equal(withBtry.msg, undefined);
});

test('timestamps come from the filename, since the body has none', async () => {
  const { cache } = await poll('vendee-10k');
  assert.equal(
    cache['2026-07-28T11_36_00+02_00.json'].t,
    Date.parse('2026-07-28T11:36:00+02:00')
  );
});

test('a file with unusable coordinates is skipped, not fatal', async () => {
  gh.files.set(`${RUN}/2026-07-28T13_00_00+02_00.json`, { lat: 'nope', lon: null });

  const { cache } = await poll('vendee-10k');

  assert.equal(Object.keys(cache).length, 3);
  assert.ok(!('2026-07-28T13_00_00+02_00.json' in cache));
});

test('one failing download does not sink the whole poll', async () => {
  const real = gh.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('11_23_25')) throw new Error('network');
    return real(url, opts);
  };

  const { cache } = await poll('vendee-10k');

  assert.equal(Object.keys(cache).length, 2, 'the other two still land');
});

test('the raw URL is built with the offset\'s + left literal', async () => {
  await poll('vendee-10k');

  const raw = gh.calls.find(c => c.kind === 'RAW').url;
  assert.ok(raw.includes('+02_00.json'), `encoded the plus: ${raw}`);
  assert.ok(raw.startsWith(
    `https://raw.githubusercontent.com/${CONFIG.owner}/${CONFIG.repo}/${CONFIG.branch}/${RUN}/`));
});

// --- failure modes -----------------------------------------------------------

test('a rate limit surfaces as RateLimitError carrying the reset time', async () => {
  gh.rateLimited = true;
  gh.resetAt = Date.parse('2026-07-28T13:00:00Z');

  const err = await refreshIndex().then(() => null, e => e);

  assert.ok(err instanceof RateLimitError);
  assert.equal(err.retryAt, gh.resetAt);
});

test('a plain API error propagates', async () => {
  globalThis.fetch = async () => new Response('', { status: 500 });
  await assert.rejects(refreshIndex(), /500/);
});

test('a truncated tree is reported rather than silently believed', async () => {
  gh.truncated = true;
  const { truncated } = await refreshIndex();
  assert.equal(truncated, true);
});

test('the ETag is not stored when the index could not be', async () => {
  // Simulate a full quota: writes fail silently, as localStorage does.
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };

  await refreshIndex();

  // Storing only the ETag would make the next load answer 304 with no index —
  // a map that has no idea what runs exist and never recovers.
  assert.equal(globalThis.localStorage.getItem(LS_TREE_ETAG), null);
  assert.equal(globalThis.localStorage.getItem(LS_TREE), null);
});

test('with storage unavailable, every poll still returns the full set', async () => {
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };

  await poll('vendee-10k');
  const { cache } = await poll('vendee-10k');

  assert.equal(Object.keys(cache).length, 3);
  assert.equal(globalThis.localStorage.getItem(keysFor('vendee-10k').points), null);
});
