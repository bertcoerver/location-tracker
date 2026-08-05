import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boundsOf, buildPoints, finishOf, fixesOf, latestOf, posOf, tracePath, unionBounds
} from '../src/points.js';

const cache = {
  'b.json': { name: 'b.json', t: 200, lat: 1, lon: 2 },
  'a.json': { name: 'a.json', t: 100, lat: 3, lon: -4 },
  'c.json': { name: 'c.json', t: 300, lat: -5, lon: 6 }
};

test('buildPoints sorts oldest first regardless of cache order', () => {
  assert.deepEqual(buildPoints(cache).map(p => p.name), ['a.json', 'b.json', 'c.json']);
});

test('buildPoints and latestOf handle an empty cache', () => {
  assert.deepEqual(buildPoints({}), []);
  assert.equal(latestOf([]), null);
});

test('boundsOf returns [[minLon, minLat], [maxLon, maxLat]]', () => {
  assert.deepEqual(boundsOf(buildPoints(cache)), [[-4, -5], [6, 3]]);
});

// --- the end of a run ---------------------------------------------------------

test('finishOf finds the finish when the phone signed off', () => {
  const points = buildPoints({ ...cache, 'd.json': { name: 'd.json', t: 400, is_finish: true } });
  assert.equal(finishOf(points).name, 'd.json');
});

test('a ping after the finish means the run is going again', () => {
  // The phone was restarted. Reading only the LAST point is what makes this fall
  // out for free — and what stops the panel and the poll schedule disagreeing,
  // since they are both looking at this one element.
  const points = buildPoints({
    'c.json': { name: 'c.json', t: 300, is_finish: true },
    'd.json': { name: 'd.json', t: 400, lat: 1, lon: 2 }
  });
  assert.equal(finishOf(points), null);
});

test('finishOf has nothing to say about a run in progress, or an empty one', () => {
  assert.equal(finishOf(buildPoints(cache)), null);
  assert.equal(finishOf([]), null);
});

// --- where a point is actually drawn -----------------------------------------

test('posOf prefers the snapped position over the raw fix', () => {
  const point = { lat: 1, lon: 2, snap: { lat: 10, lon: 20, along: 5, off: 30 } };
  assert.deepEqual(posOf(point), [20, 10]);
});

test('posOf falls back to the raw fix when nothing snapped', () => {
  assert.deepEqual(posOf({ lat: 1, lon: 2 }), [2, 1]);
});

test('boundsOf frames where the points are DRAWN, not where the GPS put them', () => {
  // Otherwise the camera would fit to a box the visible dots aren't inside.
  const points = [
    { lat: 0, lon: 0, snap: { lat: 50, lon: 60 } },
    { lat: 1, lon: 1 }
  ];
  // The raw (0, 0) is nowhere in the box — only (60, 50) and (1, 1) are.
  assert.deepEqual(boundsOf(points), [[1, 1], [60, 50]]);
});

test('unionBounds covers both boxes, and tolerates either being absent', () => {
  const a = [[0, 0], [10, 10]];
  const b = [[-5, 2], [4, 20]];

  assert.deepEqual(unionBounds(a, b), [[-5, 0], [10, 20]]);
  assert.deepEqual(unionBounds(a, null), a);
  assert.deepEqual(unionBounds(null, b), b);
  assert.equal(unionBounds(null, null), null);
});

test('fixesOf keeps the photographs out of the four places they break things', () => {
  const points = [
    { name: 'a.json', t: 100, lat: 45.8, lon: 6.1 },
    { name: 'p.jpeg', t: 150, lat: 43.0, lon: -0.4, kind: 'media' },
    { name: 'b.json', t: 200, lat: 45.9, lon: 6.2, is_finish: true }
  ];

  const fixes = fixesOf(points);
  assert.deepEqual(fixes.map(p => p.name), ['a.json', 'b.json']);
  // The two that matter most: the finish survives a photo taken after it, and the
  // camera fit is not dragged 350 km west by a picture from another range.
  assert.equal(finishOf(fixes).name, 'b.json');
  assert.deepEqual(boundsOf(fixes), [[6.1, 45.8], [6.2, 45.9]]);
  // Where a run has no media at all — every run, until somebody uploads one — the
  // array comes back untouched rather than copied.
  const plain = [points[0], points[2]];
  assert.equal(fixesOf(plain), plain);
});

