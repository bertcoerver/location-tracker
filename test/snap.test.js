import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { buildCourse } from '../src/course.js';
import { applySnaps, candidatesFor, snapAll } from '../src/snap.js';

const LAT0 = 46.5;
const M_LAT = 110540;
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

const toLatLon = ([e, n]) => ({ lat: LAT0 + n / M_LAT, lon: e / M_LON, ele: 0 });

function courseFrom(offsets, sha = 'course-1') {
  return buildCourse(
    { segments: [offsets.map(toLatLon)], waypoints: [], hasElevation: true }, sha);
}

/**
 * Pings in the same metre frame, in the order given.
 *
 * Five minutes apart, not one: the cost function now reasons about SPEED, so the
 * spacing is part of what is being tested rather than an arbitrary stamp. Five
 * minutes is what the phone actually does, and it makes the kilometre-scale steps
 * these fixtures take a plausible run rather than a 60 km/h one.
 */
function pings(offsets) {
  return offsets.map(([e, n], i) => ({
    name: `p${i}.json`,
    t: Date.parse('2026-07-28T12:00:00Z') + i * 300000,
    ...toLatLon([e, n])
  }));
}

/** The snaps for a whole run, by filename. */
const snapsOf = (course, points, opts) => snapAll(course, points, null, opts).cache.snaps;

/** One ping's snap, for the cases that are genuinely about a single fix. */
const snapOne = (course, point, opts) => snapsOf(course, [point], opts)[point.name];

const STRAIGHT = courseFrom([[0, 0], [1000, 0], [2000, 0]]);

// A 4 km square loop whose finish lands back on its start — the case the whole
// cost function exists for.
const LOOP = courseFrom([[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]], 'loop');

// Long enough that a fix can be wrong about where it is by more than the width of
// STRAIGHT, which is what the re-evaluation cases need room for.
const LONG = courseFrom([[0, 0], [3000, 0], [6000, 0]], 'long');

test('a ping beside the course snaps onto it', () => {
  const [p] = pings([[600, 100]]);
  const snap = snapOne(STRAIGHT, p);

  assert.ok(Math.abs(snap.along - 600) < 1, `along ${snap.along}`);
  assert.ok(Math.abs(snap.off - 100) < 1, `off ${snap.off}`);
});

test('a ping too far from the course is left where it is', () => {
  const [p] = pings([[600, CONFIG.snapMeters + 100]]);
  assert.equal(snapOne(STRAIGHT, p), null);
});

// --- the finish -------------------------------------------------------------

test('a finish is pinned to the end of the course, not to the nearest point', () => {
  // Half way along, but the phone says the course is done — so the end is where
  // it goes, and `along` reads the full course length rather than 1000 m.
  const [p] = pings([[1000, 50]]);
  const snap = snapOne(STRAIGHT, { ...p, is_finish: true });

  assert.equal(snap.along, STRAIGHT.length);
  // `off` is the distance to where it was PINNED — 1000 m up the course and 50
  // aside — not the 50 m perpendicular a normal snap would have reported. That
  // is the number the tooltip and the dashed link both need.
  assert.ok(Math.abs(snap.off - Math.hypot(1000, 50)) < 1, `off ${snap.off}`);
});

test('a finish is pinned even from beyond snapMeters, where a ping would not be', () => {
  // The threshold exists because a distant fix is EVIDENCE the phone is not on
  // the course. A finish is not evidence, it is an assertion, so it overrides —
  // and `off` is left telling the truth about how far away it was.
  const [p] = pings([[2000, CONFIG.snapMeters + 400]]);

  assert.equal(snapOne(STRAIGHT, p), null, 'the same fix without the flag');

  const snap = snapOne(STRAIGHT, { ...p, is_finish: true });
  assert.equal(snap.along, STRAIGHT.length);
  assert.ok(Math.abs(snap.off - (CONFIG.snapMeters + 400)) < 1, `off ${snap.off}`);
});

