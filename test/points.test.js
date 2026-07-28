import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boundsOf, buildPoints, latestOf } from '../src/points.js';
import { interpolate } from '../src/colors.js';

const cache = {
  'b.json': { name: 'b.json', t: 200, lat: 1, lon: 2 },
  'a.json': { name: 'a.json', t: 100, lat: 3, lon: -4 },
  'c.json': { name: 'c.json', t: 300, lat: -5, lon: 6 }
};

test('buildPoints sorts oldest first regardless of cache order', () => {
  assert.deepEqual(buildPoints(cache).map(p => p.name), ['a.json', 'b.json', 'c.json']);
});

test('buildPoints spreads k across the full time span', () => {
  const [a, b, c] = buildPoints(cache);
  assert.equal(a.k, 0);
  assert.equal(b.k, 0.5);
  assert.equal(c.k, 1);
});

test('buildPoints treats a single point as newest, not oldest', () => {
  // k=0 would paint the only fix in the faintest colour on the ramp.
  const [only] = buildPoints({ 'a.json': { name: 'a.json', t: 100, lat: 0, lon: 0 } });
  assert.equal(only.k, 1);
});

test('buildPoints survives points that share one timestamp', () => {
  const same = buildPoints({
    'a.json': { name: 'a.json', t: 100, lat: 0, lon: 0 },
    'b.json': { name: 'b.json', t: 100, lat: 1, lon: 1 }
  });
  assert.ok(same.every(p => Number.isFinite(p.k)));
});

test('buildPoints and latestOf handle an empty cache', () => {
  assert.deepEqual(buildPoints({}), []);
  assert.equal(latestOf([]), null);
});

test('boundsOf returns [[minLon, minLat], [maxLon, maxLat]]', () => {
  assert.deepEqual(boundsOf(buildPoints(cache)), [[-4, -5], [6, 3]]);
});

test('interpolate hits the ramp endpoints exactly', () => {
  const stops = [[0, 0, 0], [128, 128, 128], [255, 255, 255]];
  assert.deepEqual(interpolate(stops, 0), [0, 0, 0]);
  assert.deepEqual(interpolate(stops, 1), [255, 255, 255]);
  assert.deepEqual(interpolate(stops, 0.5), [128, 128, 128]);
});

test('interpolate clamps out-of-range input instead of extrapolating', () => {
  const stops = [[0, 0, 0], [255, 255, 255]];
  assert.deepEqual(interpolate(stops, -3), [0, 0, 0]);
  assert.deepEqual(interpolate(stops, 99), [255, 255, 255]);
});

test('interpolate is monotonic across the real light-mode ramp', () => {
  const ramp = ['#86b6ef', '#5598e7', '#2a78d6', '#184f95', '#0d366b']
    .map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)));

  const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let previous = Infinity;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const l = lum(interpolate(ramp, t));
    assert.ok(l <= previous + 0.5, `ramp brightened at t=${t.toFixed(2)}`);
    previous = l;
  }
});
