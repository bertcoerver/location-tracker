// Only the pure, DOM-free half of layers.js is exercised here. The layer
// builders need deck.gl's global, which is a browser concern.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse } from '../src/course.js';
import {
  beaconLayers, beaconTooltipHtml, fmtDistance, forecastLayers, hoverTooltipHtml, makeTooltip,
  splitWeather, tooltipHtml, viewerLayers, waypointTooltipHtml
} from '../src/layers.js';
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

// --- what the phone was dealing with ------------------------------------------

test('battery and signal share one row, and either half can be missing', () => {
  const both = text(tooltipHtml({ ...point, btry: 76, ntwrk: 2 }, false));
  assert.ok(both.includes('Battery 76% · Signal 2/4'), both);

  // Every file written before `ntwrk` existed, which is most of them.
  assert.ok(text(tooltipHtml({ ...point, btry: 76 }, false)).includes('Battery 76%'));
  // And the other way round, without a stray separator hanging off it.
  const signal = text(tooltipHtml({ ...point, ntwrk: 0 }, false));
  assert.ok(signal.includes('Signal 0/4'), signal);
  assert.ok(!signal.includes('·'), signal);
});

test('no signal is 0/4 rather than nothing at all', () => {
  // A phone with no bars is exactly the interesting case: it explains the gap in
  // the trail on either side of this ping. `0` must not be read as absent.
  assert.ok(text(tooltipHtml({ ...point, ntwrk: 0 }, false)).includes('Signal 0/4'));
});

test('the weather is reported as two readings, not as the one string it arrives as', () => {
  const out = text(tooltipHtml({ ...point, wthr: '28°C and Sunny' }, false));
  assert.ok(out.includes('28°C · Sunny'), out);
});

test('splitWeather cuts at the first "and", so a label keeping one survives', () => {
  assert.deepEqual(splitWeather('28°C and Sunny'), ['28°C', 'Sunny']);
  assert.deepEqual(splitWeather('9°C and Rain and thunder'), ['9°C', 'Rain and thunder']);
  // Nothing to cut on: passed through whole rather than sliced on a guess.
  assert.deepEqual(splitWeather('Sunny'), ['Sunny']);
  assert.deepEqual(splitWeather('  28°C and Sunny  '), ['28°C', 'Sunny']);
});

test('splitWeather has nothing to say about a missing or empty field', () => {
  assert.equal(splitWeather(undefined), null);
  assert.equal(splitWeather(''), null);
  assert.equal(splitWeather('   '), null);
});

test('the weather is escaped — it is a string a phone composed', () => {
  const out = splitWeather('28°C and <b>Sunny</b>');
  assert.deepEqual(out, ['28°C', '&lt;b&gt;Sunny&lt;/b&gt;']);
  assert.ok(!tooltipHtml({ ...point, wthr: '<img src=x>' }, false).includes('<img src=x>'));
});

test('the finish says so, and says it instead of "latest"', () => {
  // It is almost always both, and "finish" is the more useful of the two — and
  // the one that is still true tomorrow, once a newer run has taken "latest".
  const finish = { ...point, is_finish: true, stats: { sinceStart: 0 } };

  assert.ok(text(tooltipHtml(finish, true)).includes('· finish'));
  assert.ok(!text(tooltipHtml(finish, true)).includes('· latest'));
  assert.ok(text(tooltipHtml(finish, false)).includes('· finish'), 'even when it is not newest');
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

test('fmtDistance switches units the same way everywhere it is shown', () => {
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
    assert.match(html, /href="https:\/\/maps\.google\.com\/\?q=/, html);
    // New tab, and `noopener` so the opened page can't reach back through
    // window.opener into this one.
    assert.match(html, /target="_blank"/, html);
    assert.match(html, /rel="noopener noreferrer"/, html);
  }
  assert.ok(ping.includes('q=46.500000,8.100000('), ping);
  assert.ok(waypoint.includes('q=46.400000,-0.700000(Col)'), waypoint);
});

test('a ping links to where the phone was, not to where it was drawn', () => {
  // The snap moves the dot onto the course; it does not move the runner. A link
  // to the snapped position would be a place nobody has ever been.
  const html = tooltipHtml(
    { ...point, snap: { along: 8800, off: 300, lon: 8.2, lat: 46.6, ele: 900 } }, false);

  assert.ok(html.includes('q=46.500000,8.100000('), html);
  assert.ok(!html.includes('46.600000,8.200000'), html);
});

// The pin Google Maps drops used to open with a blank info card, so following a
// link from four different pings gave you four identical anonymous markers.

test('a ping names its pin with how far in it was and the time of day', () => {
  const html = tooltipHtml(rich, false);
  const label = decodeURIComponent(html.match(/\(([^)]*)\)/)[1]);

  assert.match(label, /^8\.8 km · /, label);
  // The time of day, in whatever form the runtime's locale gives it.
  assert.match(label, /\d/, label);
});

test('a ping with no distance yet falls back to naming the time alone', () => {
  // Before a course lands there are no stats, and "undefined km" would be worse
  // than a shorter label.
  const label = decodeURIComponent(tooltipHtml(point, false).match(/\(([^)]*)\)/)[1]);

  assert.ok(!label.includes('km'), label);
  assert.ok(!label.includes('undefined'), label);
});