test('a distant finish is not talked out of it by the off-course state', () => {
  // The trap in making the finish an ordinary member of the trellis: its `off` is
  // its emission cost, so a finish taken far enough from the line would be dearer
  // than simply declaring the ping off-course, and the assertion would be quietly
  // overruled by arithmetic. It is withheld from that comparison on purpose.
  const [p] = pings([[2000, CONFIG.snapOffCourseCost + 500]]);
  const snap = snapOne(STRAIGHT, { ...p, is_finish: true });

  assert.equal(snap.along, STRAIGHT.length);
});

test('a finish takes its position and elevation from the last vertex', () => {
  const [p] = pings([[1500, 200]]);
  const snap = snapOne(STRAIGHT, { ...p, is_finish: true });
  const end = STRAIGHT.path[STRAIGHT.path.length - 1];

  assert.equal(snap.lon, end.lon);
  assert.equal(snap.lat, end.lat);
  assert.equal(snap.ele, end.ele);
});

test('on a loop, a finish at the start/finish resolves to the END', () => {
  // The payoff. Geometrically this fix is equidistant from `along = 0` and
  // `along = length`, and as the FIRST ping of the run the cost function would
  // rightly call it the start (see the tests below). The flag settles it outright.
  const [p] = pings([[0, 20]]);
  const snap = snapOne(LOOP, { ...p, is_finish: true });

  assert.equal(snap.along, LOOP.length);
  assert.ok(LOOP.closed, 'and this is genuinely the ambiguous case');
});

test('a finish goes through the cache like any other ping', () => {
  // Its candidate is stored by name alongside the rest, so a reload must not
  // reproject it or, worse, reproject it differently.
  const [a, b] = pings([[100, 20], [1900, 30]]);
  const points = [a, { ...b, is_finish: true }];

  const warm = snapAll(STRAIGHT, points, null).cache;
  assert.equal(warm.snaps['p1.json'].along, STRAIGHT.length);

  const candidates = counting();
  const again = snapAll(STRAIGHT, points, JSON.parse(JSON.stringify(warm)), { candidates });
  assert.equal(candidates.calls, 0);
  assert.deepEqual(again.cache.snaps['p1.json'], warm.snaps['p1.json']);
});

// --- the circular course ----------------------------------------------------

test('on a loop, the FIRST ping at the start/finish snaps to the start', () => {
  // The requirement, stated directly. Geometrically this fix is equidistant
  // from `along = 0` and `along = length`; only its place in the sequence says
  // which is meant.
  const snap = snapsOf(LOOP, pings([[0, 20]]))['p0.json'];

  assert.ok(snap.along < 100, `snapped to ${snap.along} of ${LOOP.length}`);
});

test('on a loop, the SAME coordinate arriving last snaps to the finish', () => {
  // Identical geometry, opposite answer — which is only possible because the rest
  // of the run is what decides it.
  const snaps = snapsOf(LOOP, pings([[0, 20], [1000, 20], [1000, 980], [20, 980], [0, 20]]));

  assert.ok(snaps['p0.json'].along < 100, 'first should be at the start');
  assert.ok(snaps['p4.json'].along > LOOP.length - 100,
    `last snapped to ${snaps['p4.json'].along} of ${LOOP.length}`);
});

test('progress around a loop is monotone the whole way round', () => {
  const lap = pings([[0, 10], [500, 10], [1000, 200], [1000, 800],
                     [500, 990], [10, 990], [10, 400], [0, 10]]);
  const snaps = snapsOf(LOOP, lap);

  const alongs = lap.map(p => snaps[p.name].along);
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
  const snaps = snapsOf(LOOP, pings([[0, 10], [1000, 10], [10, 990], [0, 10], [1000, 10]]));

  // The lap boundary resolves to the finish, because that's where progress was…
  assert.ok(snaps['p3.json'].along > LOOP.length - 100);
  // …and the next ping has nowhere to go but back onto the first leg.
  assert.ok(Math.abs(snaps['p4.json'].along - 1000) < 50, `along ${snaps['p4.json'].along}`);
});

