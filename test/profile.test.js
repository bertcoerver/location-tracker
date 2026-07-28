import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse } from '../src/course.js';
import { columns, elevationAt, scaleFor } from '../src/profile.js';

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
