// Only the pure, DOM-free half of layers.js is exercised here. The layer
// builders need deck.gl's global, which is a browser concern.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse } from '../src/course.js';
import {
  beaconLayers, beaconTooltipHtml, fmtDistance, forecastLayers, hoverTooltipHtml, makeTooltip,
  mediaTooltipHtml, splitWeather, sunGlyph, sunTooltipHtml, tooltipHtml, viewerLayers,
  waypointTooltipHtml
} from '../src/layers.js';
import { buildForecast } from '../src/predict.js';
import { interpolateAt } from '../src/stats.js';
import { dayTag, fmtClock } from '../src/util.js';

// Midday in the Alps in July, which matters to exactly one thing here: the weather
// glyph now asks whether the sun was up, and this fix is in broad daylight.
const point = {
  name: '2026-07-28T12_06_01+02_00.json',
  t: Date.parse('2026-07-28T12:06:01+02:00'),
  lat: 46.5,
  lon: 8.1
};

/** The same place thirteen hours on — 01:06 local, and comfortably dark. */
const afterDark = { ...point, t: point.t + 13 * 3600000 };

/** Strip the markup so a test reads what a person would see. */
const text = html => html
  .replace(/<[^>]+>/g, '\n')
  .replace(/&middot;/g, '·')
  .replace(/&ndash;/g, '–')
  .replace(/&uarr;/g, '↑')
  .replace(/&darr;/g, '↓')
  .replace(/&thinsp;|&#8202;|&nbsp;/g, ' ');

/** How many reading rows a tooltip drew — the icon-and-value kind. */
const rowCount = html => (html.match(/class="row\b/g) || []).length;

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

test('pace over the last leg is a reading of its own, in both units', () => {
  // The number a runner actually wants, and neither row has a total to lead on: a pace
  // is always about a stretch, and the stretch that matters is the last one.
  //
  // Both units from one measurement, because the two audiences don't convert: a runner
  // thinks in min/km, anyone following by car or bike thinks in km/h.
  const html = tooltipHtml(rich, false);
  const out = text(html);

  assert.ok(out.includes('3:30 min/km'), out);
  // In the column the legs live in, quietly, because it is the same measurement said
  // differently — two rows claimed two measurements.
  assert.match(html, /class="p">3:30&thinsp;min\/km<\/span><span class="s">17\.1&thinsp;km\/h/);
});

test('a ping with no pace yet shows neither pace nor speed', () => {
  // The first snapped ping of a run, or a runner who has not moved. See `deriveStats`.
  // One missing measurement, so both readings of it go.
  const html = tooltipHtml({ ...rich, stats: { ...rich.stats, pace: undefined } }, false);
  const out = text(html);

  assert.ok(!out.includes('/km'), out);
  assert.ok(!out.includes('km/h'), out);
  assert.equal(rowCount(html), 4, html);
  assert.equal(rowCount(tooltipHtml(rich, false)), 5, 'the pace row went missing too');
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

// --- the status bar, and the weather ------------------------------------------

test('battery and signal sit on the title line, drawn rather than lettered', () => {
  const html = tooltipHtml({ ...point, btry: 73, ntwrk: 3 }, false);

  // Both inside the one status group, which is inside the title row — this is a
  // phone's status bar, and it is one line with the time.
  const bar = /<div class="t">.*?<span class="st">(.*?)<\/span><\/div>/s.exec(html);
  assert.ok(bar, html);
  assert.ok(bar[1].includes('73%'), bar[1]);
  // The signal has no text at all: the icon IS the reading, so its label is where
  // "3/4" survives — for a screen reader and for a pointer resting on it.
  assert.ok(bar[1].includes('aria-label="Signal 3/4"'), bar[1]);
  assert.ok(bar[1].includes('aria-label="Battery 73%"'), bar[1]);
});

test('the drawn battery is as full as the phone was', () => {
  // The whole reason these two are SVG and everything else is an emoji: 🔋 is the
  // same glyph at 4% as at 100%, so it could only ever label a number. A drawn cell
  // carries the reading in its shape.
  const fill = pct => Number(/<rect x="2" y="2" width="([\d.]+)"/
    .exec(tooltipHtml({ ...point, btry: pct }, false))[1]);

  assert.ok(fill(100) > fill(50), 'a full battery is not drawn fuller than a half one');
  assert.ok(fill(50) > fill(10));
  // A floor, so 1% is a sliver: an empty shell reads as "no reading", which is a
  // different thing from "nearly flat".
  assert.ok(fill(1) > 0);
  assert.equal(fill(0), 0);
});

test('the drawn signal lights as many bars as the phone had', () => {
  const lit = n => (tooltipHtml({ ...point, ntwrk: n }, false)
    .match(/fill-opacity="1"/g) || []).length;

  assert.equal(lit(4), 4);
  assert.equal(lit(2), 2);
  // A phone with no bars is exactly the interesting case: it explains the gap in the
  // trail on either side of this ping. `0` must be drawn, and drawn as empty.
  assert.equal(lit(0), 0);
  assert.ok(tooltipHtml({ ...point, ntwrk: 0 }, false).includes('aria-label="Signal 0/4"'));
});

test('each status reading can be missing on its own', () => {
  // Every file written before a field existed has none of it, which is most of them.
  assert.ok(tooltipHtml({ ...point, btry: 76 }, false).includes('76%'));
  assert.ok(tooltipHtml({ ...point, btry: 76 }, false).includes('class="st"'));

  const signal = tooltipHtml({ ...point, ntwrk: 2 }, false);
  assert.ok(signal.includes('aria-label="Signal 2/4"'), signal);
  // And no battery beside it. Read out of the status group rather than off the whole
  // card, since the Maps link's URL escaping is full of percent signs.
  const bar = /<span class="st">(.*?)<\/span><\/div>/s.exec(signal);
  assert.ok(!bar[1].includes('%'), bar[1]);
});

test('a ping with neither battery nor signal has no status group at all', () => {
  const html = tooltipHtml(point, false);
  assert.ok(!html.includes('class="st"'), html);
  assert.ok(!html.includes('<svg'), html);
});

test('a heart rate is a reading of the run, with its unit', () => {
  // In with the pace and the climb rather than off among the handset readings: it is
  // what the last kilometre COST, which is a fact about the run.
  const html = tooltipHtml({ ...point, bpm: 69 }, false);
  const out = text(html);

  assert.ok(out.includes('69 bpm'), out);
  assert.ok(out.includes('❤️'), out);
  assert.equal(rowCount(html), 1, html);
});

test('the weather is its own line: one glyph, the temperature, and the label', () => {
  // The phone sends "28°C and Sunny" as one string. Those are two readings — a number
  // you compare with the last ping's, and a word you don't — but one sensor took both,
  // so the sky's glyph does duty for the thermometer that used to sit beside the number.
  const html = tooltipHtml({ ...point, wthr: '28°C and Sunny' }, false);
  const out = text(html);

  assert.equal((html.match(/class="wx"/g) || []).length, 1, html);
  assert.ok(out.includes('28°C'), out);
  assert.ok(out.includes('☀️'), out);
  // The label is kept, not replaced by the glyph: "Rain and thunder" and "Isolated
  // Thunderstorms" draw the same cloud, and this is where the difference survives.
  assert.ok(out.includes('Sunny'), out);
  // No thermometer anywhere. One sensor, one icon.
  assert.ok(!html.includes('🌡'), html);
});

test('a ping with no weather has no weather line', () => {
  assert.ok(!tooltipHtml(point, false).includes('class="wx"'));
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
  // A sun, and only because this fix is at midday — see the night twin below.
  assert.ok(glyph('14°C and Clear').includes('☀️'), 'clear');
});

// --- and the same ladder after dark --------------------------------------------
// Only the two entries that draw a sun change. Everything else looks the same at
// midnight, and the ladder's order is untouched by any of this.

const MOONS = ['\u{1F311}', '\u{1F312}', '\u{1F313}', '\u{1F314}',
  '\u{1F315}', '\u{1F316}', '\u{1F317}', '\u{1F318}'];

test('a clear night draws the moon, and no sun anywhere', () => {
  const html = tooltipHtml({ ...afterDark, wthr: '4°C and Clear' }, false);
  const out = text(html);

  assert.ok(MOONS.some(m => out.includes(m)), out);
  assert.ok(!out.includes('☀️'), out);
  assert.ok(!out.includes('⛅'), out);
  // The rest of the line is unchanged: the reading and the phone's own wording.
  assert.ok(out.includes('4°C'), out);
  assert.ok(out.includes('Clear'), out);
});

test('the moon drawn is the phase that was actually up', () => {
  // 29 July 2026 is a full moon, and this fix is the small hours of the 29th. Not
  // a property test — `test/sun.test.js` does the phases — but the one assertion
  // that the tooltip asks about its OWN moment rather than about now.
  const out = text(tooltipHtml({ ...afterDark, wthr: '4°C and Clear' }, false));
  assert.ok(out.includes('\u{1F315}'), out);
});

test('a cloud stays a cloud at night, and the label keeps the difference', () => {
  // ⛅ has no lunar twin in Unicode, so both cloudy answers draw ☁️ after dark and
  // the three-way distinction lives on the label beside it.
  const glyph = wthr => text(tooltipHtml({ ...afterDark, wthr }, false));

  for (const label of ['Partly Cloudy', 'Mostly Clear', 'Mostly Cloudy', 'Cloudy']) {
    const out = glyph(`4°C and ${label}`);
    assert.ok(out.includes('☁️'), `${label}: ${out}`);
    assert.ok(!out.includes('⛅'), `${label} drew a sun behind a cloud`);
    assert.ok(!MOONS.some(m => out.includes(m)), `${label} drew a moon`);
    assert.ok(out.includes(label), `${label} lost its wording`);
  }
});

test('weather that looks the same at midnight is drawn the same', () => {
  const day = wthr => text(tooltipHtml({ ...point, wthr }, false));
  const night = wthr => text(tooltipHtml({ ...afterDark, wthr }, false));

  for (const [label, want] of [['Heavy Rain', '🌧️'], ['Foggy', '🌫️'],
    ['Breezy', '💨'], ['Heavy Snow', '❄️'], ['Isolated Thunderstorms', '⛈️'],
    ['Gorgeous', '🌡️']]) {
    assert.ok(day(`4°C and ${label}`).includes(want), `${label} by day`);
    assert.ok(night(`4°C and ${label}`).includes(want), `${label} by night`);
  }
});

test('a ping that never snapped still resolves its own sky', () => {
  // No `snap`, so no height, so the sea-level horizon — the honest answer when we
  // do not know how high it was standing, and not a crash.
  const bare = { t: afterDark.t, lat: afterDark.lat, lon: afterDark.lon };
  const out = text(tooltipHtml({ ...bare, wthr: '4°C and Clear' }, false));
  assert.ok(MOONS.some(m => out.includes(m)), out);

  // And a snapped one is asked at the height the course records there.
  const high = { ...afterDark, snap: { along: 1000, lat: afterDark.lat,
    lon: afterDark.lon, ele: 2500, off: 4 } };
  assert.ok(MOONS.some(m => text(tooltipHtml({ ...high, wthr: '4°C and Clear' },
    false)).includes(m)));
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

test('a spot between two pings describes the ground, and claims no time', () => {
  const c = course();
  const points = [ping('a', 0, 0), ping('b', 20, 2000)];
  const html = hoverTooltipHtml(interpolateAt(points, c, 1000));
  const out = text(html);

  // The distance leads, carrying the same ruler the ping tooltips label theirs with,
  // and without the word "in" that a bare number used to need.
  assert.ok(out.includes('📏'), out);
  assert.ok(out.includes('1.0 km'), out);
  assert.ok(!out.includes('km in'), out);
  // No interpolated time. Straight-lining a clock across a leg that was climbed at
  // whatever pace it was climbed at is arithmetic, and the fixes either side both
  // carry times somebody actually recorded.
  assert.ok(!out.includes('estimated'), out);
  assert.ok(!out.includes('10m'), out);
  assert.ok(!out.includes('Not reached yet'), out, 'the runner has been past here');
  assert.ok(out.includes('📈'), out, 'climb is a fact about the course, known here');
});

test('past the last ping it says so rather than extrapolating a pace', () => {
  const c = course();
  const points = [ping('a', 0, 0), ping('b', 20, 2000)];
  const out = text(hoverTooltipHtml(interpolateAt(points, c, 3500)));

  assert.ok(out.includes('Not reached yet'), out);
  // The ground is still described — height and climb don't wait for a runner.
  assert.ok(out.includes('📈'), out);
  assert.ok(out.includes('3.5 km'), out);
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

test('a ping tooltip carries no prediction at all', () => {
  // It used to score each ping against the forecast made before it arrived — "47s
  // late" — which was a reading about the MODEL on a card about a runner. The one
  // place a prediction belongs is ground nobody has reached yet, which is the hover.
  const html = tooltipHtml(rich, true);

  assert.ok(!html.includes('class="pred"'), html);
  assert.ok(!html.includes('class="bar"'), html);
  // The scoring wording is gone with it. `\b` because the tag on the newest fix is
  // "latest", which is not a verdict on anybody's timekeeping.
  assert.ok(!/\blate\b|\bearly\b|spot on/.test(text(html)), html);
  assert.ok(!text(html).includes('Forecast'), html);
});

/** The prediction section for a spot the runner hasn't reached. */
function predicted(along = 3500) {
  const c = course();
  const points = [ping('a', 0, 0), ping('b', 20, 1000), ping('c', 40, 2000)];
  return hoverTooltipHtml(interpolateAt(points, c, along, buildForecast(points, c)));
}

test('a prediction is drawn as a diagram, centred on the predicted time', () => {
  // The window's two edges sit at the two ends of the bar, and the bar grows out from
  // the middle where the predicted time is — so nothing has to be read to see how
  // uncertain the answer is. "Likely 14:40 – 15:05" asked for arithmetic instead.
  const html = predicted();

  assert.equal((html.match(/class="pred"/g) || []).length, 1, html);
  assert.ok(html.includes('class="pv"'), html);
  assert.ok(html.includes('class="bar"'), html);
  // One line holding all three: the near edge, the width of the window, the far edge —
  // so the width reads as the gap those two numbers describe. A bare duration, since
  // the bar above it already says the word "wide".
  const edges = new RegExp('<div class="edges"><span>(\\d\\d:\\d\\d)</span>' +
    '<span class="wide">([^<]+)</span><span>(\\d\\d:\\d\\d)</span></div>').exec(html);
  assert.ok(edges, html);
  assert.ok(edges[1] < edges[3], `${edges[1]} is not before ${edges[3]}`);
  assert.match(edges[2], /^(\d+h )?\d+m( \d+s)?$|^\d+s$/);
  assert.ok(!text(html).includes('wide'), html);
  assert.ok(!text(html).includes('Likely'), html);
  // And the race clock at that moment, under the diagram — as an ordinary reading row,
  // typeset exactly as a ping states the elapsed time it measured. The diagram above it
  // is the part that is a diagram.
  const clock = html.slice(html.indexOf('class="edges"'));
  assert.match(clock, /<div class="row big"><span class="i" aria-hidden="true">🕒<\/span>/);
  assert.match(clock, /class="p">\d+h \d+m<\/span>/);
});

test('the prediction leads the card, and the distance follows it', () => {
  // It is the answer to the question that made somebody point at ground nobody has
  // reached. The distance and the climb are how far away "here" is.
  const html = predicted();

  assert.ok(html.indexOf('class="pred"') < html.indexOf('class="row'), html);
  // Which means it is also the first thing in the card, so it opens with no rule
  // above it — `:first-child` in the stylesheet.
  assert.ok(html.startsWith('<div class="pred">'), html);
  // No caption on the elapsed race time any more: it is a line of its own now.
  assert.ok(!/Predicted[^<]*&middot;/.test(html), html);
});

test('the bar grows with the window and pins at full width', () => {
  const width = spanMs => {
    const html = predictionSection({ t: 0, lo: 0, hi: spanMs });
    return Number(html.match(/width:([\d.]+)%/)[1]);
  };

  // Scaled to `uncertaintyRefMs`, which is 30 minutes: a quarter-hour window is half
  // the track, on every prediction of every run. That fixed ruler is what makes two
  // bars worth comparing at all.
  assert.equal(width(15 * MIN), 50);
  assert.ok(width(6 * MIN) < width(20 * MIN));
  // A window wider than the reference pins rather than overflowing its own track.
  assert.equal(width(3 * 3600000), 100);
  assert.equal(width(0), 0);
});

/**
 * `predictionHtml` is module-private, so it is reached the way the app reaches it:
 * through a hovered spot whose forecast has been replaced with a known window. The
 * geometry of the bar is what is under test, not the model behind it.
 */
function predictionSection({ t, lo, hi }) {
  const c = course();
  const points = [ping('a', 0, 0), ping('b', 20, 1000), ping('c', 40, 2000)];
  const at = interpolateAt(points, c, 3500, buildForecast(points, c));
  return hoverTooltipHtml({ ...at, predicted: { t, lo, hi } });
}

test('a hovered spot past the runner predicts rather than refusing to answer', () => {
  const html = predicted();

  assert.ok(text(html).includes('Predicted'), html);
  // Which replaces the refusal: there is a model, so there is an answer.
  assert.ok(!text(html).includes('Not reached yet'), html);
  // And the elapsed race time at that moment, on a row of its own under the diagram.
  assert.match(html.slice(html.indexOf('class="edges"')), /class="row big"/);
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

  assert.ok(out.html.includes('1.0 km'), out.html);
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

test('a photograph opts back IN, because it has nothing to click', () => {
  // deck lands the card's top-left corner on the cursor. A 340 px opaque picture
  // that accepts pointer events covers the very thumbnail deck is picking, the
  // pick comes back empty, the card hides, the pick succeeds again — a flicker at
  // pointer-event rate. Nothing in this one is reachable, so nothing is lost.
  const tooltip = makeTooltip(() => []);
  const out = tooltip({ object: mediaPoi(), layer: { id: 'media' } });

  assert.equal(out.style.pointerEvents, 'none');
});

test('an unchanged tooltip is moved, not rebuilt', () => {
  // deck asks on every pointer move and assigns innerHTML whenever it is given
  // any, so the same card was being destroyed and recreated dozens of times a
  // second. A fresh <img> repaints and a fresh <video autoplay> seeks to zero.
  const tooltip = makeTooltip(() => []);
  const info = { object: mediaPoi(), layer: { id: 'media' } };

  const first = tooltip(info);
  assert.ok(first.html, 'the first hover has to supply the markup');

  const second = tooltip(info);
  assert.ok(!('html' in second), 'rewrote identical markup deck already has');
  assert.equal(second.className, 'tip', 'still has to claim the class every time');

  // A different object writes again, or the card would never change.
  assert.ok(tooltip({ object: mediaPoi({ sha: 'm2', t: null }), layer: { id: 'media' } }).html);
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

// --- sunrise and sunset -------------------------------------------------------

const GUN = Date.parse('2026-08-22T20:00:00+02:00');

/** A sun POI as `sunPois` builds one. */
function sunPoi(over = {}) {
  return {
    kind: 'sun',
    event: 'sunset',
    t: GUN + 53 * 60000,
    lat: 42.79,
    lon: 0.14,
    along: 8823,
    ele: 1204,
    gap: 30 * 60000,
    ...over
  };
}

test('a sun mark says which event, when, and how far in', () => {
  const poi = sunPoi();
  const html = sunTooltipHtml(poi, GUN);
  const shown = text(html);

  // The wall clock in the title, where every tooltip on this page puts one, and the
  // event beside it. Against `fmtClock` rather than against a literal, because a
  // literal would only be right in the zone this file was written in — what is being
  // checked here is that the title carries the clock, and what the clock says is
  // `test/util.test.js`'s business.
  assert.match(shown, new RegExp(fmtClock(poi.t)));
  assert.match(shown, /· sunset/);
  // Then the race clock — the same 🕒 row a ping tooltip uses, in the same wording
  // and meaning the same thing: time on the clock, not time of day.
  assert.match(shown, /53m/);
  assert.match(shown, /8\.8 km/);
  assert.match(shown, /1,204 m/);
  assert.match(html, /href="https:\/\/maps\.google\.com\/\?q=/);
});

test('a sun mark on a later day is tagged with the day', () => {
  // Thirty hours in, which is a later calendar day in every zone on earth — an
  // eleven-hour gap is not, and that is what this used to assert.
  const t = GUN + 30 * 3600000;
  const html = sunTooltipHtml(sunPoi({ event: 'sunrise', t }), GUN);

  const day = dayTag(t, GUN);
  assert.ok(day, 'no day tag to look for');
  assert.match(html, new RegExp(`<span class="d">\\${day}</span>`), html);
  assert.match(text(html), /· sunrise/);
});

test('a sun mark placed across a long silence says it was interpolated', () => {
  const quiet = sunTooltipHtml(sunPoi({ gap: 100 * 60000 }), GUN);
  assert.match(text(quiet), /interpolated across 1h 40m/);

  // And not for an ordinary gap between pings, which is every mark on a run whose
  // phone was reporting normally.
  assert.doesNotMatch(text(sunTooltipHtml(sunPoi(), GUN)), /interpolated/);
});

test('a sun mark off the course keeps the rows it can still answer', () => {
  // A run with no GPX: a position and a moment, no distance and no height.
  const html = sunTooltipHtml(sunPoi({ along: null, ele: null }), GUN);
  const shown = text(html);

  assert.match(shown, /· sunset/);
  assert.doesNotMatch(shown, /km|NaN/);
  assert.doesNotMatch(shown, / m\b/);
  assert.match(html, /href="https:\/\/maps\.google\.com\/\?q=/);
});

test('a sun mark before the gun has no race clock rather than a negative one', () => {
  // A sunrise on the morning of a race that starts at eight in the evening, with a
  // phone that was already pinging: a real moment, and not one the race clock has
  // anything to say about.
  const html = sunTooltipHtml(sunPoi({ event: 'sunrise', t: GUN - 13 * 3600000 }), GUN);

  // No 🕒 row at all, rather than one reading "-13h". The DAY tag is a different
  // matter and is expected to read `-1`: that one is a fact about the calendar and
  // says the useful thing, which is that this was the morning before.
  assert.doesNotMatch(html, /\u{1F552}/u, html);
  // And no crash with no origin at all, which is a caller that has no points.
  assert.match(text(sunTooltipHtml(sunPoi(), null)), /· sunset/);
});

test('a sun mark is not mistaken for a ping', () => {
  // The dispatch trap this feature is most likely to fall into: a sun POI carries
  // a `t`, and the fall-through in `makeTooltip` tests for nothing at all.
  const html = makeTooltip(() => [])({ object: sunPoi(), layer: { id: 'sun' } }).html;

  assert.match(text(html), /· sunset/, html);
  assert.doesNotMatch(html, /class="st"/, 'described a sunset as a phone');
});

// --- photographs and clips ----------------------------------------------------

/** A media POI as `placeMedia` builds one. */
function mediaPoi(over = {}) {
  return {
    kind: 'media',
    name: '2026-08-22T20_53_00+02_00.jpeg',
    sha: 'm1',
    url: 'https://raw.githubusercontent.com/o/r/main/locations/run/2026-08-22T20_53_00+02_00.jpeg?m1',
    animated: false,
    assumedUtc: false,
    t: GUN + 53 * 60000,
    lat: 42.79,
    lon: 0.14,
    along: 8823,
    ele: 1204,
    gap: 30 * 60000,
    source: 'trace',
    point: false,
    ...over
  };
}

test('a photo IS the tooltip, with its readings laid over the picture', () => {
  const poi = mediaPoi();
  const html = mediaTooltipHtml(poi, GUN);

  // The picture first and inside nothing but the figure, because the stylesheet
  // drops the card's padding for exactly this shape — see `.tip:has(.ph)`.
  assert.match(html, /^<figure class="ph"><img class="media" src="[^"]+\.jpeg\?m1" alt="">/, html);
  assert.match(html, /<figcaption class="cap">/, html);

  assert.match(text(html), new RegExp(fmtClock(poi.t)));
  assert.match(text(html), /53m/);
  assert.match(text(html), /8\.8 km/);
  assert.match(text(html), /1,204 m/);
});

test('a photo does not offer to open itself somewhere else', () => {
  // The marker is already ON the map, at the place in question. A Maps link is the
  // answer to "where is this", and pointing at it was the question.
  assert.doesNotMatch(mediaTooltipHtml(mediaPoi(), GUN), /maps\.google\.com/);
});

test('a clip is a player and a gif is not', () => {
  // A GIF animates perfectly well as an image, and wrapping it in a player would
  // give it controls it has no use for.
  const clip = mediaTooltipHtml(mediaPoi({ name: 'a.webm', animated: true }), GUN);
  assert.match(clip, /<video class="media"[^>]*\bloop\b/, clip);
  assert.match(clip, /\bmuted\b/);
  assert.match(clip, /\bplaysinline\b/);

  const gif = mediaTooltipHtml(mediaPoi({ name: 'a.gif', animated: true }), GUN);
  assert.match(gif, /<img class="media"/, gif);
  assert.doesNotMatch(gif, /<video/);
});

test('the caption says nothing about where the position came from', () => {
  // That fact moved onto the map itself: the dot under the picture is the accent
  // when the photo recorded its own coordinates and the course purple when it was
  // placed between the pings either side. See `mediaLayers`.
  for (const source of ['exif', 'trace']) {
    const html = text(mediaTooltipHtml(mediaPoi({ source }), GUN));
    assert.doesNotMatch(html, /placed from|interpolated from/, source);
  }
});

test('a photo whose zone nobody recorded says so too', () => {
  assert.match(text(mediaTooltipHtml(mediaPoi({ assumedUtc: true }), GUN)), /zone\?/);
  assert.doesNotMatch(text(mediaTooltipHtml(mediaPoi(), GUN)), /zone\?/);
});

test('a photo with no moment is titled like a place', () => {
  // Rule four: coordinates and no timestamp anywhere. There is no wall clock to
  // put in the title, so the filename goes there — the waypoint treatment, for a
  // thing that has become a place.
  const html = mediaTooltipHtml(mediaPoi({
    name: 'summit.jpg', t: null, along: null, source: 'exif'
  }), GUN);

  assert.match(text(html), /summit/);
  assert.doesNotMatch(html, /\u{1F552}/u, 'gave a race clock to a mark with no time');
});

test('a photo before the gun has no race clock rather than a negative one', () => {
  const html = mediaTooltipHtml(mediaPoi({ t: GUN - 3600000 }), GUN);
  assert.doesNotMatch(html, /\u{1F552}/u, html);
});

test('a photo placed across a long silence marks its distance approximate', () => {
  // The caption has room for an annotation and none for a sentence, so the caveat
  // is a `~` on the figure it qualifies rather than a line underneath it.
  assert.match(text(mediaTooltipHtml(mediaPoi({ gap: 100 * 60000 }), GUN)), /~8\.8 km/);
  assert.doesNotMatch(text(mediaTooltipHtml(mediaPoi(), GUN)), /~8\.8 km/);
});

test('a filename cannot break out of the attributes it is written into', () => {
  // Anything at all can be committed to a run's folder, so a filename is not a
  // trusted string — and it reaches the page twice, as a src and as a title.
  const html = mediaTooltipHtml(mediaPoi({
    name: '"><script>alert(1)</script>.jpg',
    url: 'https://example/"><script>alert(1)</script>.jpg',
    t: null
  }), GUN);

  assert.doesNotMatch(html, /<script>/, html);
});

test('a photo is not mistaken for a ping', () => {
  // The same dispatch trap the sun falls into, and worse: a photo that recorded
  // its own coordinates is genuinely IN the points array, so it has every field
  // the fall-through tests for.
  const poi = mediaPoi({ source: 'exif', point: true });
  const html = makeTooltip(() => [])({ object: poi, layer: { id: 'media' } }).html;

  assert.match(html, /<img class="media"/, html);
  assert.doesNotMatch(html, /class="st"/, 'described a photograph as a phone');
});

test('the two sun glyphs are one character each and not the same one', () => {
  // The height strip draws these with canvas `fillText` while the map draws them
  // through an icon atlas, and both take them from here — so this is the one place
  // the pair is stated. They have to differ: two marks a night that look alike are
  // two marks that say nothing.
  const rise = sunGlyph('sunrise');
  const set = sunGlyph('sunset');

  assert.notEqual(rise, set);
  assert.equal([...rise].length, 1, `${rise} is not one character`);
  assert.equal([...set].length, 1, `${set} is not one character`);
});