// --- the reason this is a Viterbi pass and not a greedy one ------------------
//
// Every test here fails under a matcher that scores each ping against the
// previous one and never looks back. They are `test_run`, reduced.

test('a lone bad fix does not drag the pings after it off the course', () => {
  // The 09:05 case. One outlier between two good fixes must not become the thing
  // everything afterwards is measured from.
  const points = pings([[100, 10], [600, 10], [700, 240], [1200, 10], [1700, 10]]);
  const snaps = snapsOf(STRAIGHT, points);

  assert.ok(Math.abs(snaps['p3.json'].along - 1200) < 20, `p3 at ${snaps['p3.json'].along}`);
  assert.ok(Math.abs(snaps['p4.json'].along - 1700) < 20, `p4 at ${snaps['p4.json'].along}`);
});

test('a fix on the course never loses to one far off it', () => {
  // The symptom that made this obvious: pings sitting metres from the route were
  // landing hundreds of metres away, because once progress was wrong the cost of
  // going back swamped the geometry and `perp` stopped mattering at all.
  const points = pings([[100, 10], [600, 10], [1100, 10], [1600, 10]]);
  const snaps = snapsOf(STRAIGHT, points);

  for (const p of points) {
    assert.ok(snaps[p.name].off < 20, `${p.name} snapped ${snaps[p.name].off} m off course`);
  }
});

test('no leg implies a speed the runner could not have run', () => {
  // On a course whose end overlaps its start, the wrong branch is only a few
  // metres away geometrically and half a course away in `along`. Taking it used
  // to cost less than stepping backwards, which is how a trail run came to report
  // 300 km/h.
  const points = pings([[0, 10], [500, 10], [1000, 10], [1500, 10], [2000, 10]]);
  const snaps = snapsOf(STRAIGHT, points);

  for (let i = 1; i < points.length; i++) {
    const metres = Math.abs(snaps[points[i].name].along - snaps[points[i - 1].name].along);
    const hours = (points[i].t - points[i - 1].t) / 3600000;
    const kmh = metres / 1000 / hours;
    assert.ok(kmh < CONFIG.snapMaxSpeedKmh * 2, `leg ${i} implied ${kmh.toFixed(0)} km/h`);
  }
});

test('a bad FIRST fix costs nothing but itself', () => {
  // The weakest ping in a run, because it is the only one with no earlier evidence
  // to contradict it. Both ways of being wrong are here: a fix that is ON the
  // course but four kilometres from where the run then demonstrably starts, and a
  // fix that is nowhere near it. Each is rightly rejected, and neither may cost
  // the run anything beyond itself.
  //
  // What made this subtle is that rejecting a fix is not the same as forgetting
  // it. The off-course state carries the last position forward for the next ping
  // to be measured from, and while a REJECTED fix was left in that role, the chord
  // from it to the first good fix was the width of the mistake — so rejoining the
  // course near the start came out dearer than staying off it. On a real 165 km
  // race a single bad opening fix silently dropped the next sixty pings, twenty
  // kilometres of them, every one within metres of the route.
  const good = pings([[100, 10], [600, 10], [1100, 10], [1600, 10]]);
  const clean = snapsOf(LONG, good);

  for (const [label, stray] of [
    ['on the course, far ahead', [5000, 10]],
    ['nowhere near the course', [4000, CONFIG.snapMeters + 900]]
  ]) {
    const opened = [{ name: 'bad.json', t: good[0].t - 300000, ...toLatLon(stray) }, ...good];
    const after = snapsOf(LONG, opened);

    assert.equal(after['bad.json'], null, `${label}: the run says where it started`);
    for (const p of good) {
      assert.deepEqual(after[p.name], clean[p.name], `${label}: ${p.name} was disturbed`);
    }
  }
});

