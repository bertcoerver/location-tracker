import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  boundsOf, buildPoints, finishOf, latestOf, posOf, unionBounds
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