test('a waypoint names its pin after itself', () => {
  const html = waypointTooltipHtml({ name: 'Feed station', lat: 46.5, lon: 8.1 });
  assert.ok(html.includes('(Feed%20station)'), html);
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

  assert.match(html, /href="https:\/\/maps\.google\.com\/\?q=/);
  // And names the pin after the one thing that identifies a bare spot on a
  // course: how far along it is.
  assert.ok(html.includes('(2.0%20km%20in)'), html);
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

test('hover produces no tooltip at all while a point is pinned', () => {
  // The user has said which point they want to read. A second tooltip chasing
  // the cursor beside the pinned one is two answers to a settled question.
  const c = course();
  const points = [ping('a', 0, 0), ping('b', 20, 2000)];
  const at = c.path[10];

  const free = makeTooltip(() => points, () => c, () => false);
  const pinned = makeTooltip(() => points, () => c, () => true);

  for (const info of [
    { object: point, layer: { id: 'trail' } },
    { object: { kind: 'waypoint', name: 'Col', lat: 46.4, lon: -0.7 }, layer: { id: 'waypoints' } },
    { object: c.segments[0], layer: { id: 'course-hit' }, coordinate: [at.lon, at.lat] }
  ]) {
    assert.ok(free(info), 'this case answers when nothing is pinned');
    assert.equal(pinned(info), null);
  }
});

// --- the forecast marker on the map -------------------------------------------

test('forecastLayers draws nothing without both a course and a marker', () => {
  // The only half of this that can be exercised here: building the layers needs
  // deck.gl's global. The guard is what keeps a run with no course, or a
  // finished one with no forecast, from reaching for `pathsBetween` at all.
  assert.deepEqual(forecastLayers(null, { along: 100, lo: 50, hi: 200 }), []);
  assert.deepEqual(forecastLayers(course(), null), []);
  assert.deepEqual(forecastLayers(null, null), []);
});

// --- the other runs -----------------------------------------------------------

test('beaconLayers draws nothing when there are no other runs', () => {
  // The layers themselves need deck.gl's global; this is the guard that keeps a
  // repo with one run in it from adding two empty layers to every frame.
  assert.deepEqual(beaconLayers([]), []);
});

test('a beacon tooltip names the run, ages it, and says it can be opened', () => {
  const html = beaconTooltipHtml({
    run: 'utmb-2026',
    latest: Date.now() - 2 * 3600000
  });

  const lines = text(html);
  assert.match(lines, /utmb-2026/);
  assert.match(lines, /Last ping 2h ago/);
  // Without this the dot is a feature nobody finds: nothing else on the map
  // navigates, so there is no convention to fall back on.
  assert.match(lines, /Click to open/);
  // No coordinates and no Maps link: this is a signpost, not a reading.
  assert.ok(!html.includes('maps'), 'a beacon is not a place to go and look at');
});

test('a run name is escaped, since it comes from a folder in the repo', () => {
  const html = beaconTooltipHtml({ run: '<script>x</script>', latest: Date.now() });
  assert.ok(!html.includes('<script>'), html);
});

// --- the visitor's own position -----------------------------------------------

test('viewerLayers draws nothing until a position has actually arrived', () => {
  // The page asks on load, but the answer may be a refusal, an error, or simply
  // not back yet — and none of those is a place to draw a dot. The layers
  // themselves need deck.gl's global.
  assert.deepEqual(viewerLayers(null, 0), []);
});
