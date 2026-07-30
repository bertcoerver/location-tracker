import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse, gainAt } from '../src/course.js';
import { deriveStats, interpolateAt, originOf } from '../src/stats.js';

const LAT0 = 46.5;
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

/** A course due east, a vertex every 100 m, with the given heights. */
function hills(eles) {
  const segments = [eles.map((ele, i) => ({ lat: LAT0, lon: (i * 100) / M_LON, ele }))];
  return buildCourse({ segments, waypoints: [], hasElevation: true }, 'sha');
}

/** 5 km climbing steadily from 100 m to 600 m, then back down to 200 m. */
function slope() {
  return hills([
    ...Array.from({ length: 51 }, (_, i) => 100 + i * 10),
    ...Array.from({ length: 41 }, (_, i) => 600 - i * 10)
  ]);
}

const MINUTE = 60000;

/** A ping at `t` minutes, snapped `along` metres in (or nowhere, with null). */
function ping(name, minutes, along) {
  const point = { name, t: minutes * MINUTE, lat: LAT0, lon: 0 };
  if (along !== null) point.snap = { along, lon: 0, lat: LAT0, ele: 0, off: 4 };
  return point;
}

test('the first ping is at zero and has nothing before it', () => {
  const course = slope();
  const points = deriveStats([ping('a', 0, 0), ping('b', 10, 2000)], course);

  assert.equal(points[0].stats.sinceStart, 0);
  assert.equal(points[0].stats.sincePrev, undefined, 'invented a previous ping');
  assert.equal(points[0].stats.up, 0);
  assert.equal(points[0].stats.down, 0);
});

test('elapsed times measure from the first ping and from the previous one', () => {
  const points = deriveStats([ping('a', 0, 0), ping('b', 10, 1000), ping('c', 25, 2000)], slope());

  assert.equal(points[2].stats.sinceStart, 25 * MINUTE);
  assert.equal(points[2].stats.sincePrev, 15 * MINUTE);
});

test('climb totals track the course, and the leg is the difference', () => {
  const course = slope();
  const points = deriveStats([ping('a', 0, 0), ping('b', 10, 2000), ping('c', 20, 4000)], course);

  // 100 m of ascent per kilometre on the way up.
  assert.ok(Math.abs(points[1].stats.upTotal - 200) < 10, `${points[1].stats.upTotal}`);
  assert.ok(Math.abs(points[2].stats.upTotal - 400) < 10, `${points[2].stats.upTotal}`);
  assert.ok(Math.abs(points[2].stats.up - 200) < 10, `leg was ${points[2].stats.up}`);
  assert.equal(points[2].stats.down, 0);
});

test('descent is recorded once the course turns downhill', () => {
  const course = slope();
  // 5,000 m is the summit; 7,000 m is 2 km down the far side.
  const points = deriveStats([ping('a', 0, 5000), ping('b', 10, 7000)], course);

  assert.ok(Math.abs(points[1].stats.down - 200) < 15, `${points[1].stats.down}`);
  assert.ok(points[1].stats.up < 15, `climbed ${points[1].stats.up} m going downhill`);
});

test('a leg spans an unsnapped ping rather than losing the ground under it', () => {
  const course = slope();
  const points = deriveStats([
    ping('a', 0, 0),
    ping('b', 10, null),      // signal lost, nowhere near the course
    ping('c', 20, 3000)
  ], course);

  assert.equal(points[1].stats.up, undefined, 'measured climb for an unsnapped fix');
  // Still 300 m of climbing since the last fix that WAS on the course, not
  // since some vanished midpoint.
  assert.ok(Math.abs(points[2].stats.up - 300) < 15, `${points[2].stats.up}`);
  // Times are wall-clock, so they use the previous ping whether it snapped or not.
  assert.equal(points[2].stats.sincePrev, 10 * MINUTE);
});

test('going backwards along the course gives positive metres, up and down swapped', () => {
  // snapBackPenalty is a cost, not a prohibition, so this does happen. Reporting
  // -200 m of ascent would be arithmetic rather than a fact about the ground.
  const course = slope();
  const points = deriveStats([ping('a', 0, 3000), ping('b', 10, 1000)], course);
  const leg = points[1].stats;

  assert.ok(leg.up >= 0 && leg.down >= 0, `${leg.up} / ${leg.down}`);
  assert.ok(Math.abs(leg.down - 200) < 15, `retreat down a climb should descend: ${leg.down}`);
  assert.equal(leg.up, 0);
});

test('no course at all: times still work, climb is absent rather than zero', () => {
  // Absent, because 0 would read as "flat ground", which is a different claim
  // from "there is no course to measure against".
  const points = deriveStats([ping('a', 0, null), ping('b', 5, null)], null);

  assert.equal(points[1].stats.sincePrev, 5 * MINUTE);
  assert.equal(points[1].stats.upTotal, undefined);
  assert.equal(points[1].stats.up, undefined);
});

