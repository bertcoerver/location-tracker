import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ago, coarse, escapeHtml, fmtCountdown, fmtDuration, fmtElapsed, mapsUrl, parseStamp, parseTime,
  persistedAt, pool, throttle
} from '../src/util.js';

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

// --- a start time out of a course filename -------------------------------------

test('parseStamp reads the scheduled start off a course filename', () => {
  assert.equal(
    parseStamp('UTMB_2026-08-28T09_00_00+02_00.gpx'),
    Date.parse('2026-08-28T09:00:00+02:00')
  );
});

test('parseTime cannot read a course filename — which is why parseStamp exists', () => {
  // The label in front of the stamp is what breaks it: `parseTime` replaces every
  // underscore with a colon, so `UTMB_2026…` becomes `UTMB:2026…`. Pinned here so
  // that nobody "simplifies" the two functions into one.
  assert.ok(Number.isNaN(parseTime('UTMB_2026-08-28T09_00_00+02_00.gpx')));
});

test('parseStamp honours the offset rather than assuming UTC', () => {
  const plus2 = parseStamp('race_2026-08-28T09_00_00+02_00.gpx');
  const utc   = parseStamp('race_2026-08-28T09_00_00+00_00.gpx');
  assert.equal(utc - plus2, 2 * 3600 * 1000);
});

test('parseStamp accepts Z, a colon offset, and no offset at all', () => {
  assert.equal(parseStamp('r_2026-08-28T09_00_00Z.gpx'), Date.parse('2026-08-28T09:00:00Z'));
  assert.equal(parseStamp('r_2026-08-28T09:00:00Z.gpx'), Date.parse('2026-08-28T09:00:00Z'));
  // No zone means the viewer's own, which is what `Date.parse` does with a bare
  // date-time and the least surprising reading of a name that declined to say.
  assert.equal(parseStamp('r_2026-08-28T09_00_00.gpx'), Date.parse('2026-08-28T09:00:00'));
});

test('parseStamp does not need the seconds', () => {
  // Nobody writes `:00` for a race that starts on the hour.
  assert.equal(parseStamp('r_2026-08-28T09_00.gpx'), Date.parse('2026-08-28T09:00:00'));
});

test('parseStamp returns null rather than guessing at a gun time', () => {
  for (const name of [
    'course.gpx',                    // the ordinary case: no schedule at all
    'utmb-2026.gpx',                 // a year is not a start
    'r_2026-08-28.gpx',              // a date with no time would have to mean midnight
    'r_2026-08-28T09.gpx',           // an hour with no minute, likewise
    '',
    null,
    undefined
  ]) {
    assert.equal(parseStamp(name), null, JSON.stringify(name));
  }
});

test('parseStamp normalises an offset written without a separator', () => {
  // `+0200` is unambiguous to a reader, but only `±HH:MM` is specified and engines
  // differ on the rest — so it is normalised here rather than left to `Date.parse`,
  // where the failure mode is a gun time silently two hours out.
  assert.equal(
    parseStamp('r_2026-08-28T09_00_00+0200.gpx'),
    Date.parse('2026-08-28T09:00:00+02:00')
  );
  assert.equal(
    parseStamp('r_2026-08-28T09_00_00-0530.gpx'),
    Date.parse('2026-08-28T09:00:00-05:30')
  );
});

// --- counting down to it -------------------------------------------------------

test('fmtCountdown is the elapsed clock inside the last day', () => {
  // So the countdown and the clock it becomes at the gun are typeset identically
  // and the digits do not jump when it flips.
  for (const ms of [0, 1000, 4 * 3600000 + 31 * 60000 + 7000, 86399 * 1000]) {
    assert.equal(fmtCountdown(ms), fmtElapsed(ms));
  }
});

test('fmtCountdown switches to days beyond one, so a month is readable', () => {
  // `fmtElapsed` would render four weeks out as "700:18:42", which reads as a run
  // that has been going for 700 hours rather than as a date.
  assert.equal(fmtCountdown(29 * 86400000 + 4 * 3600000), '29d 4h');
  assert.equal(fmtCountdown(86400000), '1d');
  assert.equal(fmtCountdown(2 * 86400000 + 59 * 60000), '2d');
});

test('fmtCountdown truncates hours, so it never overstates the time left', () => {
  // 3d 23h 59m is still 3d 23h. Rounding would read "3d 24h", which is not a thing.
  assert.equal(fmtCountdown(3 * 86400000 + 23 * 3600000 + 59 * 60000), '3d 23h');
});

test('a countdown that has run out reads zero rather than going negative', () => {
  assert.equal(fmtCountdown(-5000), '0:00:00');
});

