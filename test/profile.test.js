import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse } from '../src/course.js';
import { columns, elevationAt, hitTest, scaleFor, smooth } from '../src/profile.js';

const LAT0 = 46.5;
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

/** A course running due east, one vertex per `step` metres, with given heights. */
function ramp(eles, step = 100) {
  const segments = [eles.map((ele, i) => ({ lat: LAT0, lon: (i * step) / M_LON, ele }))];
  return buildCourse({ segments, waypoints: [], hasElevation: true }, 'sha');
}

test('columns produces exactly one min/max pair per pixel', () => {
  const course = ramp(Array.from({ length: 500 }, (_, i) => i));
  const { min, max } = columns(course, 120);

  assert.equal(min.length, 120);
  assert.equal(max.length, 120);
});

test('a dense course is summarised, not sampled — spikes survive', () => {
  // The point of min/max per column: a one-vertex spike between two pixels must
  // still show up, or a summit disappears at some window widths.
  const eles = new Array(1000).fill(100);
  eles[500] = 900;
  const course = ramp(eles);

  const { max } = columns(course, 50);
  assert.equal(Math.max(...max), 900);
});

test('columns rises monotonically for a course that does', () => {
  const course = ramp(Array.from({ length: 300 }, (_, i) => i * 2));
  const { min, max } = columns(course, 60);

  for (let i = 1; i < max.length; i++) assert.ok(max[i] >= max[i - 1], `dip at ${i}`);
  // Each column summarises five vertices, so the ends are the extremes of the
  // whole course rather than of any one vertex.
  assert.equal(min[0], 0);
  assert.equal(max[max.length - 1], 598);
});

test('a course with fewer vertices than the strip has pixels leaves no gaps', () => {
  const course = ramp([10, 20, 30]);
  const { min, max } = columns(course, 400);

  for (let i = 0; i < 400; i++) {
    assert.ok(Number.isFinite(min[i]), `hole in min at ${i}`);
    assert.ok(Number.isFinite(max[i]), `hole in max at ${i}`);
  }
});

test('scaleFor puts the start at the left edge and the finish at the right', () => {
  const course = ramp([0, 50, 100]);
  const scale = scaleFor(course, 800, 100);

  assert.equal(scale.x(0), 0);
  assert.ok(Math.abs(scale.x(course.length) - 800) < 1e-9);
});

test('x and distanceAt are inverses', () => {
  const course = ramp([0, 50, 100]);
  const scale = scaleFor(course, 640, 100);

  for (const d of [0, 55, 123.4, course.length]) {
    assert.ok(Math.abs(scale.distanceAt(scale.x(d)) - d) < 1e-6, `${d}`);
  }
});

test('the highest point sits above the lowest on screen', () => {
  // y grows downwards, which is exactly the kind of thing to get backwards once.
  const course = ramp([10, 500, 10]);
  const scale = scaleFor(course, 800, 100);

  assert.ok(scale.y(500) < scale.y(10));
});

test('a flat course is not amplified into a mountain range', () => {
  // Two centimetres of GPS noise stretched over the full height of the strip
  // would be a lie. There is a floor on the elevation range for exactly this.
  const flat = ramp([100, 100.01, 100]);
  const scale = scaleFor(flat, 800, 100);

  assert.ok(scale.hi - scale.lo >= 20);
  assert.ok(Math.abs(scale.y(100.01) - scale.y(100)) < 1, 'flat should look flat');
});

test('elevationAt interpolates between vertices', () => {
  const course = ramp([100, 200], 1000);   // 1 km climbing 100 m

  assert.ok(Math.abs(elevationAt(course, 0) - 100) < 0.01);
  assert.ok(Math.abs(elevationAt(course, 500) - 150) < 0.5);
  assert.ok(Math.abs(elevationAt(course, course.length) - 200) < 0.01);
});