test('a course with no elevation data reports no climb either', () => {
  const segments = [[{ lat: LAT0, lon: 0 }, { lat: LAT0, lon: 0.05 }]];
  const flat = buildCourse({ segments, waypoints: [], hasElevation: false }, 'sha');
  const points = deriveStats([ping('a', 0, 0), ping('b', 5, 1000)], flat);

  assert.equal(points[1].stats.upTotal, undefined);
  assert.equal(points[1].stats.sinceStart, 5 * MINUTE);
});

test('a point\'s totals match asking the course directly', () => {
  const course = slope();
  const points = deriveStats([ping('a', 0, 0), ping('b', 10, 2500), ping('c', 20, 6000)], course);
  const direct = gainAt(course, 6000);

  assert.ok(Math.abs(points[2].stats.upTotal - direct.up) < 1e-9);
  assert.ok(Math.abs(points[2].stats.downTotal - direct.down) < 1e-9);
});

test('deriveStats survives an empty run', () => {
  assert.deepEqual(deriveStats([], slope()), []);
});

// --- distance along the course ------------------------------------------------

test('distance is carried both as a total and as a leg', () => {
  const points = deriveStats([ping('a', 0, 0), ping('b', 10, 1200), ping('c', 20, 3000)], slope());

  assert.equal(points[0].stats.distTotal, 0);
  assert.equal(points[0].stats.dist, 0, 'invented a leg before the first ping');
  assert.equal(points[1].stats.distTotal, 1200);
  assert.equal(points[1].stats.dist, 1200);
  assert.equal(points[2].stats.dist, 1800);
});

test('a backwards leg still covered that ground', () => {
  // Same reasoning as the up/down swap: -2,000 m is arithmetic, not a distance.
  const points = deriveStats([ping('a', 0, 3000), ping('b', 10, 1000)], slope());

  assert.equal(points[1].stats.dist, 2000);
});

test('distance needs no elevation — it is not a climb figure', () => {
  const segments = [[{ lat: LAT0, lon: 0 }, { lat: LAT0, lon: 0.05 }]];
  const flat = buildCourse({ segments, waypoints: [], hasElevation: false }, 'sha');
  const points = deriveStats([ping('a', 0, 0), ping('b', 5, 900)], flat);

  assert.equal(points[1].stats.distTotal, 900);
  assert.equal(points[1].stats.dist, 900);
  assert.equal(points[1].stats.upTotal, undefined);
});

test('a leg spanning an unsnapped ping measures from the last one that landed', () => {
  const points = deriveStats([
    ping('a', 0, 500), ping('b', 10, null), ping('c', 20, 2500)
  ], slope());

  assert.equal(points[1].stats.distTotal, undefined, 'measured a distance for a fix with none');
  assert.equal(points[2].stats.dist, 2000);
});

// --- interpolating an arbitrary spot on the course ----------------------------

test('interpolateAt puts the time linearly across the leg it falls in', () => {
  const course = slope();
  const points = [ping('a', 0, 0), ping('b', 20, 2000)];

  const quarter = interpolateAt(points, course, 500);
  assert.equal(quarter.state, 'between');
  assert.equal(quarter.sinceStart, 5 * MINUTE);

  const half = interpolateAt(points, course, 1000);
  assert.equal(half.sinceStart, 10 * MINUTE);
});

test('landing exactly on a ping gives that ping\'s own time', () => {
  const course = slope();
  const points = [ping('a', 0, 0), ping('b', 20, 2000), ping('c', 35, 4000)];

  assert.equal(interpolateAt(points, course, 2000).sinceStart, 20 * MINUTE);
  assert.equal(interpolateAt(points, course, 4000).sinceStart, 35 * MINUTE);
});

test('the LATEST visit wins where a lap course has been covered twice', () => {
  // Out to 3 km, back to 1 km, out again. Hovering 2 km should report the last
  // time the runner was there, not the first.
  const course = slope();
  const points = [ping('a', 0, 0), ping('b', 30, 3000), ping('c', 60, 1000), ping('d', 90, 3000)];

  const at = interpolateAt(points, course, 2000);
  assert.equal(at.state, 'between');
  // Between c (60 min at 1 km) and d (90 min at 3 km), halfway.
  assert.equal(at.sinceStart, 75 * MINUTE);
});

test('past the furthest ping there is nothing to interpolate from', () => {
  const course = slope();
  const at = interpolateAt([ping('a', 0, 0), ping('b', 20, 2000)], course, 3000);

  assert.equal(at.state, 'beyond');
  assert.equal(at.sinceStart, undefined, 'extrapolated a pace into unrun ground');
});

test('short of the first ping reads as unreached rather than as time zero', () => {
  const course = slope();
  const at = interpolateAt([ping('a', 0, 1000), ping('b', 20, 3000)], course, 200);

  assert.equal(at.state, 'before');
  assert.equal(at.sinceStart, undefined);
});

test('with no ping on the course the ground is still described', () => {
  const course = slope();
  const at = interpolateAt([ping('a', 0, null)], course, 2000);

  assert.equal(at.state, 'unknown');
  assert.equal(at.sinceStart, undefined);
});

