// Only the pure, DOM-free half of layers.js is exercised here. The layer
// builders need deck.gl's global, which is a browser concern.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse } from '../src/course.js';
import { fmtDistance, hoverTooltipHtml, makeTooltip, tooltipHtml } from '../src/layers.js';
import { interpolateAt } from '../src/stats.js';

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
  // Two rows and no more: a ping with no course and no stats says nothing it
  // hasn't been told. (The Maps link is an anchor, not a row.)
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

/** A snapped ping with the full set of derived figures hung off it. */
const rich = {
  ...point,
  snap: { along: 8800, off: 12, lon: 8.1, lat: 46.5, ele: 900 },
  stats: {
    sinceStart: 4980000, sincePrev: 252000,
    distTotal: 8800, dist: 1200,
    upTotal: 1240, downTotal: 980, up: 124, down: 38
  }
};

test('climb shows both a total and the leg since the previous ping', () => {
  const out = text(tooltipHtml(rich, false));

  assert.ok(out.includes('↑ 1,240 m'), out);
  assert.ok(out.includes('↓ 980 m'), out);
  assert.ok(out.includes('↑ 124 m  ↓ 38 m since last'), out);
});

test('distance and time each read as a total and a leg', () => {
  // The four figures the tooltip owes you, paired like with like rather than
  // scattered across the rows.
  const out = text(tooltipHtml(rich, false));

  assert.ok(out.includes('8.8 km in · 1.2 km since last'), out);
  assert.ok(out.includes('1h 23m in · 4m 12s since last'), out);
});

test('"snapped 12 m" sits beside the coordinates it qualifies', () => {
  // It says how far the drawn dot is from the raw fix on the line above, so
  // that is where it belongs — not filed with the distances along the course.
  const out = text(tooltipHtml(rich, false));

  assert.ok(out.includes('46.500000, 8.100000 · snapped 12 m'), out);
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

// --- the Google Maps link -----------------------------------------------------

test('every tooltip carries a link to the place it describes', () => {
  const ping = tooltipHtml(point, false);
  const waypoint = makeTooltip(() => [])({
    object: { kind: 'waypoint', name: 'Col', lat: 46.4, lon: -0.7 },
    layer: { id: 'waypoints' }
  }).html;

  for (const html of [ping, waypoint]) {
    assert.match(html, /href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/, html);
    // New tab, and `noopener` so the opened page can't reach back through
    // window.opener into this one.
    assert.match(html, /target="_blank"/, html);
    assert.match(html, /rel="noopener noreferrer"/, html);
  }
  assert.ok(ping.includes('query=46.500000,8.100000'), ping);
  assert.ok(waypoint.includes('query=46.400000,-0.700000'), waypoint);
});

test('a ping links to where the phone was, not to where it was drawn', () => {
  // The snap moves the dot onto the course; it does not move the runner. A link
  // to the snapped position would be a place nobody has ever been.
  const html = tooltipHtml(
    { ...point, snap: { along: 8800, off: 300, lon: 8.2, lat: 46.6, ele: 900 } }, false);

  assert.ok(html.includes('query=46.500000,8.100000'), html);
  assert.ok(!html.includes('46.600000,8.200000'), html);
});

// --- the hovered spot on the course -------------------------------------------

const LAT0 = 46.5;
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

/** 4 km due east, climbing 100 m to 500 m. */
function course() {
  const segments = [Array.from({ length: 41 }, (_, i) => ({
    lat: LAT0, lon: (i * 100) / M_LON, ele: 100 + i * 10
  }))];
  return buildCourse({ segments, waypoints: [], hasElevation: true }, 'sha');
}

const MINUTE = 60000;
const ping = (name, minutes, along) => ({
  name, t: minutes * MINUTE, lat: LAT0, lon: 0,
  snap: { along, lon: 0, lat: LAT0, ele: 0, off: 4 }
});

test('a spot between two pings reads as an estimated time', () => {
  const c = course();
  const points = [ping('a', 0, 0), ping('b', 20, 2000)];
  const out = text(hoverTooltipHtml(interpolateAt(points, c, 1000)));

  assert.ok(out.includes('1.0 km in'), out);
  // Halfway along a 20-minute leg.
  assert.ok(out.includes('10m in'), out);
  assert.ok(out.includes('estimated'), out, 'an interpolated time must say so');
  assert.ok(out.includes('↑'), out, 'climb is a fact about the course, known here');
});

test('past the last ping it says so rather than extrapolating a pace', () => {
  const c = course();
  const points = [ping('a', 0, 0), ping('b', 20, 2000)];
  const out = text(hoverTooltipHtml(interpolateAt(points, c, 3500)));

  assert.ok(out.includes('Not reached yet'), out);
  assert.ok(!out.includes('estimated'), out);
  // The ground is still described — height and climb don't wait for a runner.
  assert.ok(out.includes('↑'), out);
  assert.ok(out.includes('3.5 km in'), out);
});

test('the hovered spot links to itself on the course, interpolated', () => {
  const c = course();
  const html = hoverTooltipHtml(interpolateAt([ping('a', 0, 0)], c, 2000));

  assert.match(html, /href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
});

test('hoverTooltipHtml renders nothing at all when there is nothing to describe', () => {
  assert.equal(hoverTooltipHtml(null), '');
  assert.equal(hoverTooltipHtml(interpolateAt([], null, 100)), '');
});

// --- what getTooltip does with each layer --------------------------------------

test('hovering the course hit band describes the spot, not the segment', () => {
  // `object` arrives as a segment — an array of vertices, not a fix — so
  // describing it as one would read `undefined.toFixed`. What's worth
  // describing is the coordinate.
  const c = course();
  const points = [ping('a', 0, 0), ping('b', 20, 2000)];
  const tooltip = makeTooltip(() => points, () => c);
  const at = c.path[10];

  const out = tooltip({
    object: c.segments[0],
    layer: { id: 'course-hit' },
    coordinate: [at.lon, at.lat]
  });

  assert.ok(out.html.includes('1.0 km in'), out.html);
  assert.equal(tooltip({ object: null, layer: { id: 'trail' } }), null);
});

test('hovering the course well off it produces no tooltip', () => {
  const c = course();
  const tooltip = makeTooltip(() => [], () => c);

  assert.equal(tooltip({
    object: c.segments[0], layer: { id: 'course-hit' }, coordinate: [8.9, 47.9]
  }), null);
  // And with no course loaded at all, rather than throwing.
  assert.equal(makeTooltip(() => [])({
    object: c.segments[0], layer: { id: 'course-hit' }, coordinate: [0, LAT0]
  }), null);
});

test('every tooltip opts out of deck.gl\'s pointer-events: none', () => {
  // Without this the Google Maps link is visible and dead, and the tooltip
  // vanishes the moment the cursor moves off the dot towards it.
  const tooltip = makeTooltip(() => []);
  const out = tooltip({ object: point, layer: { id: 'trail' } });

  assert.equal(out.style.pointerEvents, 'auto');
});
