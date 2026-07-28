import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { buildCourse, nearestOnCourse } from '../src/course.js';
import { applySnaps, snapAll, snapOne } from '../src/snap.js';

const LAT0 = 46.5;
const M_LAT = 110540;
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

const toLatLon = ([e, n]) => ({ lat: LAT0 + n / M_LAT, lon: e / M_LON, ele: 0 });

function courseFrom(offsets, sha = 'course-1') {
  return buildCourse(
    { segments: [offsets.map(toLatLon)], waypoints: [], hasElevation: true }, sha);
}

/** Pings in the same metre frame, one minute apart, in the order given. */
function pings(offsets) {
  return offsets.map(([e, n], i) => ({
    name: `p${i}.json`,
    t: Date.parse('2026-07-28T12:00:00Z') + i * 60000,
    ...toLatLon([e, n])
  }));
}

const STRAIGHT = courseFrom([[0, 0], [1000, 0], [2000, 0]]);

// A 4 km square loop whose finish lands back on its start — the case the whole
// cost function exists for.
const LOOP = courseFrom([[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]], 'loop');

test('a ping beside the course snaps onto it', () => {
  const [p] = pings([[600, 100]]);
  const snap = snapOne(STRAIGHT, p, 0);

  assert.ok(Math.abs(snap.along - 600) < 1, `along ${snap.along}`);
  assert.ok(Math.abs(snap.off - 100) < 1, `off ${snap.off}`);
});

test('a ping too far from the course is left where it is', () => {
  const [p] = pings([[600, CONFIG.snapMeters + 100]]);
  assert.equal(snapOne(STRAIGHT, p, 0), null);
});

// --- the circular course ----------------------------------------------------

test('on a loop, the FIRST ping at the start/finish snaps to the start', () => {
  // The requirement, stated directly. Geometrically this fix is equidistant
  // from `along = 0` and `along = length`; only its place in the sequence says
  // which is meant.
  const { cache } = snapAll(LOOP, pings([[0, 20]]), null);
  const snap = cache.byName['p0.json'];

  assert.ok(snap.along < 100, `snapped to ${snap.along} of ${LOOP.length}`);
});

test('on a loop, the SAME coordinate arriving last snaps to the finish', () => {
  // Identical geometry, opposite answer — which is only possible because the
  // history is what decides it.
  const lap = pings([[0, 20], [1000, 20], [1000, 980], [20, 980], [0, 20]]);
  const { cache } = snapAll(LOOP, lap, null);

  assert.ok(cache.byName['p0.json'].along < 100, 'first should be at the start');
  assert.ok(cache.byName['p4.json'].along > LOOP.length - 100,
    `last snapped to ${cache.byName['p4.json'].along} of ${LOOP.length}`);
});

test('progress around a loop is monotone the whole way round', () => {
  const lap = pings([[0, 10], [500, 10], [1000, 200], [1000, 800],
                     [500, 990], [10, 990], [10, 400], [0, 10]]);
  const { cache } = snapAll(LOOP, lap, null);

  const alongs = lap.map(p => cache.byName[p.name].along);
  for (let i = 1; i < alongs.length; i++) {
    assert.ok(alongs[i] >= alongs[i - 1] - 1e-9,
      `went backwards at ${i}: ${alongs[i - 1]} -> ${alongs[i]}`);
  }
});

test('a second lap wraps back round the course rather than running off the end', () => {
  // `along` is a position ON THE COURSE, not a race odometer. A ping on the
  // second lap is physically at the same place as its first-lap counterpart, and
  // that place is the only candidate within range, so it snaps there — going
  // "backwards". That is the honest answer: the profile plots position, and laps
  // are not something this models.
  const two = pings([[0, 10], [1000, 10], [10, 990], [0, 10], [1000, 10]]);
  const { cache } = snapAll(LOOP, two, null);

  // The lap boundary resolves to the finish, because that's where progress was…
  assert.ok(cache.byName['p3.json'].along > LOOP.length - 100);
  // …and the next ping has nowhere to go but back onto the first leg.
  assert.ok(Math.abs(cache.byName['p4.json'].along - 1000) < 50,
    `along ${cache.byName['p4.json'].along}`);
});

// --- the cache: every ping projected exactly once ----------------------------

/** Wraps the projection so the tests can count how much work actually happened. */
function counting() {
  const fn = (...args) => { fn.calls++; return nearestOnCourse(...args); };
  fn.calls = 0;
  return fn;
}

test('a warm cache does no work at all', () => {
  const points = pings([[100, 20], [600, 30], [1400, 10]]);
  const first = snapAll(STRAIGHT, points, null);
  assert.equal(first.snapped, 3);

  const nearest = counting();
  const again = snapAll(STRAIGHT, points, first.cache, nearest);

  assert.equal(nearest.calls, 0, 'a repaint must not reproject anything');
  assert.equal(again.snapped, 0);
});

