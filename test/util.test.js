import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ago, escapeHtml, parseTime, persistedAt, pool, throttle } from '../src/util.js';

test('parseTime recovers the ISO timestamp from a filename', () => {
  // Underscores stand in for colons — in the time AND in the UTC offset.
  assert.equal(
    parseTime('2026-07-28T12_06_01+02_00.json'),
    Date.parse('2026-07-28T12:06:01+02:00')
  );
});

test('parseTime works with or without the .json extension', () => {
  assert.equal(
    parseTime('2026-07-28T12_06_01+02_00'),
    parseTime('2026-07-28T12_06_01+02_00.json')
  );
});

test('parseTime honours the offset rather than assuming UTC', () => {
  const plus2 = parseTime('2026-07-28T12_00_00+02_00.json');
  const utc   = parseTime('2026-07-28T12_00_00+00_00.json');
  assert.equal(utc - plus2, 2 * 3600 * 1000);
});

test('parseTime returns NaN for a name it cannot read', () => {
  assert.ok(Number.isNaN(parseTime('README.json')));
});

test('ago formats each magnitude', () => {
  const now = Date.parse('2026-07-28T12:00:00Z');
  assert.equal(ago(now - 30 * 1000, now), '30s ago');
  assert.equal(ago(now - 5 * 60000, now), '5m ago');
  assert.equal(ago(now - 3 * 3600000, now), '3h ago');
  assert.equal(ago(now - 2 * 86400000, now), '2d ago');
});

test('ago never reports a negative age for a clock-skewed future point', () => {
  const now = Date.parse('2026-07-28T12:00:00Z');
  assert.equal(ago(now + 60000, now), '0s ago');
});

test('pool visits every item and respects the concurrency limit', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let inFlight = 0;
  let peak = 0;

  const results = await pool(items, 4, async i => {
    peak = Math.max(peak, ++inFlight);
    await new Promise(r => setTimeout(r, 1));
    inFlight--;
    return i * 2;
  });

  assert.equal(results.length, 20);
  assert.deepEqual(results.sort((a, b) => a - b), items.map(i => i * 2));
  assert.ok(peak <= 4, `peak concurrency was ${peak}`);
});

test('pool handles an empty list without hanging', async () => {
  assert.deepEqual(await pool([], 8, async () => 1), []);
});

test('escapeHtml neutralises markup from user-supplied messages', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
  );
});

// --- throttle ----------------------------------------------------------------
// This is what stands between a tab-flipping viewer and a spent hourly budget,
// so the limit itself is worth pinning down rather than trusting by inspection.

/** A clock we control, so none of this needs real timers. */
function fakeClock() {
  let t = 1000;
  const now = () => t;
  now.advance = ms => { t += ms; };
  return now;
}

test('throttle runs the first call immediately', async () => {
  let calls = 0;
  const f = throttle(() => calls++, 30000, { now: fakeClock() });

  await f();
  assert.equal(calls, 1);
});

test('throttle drops calls inside the window and allows one after it', async () => {
  let calls = 0;
  const now = fakeClock();
  const f = throttle(() => calls++, 30000, { now });

  await f();
  for (let i = 0; i < 50; i++) { now.advance(500); await f(); }   // 25s of flipping

  assert.equal(calls, 1, 'a burst inside the window costs exactly one request');

  now.advance(30000);
  await f();
  assert.equal(calls, 2);
});

test('throttle bounds the request rate no matter how often it is called', async () => {
  // The actual guarantee: 30s spacing over an hour can't exceed 120 requests,
  // and at the real 240s poll rate it stays far under GitHub's 60/hour.
  let calls = 0;
  const now = fakeClock();
  const f = throttle(() => calls++, 30000, { now });

  for (let i = 0; i < 3600; i++) { await f(); now.advance(1000); }   // one call/s for an hour

  assert.equal(calls, 120);
});

test('throttle coalesces overlapping calls into the in-flight one', async () => {
  // Two events landing together must not open two concurrent listings.
  let started = 0;
  let release;
  const f = throttle(() => { started++; return new Promise(r => { release = r; }); },
    30000, { now: fakeClock() });

  const a = f();
  const b = f();
  assert.equal(started, 1);
  assert.equal(a, b, 'the second caller gets the first call\'s promise');

  release();
  await Promise.all([a, b]);
});

test('throttle recovers after the wrapped function throws', async () => {
  // A failed poll must not wedge the in-flight guard shut forever.
  let calls = 0;
  const now = fakeClock();
  const f = throttle(() => { calls++; return Promise.reject(new Error('network')); },
    30000, { now });

  await f().catch(() => {});
  now.advance(30000);
  await f().catch(() => {});

  assert.equal(calls, 2);
});

// --- the throttle surviving a reload -----------------------------------------
// A reload destroys all JS state, so an in-memory interval resets and mashing
// the refresh button spends a request every time. These pin down the fix.

/** Each call builds a *new* throttle over the same storage — i.e. a page load. */
function reloadable(fn, now, key = 'lt.refresh.test') {
  return () => throttle(fn, 30000, { now, store: persistedAt(key) });
}

test('persistedAt keeps the interval across a reload', async () => {
  globalThis.localStorage = fakeStorage();
  let calls = 0;
  const now = fakeClock();
  const load = reloadable(() => calls++, now);

  await load()();                                   // first visit
  for (let i = 0; i < 10; i++) { now.advance(1000); await load()(); }   // 10 reloads

  assert.equal(calls, 1, 'reloads inside the window cost nothing');

  now.advance(30000);
  await load()();
  assert.equal(calls, 2, 'and one is allowed once the window passes');
});

test('persistedAt keys are independent of one another', () => {
  globalThis.localStorage = fakeStorage();
  const now = fakeClock();
  let a = 0, b = 0;

  reloadable(() => a++, now, 'lt.refresh.one')()();
  reloadable(() => b++, now, 'lt.refresh.two')()();

  // Same instant: a shared key would have blocked the second one.
  assert.equal(a, 1);
  assert.equal(b, 1);
});

test('with storage unavailable the throttle refreshes rather than blocking', async () => {
  globalThis.localStorage = { getItem: () => { throw new Error('disabled'); },
                              setItem: () => { throw new Error('disabled'); },
                              removeItem: () => {} };
  let calls = 0;
  const now = fakeClock();
  const load = reloadable(() => calls++, now);

  await load()();
  await load()();

  // Degrading to "always refresh" is the safe direction: a stuck-blank map would
  // be worse than an extra request, and private-mode browsers land here.
  assert.equal(calls, 2);
});

function fakeStorage() {
  const map = new Map();
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    removeItem: k => map.delete(k)
  };
}