test('height and climb are known everywhere, whatever the state', () => {
  // They are properties of the COURSE. Whether anyone has been there yet is a
  // different question, and it is the only one `state` answers.
  const course = slope();
  const points = [ping('a', 0, 0), ping('b', 20, 2000)];

  for (const along of [500, 2000, 4500]) {
    const at = interpolateAt(points, course, along);
    assert.equal(at.along, along);
    assert.ok(Number.isFinite(at.ele), `no height at ${along}`);
    assert.ok(Number.isFinite(at.upTotal), `no ascent at ${along}`);
    assert.ok(Number.isFinite(at.downTotal), `no descent at ${along}`);
    // And a coordinate, which is what the Maps link and the map's ring need.
    assert.ok(Number.isFinite(at.lat) && Number.isFinite(at.lon), `no position at ${along}`);
  }
});

test('interpolateAt declines the questions it cannot answer', () => {
  assert.equal(interpolateAt([], null, 100), null, 'no course');
  assert.equal(interpolateAt([], slope(), null), null);
  assert.equal(interpolateAt([], slope(), NaN), null);
});

// --- a race with a scheduled start -------------------------------------------
//
// Elapsed time counts from the gun, not from the oldest file in the folder. The
// difference is a race clock versus the age of a directory: pings written on the
// drive to the start used to become the start.

test('elapsed time counts from the gun rather than the first ping', () => {
  // The gun at 10 minutes, a warm-up ping at 4 and the first real one at 12.
  const points = deriveStats(
    [ping('warm', 4, null), ping('a', 12, 500), ping('b', 30, 2000)],
    slope(), 10 * MINUTE);

  assert.equal(points[1].stats.sinceStart, 2 * MINUTE, 'two minutes into the race');
  assert.equal(points[2].stats.sinceStart, 20 * MINUTE);
});

test('a ping from before the gun has no elapsed time at all', () => {
  const points = deriveStats(
    [ping('warm', 4, null), ping('a', 12, 500)], slope(), 10 * MINUTE);

  // Absent rather than negative: "-6 minutes into the race" is arithmetic, not a
  // fact, and the tooltip drops the row rather than printing it.
  assert.equal(points[0].stats.sinceStart, undefined);
});

test('the gap since the previous ping survives across the gun', () => {
  const points = deriveStats(
    [ping('warm', 4, null), ping('a', 12, 500)], slope(), 10 * MINUTE);

  // How long the phone was quiet is a fact about two fixes, and it reads the same
  // either side of the start — so the first racing ping legitimately reports a gap
  // that spans the gun.
  assert.equal(points[1].stats.sincePrev, 8 * MINUTE);
  assert.equal(points[0].stats.sincePrev, undefined, 'still nothing before the first');
});

test('no gun reproduces the old behaviour exactly', () => {
  const points = [ping('a', 5, 0), ping('b', 15, 1000)];
  const withNull = deriveStats(points.map(p => ({ ...p })), slope(), null);
  const without = deriveStats(points.map(p => ({ ...p })), slope());

  assert.deepEqual(withNull.map(p => p.stats), without.map(p => p.stats));
  assert.equal(without[0].stats.sinceStart, 0, 'the first ping is still zero');
});

test('originOf recovers the moment the clock counts from', () => {
  const gun = 10 * MINUTE;
  const points = deriveStats(
    [ping('warm', 4, null), ping('a', 12, 500)], slope(), gun);

  assert.equal(originOf(points), gun);
  // Without a gun it is the first ping, which is what it has always been.
  assert.equal(originOf(deriveStats([ping('a', 5, 0)], slope())), 5 * MINUTE);
});

test('originOf has no answer before any ping has raced', () => {
  assert.equal(originOf([]), null);
  // Nothing but warm-up pings: the race has a start, but no ping is measured from
  // it yet, so there is nothing to recover.
  assert.equal(originOf(deriveStats([ping('warm', 4, null)], slope(), 10 * MINUTE)), null);
});

test('a hovered point on the course reads off the race clock too', () => {
  const gun = 10 * MINUTE;
  const course = slope();
  const points = deriveStats(
    [ping('warm', 4, null), ping('a', 20, 1000), ping('b', 40, 3000)], course, gun);

  // Half way between the two racing pings by distance, so half way by time: 30
  // minutes on the wall, 20 into the race.
  const at = interpolateAt(points, course, 2000);
  assert.equal(at.state, 'between');
  assert.equal(at.sinceStart, 20 * MINUTE);
});

test('interpolateAt still answers for points that never saw deriveStats', () => {
  // Its origin is read back off the pings rather than passed in, so a caller that
  // skipped `deriveStats` gets the first-ping clock instead of NaN.
  const course = slope();
  const at = interpolateAt([ping('a', 10, 1000), ping('b', 30, 3000)], course, 2000);

  assert.equal(at.sinceStart, 10 * MINUTE);
});