test('a later ping can change an EARLIER snap', () => {
  // The guarantee a greedy matcher cannot offer at any price, and the one the
  // whole rewrite is for. This fix is 240 m off the route: believable while it is
  // the newest thing known, because nothing yet contradicts it. Then a ping
  // arrives a minute later and 900 m further on, which the fix could only have
  // reached at 54 km/h — and the cheaper reading of the pair becomes that the
  // fix was simply wrong. So it is re-read, having already been decided once.
  const at = (name, ms, xy) => ({ name, t: Date.parse('2026-07-28T12:00:00Z') + ms, ...toLatLon(xy) });
  const upto = [at('p0.json', 0, [100, 10]), at('p1.json', 300000, [600, 10]),
                at('p2.json', 600000, [1500, 240])];

  const early = snapsOf(LONG, upto);
  const later = snapsOf(LONG, [...upto, at('p3.json', 660000, [2400, 10])]);

  assert.ok(early['p2.json'], 'on its own it is a plausible place to be');
  assert.ok(Math.abs(early['p2.json'].along - 1500) < 20);
  assert.equal(later['p2.json'], null, 'the ping after it says otherwise, so it is re-read');
  assert.ok(Math.abs(later['p3.json'].along - 2400) < 20, 'and the run carries on regardless');
});

// --- the cache: every ping projected exactly once ----------------------------

/** Wraps the projection so the tests can count how much work actually happened. */
function counting() {
  const fn = (...args) => { fn.calls++; return candidatesFor(...args); };
  fn.calls = 0;
  return fn;
}

test('a warm cache does no work at all', () => {
  const points = pings([[100, 20], [600, 30], [1400, 10]]);
  const first = snapAll(STRAIGHT, points, null);
  assert.equal(first.snapped, 3);

  const candidates = counting();
  const again = snapAll(STRAIGHT, points, first.cache, { candidates });

  assert.equal(candidates.calls, 0, 'a repaint must not reproject anything');
  assert.equal(again.snapped, 0);
});

test('one new ping costs exactly one projection', () => {
  const points = pings([[100, 20], [600, 30], [1400, 10]]);
  const warm = snapAll(STRAIGHT, points, null).cache;

  const grown = [...points, { name: 'p3.json', t: points[2].t + 300000, ...toLatLon([1800, 20]) }];
  const candidates = counting();
  const { snapped } = snapAll(STRAIGHT, grown, warm, { candidates });

  assert.equal(candidates.calls, 1);
  assert.equal(snapped, 1);
});

test('growing a run one ping at a time gives the same answer as doing it all at once', () => {
  // The incremental path is the one that runs in production; this is what says it
  // is not a cheaper approximation of the real thing. Note that this is now a
  // statement about the CACHED GEOMETRY as well as the result: the choosing is
  // redone from scratch either way, so the two can only differ if the stored
  // candidates do.
  const points = pings([[0, 10], [400, 20], [1000, 200], [1000, 900], [200, 990], [0, 10]]);

  let cache = null;
  for (let i = 1; i <= points.length; i++) {
    cache = snapAll(LOOP, points.slice(0, i), cache).cache;
  }
  const cold = snapAll(LOOP, points, null).cache;

  assert.deepEqual(cache.byName, cold.byName);
  assert.deepEqual(cache.snaps, cold.snaps);
});

test('an unsnappable ping does not disturb the pings around it', () => {
  // Losing signal in a tunnel must not send the runner back to the start line.
  const withGap = pings([[100, 20], [600, CONFIG.snapMeters + 400], [1400, 10]]);
  const snaps = snapAll(STRAIGHT, withGap, null).cache.snaps;

  assert.equal(snaps['p1.json'], null);
  assert.ok(Math.abs(snaps['p2.json'].along - 1400) < 2);
});

