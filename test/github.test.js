// Regression tests for the whole point of this app: never refetch what we
// already have. These run against a fake GitHub, so they're offline and fast.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { keysFor } from '../src/config.js';
import { listRuns, RateLimitError, sync } from '../src/github.js';

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

/** A stand-in for the repo. `files` maps a full repo path to a body object. */
function fakeGitHub(files) {
  const state = { files: new Map(Object.entries(files)), calls: [] };

  const dirname = path => path.slice(0, path.lastIndexOf('/'));

  /** Immediate children of `path`, in Contents API shape. */
  const listing = path => {
    const entries = [];
    const dirs = new Set();

    for (const [full, body] of state.files) {
      if (!full.startsWith(`${path}/`)) continue;
      const rest = full.slice(path.length + 1);
      if (rest.includes('/')) {
        dirs.add(rest.slice(0, rest.indexOf('/')));
      } else {
        entries.push({
          name: rest,
          type: 'file',
          sha: `sha-${rest}-${JSON.stringify(body).length}`,
          download_url: `https://raw.githubusercontent.com/x/y/main/${full}`
        });
      }
    }
    for (const name of dirs) entries.push({ name, type: 'dir', sha: `dir-${name}` });
    return entries;
  };

  // The ETag changes whenever the listing does — same as GitHub.
  const etagOf = path => `"${JSON.stringify(listing(path).map(e => e.sha))}"`;

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
      const path = String(url).split('/contents/')[1];
      const entries = listing(path);
      if (!entries.length && ![...state.files.keys()].some(f => dirname(f) === path)) {
        return new Response('', { status: 404 });   // git has no empty directories
      }
      const etag = etagOf(path);
      if (opts.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(entries), { status: 200, headers: { etag } });
    }

    const path = decodeURIComponent(String(url).split('/main/')[1]);
    if (!state.files.has(path)) return new Response('', { status: 404 });
    return new Response(JSON.stringify(state.files.get(path)), { status: 200 });
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

beforeEach(() => {
  globalThis.localStorage = fakeLocalStorage();
  gh = fakeGitHub({ ...FILES });
  globalThis.fetch = (...args) => gh.fetch(...args);
});

// --- the caching contract ----------------------------------------------------

test('cold start fetches the listing and every file once', async () => {
  const { changed, cache } = await sync('vendee-10k');

  assert.equal(changed, true);
  assert.equal(Object.keys(cache).length, 3);
  assert.deepEqual(gh.counts(), { api: 1, raw: 3 });
});

test('a poll with nothing new costs one conditional request and zero downloads', async () => {
  await sync('vendee-10k');
  gh.reset();

  const { changed, cache } = await sync('vendee-10k');

  assert.equal(changed, false, 'a 304 must report no change');
  assert.equal(Object.keys(cache).length, 3, 'cached points survive the 304');
  assert.deepEqual(gh.counts(), { api: 1, raw: 0 });
});

test('a new point upstream downloads exactly that one file', async () => {
  await sync('vendee-10k');
  gh.reset();

  gh.files.set(`${RUN}/2026-07-28T12_06_01+02_00.json`, { lat: 46.5736, lon: -0.7720, btry: 49 });
  const { cache } = await sync('vendee-10k');

  assert.equal(Object.keys(cache).length, 4);
  assert.deepEqual(gh.counts(), { api: 1, raw: 1 });
});

test('an edited file is refetched because its sha changed', async () => {
  await sync('vendee-10k');
  gh.reset();

  gh.files.set(`${RUN}/2026-07-28T11_23_25+02_00.json`, { lat: 1, lon: 2, btry: 100 });
  const { cache } = await sync('vendee-10k');

  assert.deepEqual(gh.counts(), { api: 1, raw: 1 });
  assert.equal(cache['2026-07-28T11_23_25+02_00.json'].lat, 1);
});

test('deleting a file upstream drops it from the cache', async () => {
  await sync('vendee-10k');
  gh.files.delete(`${RUN}/2026-07-28T11_09_28+02_00.json`);

  const { cache } = await sync('vendee-10k');

  assert.equal(Object.keys(cache).length, 2);
  assert.ok(!('2026-07-28T11_09_28+02_00.json' in cache));
});

// --- runs --------------------------------------------------------------------

test('a run only sees its own folder', async () => {
  gh.files.set('locations/other-race/2026-07-29T09_00_00+02_00.json', { lat: 1, lon: 2 });

  const { cache } = await sync('vendee-10k');

  assert.equal(Object.keys(cache).length, 3);
  assert.equal(Object.keys(await sync('other-race').then(r => r.cache)).length, 1);
});

