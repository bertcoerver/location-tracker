import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { buildCourse } from '../src/course.js';
import {
  axisTicks, columns, elevationAt, hitTest, scaleFor, smooth, stripWidth, tickLabel
} from '../src/profile.js';

const LAT0 = 46.5;
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

/** A course running due east, one vertex per `step` metres, with given heights. */
function ramp(eles, step = 100) {
  const segments = [eles.map((ele, i) => ({ lat: LAT0, lon: (i * step) / M_LON, ele }))];
  return buildCourse({ segments, waypoints: [], hasElevation: true }, 'sha');
}

// --- how wide the strip wants to be -------------------------------------------

test('a long course gets a fixed number of pixels per kilometre', () => {
  // 150 km — the case the floor exists for. Squeezed into a window it is a
  // smear; at a fixed scale it is a chart you scroll.
  assert.equal(stripWidth({ length: 150_000 }), 150 * CONFIG.profilePxPerKm);
});

test('a short course keeps the minimum width rather than shrinking to fit', () => {
  // Honouring px/km here would draw a 3 km course a couple of hundred pixels
  // wide on a desktop, which obeys the rule and shows nothing.
  const short = stripWidth({ length: 3000 });
  assert.equal(short, CONFIG.profileMinWidth);
  assert.ok(3 * CONFIG.profilePxPerKm < CONFIG.profileMinWidth, 'and px/km really is the smaller');
});

test('the two rules cross over exactly where the widths are equal', () => {
  const crossover = (CONFIG.profileMinWidth / CONFIG.profilePxPerKm) * 1000;
  assert.equal(stripWidth({ length: crossover }), CONFIG.profileMinWidth);
  assert.ok(stripWidth({ length: crossover + 1000 }) > CONFIG.profileMinWidth);
});

test('no course, or one of no length, still asks for the minimum', () => {
  // `sync` calls this before a course has loaded and on a run that has none.
  // Returning 0 would collapse the canvas rather than leave it window-width.
  assert.equal(stripWidth(null), CONFIG.profileMinWidth);
  assert.equal(stripWidth(undefined), CONFIG.profileMinWidth);
  assert.equal(stripWidth({ length: 0 }), CONFIG.profileMinWidth);
});

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

test('scaleFor insets the course from both edges rather than bleeding off them', () => {
  // The start and the finish are the two most interesting points on a course,
  // and edge to edge puts both of them half off the canvas.
  const course = ramp([0, 50, 100]);
  const scale = scaleFor(course, 800, 100);

  assert.ok(scale.x(0) > 0, 'the start is on the left edge');
  assert.ok(scale.x(course.length) < 800, 'the finish is on the right edge');
  // Symmetric, and the plot is what's left in between.
  assert.equal(scale.plotLeft, 800 - scale.x(course.length));
  assert.ok(Math.abs(scale.x(course.length) - scale.x(0) - scale.plotWidth) < 1e-9);
});

test('x and distanceAt are inverses', () => {
  const course = ramp([0, 50, 100]);
  const scale = scaleFor(course, 640, 100);

  for (const d of [0, 55, 123.4, course.length]) {
    assert.ok(Math.abs(scale.distanceAt(scale.x(d)) - d) < 1e-6, `${d}`);
  }
});

test('distanceAt clamps in the margins rather than reporting a negative distance', () => {
  // The cursor can now sit outside the plot — that is what the margins are for.
  const course = ramp([0, 50, 100]);
  const scale = scaleFor(course, 640, 100);

  assert.equal(scale.distanceAt(0), 0);
  assert.equal(scale.distanceAt(-40), 0);
  assert.equal(scale.distanceAt(640), course.length);
  assert.equal(scale.distanceAt(9999), course.length);
});

test('the terrain floor leaves room for the axis below it', () => {
  const scale = scaleFor(ramp([0, 50, 100]), 800, 112);

  assert.ok(scale.floor < 112, 'terrain runs to the very bottom of the canvas');
  assert.ok(scale.y(scale.lo) <= scale.floor + 1e-9, 'the lowest point sits below the floor');
});

// --- the distance axis --------------------------------------------------------

test('axisTicks starts at zero and never runs past the end of the course', () => {
  for (const length of [850, 8835, 42195, 160000]) {
    const ticks = axisTicks(length, 900);
    assert.equal(ticks[0], 0, `${length}`);
    assert.ok(ticks[ticks.length - 1] <= length, `${length}: overran to ${ticks.at(-1)}`);
  }
});

test('axisTicks never packs the labels closer than the minimum spacing', () => {
  // This is the whole job: too many ticks is unreadable, and a course can be
  // anything from a 600 m parkrun to a 160 km ultra.
  for (const length of [500, 3000, 8835, 42195, 250000]) {
    const width = 900;
    const ticks = axisTicks(length, width, 60);
    for (let i = 1; i < ticks.length; i++) {
      const gap = ((ticks[i] - ticks[i - 1]) / length) * width;
      assert.ok(gap >= 60 - 1e-9, `${length} m: ${gap}px apart`);
    }
  }
});

test('axisTicks lands on round numbers, not on length/8', () => {
  // A tick at 1,104 m is not a landmark. Every step must be 1, 2 or 5 x 10^n.
  const ticks = axisTicks(8835, 900);
  const step = ticks[1] - ticks[0];
  const mantissa = step / 10 ** Math.floor(Math.log10(step));

  assert.ok([1, 2, 5].includes(Math.round(mantissa)), `step of ${step}`);
  assert.ok(ticks.length >= 3, `only ${ticks.length} ticks on an 8.8 km course`);
});

test('axisTicks survives a degenerate course rather than looping forever', () => {
  assert.deepEqual(axisTicks(0, 900), [0]);
  assert.deepEqual(axisTicks(1000, 0), [0]);
});

test('tickLabel switches units at a kilometre and keeps at most one decimal', () => {
  assert.equal(tickLabel(0), '0');
  assert.equal(tickLabel(500), '500 m');
  assert.equal(tickLabel(1000), '1 km');
  assert.equal(tickLabel(1500), '1.5 km');
  assert.equal(tickLabel(20000), '20 km');
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