// --- before the gun ----------------------------------------------------------
//
// A scheduled start means pings can exist that are not part of the race: the drive
// to the start, the warm-up, a phone left on overnight. They are real fixes and
// stay on the map, but placing them on the course would count a warm-up as race
// progress — and because so much downstream keys on `snap`, refusing to snap them
// is the whole of the exclusion.

/** The gun, landing between the first and second ping of a `pings()` sequence. */
const GUN = Date.parse('2026-07-28T12:02:30Z');

test('a ping from before the gun is not placed on the course', () => {
  const points = pings([[100, 20], [600, 30], [1200, 25]]);
  const snaps = snapsOf(STRAIGHT, points, { start: GUN });

  assert.equal(snaps['p0.json'], null, 'before the gun, so nowhere on the course');
  assert.ok(snaps['p1.json'], 'after it, so snapped as usual');
  assert.ok(snaps['p2.json']);
});

test('a pre-start ping is recorded, not merely skipped', () => {
  // A name missing from `byName` means "never seen", and this one has been seen and
  // decided about. Skipping it instead leaves `snapped` at zero on the second pass,
  // `show()` never persists the cache, the new `start` never reaches the version
  // tuple — and every paint finds the cache stale and re-snaps the entire run.
  const points = pings([[100, 20], [600, 30]]);
  const first = snapAll(STRAIGHT, points, null, { start: GUN });

  assert.equal(first.snapped, 2, 'both were decided about');
  assert.ok('p0.json' in first.cache.byName);

  const candidates = counting();
  const again = snapAll(STRAIGHT, points, first.cache, { start: GUN, candidates });
  assert.equal(again.snapped, 0, 'and nothing is reconsidered on the next pass');
  assert.equal(candidates.calls, 0);
});

test('a pre-start ping does not move the runner along the course', () => {
  // The sequence has to read as though the warm-up never happened, so this must
  // match a run where the pre-start pings were simply absent. Under a global
  // matcher that is a stronger claim than it was under a greedy one: an excluded
  // ping must not be able to argue about the pings AFTER it either.
  const all = pings([[1500, 20], [100, 30], [600, 25]]);
  const withGun = snapsOf(STRAIGHT, all, { start: GUN });
  // ... and the same run with the warm-up ping deleted outright.
  const without = snapsOf(STRAIGHT, all.slice(1));

  for (const name of ['p1.json', 'p2.json']) {
    assert.deepEqual(withGun[name], without[name], name);
  }
});

test('no scheduled start means every ping races, exactly as before', () => {
  const points = pings([[100, 20], [600, 30]]);

  assert.deepEqual(
    snapAll(STRAIGHT, points, null, { start: null }).cache,
    snapAll(STRAIGHT, points, null).cache
  );
});

test('a moved gun invalidates everything, even though the course file did not change', () => {
  // The trap this guards: a tree entry's sha is a hash of the CONTENT, so renaming a
  // GPX from 09:00 to 08:00 leaves `courseSha` identical. Without `start` in the
  // version tuple, every stored candidate would keep the answer from the old gun.
  const points = pings([[100, 20], [600, 30]]);
  const warm = snapAll(STRAIGHT, points, null, { start: GUN }).cache;

  const candidates = counting();
  const moved = snapAll(STRAIGHT, points, warm, { start: GUN - 3600000, candidates });

  assert.equal(moved.snapped, 2, 'both pings reconsidered under the new start');
  assert.ok(candidates.calls > 0);
  assert.ok(moved.cache.snaps['p0.json'], 'the warm-up ping is in the race now');
});

// --- the speed ceiling -------------------------------------------------------

