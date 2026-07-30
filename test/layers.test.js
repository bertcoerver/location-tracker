// Only the pure, DOM-free half of layers.js is exercised here. The layer
// builders need deck.gl's global, which is a browser concern.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse } from '../src/course.js';
import {
  beaconLayers, beaconTooltipHtml, fmtDistance, forecastLayers, hoverTooltipHtml, makeTooltip,
  splitWeather, tooltipHtml, viewerLayers, waypointTooltipHtml
} from '../src/layers.js';
import { buildForecast } from '../src/predict.js';
import { interpolateAt } from '../src/stats.js';
import { fmtClock } from '../src/util.js';

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
  .replace(/&ndash;/g, '–')
  .replace(/&uarr;/g, '↑')
  .replace(/&darr;/g, '↓')
  .replace(/&thinsp;|&#8202;|&nbsp;/g, ' ');

/** How many reading rows a tooltip drew — the icon-and-value kind. */
const rowCount = html => (html.match(/class="row"/g) || []).length;

test('a bare fix says the time and nothing else', () => {
  const html = tooltipHtml(point, false);

  // One row, the title, and no more: a ping with no course and no stats says
  // nothing it hasn't been told. (The Maps link is an anchor, not a div.)
  assert.equal(html.match(/<div/g).length, 1, html);
  assert.equal(rowCount(html), 0, html);
});

test('the title is a bare 24-hour time — no date, no AM/PM', () => {
  // The date used to lead every tooltip, repeated on all four hundred pings of a
  // run that happened on one afternoon. What it was carrying is which day of the
  // RACE it is, and `dayTag` says that in two characters instead.
  const out = text(tooltipHtml(point, false));

  assert.ok(out.includes(fmtClock(point.t)), out);
  assert.match(fmtClock(point.t), /^\d\d:\d\d:\d\d$/);
  assert.ok(!/\bAM\b|\bPM\b/.test(out), out);
  assert.ok(!out.includes('2026'), out);
  assert.ok(!out.includes('Jul'), out);
});

test('a ping on the second day of a race is tagged, one on the first is not', () => {
  const gun = Date.parse('2026-07-28T12:00:00+02:00');
  // Built from local components, so the assertion holds under any TZ: this is the
  // same wall-clock hour on the day after `gun`'s local day, whatever zone that is.
  const local = new Date(gun);
  const nextDay = new Date(
    local.getFullYear(), local.getMonth(), local.getDate() + 1, local.getHours()).getTime();

  const day2 = text(tooltipHtml({ ...point, t: nextDay }, false, gun));
  assert.ok(day2.includes('+1'), day2);

  const day1 = text(tooltipHtml({ ...point, t: gun + 3600000 }, false, gun));
  assert.ok(!day1.includes('+1'), day1);
});

test('no coordinates anywhere in a tooltip — they were diagnostics', () => {
  // Six decimal places of latitude and "snapped 12 m" were the first two things
  // under the title, above how far in and how long in. The Maps link still carries
  // the raw fix, which is the one place it is worth anything.
  const html = tooltipHtml(rich, false);
  const rows = html.slice(0, html.indexOf('<a'));

  assert.ok(!rows.includes('46.500000'), rows);
  assert.ok(!rows.includes('snapped'), rows);
});

test('elapsed times appear once stats are attached', () => {
  const out = text(tooltipHtml(
    { ...point, stats: { sinceStart: 4980000, sincePrev: 252000 } }, false));

  assert.ok(out.includes('1h 23m'), out);
  // The leg, marked as an addition to the total rather than labelled in words.
  assert.ok(out.includes('+4m 12s'), out);
});

test('a ping from before the gun reports no elapsed time', () => {
  // It has a `stats` object — the gap since the previous ping is still a fact — but
  // no `sinceStart`, because the race had not begun. Formatting the absence would
  // put "NaN in" on the tooltip, which is the failure this guards.
  const html = tooltipHtml({ ...point, stats: { sincePrev: 252000 } }, false);
  const out = text(html);

  // No reading rows at all — the same as a ping with no stats whatsoever.
  assert.equal(rowCount(html), 0, html);
  assert.ok(!out.includes('4m 12s'), out);
  assert.ok(!out.includes('NaN'), out);
  assert.ok(!out.includes('undefined'), out);
});

test('a pre-start ping still shows what the phone was dealing with', () => {
  const out = text(tooltipHtml(
    { ...point, btry: 96, ntwrk: 3, wthr: '19°C and Cloudy', stats: { sincePrev: 60000 } },
    false));

  assert.ok(out.includes('96%'), out);
  assert.ok(out.includes('19°C'), out);
  assert.ok(out.includes('3/4'), out);
  assert.ok(!out.includes('NaN'), out);
});

test('the first ping has no leg beside its total — there is nothing before it', () => {
  const html = tooltipHtml({ ...point, stats: { sinceStart: 0 } }, false);

  assert.ok(text(html).includes('0s'), html);
  assert.ok(!html.includes('+'), html);
});

/** A snapped ping with the full set of derived figures hung off it. */
const rich = {
  ...point,
  snap: { along: 8800, off: 12, lon: 8.1, lat: 46.5, ele: 900 },
  stats: {
    sinceStart: 4980000, sincePrev: 252000,
    distTotal: 8800, dist: 1200, pace: 210000,
    upTotal: 1240, downTotal: 980, up: 124, down: 38
  }
};

test('climb is two rows, each a total with its leg beside it', () => {
  // One four-figure line used to hold both totals and both legs, which is the one
  // arrangement that cannot put focus on any of them.
  const html = tooltipHtml(rich, false);
  const out = text(html);

  assert.ok(out.includes('1,240 m'), out);
  assert.ok(out.includes('+124 m'), out);
  assert.ok(out.includes('980 m'), out);
  assert.ok(out.includes('+38 m'), out);
  // Time, distance, pace, up, down.
  assert.equal(rowCount(html), 5, html);
});

test('distance and time each read as a total with the leg that got there', () => {
  const out = text(tooltipHtml(rich, false));

  assert.ok(out.includes('8.8 km'), out);
  assert.ok(out.includes('+1.2 km'), out);
  assert.ok(out.includes('1h 23m'), out);
  assert.ok(out.includes('+4m 12s'), out);
});

test('pace over the last leg is a reading of its own', () => {
  // The number a runner actually wants, and the only row with no total to lead on:
  // a pace is always about a stretch, and the stretch that matters is the last one.
  const out = text(tooltipHtml(rich, false));

  assert.ok(out.includes('3:30 /km'), out);
});

test('a ping with no pace yet shows no pace row', () => {
  // The first snapped ping of a run, or a runner who has not moved. See `deriveStats`.
  const html = tooltipHtml({ ...rich, stats: { ...rich.stats, pace: undefined } }, false);

  assert.ok(!text(html).includes('/km'), html);
  assert.equal(rowCount(html), 4, html);
});

test('a run without elevation gets the times but not the climb', () => {
  // Absent rather than "0 m", which would read as flat ground.
  const html = tooltipHtml({
    ...point,
    snap: { along: 8800, off: 12, lon: 8.1, lat: 46.5, ele: null },
    stats: { sinceStart: 60000, sincePrev: 60000 }
  }, false);

  assert.ok(text(html).includes('1m'), html);
  assert.equal(rowCount(html), 1, html);
});

test('the newest fix is marked, and a message and battery still come through', () => {
  const out = text(tooltipHtml(
    { ...point, btry: 78, msg: 'over the top', stats: { sinceStart: 0 } }, true));

  assert.ok(out.includes('· latest'));
  assert.ok(out.includes('78%'));
  assert.ok(out.includes('over the top'));
});

// --- what the phone was dealing with ------------------------------------------

test('the five sensor readings are one line, whichever of them are present', () => {
  const html = tooltipHtml(
    { ...point, btry: 73, ntwrk: 3, wthr: '29°C and Sunny', bpm: 69 }, false);

  // Exactly one, however many readings went into it. They used to be three rows.
  assert.equal((html.match(/class="meta"/g) || []).length, 1, html);
  const out = text(html);
  assert.ok(out.includes('73%'), out);
  assert.ok(out.includes('29°C'), out);
  assert.ok(out.includes('3/4'), out);
  assert.ok(out.includes('69'), out);
  assert.ok(out.includes('☀️'), out);
});

test('each sensor reading can be missing on its own', () => {
  // Every file written before a field existed has none of it, which is most of them.
  assert.ok(text(tooltipHtml({ ...point, btry: 76 }, false)).includes('76%'));
  assert.ok(text(tooltipHtml({ ...point, bpm: 142 }, false)).includes('142'));

  const signal = tooltipHtml({ ...point, ntwrk: 0 }, false);
  assert.ok(text(signal).includes('0/4'), signal);
  // No separator glyphs left hanging off the one reading that is there — the cells
  // are spaced by CSS now rather than by a `·` that had to be counted out.
  assert.ok(!signal.includes('&middot;'), signal);
});

test('no sensors at all means no sensor line at all', () => {
  assert.ok(!tooltipHtml(point, false).includes('class="meta"'));
});

test('no signal is 0/4 rather than nothing at all', () => {
  // A phone with no bars is exactly the interesting case: it explains the gap in
  // the trail on either side of this ping. `0` must not be read as absent.
  assert.ok(text(tooltipHtml({ ...point, ntwrk: 0 }, false)).includes('0/4'));
});

test('a heart rate is a sensor reading like the others', () => {
  const out = text(tooltipHtml({ ...point, bpm: 69 }, false));
  assert.ok(out.includes('69'), out);
  assert.ok(out.includes('❤️'), out);
});

test('the temperature is split off the weather string and the sky becomes a glyph', () => {
  // The phone sends "29°C and Sunny" as one string. Those are two readings: a number
  // you compare with the last ping's, and a word you don't — which is now a glyph.
  const html = tooltipHtml({ ...point, wthr: '28°C and Sunny' }, false);
  const out = text(html);

  assert.ok(out.includes('28°C'), out);
  assert.ok(out.includes('☀️'), out);
  // The label survives where it can still be read, rather than being thrown away
  // with the word: "Rain and thunder" and "Isolated Thunderstorms" share a glyph.
  assert.ok(html.includes('title="Sunny"'), html);
});

test('a weather label with no temperature beside it still draws its glyph', () => {
  // A phone that stopped gluing the two together, which `splitWeather` allows for.
  const out = text(tooltipHtml({ ...point, wthr: 'Heavy Rain' }, false));
  assert.ok(out.includes('🌧️'), out);
  assert.ok(!out.includes('°C'), out);
});

// --- the weather ladder --------------------------------------------------------
// Order is the whole design here: it runs from the weather you would most want to
// know about down to the weather you wouldn't, so the first pattern to match wins.

test('a thunderstorm is never merely rain', () => {
  const glyph = wthr => text(tooltipHtml({ ...point, wthr }, false));

  assert.ok(glyph('Rain and thunder').includes('⛈️'));
  assert.ok(!glyph('Rain and thunder').includes('🌧️'));
  assert.ok(glyph('9°C and Isolated Thunderstorms').includes('⛈️'));
  // And plain rain still is.
  assert.ok(glyph('9°C and Showers').includes('🌧️'));
});

test('"Partly Cloudy", "Mostly Cloudy" and "Mostly Clear" are three answers', () => {
  // The qualifier has to be read together with what it qualifies. Mostly cloudy is
  // the cloudy one; partly cloudy and mostly clear are both the in-between one.
  const glyph = wthr => text(tooltipHtml({ ...point, wthr }, false));

  assert.ok(glyph('14°C and Partly Cloudy').includes('⛅'), 'partly cloudy');
  assert.ok(glyph('14°C and Mostly Clear').includes('⛅'), 'mostly clear');
  assert.ok(glyph('14°C and Mostly Cloudy').includes('☁️'), 'mostly cloudy');
  assert.ok(glyph('14°C and Cloudy').includes('☁️'), 'cloudy');
  assert.ok(glyph('14°C and Clear').includes('☀️'), 'clear');
});

test('the whole vocabulary resolves to something, including words nobody planned for', () => {
  const glyph = wthr => text(tooltipHtml({ ...point, wthr }, false));

  assert.ok(glyph('Blizzard').includes('❄️'));
  assert.ok(glyph('Heavy Snow').includes('❄️'));
  assert.ok(glyph('Freezing Drizzle').includes('🧊'), 'freezing beats drizzle');
  assert.ok(glyph('Sleet').includes('🧊'));
  assert.ok(glyph('Foggy').includes('🌫️'));
  assert.ok(glyph('Blowing Dust').includes('🌫️'));
  assert.ok(glyph('Breezy').includes('💨'));
  assert.ok(glyph('Hurricane').includes('🌀'));
  assert.ok(glyph('Tropical Storm').includes('🌀'), 'tropical beats storm');
  assert.ok(glyph('Tornado').includes('🌪️'), 'and a tornado is its own thing');
  // Nothing matched. A fallback glyph keeps the line's shape; drawing nothing would
  // look like a bug in the ping rather than a word the ladder had not met.
  assert.ok(glyph('Gorgeous').includes('🌡️'));
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
  assert.ok(out.includes('10m'), out);
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

// --- predictions, and the width of the window round them -----------------------

const MIN = 60000;

test('a forecast is fenced off from everything that was measured', () => {
  // The border is the only thing on a tooltip saying which figures came from a phone
  // and which from a model. Before this, the forecast was one grey line among nine.
  const html = tooltipHtml({
    ...rich,
    stats: { ...rich.stats, forecast: { t: rich.t - 47000, error: 47000, lo: rich.t - 12 * MIN, hi: rich.t + 13 * MIN } }
  }, false);

  assert.equal((html.match(/class="pred"/g) || []).length, 1, html);
  const out = text(html);
  assert.ok(out.includes('Forecast'), out);
  // "Late" describes the RUNNER against the prediction: they arrived after it.
  assert.ok(out.includes('47s late'), out);
  assert.ok(out.includes('Likely'), out);
  assert.ok(out.includes('25m wide'), out);
});

test('a forecast that was right says so rather than quoting a sub-second miss', () => {
  const out = text(tooltipHtml({
    ...rich,
    stats: { ...rich.stats, forecast: { t: rich.t - 400, error: 400, lo: rich.t - MIN, hi: rich.t + MIN } }
  }, false));

  assert.ok(out.includes('spot on'), out);
  assert.ok(!out.includes('late'), out);
  assert.ok(!out.includes('early'), out);
});

test('arriving before the prediction is early, not a negative lateness', () => {
  const out = text(tooltipHtml({
    ...rich,
    stats: { ...rich.stats, forecast: { t: rich.t + 90000, error: -90000, lo: rich.t, hi: rich.t + 5 * MIN } }
  }, false));

  assert.ok(out.includes('1m 30s early'), out);
  assert.ok(!out.includes('-'), out);
});

test('no forecast means no prediction section', () => {
  assert.ok(!tooltipHtml(rich, false).includes('class="pred"'));
});

test('the bar grows with the window and pins at full width', () => {
  const width = spanMs => {
    const html = tooltipHtml({
      ...rich,
      stats: { ...rich.stats, forecast: { t: rich.t, error: 0, lo: rich.t, hi: rich.t + spanMs } }
    }, false);
    return Number(html.match(/width:([\d.]+)%/)[1]);
  };

  // Scaled to `uncertaintyRefMs`, which is 30 minutes: a quarter-hour window is half
  // the track, on every ping of every run. That fixed ruler is what makes two bars
  // worth comparing at all.
  assert.equal(width(15 * MIN), 50);
  assert.ok(width(6 * MIN) < width(20 * MIN));
  // A window wider than the reference pins rather than overflowing its own track.
  assert.equal(width(3 * 3600000), 100);
  assert.equal(width(0), 0);
});

test('a hovered spot past the runner predicts, in the same section as a ping does', () => {
  // Typeset by the same builder, because it is the same claim — one made about the
  // future and one about the past. Two builders would make them look like two kinds.
  const c = course();
  const points = [ping('a', 0, 0), ping('b', 20, 1000), ping('c', 40, 2000)];
  const forecast = buildForecast(points, c);
  const html = hoverTooltipHtml(interpolateAt(points, c, 3500, forecast));

  assert.ok(html.includes('class="pred"'), html);
  assert.ok(text(html).includes('Predicted'), html);
  assert.ok(html.includes('class="bar"'), html);
  assert.ok(!text(html).includes('Not reached yet'), html);
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

test('a leg that rounds away to zero is left off rather than shown as "+0 m"', () => {
  // Found on the real runs in this repo: `stats.down` comes back as fractions of a
  // metre left over from the elevation threshold, so a flat kilometre drew a column of
  // "+0 m". Beside a total that reads as a measured zero — "this leg was flat" —
  // rather than as a number too small to have a digit.
  const out = text(tooltipHtml({
    ...rich,
    stats: { ...rich.stats, dist: 0.4, up: 0.2, down: 0 }
  }, false));

  assert.ok(!out.includes('+0 m'), out);
  // The totals are untouched: they are big enough to have digits.
  assert.ok(out.includes('1,240 m'), out);
  assert.ok(out.includes('980 m'), out);
});
