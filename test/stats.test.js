import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse, gainAt } from '../src/course.js';
import { deriveStats } from '../src/stats.js';

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
