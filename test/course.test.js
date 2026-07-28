import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { buildCourse, courseBounds, nearestOnCourse } from '../src/course.js';

// Everything here works in metres, so the fixtures are built from metres too:
// at this latitude these are the degree sizes the projection uses.
const LAT0 = 46.5;
const M_LAT = 110540;
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

/** A course from offsets in metres east/north of a fixed origin. */
function courseFrom(offsets, opts = {}) {
  const segments = [offsets.map(([e, n]) => ({
    lat: LAT0 + n / M_LAT,
    lon: 0 + e / M_LON,
    ele: 0
  }))];
  return buildCourse({ segments, waypoints: [], hasElevation: true, name: null, ...opts }, 'sha');
}

/** A point in the same frame, as { lon, lat }. */
function at(e, n) {
  return { lon: e / M_LON, lat: LAT0 + n / M_LAT };
}

test('cumulative distance matches the metres the course was built from', () => {
  const course = courseFrom([[0, 0], [1000, 0], [1000, 500]]);

  assert.ok(Math.abs(course.cum[1] - 1000) < 1, `${course.cum[1]}`);
  assert.ok(Math.abs(course.cum[2] - 1500) < 1, `${course.cum[2]}`);
  assert.ok(Math.abs(course.length - 1500) < 1);
});

test('a loop is recognised as closed and a point-to-point is not', () => {
  const loop = courseFrom([[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]]);
  const line = courseFrom([[0, 0], [1000, 0], [2000, 0]]);

  assert.equal(loop.closed, true);
  assert.equal(line.closed, false);
});

test('a course that ends near, but not at, its start still counts as a loop', () => {
  // Start and finish lines are metres apart in practice, never identical.
  const almost = courseFrom([[0, 0], [2000, 0], [2000, 2000], [100, 0]]);
  assert.ok(CONFIG.loopMeters >= 100);
  assert.equal(almost.closed, true);
});

test('a point beside the course finds it, at the right distance along', () => {
  const course = courseFrom([[0, 0], [1000, 0]]);
  const [best] = nearestOnCourse(course, at(400, 100).lon, at(400, 100).lat);

  assert.ok(Math.abs(best.perp - 100) < 1, `perp ${best.perp}`);
  assert.ok(Math.abs(best.along - 400) < 1, `along ${best.along}`);
});

test('a point beyond the threshold finds nothing', () => {
  const course = courseFrom([[0, 0], [1000, 0]]);
  const far = at(400, CONFIG.snapMeters + 200);

  assert.deepEqual(nearestOnCourse(course, far.lon, far.lat), []);
});

test('past the end of the course, the nearest place is the end of it', () => {
  const course = courseFrom([[0, 0], [1000, 0]]);
  const beyond = at(1200, 0);
  const [best] = nearestOnCourse(course, beyond.lon, beyond.lat);

  assert.ok(Math.abs(best.along - 1000) < 1, `along ${best.along}`);
  assert.ok(Math.abs(best.perp - 200) < 1);
});

test('a loop offers BOTH the start and the finish at their junction', () => {
  // This is the whole reason nearestOnCourse returns every candidate rather
  // than just the closest: geometry alone cannot choose between these two.
  const loop = courseFrom([[0, 0], [1000, 0], [1000, 1000], [0, 1000], [0, 0]]);
  const junction = at(0, 30);
  const alongs = nearestOnCourse(loop, junction.lon, junction.lat).map(c => c.along);

  assert.ok(alongs.some(a => a < 50), `no start candidate in ${alongs}`);
  assert.ok(alongs.some(a => a > loop.length - 50), `no finish candidate in ${alongs}`);
});

test('elevation is interpolated along the segment, not snapped to a vertex', () => {
  const segments = [[
    { lat: LAT0, lon: 0, ele: 100 },
    { lat: LAT0, lon: 1000 / M_LON, ele: 200 }
  ]];
  const course = buildCourse({ segments, waypoints: [], hasElevation: true }, 'sha');
  const [best] = nearestOnCourse(course, at(250, 10).lon, at(250, 10).lat);

  assert.ok(Math.abs(best.ele - 125) < 1, `ele ${best.ele}`);
});