// --- the line through the pings, for a run with no course ---------------------

/** Pings from lon/lat pairs, in the order given. */
const pings = coords => coords.map(([lon, lat], i) => ({ name: `${i}.json`, t: i * 1000, lon, lat }));

/** Is `p` one of the coordinates in `path`, to within a rounding error? */
const onPath = (path, p) =>
  path.some(q => Math.abs(q[0] - p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9);

test('tracePath has nothing to draw through fewer than two places', () => {
  assert.deepEqual(tracePath([]), []);
  assert.deepEqual(tracePath(pings([[6.1, 45.8]])), []);
  // Two pings from a phone that hasn't moved are one place, not two.
  assert.deepEqual(tracePath(pings([[6.1, 45.8], [6.1, 45.8]])), []);
});

test('tracePath runs through every ping, in order, and ends on the last one', () => {
  const points = pings([[6.10, 45.80], [6.12, 45.81], [6.13, 45.83], [6.16, 45.82]]);
  const path = tracePath(points);

  // The whole point of an interpolating spline: these are measurements, and a
  // curve that passed NEAR them would be inventing positions the run didn't have.
  for (const p of points) assert.ok(onPath(path, [p.lon, p.lat]), `${p.lon},${p.lat}`);
  assert.deepEqual(path[0], [6.10, 45.80]);
  assert.deepEqual(path[path.length - 1], [6.16, 45.82]);
  // Smoothed, so there is a good deal more line than there are pings.
  assert.ok(path.length > points.length * 5, path.length);
});

test('tracePath draws a straight run straight', () => {
  // Four collinear fixes. A spline that wandered off the line between them would
  // be drawing a course nobody ran.
  const path = tracePath(pings([[6, 45], [6.01, 45.01], [6.02, 45.02], [6.03, 45.03]]));

  for (const [lon, lat] of path) assert.ok(Math.abs((lon - 6) - (lat - 45)) < 1e-9, `${lon},${lat}`);
});

test('tracePath keeps the curve inside the ground the run covered', () => {
  // A hairpin, which is where an unguarded spline overshoots: two fixes close
  // together and the next one far away. Centripetal parameterisation is what
  // bounds this — a little rounding of the corner is the whole idea, a loop out
  // into the next valley is not.
  const points = pings([[6.000, 45.000], [6.001, 45.010], [6.002, 45.000], [6.020, 45.001]]);
  const path = tracePath(points);
  const slack = 0.004;

  for (const [lon, lat] of path) {
    assert.ok(lon > 6.000 - slack && lon < 6.020 + slack, `lon ${lon}`);
    assert.ok(lat > 45.000 - slack && lat < 45.010 + slack, `lat ${lat}`);
  }
});

test('tracePath ignores a phone that pinged twice from the same spot', () => {
  const moved = pings([[6.10, 45.80], [6.12, 45.81], [6.13, 45.83]]);
  const stalled = pings([
    [6.10, 45.80], [6.12, 45.81], [6.12, 45.81], [6.12, 45.81], [6.13, 45.83]
  ]);

  // Not merely "doesn't crash on the divide by zero": the repeats say nothing
  // about where the runner went, so they must not bend the line either.
  assert.deepEqual(tracePath(stalled), tracePath(moved));
});

test('tracePath follows a point to wherever it is drawn', () => {
  // `posOf`, so the line joins the dots the map actually shows. Moot for the runs
  // this draws for — nothing snaps without a course — but a line that disagreed
  // with the marks at its ends would be a bug waiting for the day one does.
  const path = tracePath([
    { t: 1, lon: 6.10, lat: 45.80 },
    { t: 2, lon: 0, lat: 0, snap: { lon: 6.12, lat: 45.81 } }
  ]);

  assert.deepEqual(path[path.length - 1], [6.12, 45.81]);
  assert.ok(!path.some(([lon, lat]) => lon === 0 && lat === 0));
});