test('elevationAt is finite anywhere on a long course', () => {
  const course = ramp(Array.from({ length: 400 }, (_, i) => 100 + Math.sin(i / 5) * 30));

  for (let d = 0; d <= course.length; d += course.length / 97) {
    assert.ok(Number.isFinite(elevationAt(course, d)), `at ${d}`);
  }
});

// --- smoothing the drawn line ------------------------------------------------

test('smooth returns one value per input and leaves flat ground flat', () => {
  const flat = new Array(50).fill(120);
  const out = smooth(flat, 3);

  assert.equal(out.length, 50);
  for (let i = 0; i < 50; i++) assert.ok(Math.abs(out[i] - 120) < 1e-9, `moved at ${i}`);
});

test('smooth at radius 0 is the identity', () => {
  const values = [5, 90, 5, 40, 5];
  assert.deepEqual([...smooth(values, 0)], values);
});

test('smooth settles noise without moving the hill', () => {
  // A hill with a picket fence of GPS noise laid over it. The noise should go;
  // the hill, and where its summit is, should not.
  const noisy = Array.from({ length: 101 },
    (_, i) => 100 + (50 - Math.abs(50 - i)) * 4 + (i % 2 ? 6 : -6));
  const out = smooth(noisy, 3);

  // Column-to-column jitter collapses...
  let worst = 0;
  for (let i = 1; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - out[i - 1]));
  assert.ok(worst < 6, `still jagged: ${worst}`);

  // ...but the summit stays put, and stays roughly as tall.
  let peak = 0;
  for (let i = 1; i < out.length; i++) if (out[i] > out[peak]) peak = i;
  assert.ok(Math.abs(peak - 50) <= 2, `summit moved to ${peak}`);
  assert.ok(Math.abs(out[peak] - 300) < 15, `summit is now ${out[peak]}`);
});

test('smooth does not drag the ends of the course towards zero', () => {
  // The easy half of a box blur to get wrong: treating off-the-end as 0 rather
  // than shrinking the window would pull both ends down towards sea level.
  const level = new Array(40).fill(800);
  const out = smooth(level, 5);

  assert.ok(Math.abs(out[0] - 800) < 1e-9, `start sagged to ${out[0]}`);
  assert.ok(Math.abs(out[out.length - 1] - 800) < 1e-9, `end sagged to ${out[out.length - 1]}`);
});

// --- picking a dot off the strip ---------------------------------------------

/** A course 1 km long climbing 0 -> 100 m, and a strip 1000 px wide by 100 tall. */
function strip() {
  const course = ramp([0, 100], 1000);
  return { course, scale: scaleFor(course, 1000, 100) };
}

const at = (name, along) => ({ name, t: along, snap: { along, ele: along / 10 } });

test('hitTest finds the dot under the cursor', () => {
  const { course, scale } = strip();
  const points = [at('a.json', 200), at('b.json', 600)];
  const target = points[1];

  const hit = hitTest(points, course, scale,
    scale.x(target.snap.along), scale.y(target.snap.ele));

  assert.equal(hit?.name, 'b.json');
});

test('hitTest returns null when the cursor is nowhere near a dot', () => {
  const { course, scale } = strip();
  const points = [at('a.json', 200)];

  assert.equal(hitTest(points, course, scale, scale.x(600), 50), null);
});

test('hitTest picks the nearer of two dots, not the first it sees', () => {
  const { course, scale } = strip();
  // Close enough together that both are inside the hit radius.
  const points = [at('a.json', 500), at('b.json', 508)];

  const hit = hitTest(points, course, scale, scale.x(507), scale.y(50.7));
  assert.equal(hit?.name, 'b.json');
});

test('hitTest ignores unsnapped pings — they are not drawn here', () => {
  // They have no distance along the course, so there is no x to hit.
  const { course, scale } = strip();
  const points = [{ name: 'a.json', t: 1, lat: 46.5, lon: 0 }];

  assert.equal(hitTest(points, course, scale, 0, 50), null);
});