test('duplicate consecutive vertices do not produce NaN', () => {
  // The real MapOut export is full of these.
  const course = courseFrom([[0, 0], [500, 0], [500, 0], [1000, 0]]);
  const [best] = nearestOnCourse(course, at(500, 20).lon, at(500, 20).lat);

  assert.ok(Number.isFinite(best.along));
  assert.ok(Number.isFinite(best.perp));
});

test('nothing snaps to the gap between two track segments', () => {
  // The two legs are 3 km apart. A ping halfway between them is within 500 m of
  // the imaginary line joining them and must find nothing at all.
  const seg = ns => ns.map(([e, n]) => ({ lat: LAT0 + n / M_LAT, lon: e / M_LON, ele: 0 }));
  const course = buildCourse({
    segments: [seg([[0, 0], [1000, 0]]), seg([[4000, 0], [5000, 0]])],
    waypoints: [], hasElevation: true
  }, 'sha');

  const between = at(2500, 0);
  assert.deepEqual(nearestOnCourse(course, between.lon, between.lat), []);

  // …but distance along still runs across the join, so `along` stays monotone.
  const [onSecond] = nearestOnCourse(course, at(4500, 0).lon, at(4500, 0).lat);
  assert.ok(onSecond.along > 1000, `along ${onSecond.along}`);
});

test('the grid index agrees with brute force everywhere', () => {
  // The index is an optimisation, so the property that matters is that it never
  // changes the answer. A deterministic pseudo-random sweep over a wiggly course.
  const offsets = [];
  for (let i = 0; i < 400; i++) offsets.push([i * 25, Math.sin(i / 7) * 900]);
  const course = courseFrom(offsets);

  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  for (let i = 0; i < 200; i++) {
    const e = rand() * 10000;
    const n = (rand() - 0.5) * 3000;
    const probe = at(e, n);

    const viaGrid = nearestOnCourse(course, probe.lon, probe.lat)
      .reduce((a, b) => (b.perp < (a?.perp ?? Infinity) ? b : a), null);
    const viaBrute = bruteForce(course, probe.lon, probe.lat);

    if (!viaBrute) {
      assert.equal(viaGrid, null, `grid found something brute force did not at ${e},${n}`);
      continue;
    }
    assert.ok(viaGrid, `grid missed a candidate at ${e},${n}`);
    assert.ok(Math.abs(viaGrid.perp - viaBrute.perp) < 1e-6, `${viaGrid.perp} vs ${viaBrute.perp}`);
    assert.ok(Math.abs(viaGrid.along - viaBrute.along) < 1e-6);
  }
});

/** Every segment, no index — the answer the grid has to reproduce. */
function bruteForce(course, lon, lat) {
  const { xy, cum, proj } = course;
  const px = proj.x(lon);
  const py = proj.y(lat);
  let best = null;

  for (let i = 0; i < xy.length / 2 - 1; i++) {
    const x0 = xy[i * 2], y0 = xy[i * 2 + 1];
    const dx = xy[i * 2 + 2] - x0, dy = xy[i * 2 + 3] - y0;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2)) : 0;
    const perp = Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
    if (perp > CONFIG.snapMeters) continue;
    if (!best || perp < best.perp) best = { perp, along: cum[i] + Math.sqrt(len2) * t };
  }
  return best;
}

test('courseBounds covers every vertex', () => {
  const course = courseFrom([[0, 0], [1000, 500], [-500, -200]]);
  const [[minLon, minLat], [maxLon, maxLat]] = courseBounds(course);

  for (const p of course.path) {
    assert.ok(p.lon >= minLon && p.lon <= maxLon);
    assert.ok(p.lat >= minLat && p.lat <= maxLat);
  }
});

test('a course needs at least two points to exist', () => {
  assert.equal(buildCourse({ segments: [[{ lat: 1, lon: 1, ele: 0 }]] }, 'sha'), null);
  assert.equal(buildCourse({ segments: [] }, 'sha'), null);
  assert.equal(buildCourse(null, 'sha'), null);
});
