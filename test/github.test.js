// Regression tests for the whole point of this app: never refetch what we
// already have. These run against a fake GitHub, so they're offline and fast.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { LS_ETAG, LS_POINTS } from '../src/config.js';
import { RateLimitError, sync } from '../src/github.js';

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

/** A stand-in for the repo. `files` is name -> body object. */
function fakeGitHub(files) {
  const state = { files: new Map(Object.entries(files)), calls: [] };

  const listing = () =>
    [...state.files].map(([name, body]) => ({
      name,
      type: 'file',
      sha: `sha-${name}-${JSON.stringify(body).length}`,
      download_url: `https://raw.githubusercontent.com/x/y/main/locations/${name}`
    }));

  // The ETag changes whenever the listing does — same as GitHub.
  const etagOf = () => `"${JSON.stringify(listing().map(e => e.sha))}"`;

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
      const etag = etagOf();
      if (opts.headers?.['If-None-Match'] === etag) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(listing()), { status: 200, headers: { etag } });
    }

    const name = decodeURIComponent(String(url).split('/').pop());
    if (!state.files.has(name)) return new Response('', { status: 404 });
    return new Response(JSON.stringify(state.files.get(name)), { status: 200 });
  };

  state.reset = () => { state.calls.length = 0; };
  state.counts = () => ({
    api: state.calls.filter(c => c.kind === 'API').length,
    raw: state.calls.filter(c => c.kind === 'RAW').length
  });
  return state;
}

const FILES = {
  '2026-07-28T11_09_28+02_00.json': { lat: 46.5735, lon: -0.7721, msg: null, img: null },
  '2026-07-28T11_23_25+02_00.json': { lat: 46.5735, lon: -0.7722, btry: 53 },
  '2026-07-28T11_36_00+02_00.json': { lat: 46.5735, lon: -0.7721, btry: 51 }
};

let gh;

beforeEach(() => {
  globalThis.localStorage = fakeLocalStorage();
  gh = fakeGitHub({ ...FILES });
  globalThis.fetch = (...args) => gh.fetch(...args);
});

// --- the caching contract ----------------------------------------------------

test('cold start fetches the listing and every file once', async () => {
  const { changed, cache } = await sync();

  assert.equal(changed, true);
  assert.equal(Object.keys(cache).length, 3);
  assert.deepEqual(gh.counts(), { api: 1, raw: 3 });
});

test('a poll with nothing new costs one conditional request and zero downloads', async () => {
  await sync();
  gh.reset();

  const { changed, cache } = await sync();

  assert.equal(changed, false, 'a 304 must report no change');
  assert.equal(Object.keys(cache).length, 3, 'cached points survive the 304');
  assert.deepEqual(gh.counts(), { api: 1, raw: 0 });
});

test('a new point upstream downloads exactly that one file', async () => {
  await sync();
  gh.reset();

  gh.files.set('2026-07-28T12_06_01+02_00.json', { lat: 46.5736, lon: -0.7720, btry: 49 });
  const { cache } = await sync();

  assert.equal(Object.keys(cache).length, 4);
  assert.deepEqual(gh.counts(), { api: 1, raw: 1 });
});

test('an edited file is refetched because its sha changed', async () => {
  await sync();
  gh.reset();

  gh.files.set('2026-07-28T11_23_25+02_00.json', { lat: 1, lon: 2, btry: 100 });
  const { cache } = await sync();

  assert.deepEqual(gh.counts(), { api: 1, raw: 1 });
  assert.equal(cache['2026-07-28T11_23_25+02_00.json'].lat, 1);
});

test('deleting a file upstream drops it from the cache', async () => {
  await sync();
  gh.files.delete('2026-07-28T11_09_28+02_00.json');

  const { cache } = await sync();

  assert.equal(Object.keys(cache).length, 2);
  assert.ok(!('2026-07-28T11_09_28+02_00.json' in cache));
});

// --- parsing -----------------------------------------------------------------

test('optional fields are carried through and absent ones stay absent', async () => {
  const { cache } = await sync();

  const withMsg = cache['2026-07-28T11_09_28+02_00.json'];
  assert.equal(withMsg.btry, undefined, 'a null msg/img file has no battery');

  const withBtry = cache['2026-07-28T11_23_25+02_00.json'];
  assert.equal(withBtry.btry, 53);
  assert.equal(withBtry.msg, undefined);
});

test('timestamps come from the filename, since the body has none', async () => {
  const { cache } = await sync();
  assert.equal(
    cache['2026-07-28T11_36_00+02_00.json'].t,
    Date.parse('2026-07-28T11:36:00+02:00')
  );
});

test('a file with unusable coordinates is skipped, not fatal', async () => {
  gh.files.set('2026-07-28T13_00_00+02_00.json', { lat: 'nope', lon: null });

  const { cache } = await sync();

  assert.equal(Object.keys(cache).length, 3);
  assert.ok(!('2026-07-28T13_00_00+02_00.json' in cache));
});

test('one failing download does not sink the whole poll', async () => {
  const real = gh.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('11_23_25')) throw new Error('network');
    return real(url, opts);
  };

  const { cache } = await sync();

  assert.equal(Object.keys(cache).length, 2, 'the other two still land');
});

test('non-json entries and directories in the listing are ignored', async () => {
  const real = gh.fetch;
  globalThis.fetch = async (url, opts) => {
    const res = await real(url, opts);
    if (!String(url).includes('api.github.com') || res.status !== 200) return res;
    const entries = await res.json();
    entries.push({ name: 'README.md', type: 'file', sha: 'x', download_url: 'u' });
    entries.push({ name: 'archive', type: 'dir', sha: 'y', download_url: 'u' });
    return new Response(JSON.stringify(entries), {
      status: 200, headers: { etag: res.headers.get('etag') }
    });
  };

  const { cache } = await sync();
  assert.equal(Object.keys(cache).length, 3);
});

// --- failure modes -----------------------------------------------------------

test('a rate limit surfaces as RateLimitError carrying the reset time', async () => {
  gh.rateLimited = true;
  gh.resetAt = Date.parse('2026-07-28T13:00:00Z');

  const err = await sync().then(() => null, e => e);

  assert.ok(err instanceof RateLimitError);
  assert.equal(err.retryAt, gh.resetAt);
});

test('a plain API error propagates', async () => {
  globalThis.fetch = async () => new Response('', { status: 500 });
  await assert.rejects(sync(), /500/);
});

test('the ETag is not stored when the points could not be', async () => {
  // Simulate a full quota: writes fail silently, as localStorage does.
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };

  await sync();

  // Storing only the ETag would make the next load answer 304 with an empty
  // cache — a blank map that never recovers.
  assert.equal(globalThis.localStorage.getItem(LS_ETAG), null);
  assert.equal(globalThis.localStorage.getItem(LS_POINTS), null);
});

test('with storage unavailable, every poll still returns the full set', async () => {
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };

  await sync();
  const { cache } = await sync();

  assert.equal(Object.keys(cache).length, 3);
});
