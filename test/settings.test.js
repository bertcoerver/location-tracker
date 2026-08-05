// What a run says about itself. Two things are being defended here:
//
//   1. A settings file is written by hand, mid-race, quite possibly on a phone. One
//      mistyped field must cost that field and nothing else — a parser that throws
//      the document away over a bad distance takes the race's name off the screen.
//   2. `ping_frequency` is a file in a repo reaching into the poll scheduler, and
//      the API budget is 60 requests an hour. It is the one thing here that is
//      clamped rather than merely validated.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { parseSettings } from '../src/settings.js';

const GUN = Date.parse('2026-08-28T09:00:00+02:00');

// --- the shape of the thing --------------------------------------------------

test('an empty or absent file is not an error, it is a run with nothing to say', () => {
  assert.deepEqual(parseSettings({}), {});
  assert.deepEqual(parseSettings(null), {});
  assert.deepEqual(parseSettings(undefined), {});
  // What a `.json` holding a bare string or an array parses to. Not a crash.
  assert.deepEqual(parseSettings('nope'), {});
  assert.deepEqual(parseSettings([1, 2]), {});
});

test('any subset is legal, and names only what it names', () => {
  const found = parseSettings({ label: 'UTMB' });

  assert.deepEqual(found, { label: 'UTMB' });
  // Absent, not null. Everything downstream reads these with `??`, and a null would
  // read as "this run has explicitly no label" rather than "the file didn't say".
  assert.equal('start' in found, false);
  assert.equal('ping' in found, false);
});

test('id is read by humans and ignored by this', () => {
  // The folder name is the run's identity — the URL, the caches and the beacons all
  // key on it. A file that could rename its own run would be one thing to the tree
  // API and another to everything downstream of it.
  assert.deepEqual(parseSettings({ id: 'somewhere-else', label: 'UTMB' }), { label: 'UTMB' });
});

// --- the label ---------------------------------------------------------------

test('a label is trimmed, and an empty one is no label at all', () => {
  assert.equal(parseSettings({ label: '  UTMB  ' }).label, 'UTMB');
  // The folder name is a better heading than a blank one.
  assert.equal('label' in parseSettings({ label: '   ' }), false);
  assert.equal('label' in parseSettings({ label: 42 }), false);
});

test('a label may be anything a person would write', () => {
  // Emoji and accents need no special handling at all — the page is UTF-8 and this
  // string reaches a text node. Worth a test precisely because it is the thing
  // somebody will assume needs escaping and then escape twice.
  assert.equal(parseSettings({ label: 'Île de Ré 👟' }).label, 'Île de Ré 👟');
});

// --- the gun -----------------------------------------------------------------

test('the underscore offset a filename forces is understood here too', () => {
  // Every timestamp anyone in this repo has ever typed writes `+02_00`, because a
  // filename cannot hold a colon. Carried across into JSON it is perfectly legible
  // and `Date.parse` returns NaN on it. Both spellings mean one instant.
  assert.equal(parseSettings({ start_datetime: '2026-08-28T09:00:00+02_00' }).start, GUN);
  assert.equal(parseSettings({ start_datetime: '2026-08-28T09:00:00+02:00' }).start, GUN);
  assert.equal(parseSettings({ start_datetime: '2026-08-28T09_00_00+0200' }).start, GUN);
});

test('seconds are optional and a bare date is not a start', () => {
  assert.equal(parseSettings({ start_datetime: '2026-08-28T09:00+02:00' }).start, GUN);
  // Midnight in some zone, invented out of nothing, is worse than no gun at all.
  assert.equal('start' in parseSettings({ start_datetime: '2026-08-28' }), false);
  assert.equal('start' in parseSettings({ start_datetime: 'next tuesday' }), false);
  assert.equal('start' in parseSettings({ start_datetime: 12345 }), false);
});

// --- the ping curve, which is the one clamped thing --------------------------

test('a ping curve in minutes becomes one in milliseconds', () => {
  const { ping } = parseSettings({
    ping_frequency: { min_interval: 5, max_interval: 30, k: 0.3, midpoint: 25 }
  });

  assert.deepEqual(ping, {
    minPingMs: 300000, maxPingMs: 1800000, batteryK: 0.3, batteryMid: 25
  });
});

test('each key of the curve falls back on its own', () => {
  // The units are not uniform, and this is the test that says so out loud: the
  // intervals are minutes, `k` is per battery-point, `midpoint` is a percentage.
  const { ping } = parseSettings({ ping_frequency: { midpoint: 40 } });

  assert.equal(ping.batteryMid, 40);
  assert.equal(ping.minPingMs, CONFIG.minPingMs);
  assert.equal(ping.maxPingMs, CONFIG.maxPingMs);
  assert.equal(ping.batteryK, CONFIG.batteryK);
});

test('a min_interval under the floor is refused, not clamped up to it', () => {
  // The whole reason `pingFloorMs` exists. `nextPollMs` sleeps about one ping
  // interval, so a zero here makes every branch return the 30-second floor, which
  // spends 60 requests an hour in half an hour and locks the map out for everyone
  // behind the same IP — with nothing on screen saying why.
  assert.equal('ping' in parseSettings({ ping_frequency: { min_interval: 0 } }), false);
  assert.equal('ping' in parseSettings({ ping_frequency: { min_interval: 0.5 } }), false);

  const floorMinutes = CONFIG.pingFloorMs / 60000;
  assert.equal(
    parseSettings({ ping_frequency: { min_interval: floorMinutes } }).ping.minPingMs,
    CONFIG.pingFloorMs,
    'exactly at the floor is allowed — it is a floor, not a threshold'
  );
});

