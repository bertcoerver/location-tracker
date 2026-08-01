// Regression tests for the whole point of this app: never refetch what we
// already have, and never spend an API request you don't have to. These run
// against a fake GitHub, so they're offline and fast.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG, LS_BEACONS, LS_SETTINGS, LS_TREE, LS_TREE_ETAG, keysFor } from '../src/config.js';
import {
  buildIndex, byRecency, cachedBeacons, cachedSettings, defaultRun, fetchCourse, hydrate, isLive,
  newestFile, RateLimitError, refreshBeacons, refreshIndex, refreshSettings
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

    // The blob sha rides along as a query string, which the real CDN ignores —
    // it is there to make the URL content-addressed, not to select anything.
    const path = String(url).split(`/${CONFIG.branch}/`)[1].split('?')[0];
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

test('buildIndex sorts media into its own map, in either case', () => {
  const index = buildIndex([
    ...TREE,
    { path: 'new-race/2026-07-28T11_30_00+02_00.jpeg', type: 'blob', sha: 'm1' },
    { path: 'new-race/2026-07-28T11_31_00+02_00.JPG', type: 'blob', sha: 'm2' },
    { path: 'new-race/2026-07-28T11_32_00+02_00.png', type: 'blob', sha: 'm3' },
    { path: 'new-race/2026-07-28T11_33_00+02_00.GIF', type: 'blob', sha: 'm4' },
    { path: 'new-race/2026-07-28T11_34_00+02_00.webm', type: 'blob', sha: 'm5' },
    { path: 'new-race/summit.jpg', type: 'blob', sha: 'm6' }
  ]);

  assert.equal(Object.keys(index['new-race'].media).length, 6);
  // And out of `files`, which is what keeps `hydrate` and `newestFile` — and so
  // the beacons and the whole poll schedule — from ever seeing one.
  assert.equal(Object.keys(index['new-race'].files).length, 2, 'still only the two pings');
});

test('a photo never moves a run\'s latest', () => {
  // The rule the `.gpx` branch has always followed, and the reason it matters
  // here: dropping a picture into a race that finished last summer is not that
  // race moving, and a run that went live again because somebody uploaded a photo
  // would be polled for pings that are never coming.
  const index = buildIndex([
    ...TREE,
    { path: 'old-race/2026-12-25T09_00_00+02_00.jpeg', type: 'blob', sha: 'm1' }
  ]);

  assert.equal(index['old-race'].latest, Date.parse('2026-07-01T09:00:00+02:00'));
});

test('a folder holding only a photo is still a run', () => {
  const index = buildIndex([
    ...TREE,
    { path: 'photo-only/2026-07-28T11_30_00+02_00.jpeg', type: 'blob', sha: 'm1' }
  ]);

  assert.deepEqual(Object.keys(index).sort(), ['new-race', 'old-race', 'photo-only']);
  assert.equal(index['photo-only'].latest, null);
  assert.deepEqual(index['photo-only'].files, {});
  assert.deepEqual(index['photo-only'].media, { '2026-07-28T11_30_00+02_00.jpeg': 'm1' });
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

// --- a race that hasn't happened yet -----------------------------------------
//
// One trap runs through all of this: a scheduled start is a time in the FUTURE, and
// every ordering and freshness test in the app was written for times in the past.
// Let a start reach any of them and it wins, because it is larger than every real
// ping — so a race three weeks out would pulse as live, top the picker, and take
// the landing view. These are the tests that go red if it ever leaks.

/** `TREE` plus a race a month out: a course, a settings file, and no pings. */
const UPCOMING = [
  ...TREE,
  { path: 'utmb/course.gpx', type: 'blob', sha: 'g' },
  { path: 'utmb/course_settings.json', type: 'blob', sha: 's' }
];
const GUN = Date.parse('2026-08-28T09:00:00+02:00');
// The gun no longer travels with the index — it comes out of the run's settings
// file, which is fetched separately and cached separately. Everything that sorts or
// defaults now takes both, so the fixtures do too.
const SCHEDULE = { utmb: { sha: 's', start: GUN } };

test('an upcoming run is never live, however close its gun is', () => {
  const index = buildIndex(UPCOMING);

  assert.equal(isLive(index.utmb, GUN - 60000), false, 'a minute before the start');
  assert.equal(isLive(index.utmb, GUN), false, 'on the gun, with nothing reported');
  assert.equal(isLive(index.utmb, GUN + 60000), false, 'a minute after, still silent');
  // Liveness is a claim about a phone being out there. Only a ping is evidence of
  // one, and this run has none — no arithmetic on `start` may say otherwise.
  assert.equal(index.utmb.latest, null);
});

test('an upcoming run sorts by its gun, so it is findable in the picker', () => {
  const index = buildIndex(UPCOMING);
  const order = Object.keys(index).sort(byRecency(index, SCHEDULE));

  // Top of the list: it is the next thing that will happen. Being top of the picker
  // is not being the default view — see the test below.
  assert.deepEqual(order, ['utmb', 'new-race', 'old-race']);
});

test('without its settings an upcoming run sorts on its name, not on nothing', () => {
  // The very first paint of a browser that has never seen this repo has an index and
  // no settings at all. That must be an ORDER — bottom of the list, by name, among
  // the other things nothing is known about — rather than a comparator returning NaN
  // and handing the list to the engine.
  const index = buildIndex(UPCOMING);

  const once = Object.keys(index).sort(byRecency(index));
  assert.deepEqual(once, ['new-race', 'old-race', 'utmb']);
  assert.deepEqual(once.slice().sort(byRecency(index)), once, 'and sorting again agrees');
});

test('byRecency is stable when nothing can be compared', () => {
  // Two runs with an unstamped course and no pings both score -Infinity, and
  // `-Infinity - -Infinity` is NaN. A comparator returning NaN hands the order to
  // the engine, which is how a list that looked stable starts shuffling.
  const index = buildIndex([
    { path: 'zeta/course.gpx', type: 'blob', sha: 'z' },
    { path: 'alpha/course.gpx', type: 'blob', sha: 'a' },
    { path: 'mid/course.gpx', type: 'blob', sha: 'm' }
  ]);

  const once = Object.keys(index).sort(byRecency(index));
  assert.deepEqual(once, ['alpha', 'mid', 'zeta'], 'names break the tie');
  assert.deepEqual(once.slice().sort(byRecency(index)), once, 'and sorting again is idempotent');
});

test('defaultRun will not open on a race that has not started', () => {
  // The plain link still follows whichever run PINGED last. Opening on an upcoming
  // race means opening on an empty map, possibly while a real one is underway two
  // options down the picker.
  assert.equal(defaultRun(buildIndex(UPCOMING), SCHEDULE), 'new-race');
});

test('defaultRun falls back to an upcoming run when nothing has ever pinged', () => {
  // Then the empty map is the honest answer, and a countdown is better than nothing.
  const index = buildIndex([
    { path: 'utmb/course.gpx', type: 'blob', sha: 'g' },
    { path: 'later/course.gpx', type: 'blob', sha: 'h' }
  ]);
  const settings = {
    utmb: { start: GUN },
    later: { start: Date.parse('2026-09-30T06:00:00+02:00') }
  };

  assert.equal(defaultRun(index, settings), 'later',
    'the furthest-out gun is still the newest key');
  assert.equal(defaultRun({}), null, 'and an empty index is still nothing at all');
});

// --- the other runs, as dots -------------------------------------------------
//
// The contract these defend is the whole reason this feature is affordable:
// marking every other run on the map must cost ZERO API requests, and in the
// steady state zero requests of any kind. Everything it needs beyond a position
// is already in the tree response.

test('newestFile picks a run\'s last ping, by filename', () => {
  const index = buildIndex(TREE);

  assert.deepEqual(newestFile(index['new-race']),
    { name: '2026-07-28T12_00_00+02_00.json', sha: 'c', t: Date.parse('2026-07-28T12:00:00+02:00') });
});

test('newestFile has nothing to say about a run with no pings', () => {
  assert.equal(newestFile({ files: {} }), null);
  assert.equal(newestFile(undefined), null);
});

/** Two runs, so there is always exactly one OTHER run to mark. */
const OTHER = 'locations/other-race';

function withOther() {
  gh.files.set(`${OTHER}/2026-07-29T09_00_00+02_00.json`, { lat: 1.5, lon: 2.5, btry: 90 });
}

test('an upcoming run gets no dot, and costs no other run its own', async () => {
  withOther();
  // A course-only folder. It sorts to the top of the picker by its gun, but a
  // beacon marks where a run was last SEEN, and this one has never been anywhere.
  gh.files.set('locations/utmb/UTMB_2026-08-28T09_00_00+02_00.gpx', '<gpx/>');
  const { index } = await poll('vendee-10k');
  gh.reset();

  const beacons = await refreshBeacons(index, 'vendee-10k');

  assert.deepEqual(beacons.map(b => b.run), ['other-race']);
  // Dropped BEFORE the limit, not after — otherwise an upcoming race that sorts
  // first would silently spend a slot a run with a dot to draw could have used.
  assert.ok(beacons.length <= CONFIG.beaconLimit);
  assert.deepEqual(gh.counts(), { api: 0, raw: 1 }, 'and its GPX was never fetched');
});

test('the other runs are marked without a single API request', async () => {
  withOther();
  const { index } = await poll('vendee-10k');
  gh.reset();

  const beacons = await refreshBeacons(index, 'vendee-10k');

  assert.equal(beacons.length, 1);
  assert.deepEqual(
    { run: beacons[0].run, lat: beacons[0].lat, lon: beacons[0].lon },
    { run: 'other-race', lat: 1.5, lon: 2.5 });
  assert.equal(beacons[0].latest, Date.parse('2026-07-29T09:00:00+02:00'),
    'carried as `latest` so isLive reads one of these unchanged');
  // One body, for one position. The tree told us which file and what its sha is.
  assert.deepEqual(gh.counts(), { api: 0, raw: 1 });
});

test('the run on screen is drawn in full, so it never gets a dot', async () => {
  withOther();
  const { index } = await poll('vendee-10k');

  const beacons = await refreshBeacons(index, 'vendee-10k');
  assert.deepEqual(beacons.map(b => b.run), ['other-race']);

  // And the other way round, to be sure it is the argument doing the work.
  const swapped = await refreshBeacons(index, 'other-race');
  assert.deepEqual(swapped.map(b => b.run), ['vendee-10k']);
});

test('a second pass with nothing new costs nothing at all', async () => {
  withOther();
  const { index } = await poll('vendee-10k');
  await refreshBeacons(index, 'vendee-10k');
  gh.reset();

  const beacons = await refreshBeacons(index, 'vendee-10k');

  assert.equal(beacons.length, 1);
  assert.deepEqual(gh.counts(), { api: 0, raw: 0 }, 'the persisted beacon still matches the sha');
});

test('the dots are persisted, so a reload has them before any network call', async () => {
  withOther();
  const { index } = await poll('vendee-10k');
  await refreshBeacons(index, 'vendee-10k');

  assert.equal(globalThis.localStorage.getItem(LS_BEACONS) !== null, true);
  assert.deepEqual(cachedBeacons().map(b => b.run), ['other-race']);
});

test('a new ping on another run refetches only that run\'s position', async () => {
  withOther();
  gh.files.set('locations/third-race/2026-07-20T09_00_00+02_00.json', { lat: 3, lon: 4 });

  let { index } = await poll('vendee-10k');
  await refreshBeacons(index, 'vendee-10k');
  gh.reset();

  gh.files.set(`${OTHER}/2026-07-29T10_00_00+02_00.json`, { lat: 9.5, lon: 8.5 });
  ({ index } = await poll('vendee-10k'));
  gh.reset();
  const beacons = await refreshBeacons(index, 'vendee-10k');

  assert.deepEqual(gh.counts(), { api: 0, raw: 1 }, 'the quiet run costs nothing again');
  assert.equal(beacons.find(b => b.run === 'other-race').lat, 9.5);
});

test('a run you have already opened needs no fetch at all', async () => {
  withOther();
  const { index } = await poll('vendee-10k');
  await hydrate('other-race', index);   // as opening that run would
  gh.reset();

  const beacons = await refreshBeacons(index, 'vendee-10k');

  assert.equal(beacons[0].lat, 1.5);
  assert.deepEqual(gh.counts(), { api: 0, raw: 0 }, 'read straight out of that run\'s own cache');
});

test('one unreadable run loses its own dot and nobody else\'s', async () => {
  withOther();
  gh.files.set('locations/third-race/2026-07-20T09_00_00+02_00.json', { lat: 3, lon: 4 });
  const { index } = await poll('vendee-10k');
  // Present in the tree, missing from the CDN — which is what a mid-poll delete
  // looks like from here.
  gh.files.delete(`${OTHER}/2026-07-29T09_00_00+02_00.json`);

  const beacons = await refreshBeacons(index, 'vendee-10k');

  assert.deepEqual(beacons.map(b => b.run), ['third-race']);
});

test('a file with no usable coordinates is not a place, so it is not a dot', async () => {
  gh.files.set(`${OTHER}/2026-07-29T09_00_00+02_00.json`, { lat: 'nope', lon: null });
  const { index } = await poll('vendee-10k');

  assert.deepEqual(await refreshBeacons(index, 'vendee-10k'), []);
});

test('beaconLimit caps a cold start, keeping the runs that moved most recently', async () => {
  // A repo that has grown past what is worth drawing. The cap is about the cold
  // fan-out, not the API budget — there is no API request here to spend.
  const total = CONFIG.beaconLimit + 5;
  for (let i = 0; i < total; i++) {
    // Minutes apart, so every one of them is a real timestamp and they come out
    // in a known order.
    const n = String(i + 1).padStart(2, '0');
    gh.files.set(`locations/race-${n}/2026-06-01T09_${n}_00+02_00.json`, { lat: i, lon: i });
  }

  const { index } = await poll('vendee-10k');
  gh.reset();
  const beacons = await refreshBeacons(index, 'vendee-10k');

  assert.equal(beacons.length, CONFIG.beaconLimit);
  assert.deepEqual(gh.counts(), { api: 0, raw: CONFIG.beaconLimit });
  // The five oldest are the ones dropped.
  const kept = new Set(beacons.map(b => b.run));
  assert.equal(kept.has('race-05'), false, 'the oldest is dropped');
  assert.equal(kept.has(`race-${String(total).padStart(2, '0')}`), true, 'the newest is kept');
});

test('with no other runs there is nothing to mark', async () => {
  const { index } = await poll('vendee-10k');
  assert.deepEqual(await refreshBeacons(index, 'vendee-10k'), []);
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

test('a folder holding only a course is a run — an upcoming one', () => {
  // It used to be dropped, on the grounds that a run with no `latest` can't be
  // sorted, marked live or defaulted to. Each of those is now answered rather than
  // avoided, and the four assertions below are the answers.
  const index = buildIndex([...TREE, { path: 'future-race/course.gpx', type: 'blob', sha: 'g' }]);

  assert.deepEqual(Object.keys(index).sort(), ['future-race', 'new-race', 'old-race']);
  assert.equal(index['future-race'].latest, null);
  assert.deepEqual(index['future-race'].files, {});
  assert.deepEqual(index['future-race'].course, { name: 'course.gpx', sha: 'g' });
  // And no settings file, so nothing anywhere says when it starts — the case that
  // has to keep behaving exactly as an unscheduled run always did.
  assert.equal(index['future-race'].settings, null);
});

test('a course filename says nothing but which file the course is', () => {
  // It used to carry the gun time, and a stamped name still turns up in real repos.
  // Nothing may read it: the start comes from the settings file now, and a filename
  // quietly winning over what that file says is the one way to get a map drawing one
  // route and counting down to another.
  const index = buildIndex([
    { path: 'utmb/UTMB_2026-08-28T09_00_00+02_00.gpx', type: 'blob', sha: 'g' }
  ]);

  assert.deepEqual(index.utmb.course, { name: 'UTMB_2026-08-28T09_00_00+02_00.gpx', sha: 'g' });
  assert.equal(index.utmb.settings, null, 'no settings file, so nothing schedules it');
  // Still not a ping: a course must never make a run look like it has moved.
  assert.equal(index.utmb.latest, null);
  assert.deepEqual(index.utmb.files, {});
});

test('a settings file is neither a ping nor a course', () => {
  const index = buildIndex([
    { path: 'utmb/course.gpx', type: 'blob', sha: 'g' },
    { path: 'utmb/course_settings.json', type: 'blob', sha: 's' },
    { path: 'utmb/2026-08-28T09_05_00+02_00.json', type: 'blob', sha: 'p' }
  ]);

  assert.deepEqual(index.utmb.settings, { sha: 's' });
  // Out of `files`, so it is never fetched as a ping and never diffed as one.
  assert.deepEqual(Object.keys(index.utmb.files), ['2026-08-28T09_05_00+02_00.json']);
  // And out of `latest`, so editing it mid-race cannot make a finished run look live.
  assert.equal(index.utmb.latest, Date.parse('2026-08-28T09:05:00+02:00'));
});

test('a folder holding only a settings file is still a run', () => {
  // A race entered but not yet mapped: a name and a gun time, no route, no pings.
  const index = buildIndex([{ path: 'utmb/course_settings.json', type: 'blob', sha: 's' }]);

  assert.deepEqual(Object.keys(index), ['utmb']);
  assert.equal(index.utmb.course, null);
  assert.deepEqual(index.utmb.settings, { sha: 's' });
});

test('the alphabetically first course still wins the tie-break', () => {
  const entries = [
    { path: 'twice/b.gpx', type: 'blob', sha: 'b' },
    { path: 'twice/a.gpx', type: 'blob', sha: 'a' }
  ];

  for (const order of [entries, [...entries].reverse()]) {
    assert.deepEqual(buildIndex(order).twice.course, { name: 'a.gpx', sha: 'a' });
  }
});

test('an upcoming run survives the round trip through JSON', () => {
  // This is the exact trip that made the old code drop these runs: `latest` was
  // -Infinity, which comes back out of JSON as null, so every comparison against it
  // went quietly wrong. It is null on the way in now, so there is nothing to lose.
  const index = buildIndex(UPCOMING);

  assert.deepEqual(JSON.parse(JSON.stringify(index)), index);
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

test('a finish is flagged, and normalised so it survives the cache', async () => {
  // The phone's last upload is an ordinary ping with one extra field. It has to
  // come out as a real boolean, because this record goes through JSON on its way
  // to localStorage and back on every reload.
  gh.files.set(`${RUN}/2026-07-28T13_00_00+02_00.json`,
    { lat: 46.57, lon: -0.77, btry: 41, is_finish: true });

  const { cache } = await poll('vendee-10k');
  const finish = cache['2026-07-28T13_00_00+02_00.json'];

  assert.equal(finish.is_finish, true);
  assert.equal(finish.lat, 46.57, 'and it is still a fix like any other');
  assert.equal(finish.btry, 41);
  assert.equal(JSON.parse(JSON.stringify(finish)).is_finish, true);
});

test('an ordinary ping is not a finish', async () => {
  const { cache } = await poll('vendee-10k');
  assert.equal(cache['2026-07-28T11_23_25+02_00.json'].is_finish, undefined);
});

// --- editing a file that already exists ---------------------------------------
//
// Pings are append-only, so for most of this repo's life no file ever changed
// after it was written. Adding `is_finish` to the last ping of a finished run is
// the first edit there has been, and it exposed the one assumption that made:
// that a path and its contents were the same thing.

test('a body is fetched from a URL carrying its sha, not from the bare path', async () => {
  const { index } = await poll('vendee-10k');
  await fetchCourse('vendee-10k', index);

  const raw = gh.calls.filter(c => c.kind === 'RAW');
  assert.ok(raw.length > 1, 'pings and the course were both fetched');
  for (const call of raw) assert.match(call.url, /\?[^?]+$/, `no sha on ${call.url}`);
});

test('editing a file in place changes the URL it is fetched from', async () => {
  // The bug this exists for: `force-cache` returns the cached body for a URL
  // whatever its freshness, so if an edit does not change the address, the
  // browser serves the pre-edit bytes and the new sha is stored against them.
  const name = '2026-07-28T11_23_25+02_00.json';

  await poll('vendee-10k');
  const before = gh.calls.find(c => c.kind === 'RAW' && c.url.includes(name)).url;

  // Same path, new contents — exactly what adding `is_finish` by hand does.
  gh.files.set(`${RUN}/${name}`, { lat: 46.5735, lon: -0.7721, btry: 53, is_finish: true });
  gh.reset();

  const { cache } = await poll('vendee-10k');
  const after = gh.calls.find(c => c.kind === 'RAW' && c.url.includes(name)).url;

  assert.notEqual(after, before, 'the edit has to produce a different URL');
  assert.equal(cache[name].is_finish, true, 'and the new body has to land');
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

test('an index we have not heard about yet leaves the last visit\'s dots alone', async () => {
  // The first `reconcile` runs before the first poll, on whatever the cache held.
  // Writing [] over the stored beacons there would leave anyone who opened the
  // page offline looking at a map with no other races on it.
  withOther();
  const { index } = await poll('vendee-10k');
  await refreshBeacons(index, 'vendee-10k');
  gh.reset();

  const beacons = await refreshBeacons({}, 'vendee-10k');

  assert.deepEqual(beacons.map(b => b.run), ['other-race']);
  assert.deepEqual(cachedBeacons().map(b => b.run), ['other-race'], 'and it is still stored');
  assert.deepEqual(gh.counts(), { api: 0, raw: 0 });
});

test('a stored dot for the run now on screen is still left out', async () => {
  withOther();
  const { index } = await poll('vendee-10k');
  await refreshBeacons(index, 'vendee-10k');

  // Switching to other-race: it is in the stored list, from when it wasn't the
  // one being looked at.
  assert.deepEqual(await refreshBeacons({}, 'other-race'), []);
});

// --- heart rate --------------------------------------------------------------

test('a heart rate is read off a ping', async () => {
  gh.files.set(`${RUN}/2026-07-28T12_11_01+02_00.json`,
    { lat: 46.5, lon: -0.77, btry: 73, bpm: 69 });

  const { cache } = await poll('vendee-10k');

  assert.equal(cache['2026-07-28T12_11_01+02_00.json'].bpm, 69);
});

test('an implausible heart rate is dropped rather than drawn', async () => {
  // Range-checked for the reason `ntwrk` is, and the low end is the point of it: a 0
  // is a watch that was not being worn or had not found a pulse, and it would be
  // shown as a resting heart rate of zero.
  for (const [name, bpm] of [['12_11', 0], ['12_16', 400], ['12_21', 'fast'], ['12_26', null]]) {
    gh.files.set(`${RUN}/2026-07-28T${name}_01+02_00.json`, { lat: 46.5, lon: -0.77, bpm });
  }

  const { cache } = await poll('vendee-10k');

  for (const name of ['12_11', '12_16', '12_21', '12_26']) {
    const point = cache[`2026-07-28T${name}_01+02_00.json`];
    assert.ok(point, name);
    assert.equal('bpm' in point, false, `${name} kept a bpm of ${JSON.stringify(point.bpm)}`);
  }
});

test('a ping with no heart rate at all is untouched by it', async () => {
  // Every file written before the field existed, which is all of them but one.
  const { cache } = await poll('vendee-10k');

  for (const point of Object.values(cache)) assert.equal('bpm' in point, false);
});

// --- what a run says about itself --------------------------------------------
//
// Settings are a second cache with a second invalidation key: the tree ETag says
// when the LISTING changed, a blob sha says when THIS FILE did. Merging them into
// the index would put one value under two keys with only one ever checked — and
// since a 304 hands back the cached index untouched, the merged half would be
// permanently one poll stale. These tests are what keeps the two apart.

const SETTINGS_PATH = `${RUN}/course_settings.json`;
const BODY = { id: 'vendee-10k', label: 'Vendée 10K', start_datetime: '2026-07-28T10:00:00+02:00' };

test('settings cost no API request, and are fetched once per edit', async () => {
  gh.files.set(SETTINGS_PATH, BODY);
  const { index } = await refreshIndex();
  gh.reset();

  const settings = await refreshSettings(index);

  assert.equal(settings['vendee-10k'].label, 'Vendée 10K');
  assert.equal(settings['vendee-10k'].start, Date.parse('2026-07-28T10:00:00+02:00'));
  // The tree already named the file and carried its sha, so the body comes off the
  // CDN. Nothing here touches the hourly budget.
  assert.deepEqual(gh.counts(), { api: 0, raw: 1 });

  gh.reset();
  await refreshSettings((await refreshIndex()).index);
  assert.equal(gh.counts().raw, 0, 'an unchanged sha is not refetched');
});

test('an edited settings file is picked up, because its sha moved', async () => {
  gh.files.set(SETTINGS_PATH, BODY);
  await refreshSettings((await refreshIndex()).index);

  gh.files.set(SETTINGS_PATH, { ...BODY, label: 'Vendée 10K — sold out' });
  const settings = await refreshSettings((await refreshIndex()).index);

  assert.equal(settings['vendee-10k'].label, 'Vendée 10K — sold out');
});

test('a failed fetch keeps the last known settings rather than dropping them', async () => {
  gh.files.set(SETTINGS_PATH, BODY);
  await refreshSettings((await refreshIndex()).index);

  // The file changes — so the sha changes and it will be refetched — and the fetch
  // fails. Degrading to an empty record here is not a cosmetic loss: the run's gun
  // time would vanish, every warm-up ping would snap onto the course, and the
  // distance, climb, pace and forecast built on them would all be quietly wrong.
  gh.files.set(SETTINGS_PATH, { ...BODY, label: 'never served' });
  const { index } = await refreshIndex();
  gh.files.delete(SETTINGS_PATH);

  const settings = await refreshSettings(index);

  assert.equal(settings['vendee-10k'].label, 'Vendée 10K');
  assert.equal(settings['vendee-10k'].start, Date.parse('2026-07-28T10:00:00+02:00'));
});

test('a settings file that will not parse costs that run nothing it had', async () => {
  gh.files.set(SETTINGS_PATH, BODY);
  await refreshSettings((await refreshIndex()).index);

  gh.files.set(SETTINGS_PATH, 'this is not json at all');
  const settings = await refreshSettings((await refreshIndex()).index);

  assert.equal(settings['vendee-10k'].label, 'Vendée 10K');
});

test('a deleted settings file takes its run\'s settings with it', async () => {
  gh.files.set(SETTINGS_PATH, BODY);
  await refreshSettings((await refreshIndex()).index);

  gh.files.delete(SETTINGS_PATH);
  const settings = await refreshSettings((await refreshIndex()).index);

  assert.equal('vendee-10k' in settings, false);
  assert.deepEqual(cachedSettings(), {}, 'and it is gone from disk too');
});

test('a truncated listing is not a deletion', async () => {
  // A tree that hit GitHub's 100k-entry cap and dropped entries looks exactly like a
  // repo where those files were deleted. Acting on it would strip the gun times off
  // runs whose settings are sitting right there in the folder.
  gh.files.set(SETTINGS_PATH, BODY);
  await refreshSettings((await refreshIndex()).index);

  const settings = await refreshSettings(buildIndex([]), { prune: false });

  assert.equal(settings['vendee-10k'].label, 'Vendée 10K');
});

test('settings survive a reload without any network at all', async () => {
  gh.files.set(SETTINGS_PATH, BODY);
  await refreshSettings((await refreshIndex()).index);

  // What `main.js` reads synchronously at module load, before the first poll — which
  // is what lets the first paint use the right gun time and the right name.
  assert.equal(cachedSettings()['vendee-10k'].label, 'Vendée 10K');
  assert.ok(localStorage.getItem(LS_SETTINGS), 'persisted under its own key');
});

test('one unreadable file does not cost every other run its settings', async () => {
  gh.files.set(SETTINGS_PATH, BODY);
  gh.files.set('locations/other/2026-07-28T09_00_00+02_00.json', { lat: 1, lon: 2 });
  gh.files.set('locations/other/course_settings.json', { label: 'Other' });
  const { index } = await refreshIndex();
  gh.files.delete(SETTINGS_PATH);

  const settings = await refreshSettings(index);

  assert.equal(settings.other.label, 'Other');
  assert.equal('vendee-10k' in settings, false, 'and the broken one simply is not there');
});