// --- one rounding rule, used in both directions -------------------------------

test('coarse picks one unit at each magnitude', () => {
  assert.equal(coarse(30 * 1000), '30s');
  assert.equal(coarse(5 * 60000), '5m');
  assert.equal(coarse(3 * 3600000), '3h');
  assert.equal(coarse(2 * 86400000), '2d');
});

test('coarse switches unit exactly at the boundary', () => {
  assert.equal(coarse(59 * 1000), '59s');
  assert.equal(coarse(60 * 1000), '1m');
  assert.equal(coarse(3599 * 1000), '60m');   // rounds up in minutes, not to "1h"
  assert.equal(coarse(3600 * 1000), '1h');
  assert.equal(coarse(86400 * 1000), '1d');
});

test('coarse clamps a negative span to zero', () => {
  // A countdown that has run out. The caller is expected to say something more
  // useful than "0s" — the ticker says "overdue" — but it must not read "-3m".
  assert.equal(coarse(-3 * 60000), '0s');
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

// --- exact spans, as opposed to `ago`'s "roughly how stale" ------------------

test('fmtDuration keeps the seconds that ago() throws away', () => {
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(12000), '12s');
  assert.equal(fmtDuration(252000), '4m 12s');
  assert.equal(fmtDuration(300000), '5m');
});

test('fmtDuration drops to two units once it passes an hour', () => {
  assert.equal(fmtDuration(3600000), '1h');
  assert.equal(fmtDuration(4980000), '1h 23m');
  assert.equal(fmtDuration(8130000), '2h 16m');
});

test('fmtDuration never reports sixty minutes past the hour', () => {
  // 1h 59m 40s rounds the minutes to 60, which must carry rather than print.
  assert.equal(fmtDuration(7180000), '2h');
});

test('fmtDuration treats a negative span as zero', () => {
  assert.equal(fmtDuration(-5000), '0s');
});

test('fmtElapsed is always h:mm:ss, so the digits do not shuffle as it ticks', () => {
  assert.equal(fmtElapsed(0), '0:00:00');
  assert.equal(fmtElapsed(9000), '0:00:09');
  assert.equal(fmtElapsed(252000), '0:04:12');
  assert.equal(fmtElapsed(8047000), '2:14:07');
});

test('fmtElapsed truncates rather than rounding, so the clock never runs fast', () => {
  assert.equal(fmtElapsed(1999), '0:00:01');
  assert.equal(fmtElapsed(-1), '0:00:00');
});

test('fmtElapsed keeps counting past a day rather than wrapping', () => {
  assert.equal(fmtElapsed(90000000), '25:00:00');
});

test('mapsUrl keeps six decimals, negatives included', () => {
  // Six decimals is about 10 cm — well past what a phone's GPS knows, and the
  // southern and western hemispheres exist.
  assert.equal(
    mapsUrl(46.5, 8.1),
    'https://www.google.com/maps/search/?api=1&query=46.500000,8.100000'
  );
  assert.ok(mapsUrl(-33.856784, -0.759611).endsWith('query=-33.856784,-0.759611'));
});

test('mapsUrl uses the documented search form, not a scraped /maps/@ URL', () => {
  // The @lat,lon,zoom shape out of the address bar is not a supported API and
  // has changed before; `search/?api=1` is the one Google commits to, and it is
  // what an unlabelled link stays on.
  assert.match(mapsUrl(46.5, 8.1), /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.match(mapsUrl(46.5, 8.1, '   '), /\?api=1&query=/, 'a blank label is no label');
});

test('a labelled mapsUrl names the pin, at the cost of the older URL form', () => {
  // `api=1` takes EITHER a coordinate or a place name: pass a name and the pin
  // moves to whatever Google matched, which is worse than a blank card. The
  // `?q=lat,lon(Label)` form is the only one that does both, so a label buys a
  // URL scheme Google no longer documents.
  assert.equal(
    mapsUrl(46.5, 8.1, 'Feed station'),
    'https://maps.google.com/?q=46.500000,8.100000(Feed%20station)'
  );
});

test('mapsUrl keeps a label from breaking out of its own delimiters', () => {
  // The parentheses ARE the delimiters, so one inside the label would end it
  // early and leave the rest as junk query text.
  assert.equal(
    mapsUrl(46.5, 8.1, 'Col (north side)'),
    'https://maps.google.com/?q=46.500000,8.100000(Col%20north%20side)'
  );
  // And everything else is percent-encoded rather than trusted — waypoint names
  // come out of a GPX file somebody else wrote.
  assert.ok(mapsUrl(46.5, 8.1, 'a&b="c"').endsWith('(a%26b%3D%22c%22)'));
});
