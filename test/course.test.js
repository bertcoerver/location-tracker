import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import {
  buildCourse, courseBounds, courseHoverAt, gainAt, nearestOnCourse, pointAt
} from '../src/course.js';
import { elevationAt } from '../src/profile.js';

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

// --- climb along the course ---------------------------------------------------

/** A course running due east, one vertex every 100 m, with the given heights. */
function hills(eles) {
  const segments = [eles.map((ele, i) => ({ lat: LAT0, lon: (i * 100) / M_LON, ele }))];
  return buildCourse({ segments, waypoints: [], hasElevation: true }, 'sha');
}

test('a steady climb is all ascent and no descent', () => {
  const course = hills(Array.from({ length: 101 }, (_, i) => 100 + i));

  // 100 m of rise, less at most one threshold left uncommitted at the top.
  const total = gainAt(course, course.length);
  assert.ok(Math.abs(total.up - 100) <= CONFIG.eleThresholdM, `${total.up}`);
  assert.equal(total.down, 0);
});

test('an up-and-over hill records both directions', () => {
  // 100 m up, then 60 m back down.
  const course = hills([
    ...Array.from({ length: 101 }, (_, i) => 100 + i),
    ...Array.from({ length: 61 }, (_, i) => 200 - i)
  ]);
  const total = gainAt(course, course.length);

  assert.ok(Math.abs(total.up - 100) <= CONFIG.eleThresholdM * 2, `up ${total.up}`);
  assert.ok(Math.abs(total.down - 60) <= CONFIG.eleThresholdM * 2, `down ${total.down}`);
});

test('elevation noise on flat ground accumulates NOTHING', () => {
  // The whole reason for the threshold. Summing these differences naively gives
  // about 200 m of "climb" on a road that does not go anywhere.
  const course = hills(Array.from({ length: 200 }, (_, i) => 100 + (i % 2 ? 1 : -1)));
  const total = gainAt(course, course.length);

  assert.equal(total.up, 0, `invented ${total.up} m of climb`);
  assert.equal(total.down, 0);
});

test('a slow steady climb is not thrown away by the threshold', () => {
  // The other way to get hysteresis wrong: 1 m per vertex never clears a 3 m
  // threshold in one step, but 200 m of real climbing is still 200 m.
  const course = hills(Array.from({ length: 201 }, (_, i) => 100 + i));
  const total = gainAt(course, course.length);

  assert.ok(total.up > 190, `only counted ${total.up} m of 200`);
});

test('the cumulative climb arrays never decrease', () => {
  // Differencing two of them is how a leg's climb is measured, so a dip would
  // hand back negative metres.
  const course = hills(Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 7) * 40));

  for (let i = 1; i < course.cumUp.length; i++) {
    assert.ok(course.cumUp[i] >= course.cumUp[i - 1], `up dipped at ${i}`);
    assert.ok(course.cumDown[i] >= course.cumDown[i - 1], `down dipped at ${i}`);
  }
});

test('gainAt is zero at the start and interpolates on the way up', () => {
  const course = hills(Array.from({ length: 101 }, (_, i) => 100 + i));

  assert.deepEqual(gainAt(course, 0), { up: 0, down: 0 });

  const half = gainAt(course, course.length / 2);
  const full = gainAt(course, course.length);
  assert.ok(half.up > 40 && half.up < 60, `${half.up}`);
  assert.ok(half.up < full.up);
});

test('a course without elevation reports no climb rather than a wrong one', () => {
  const segments = [[{ lat: LAT0, lon: 0 }, { lat: LAT0, lon: 0.01 }]];
  const course = buildCourse({ segments, waypoints: [], hasElevation: false }, 'sha');

  assert.deepEqual(gainAt(course, course.length), { up: 0, down: 0 });
});

// --- locating a distance on the course ---------------------------------------

test('pointAt lands exactly on a vertex and interpolates between two', () => {
  const course = courseFrom([[0, 0], [1000, 0], [1000, 1000]]);

  const start = pointAt(course, 0);
  assert.ok(Math.abs(start.lon - course.path[0].lon) < 1e-12);
  assert.ok(Math.abs(start.lat - course.path[0].lat) < 1e-12);

  // Half way along the first leg: 500 m east, still on the same parallel.
  const mid = pointAt(course, 500);
  assert.ok(Math.abs(mid.lon * M_LON - 500) < 1, `${mid.lon * M_LON}`);
  assert.ok(Math.abs(mid.lat - LAT0) < 1e-12);
});

test('pointAt clamps rather than extrapolating off either end', () => {
  const course = courseFrom([[0, 0], [1000, 0]]);
  const last = course.path[course.path.length - 1];

  assert.ok(Math.abs(pointAt(course, course.length + 5000).lon - last.lon) < 1e-12);
  assert.ok(Math.abs(pointAt(course, -5000).lon - course.path[0].lon) < 1e-12);
});

test('pointAt and elevationAt agree — they are the same search', () => {
  const course = hills(Array.from({ length: 50 }, (_, i) => 100 + i * 3));

  for (const d of [0, 137, 2200, course.length]) {
    assert.ok(Math.abs(pointAt(course, d).ele - elevationAt(course, d)) < 1e-9, `${d}`);
  }
});

// --- pointing at the course from the map -------------------------------------

test('courseHoverAt returns the distance along under the cursor', () => {
  const course = courseFrom([[0, 0], [1000, 0], [2000, 0]]);
  const along = courseHoverAt(course, at(1500, 30).lon, at(1500, 30).lat);

  assert.ok(Math.abs(along - 1500) < 5, `${along}`);
});

test('courseHoverAt gives null when the cursor is nowhere near the course', () => {
  const course = courseFrom([[0, 0], [1000, 0]]);
  const far = at(500, CONFIG.snapMeters * 4);

  assert.equal(courseHoverAt(course, far.lon, far.lat), null);
});

test('courseHoverAt takes the nearest branch, with no history to weigh', () => {
  // Unlike snapping: a cursor is AT a place rather than being a noisy guess at
  // one, so the plain nearest candidate is the right answer.
  const course = courseFrom([[0, 0], [1000, 0], [1000, 40], [0, 40], [0, 0]]);
  // Just above the outbound leg, well clear of the return leg 40 m north.
  const along = courseHoverAt(course, at(500, 2).lon, at(500, 2).lat);

  assert.ok(Math.abs(along - 500) < 10, `took the far branch: ${along}`);
});
