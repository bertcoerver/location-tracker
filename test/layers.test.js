// Only the pure, DOM-free half of layers.js is exercised here. The layer
// builders need deck.gl's global, which is a browser concern.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmtDistance, makeTooltip, tooltipHtml } from '../src/layers.js';

const point = {
  name: '2026-07-28T12_06_01+02_00.json',
  t: Date.parse('2026-07-28T12:06:01+02:00'),
  lat: 46.5,
  lon: 8.1
};

/** Strip the markup so a test reads what a person would see. */
const text = html => html
  .replace(/<[^>]+>/g, '\n')
  .replace(/&middot;/g, '·')
  .replace(/&uarr;/g, '↑')
  .replace(/&darr;/g, '↓')
  .replace(/&#8202;|&nbsp;/g, ' ');

test('a bare fix shows only its time and position', () => {
  const html = tooltipHtml(point, false);

  assert.ok(text(html).includes('46.500000, 8.100000'));
  // Two rows and no more: a ping with no course and no stats must render
  // exactly as it did before any of this existed.
  assert.equal(html.match(/<div/g).length, 2, html);
});

test('elapsed times appear once stats are attached', () => {
  const out = text(tooltipHtml(
    { ...point, stats: { sinceStart: 4980000, sincePrev: 252000 } }, false));

  assert.ok(out.includes('1h 23m in'), out);
  assert.ok(out.includes('4m 12s since last'), out);
});

test('the first ping has no "since last" — there is nothing before it', () => {
  const out = text(tooltipHtml({ ...point, stats: { sinceStart: 0 } }, false));

  assert.ok(out.includes('0s in'));
  assert.ok(!out.includes('since last'), out);
});

test('climb shows both a total and the leg since the previous ping', () => {
  const out = text(tooltipHtml({
    ...point,
    snap: { along: 8800, off: 12, lon: 8.1, lat: 46.5, ele: 900 },
    stats: { sinceStart: 4980000, sincePrev: 252000, upTotal: 1240, downTotal: 980, up: 124, down: 38 }
  }, false));

  assert.ok(out.includes('8.8 km in · snapped 12 m'), out);
  assert.ok(out.includes('↑ 1,240 m'), out);
  assert.ok(out.includes('↓ 980 m'), out);
  assert.ok(out.includes('↑ 124 m  ↓ 38 m since last'), out);
});

test('a run without elevation gets the times but not the climb', () => {
  // Absent rather than "↑ 0 m", which would read as flat ground.
  const out = text(tooltipHtml({
    ...point,
    snap: { along: 8800, off: 12, lon: 8.1, lat: 46.5, ele: null },
    stats: { sinceStart: 60000, sincePrev: 60000 }
  }, false));

  assert.ok(out.includes('1m in'));
  assert.ok(!out.includes('↑'), out);
});

test('the newest fix is marked, and a message and battery still come through', () => {
  const out = text(tooltipHtml(
    { ...point, btry: 78, msg: 'over the top', stats: { sinceStart: 0 } }, true));

  assert.ok(out.includes('· latest'));
  assert.ok(out.includes('Battery 78%'));
  assert.ok(out.includes('over the top'));
});

test('the pickable course itself gets no tooltip', () => {
  // It is pickable so that hovering it can move the profile crosshair. What
  // comes back is a segment — an array of vertices — and describing it as a fix
  // would read `undefined.toFixed`.
  const tooltip = makeTooltip(() => []);
  const segment = [{ lat: 46.5, lon: 8.1, ele: 900 }];

  assert.equal(tooltip({ object: segment, layer: { id: 'course' } }), null);
  assert.equal(tooltip({ object: null, layer: { id: 'trail' } }), null);
});

test('a waypoint is described as a place, not as a moment', () => {
  const tooltip = makeTooltip(() => []);
  const out = tooltip({
    object: { kind: 'waypoint', name: 'Feed station', lat: 46.5, lon: 8.1, ele: 900 },
    layer: { id: 'waypoints' }
  });

  assert.ok(out.html.includes('Feed station'));
  assert.ok(!out.html.includes('since last'));
});

test('fmtDistance switches units where the profile readout does', () => {
  assert.equal(fmtDistance(850), '850 m');
  assert.equal(fmtDistance(12400), '12.4 km');
});