test('each run caches separately, so switching back costs no downloads', async () => {
  gh.files.set('locations/other-race/2026-07-29T09_00_00+02_00.json', { lat: 1, lon: 2 });

  await sync('vendee-10k');
  await sync('other-race');
  gh.reset();

  const { cache } = await sync('vendee-10k');

  assert.equal(Object.keys(cache).length, 3, 'the other run did not evict this one');
  assert.deepEqual(gh.counts(), { api: 1, raw: 0 });
});

test('the root feed shows only loose files, not files inside runs', async () => {
  gh.files.set('locations/2026-07-29T10_00_00+02_00.json', { lat: 9, lon: 9 });

  const { cache, dirs } = await sync(null);

  assert.deepEqual(Object.keys(cache), ['2026-07-29T10_00_00+02_00.json']);
  assert.deepEqual(dirs, ['vendee-10k'], 'polling the root discovers runs for free');
});

test('polling a run reports no dirs, since it never listed the root', async () => {
  const { dirs } = await sync('vendee-10k');
  assert.equal(dirs, null);
});

test('listRuns returns the subfolders and is free on the second call', async () => {
  assert.deepEqual(await listRuns(), ['vendee-10k']);
  gh.reset();

  assert.deepEqual(await listRuns(), ['vendee-10k'], 'served from cache behind a 304');
  assert.deepEqual(gh.counts(), { api: 1, raw: 0 });
});

test('a run folder that does not exist yet is empty, not an error', async () => {
  const { changed, cache } = await sync('not-yet-run');

  assert.equal(changed, true);
  assert.deepEqual(cache, {});
});

// --- parsing -----------------------------------------------------------------

test('optional fields are carried through and absent ones stay absent', async () => {
  const { cache } = await sync('vendee-10k');

  const withMsg = cache['2026-07-28T11_09_28+02_00.json'];
  assert.equal(withMsg.btry, undefined, 'a null msg/img file has no battery');

  const withBtry = cache['2026-07-28T11_23_25+02_00.json'];
  assert.equal(withBtry.btry, 53);
  assert.equal(withBtry.msg, undefined);
});

test('timestamps come from the filename, since the body has none', async () => {
  const { cache } = await sync('vendee-10k');
  assert.equal(
    cache['2026-07-28T11_36_00+02_00.json'].t,
    Date.parse('2026-07-28T11:36:00+02:00')
  );
});

test('a file with unusable coordinates is skipped, not fatal', async () => {
  gh.files.set(`${RUN}/2026-07-28T13_00_00+02_00.json`, { lat: 'nope', lon: null });

  const { cache } = await sync('vendee-10k');

  assert.equal(Object.keys(cache).length, 3);
  assert.ok(!('2026-07-28T13_00_00+02_00.json' in cache));
});

test('one failing download does not sink the whole poll', async () => {
  const real = gh.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('11_23_25')) throw new Error('network');
    return real(url, opts);
  };

  const { cache } = await sync('vendee-10k');

  assert.equal(Object.keys(cache).length, 2, 'the other two still land');
});

test('non-json entries in the listing are ignored', async () => {
  gh.files.set(`${RUN}/README.md`, 'not json');

  const { cache } = await sync('vendee-10k');
  assert.equal(Object.keys(cache).length, 3);
});

// --- failure modes -----------------------------------------------------------

test('a rate limit surfaces as RateLimitError carrying the reset time', async () => {
  gh.rateLimited = true;
  gh.resetAt = Date.parse('2026-07-28T13:00:00Z');

  const err = await sync('vendee-10k').then(() => null, e => e);

  assert.ok(err instanceof RateLimitError);
  assert.equal(err.retryAt, gh.resetAt);
});

test('a plain API error propagates', async () => {
  globalThis.fetch = async () => new Response('', { status: 500 });
  await assert.rejects(sync('vendee-10k'), /500/);
});

test('the ETag is not stored when the points could not be', async () => {
  // Simulate a full quota: writes fail silently, as localStorage does.
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };

  await sync('vendee-10k');

  // Storing only the ETag would make the next load answer 304 with an empty
  // cache — a blank map that never recovers.
  const keys = keysFor('vendee-10k');
  assert.equal(globalThis.localStorage.getItem(keys.etag), null);
  assert.equal(globalThis.localStorage.getItem(keys.points), null);
});

test('with storage unavailable, every poll still returns the full set', async () => {
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };

  await sync('vendee-10k');
  const { cache } = await sync('vendee-10k');

  assert.equal(Object.keys(cache).length, 3);
});