test('one new ping costs exactly one projection', () => {
  const points = pings([[100, 20], [600, 30], [1400, 10]]);
  const warm = snapAll(STRAIGHT, points, null).cache;

  const grown = [...points, { name: 'p3.json', t: points[2].t + 60000, ...toLatLon([1800, 20]) }];
  const nearest = counting();
  const { snapped } = snapAll(STRAIGHT, grown, warm, nearest);

  assert.equal(nearest.calls, 1);
  assert.equal(snapped, 1);
});

test('growing a run one ping at a time gives the same answer as doing it all at once', () => {
  // The incremental path is the one that runs in production; this is what says
  // it is not a cheaper approximation of the real thing.
  const points = pings([[0, 10], [400, 20], [1000, 200], [1000, 900], [200, 990], [0, 10]]);

  let cache = null;
  for (let i = 1; i <= points.length; i++) {
    cache = snapAll(LOOP, points.slice(0, i), cache).cache;
  }
  const cold = snapAll(LOOP, points, null).cache;

  assert.deepEqual(cache.byName, cold.byName);
});

test('an unsnappable ping does not disturb the pings around it', () => {
  // Losing signal in a tunnel must not send the runner back to the start line.
  const withGap = pings([[100, 20], [600, CONFIG.snapMeters + 400], [1400, 10]]);
  const { cache } = snapAll(STRAIGHT, withGap, null);

  assert.equal(cache.byName['p1.json'], null);
  assert.ok(Math.abs(cache.byName['p2.json'].along - 1400) < 2);
  assert.ok(Math.abs(cache.last.along - 1400) < 2, 'progress should be the last GOOD fix');
});

// --- when the cache must be thrown away -------------------------------------

test('a different course file invalidates everything', () => {
  const points = pings([[100, 20], [600, 30]]);
  const warm = snapAll(STRAIGHT, points, null).cache;

  const other = courseFrom([[0, 0], [2000, 0]], 'course-2');
  const nearest = counting();
  snapAll(other, points, warm, nearest);

  assert.equal(nearest.calls, 2, 'stored distances mean nothing against a new course');
});

test('a changed threshold invalidates everything', () => {
  const points = pings([[100, 20], [600, 30]]);
  const warm = snapAll(STRAIGHT, points, null).cache;

  const original = CONFIG.snapMeters;
  CONFIG.snapMeters = 250;
  try {
    const nearest = counting();
    snapAll(STRAIGHT, points, warm, nearest);
    assert.equal(nearest.calls, 2);
  } finally {
    CONFIG.snapMeters = original;
  }
});

test('a backfilled older ping forces the sequence to run again', () => {
  // Snapping is sequential, so a ping inserted into the middle of history was
  // never scored against the pings before it. Only a rerun can fix that.
  const points = pings([[100, 20], [600, 30], [1400, 10]]);
  const warm = snapAll(STRAIGHT, points, null).cache;

  const backfilled = [
    { name: 'old.json', t: points[0].t - 60000, ...toLatLon([50, 20]) },
    ...points
  ];
  const nearest = counting();
  const { snapped } = snapAll(STRAIGHT, backfilled, warm, nearest);

  assert.equal(nearest.calls, 4);
  assert.equal(snapped, 4);
});

test('a corrupt or missing cache is treated as empty, not trusted', () => {
  const points = pings([[100, 20]]);
  for (const bad of [null, undefined, {}, { courseSha: 'course-1' }, 'nonsense']) {
    const { cache } = snapAll(STRAIGHT, points, bad);
    assert.ok(cache.byName['p0.json'], JSON.stringify(bad));
  }
});

test('a deleted ping loses its cache entry', () => {
  const points = pings([[100, 20], [600, 30]]);
  const warm = snapAll(STRAIGHT, points, null).cache;

  const { cache } = snapAll(STRAIGHT, [points[0]], warm);
  assert.deepEqual(Object.keys(cache.byName), ['p0.json']);
});

test('the cache survives a round trip through JSON', () => {
  // It lives in localStorage, so anything that does not serialise is a bug that
  // would only show up on the second page load.
  const points = pings([[100, 20], [600, 30]]);
  const warm = snapAll(STRAIGHT, points, null).cache;
  const revived = JSON.parse(JSON.stringify(warm));

  const nearest = counting();
  snapAll(STRAIGHT, points, revived, nearest);
  assert.equal(nearest.calls, 0);
});

// --- applying the result ----------------------------------------------------

test('applySnaps hangs each snap on its point and removes stale ones', () => {
  const points = pings([[100, 20], [600, CONFIG.snapMeters + 400]]);
  const { cache } = snapAll(STRAIGHT, points, null);

  applySnaps(points, cache);
  assert.ok(points[0].snap);
  assert.equal(points[1].snap, undefined, 'an unsnapped ping keeps its real position');

  applySnaps(points, { byName: {} });
  assert.equal(points[0].snap, undefined);
});