test('a run may raise its own speed ceiling', () => {
  // `along` measures progress along the PLANNED route, so a course whose paths
  // turned out not to exist is one where the runner legitimately outruns the
  // default. `max_speed` in course_settings.json is how a run says so.
  const points = pings([[0, 10], [2000, 10]]);

  const strict = snapsOf(STRAIGHT, points, { maxSpeed: 1 });
  const loose = snapsOf(STRAIGHT, points, { maxSpeed: 100 });

  assert.ok(loose['p1.json'], 'a loose ceiling keeps the fix');
  assert.ok(Math.abs(loose['p1.json'].along - 2000) < 20);
  assert.ok(!strict['p1.json'] || strict['p1.json'].along < 2000,
    'and a ceiling of 1 km/h refuses to believe 24 km in five minutes');
});

test('a changed ceiling rescores the run', () => {
  const points = pings([[0, 10], [2000, 10]]);
  const warm = snapAll(STRAIGHT, points, null, { maxSpeed: 100 }).cache;

  const { cache } = snapAll(STRAIGHT, points, warm, { maxSpeed: 1 });
  assert.equal(cache.maxSpeed, 1);
});

// --- when the cache must be thrown away -------------------------------------

test('a different course file invalidates everything', () => {
  const points = pings([[100, 20], [600, 30]]);
  const warm = snapAll(STRAIGHT, points, null).cache;

  const other = courseFrom([[0, 0], [2000, 0]], 'course-2');
  const candidates = counting();
  snapAll(other, points, warm, { candidates });

  assert.equal(candidates.calls, 2, 'stored distances mean nothing against a new course');
});

test('a changed threshold invalidates everything', () => {
  const points = pings([[100, 20], [600, 30]]);
  const warm = snapAll(STRAIGHT, points, null).cache;

  const original = CONFIG.snapMeters;
  CONFIG.snapMeters = 400;
  try {
    const candidates = counting();
    snapAll(STRAIGHT, points, warm, { candidates });
    assert.equal(candidates.calls, 2);
  } finally {
    CONFIG.snapMeters = original;
  }
});

test('a backfilled older ping is placed without reprojecting the run', () => {
  // Under the greedy matcher this had to throw the whole cache away: a ping
  // inserted into the middle of history had never been scored against the ones
  // before it, and only a rerun could fix that. Now it simply takes its place in
  // the trellis in time order and the path is refound around it — so it costs the
  // one projection it needs, and the pings either side are still right.
  const points = pings([[600, 30], [1100, 20], [1600, 10]]);
  const warm = snapAll(STRAIGHT, points, null).cache;

  const backfilled = [
    { name: 'old.json', t: points[0].t - 300000, ...toLatLon([100, 20]) },
    ...points
  ];
  const candidates = counting();
  const { cache, snapped } = snapAll(STRAIGHT, backfilled, warm, { candidates });

  assert.equal(candidates.calls, 1, 'only the new ping is projected');
  assert.equal(snapped, 1);
  assert.ok(Math.abs(cache.snaps['old.json'].along - 100) < 20);
  assert.ok(Math.abs(cache.snaps['p2.json'].along - 1600) < 20);
});

test('a corrupt or missing cache is treated as empty, not trusted', () => {
  const points = pings([[100, 20]]);
  for (const bad of [null, undefined, {}, { courseSha: 'course-1' }, 'nonsense']) {
    const { cache } = snapAll(STRAIGHT, points, bad);
    assert.ok(cache.snaps['p0.json'], JSON.stringify(bad));
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

  const candidates = counting();
  const again = snapAll(STRAIGHT, points, revived, { candidates });
  assert.equal(candidates.calls, 0);
  assert.deepEqual(again.cache.snaps, warm.snaps, 'and gives the same answer after it');
});

// --- applying the result ----------------------------------------------------

test('applySnaps hangs each snap on its point and removes stale ones', () => {
  const points = pings([[100, 20], [600, CONFIG.snapMeters + 400]]);
  const { cache } = snapAll(STRAIGHT, points, null);

  applySnaps(points, cache);
  assert.ok(points[0].snap);
  assert.equal(points[1].snap, undefined, 'an unsnapped ping keeps its real position');

  applySnaps(points, { snaps: {} });
  assert.equal(points[0].snap, undefined);
});