test('a malformed curve falls back whole, never half', () => {
  // A sane min beside a nonsense max is not four independent numbers, it is one
  // shape — and half of it applied to half of the default is a curve nobody chose.
  const cases = [
    { min_interval: 5, max_interval: 'thirty' },
    { min_interval: 30, max_interval: 5 },     // ends the wrong way round
    { min_interval: 5, k: -1 },                 // a curve that slows down on charge
    { min_interval: 5, midpoint: 150 },         // a knee no battery can reach
    { min_interval: 5, midpoint: -10 }
  ];

  for (const ping_frequency of cases) {
    assert.equal('ping' in parseSettings({ ping_frequency }), false,
      `${JSON.stringify(ping_frequency)} must not produce a partial curve`);
  }
});

test('equal ends are a legal fixed-interval curve', () => {
  // `min + 0 / anything` is `min` at every battery level, which is a phone that
  // pings on a timer. Nothing about that is malformed.
  const { ping } = parseSettings({ ping_frequency: { min_interval: 10, max_interval: 10 } });
  assert.equal(ping.minPingMs, 600000);
  assert.equal(ping.maxPingMs, 600000);
});

test('anything that is not an object is not a curve', () => {
  assert.equal('ping' in parseSettings({ ping_frequency: 5 }), false);
  assert.equal('ping' in parseSettings({ ping_frequency: null }), false);
  assert.equal('ping' in parseSettings({ ping_frequency: {} }), true, 'but an empty one is');
});

// --- the stated figures ------------------------------------------------------

test('distance and ascent are taken only when they are numbers', () => {
  const found = parseSettings({ distance: 165, total_ascent: 9900 });
  assert.equal(found.distance, 165);
  assert.equal(found.totalAscent, 9900);

  // "165 km" is the likeliest way to get this wrong, and it must cost the distance
  // and not the file.
  const typed = parseSettings({ distance: '165 km', total_ascent: 9900, label: 'UTMB' });
  assert.equal('distance' in typed, false);
  assert.equal(typed.totalAscent, 9900);
  assert.equal(typed.label, 'UTMB');

  assert.equal('distance' in parseSettings({ distance: 0 }), false);
  assert.equal('distance' in parseSettings({ distance: -5 }), false);
});

// --- the banner --------------------------------------------------------------

test('a banner is kept whole, markdown and all', () => {
  // This layer's job is to say what the file contained. What it MEANS is news.js's.
  const text = 'Official Race Odometer [here](https://some.url)';
  assert.equal(parseSettings({ news_banner: text }).banner, text);
  assert.equal('banner' in parseSettings({ news_banner: '   ' }), false);
});

// --- the speed ceiling -------------------------------------------------------

test('a run may state the speed its snapping should believe', () => {
  // km/h, and the only field here the SNAPPING reads. Absent, CONFIG decides.
  assert.equal(parseSettings({ max_speed: 35 }).maxSpeed, 35);
  assert.equal('maxSpeed' in parseSettings({}), false);

  // Read exactly like `distance` above, so the same typo costs the same field
  // and nothing else.
  assert.equal('maxSpeed' in parseSettings({ max_speed: '35 km/h' }), false);
  assert.equal('maxSpeed' in parseSettings({ max_speed: 0 }), false);
  assert.equal('maxSpeed' in parseSettings({ max_speed: -10 }), false);
});

// --- the crew ----------------------------------------------------------------

test('a run may name the people who are out there with cameras', () => {
  // Casing preserved, because this string is shown to a reader on the photograph's
  // card. The ALL-CAPS rule belongs to the filename — see `crewOf` in media.js.
  assert.deepEqual(parseSettings({ crew: ['Mariam', 'Jo'] }).crew, ['Mariam', 'Jo']);
  assert.deepEqual(parseSettings({ crew: ['  Mariam  '] }).crew, ['Mariam']);
  assert.equal('crew' in parseSettings({}), false);
});

test('a malformed crew costs the crew and nothing else', () => {
  assert.equal('crew' in parseSettings({ crew: 'Mariam' }), false);
  assert.equal('crew' in parseSettings({ crew: [] }), false);
  assert.equal('crew' in parseSettings({ crew: ['   '] }), false);
  assert.equal('crew' in parseSettings({ crew: null }), false);

  const both = parseSettings({ crew: 'Mariam', label: 'Lac' });
  assert.equal(both.label, 'Lac');
});

test('one unusable name does not take the rest of the crew with it', () => {
  // Unlike `ping_frequency`, which is all-or-nothing because four numbers are one
  // curve. A list of people with a blank in it is still a list of people, and
  // dropping it whole would put every crew photograph back on the runner's course.
  assert.deepEqual(parseSettings({ crew: ['Mariam', '', 7, null, 'Jo'] }).crew, ['Mariam', 'Jo']);
});

test('a run may name its runner, and is under no obligation to', () => {
  assert.equal(parseSettings({ runners_name: 'Bert' }).runner, 'Bert');
  assert.equal(parseSettings({ runners_name: '  Bert  ' }).runner, 'Bert');
  // Absent is the ordinary case and the whole opt-in: no name, no byline on any
  // photograph in the folder.
  assert.equal('runner' in parseSettings({}), false);
  assert.equal('runner' in parseSettings({ runners_name: '   ' }), false);
  assert.equal('runner' in parseSettings({ runners_name: 42 }), false);
});
