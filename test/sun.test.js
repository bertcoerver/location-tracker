import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse, pointAt } from '../src/course.js';
import { isDaylight, moonPhase, sunPois, sunTimes } from '../src/sun.js';

const MINUTE = 60000;
const HOUR = 3600000;

// Every case is built from `Date.UTC` and asserted in UTC, so nothing here depends
// on the `TZ` the suite happens to run under.
const hhmm = t => `${new Date(t).toISOString().slice(11, 16)}`;

/** How far apart two moments are, in minutes. */
const apart = (a, b) => Math.abs(a - b) / MINUTE;

/** Assert `t` is within `minutes` of `Date.UTC(...)`-style `want`. */
function near(t, want, minutes, what) {
  assert.ok(t !== null, `${what}: no event at all`);
  assert.ok(apart(t, want) <= minutes,
    `${what}: ${hhmm(t)} is ${apart(t, want).toFixed(1)} min from ${hhmm(want)}`);
}

// --- the astronomy ------------------------------------------------------------

test('sunrise and sunset match the almanac', () => {
  // Two spot-checks against published figures, which is the only kind of test that
  // can catch a reduction that is self-consistently wrong. London at the June
  // solstice — 04:43 and 21:21 BST — and Quito at the equinox.
  const london = sunTimes(Date.UTC(2026, 5, 21, 12), 51.5074, -0.1278);
  near(london.sunrise, Date.UTC(2026, 5, 21, 3, 43), 3, 'London sunrise');
  near(london.sunset, Date.UTC(2026, 5, 21, 20, 21), 3, 'London sunset');

  const quito = sunTimes(Date.UTC(2026, 2, 20, 12), -0.1807, -78.4678);
  near(quito.sunrise, Date.UTC(2026, 2, 20, 11, 17), 3, 'Quito sunrise');
  near(quito.sunset, Date.UTC(2026, 2, 20, 23, 24), 3, 'Quito sunset');

  // And a southern-hemisphere spring evening on Réunion, where the ultra this page
  // was written for is run: sunset at 18:22 local, UTC+4.
  const reunion = sunTimes(Date.UTC(2026, 9, 18, 6), -21.115, 55.536);
  near(reunion.sunset, Date.UTC(2026, 9, 18, 14, 22), 4, 'Réunion sunset');
});

test('the midpoint of the two is solar noon', () => {
  // Which at longitude 0 is 12:00 UTC, give or take the equation of time — the
  // ±17 minutes by which a sundial and a clock disagree over a year. Any sign
  // error in the longitude or the hour angle breaks this on some date.
  for (const month of [0, 2, 5, 8, 10]) {
    const { sunrise, sunset } = sunTimes(Date.UTC(2026, month, 15, 12), 45, 0);
    const noon = (sunrise + sunset) / 2;
    near(noon, Date.UTC(2026, month, 15, 12), 17, `solar noon in month ${month}`);
  }
});

test('fifteen degrees of longitude is an hour', () => {
  const here = sunTimes(Date.UTC(2026, 3, 10, 12), 45, 0);
  const east = sunTimes(Date.UTC(2026, 3, 10, 12), 45, 15);

  // East is earlier: the sun gets there first.
  near(east.sunrise, here.sunrise - HOUR, 1, 'sunrise 15° east');
  near(east.sunset, here.sunset - HOUR, 1, 'sunset 15° east');
});

test('a northern summer day is long and a northern winter day is short', () => {
  const june = sunTimes(Date.UTC(2026, 5, 21, 12), 60, 0);
  const december = sunTimes(Date.UTC(2026, 11, 21, 12), 60, 0);

  const length = s => (s.sunset - s.sunrise) / HOUR;
  assert.ok(length(june) > 18, `June at 60°N was only ${length(june).toFixed(1)} h`);
  assert.ok(length(december) < 7, `December at 60°N was ${length(december).toFixed(1)} h`);

  // The two solstices are complements: as much daylight in June as darkness in
  // December, to within the refraction that lengthens both.
  assert.ok(Math.abs(length(june) + length(december) - 24) < 1.2,
    `${length(june).toFixed(1)} + ${length(december).toFixed(1)}`);
});

test('a sun that never crosses the horizon is reported as no event', () => {
  // Both directions of the polar case, and both come back as an absence rather
  // than as a NaN, a zero, or a time in the middle of a day nothing happened on.
  for (const [label, when] of [['midsummer', Date.UTC(2026, 5, 21, 12)],
    ['midwinter', Date.UTC(2026, 11, 21, 12)]]) {
    const at80 = sunTimes(when, 80, 0);
    assert.equal(at80.sunrise, null, `${label} sunrise at 80°N`);
    assert.equal(at80.sunset, null, `${label} sunset at 80°N`);
  }

  // And at the other pole, where the seasons are the other way round.
  assert.equal(sunTimes(Date.UTC(2026, 5, 21, 12), -80, 0).sunrise, null);
});

test('the two polar skies are told apart, and an ordinary day is neither', () => {
  // A sun that never sets and a sun that never rises were one answer — both
  // events null — which is right about the crossings and silent about the sky.
  assert.equal(sunTimes(Date.UTC(2026, 5, 21, 12), 80, 0).polar, 'day');
  assert.equal(sunTimes(Date.UTC(2026, 11, 21, 12), 80, 0).polar, 'night');
  // Southern hemisphere, so the seasons swap and the answers with them.
  assert.equal(sunTimes(Date.UTC(2026, 5, 21, 12), -80, 0).polar, 'night');
  assert.equal(sunTimes(Date.UTC(2026, 11, 21, 12), -80, 0).polar, 'day');

  // Exactly at the pole the hour angle divides by a cosine of zero. The infinity
  // that comes back lands on the correct side of the range on its own, which is
  // worth pinning: it is the one input where the arithmetic and not a branch is
  // doing the work.
  assert.equal(sunTimes(Date.UTC(2026, 5, 21, 12), 90, 0).polar, 'day');
  assert.equal(sunTimes(Date.UTC(2026, 11, 21, 12), 90, 0).polar, 'night');

  // And a day with crossings has no polar answer to give.
  assert.equal(sunTimes(Date.UTC(2026, 5, 21, 12), 45, 0).polar, null);
});

test('isDaylight agrees with the crossings it is asked about', () => {
  // The property the weather glyph rests on: a ping a minute after the sunrise
  // mark on the course must be daylight, and one a minute before it must not. Two
  // formulas agreeing to within seconds would not be enough — this is the same
  // arithmetic, asserted to be the same.
  for (const [lat, lon, ele] of [[45.9, 6.5, null], [51.5, -0.13, null],
    [-21.1, 55.5, 2500], [42.8, 0.15, 1800], [60, 24.9, null]]) {
    for (const month of [0, 3, 6, 9]) {
      const noon = Date.UTC(2026, month, 15, 12);
      const { sunrise, sunset } = sunTimes(noon, lat, lon, ele);
      const where = `${lat},${lon} in month ${month}`;

      assert.equal(isDaylight(sunrise - MINUTE, lat, lon, ele), false,
        `a minute before sunrise at ${where}`);
      assert.equal(isDaylight(sunrise + MINUTE, lat, lon, ele), true,
        `a minute after sunrise at ${where}`);
      assert.equal(isDaylight(sunset - MINUTE, lat, lon, ele), true,
        `a minute before sunset at ${where}`);
      assert.equal(isDaylight(sunset + MINUTE, lat, lon, ele), false,
        `a minute after sunset at ${where}`);
    }
  }
});

test('isDaylight knows midday from midnight, either side of the equator', () => {
  // Solar midday and midnight rather than the clock's, so no case here depends on
  // the offset between a longitude and its timezone.
  for (const [lat, lon] of [[45.9, 6.5], [-21.1, 55.5], [1.35, 103.8]]) {
    for (const month of [0, 5, 8, 11]) {
      const { sunrise, sunset } = sunTimes(Date.UTC(2026, month, 15, 12), lat, lon);
      const noon = (sunrise + sunset) / 2;
      const where = `${lat},${lon} in month ${month}`;

      assert.equal(isDaylight(noon, lat, lon), true, `solar noon at ${where}`);
      assert.equal(isDaylight(noon + 12 * HOUR, lat, lon), false,
        `solar midnight at ${where}`);
    }
  }
});

test('isDaylight in the polar cases follows the sky, not the clock', () => {
  // A June midnight at 80°N is broad daylight and a December noon is not, and
  // there are no crossings on either day to decide it from.
  for (let hour = 0; hour < 24; hour += 3) {
    assert.equal(isDaylight(Date.UTC(2026, 5, 21, hour), 80, 0), true,
      `80°N in June at ${hour}:00`);
    assert.equal(isDaylight(Date.UTC(2026, 11, 21, hour), 80, 0), false,
      `80°N in December at ${hour}:00`);
  }
});

test('standing high enough turns a minute of night into daylight', () => {
  // The horizon dip reaching this function too, which is what keeps the glyph on a
  // tooltip and the mark on the course from disagreeing about a mountain sunrise.
  const at = Date.UTC(2026, 7, 22, 12);
  const { sunrise } = sunTimes(at, 45, 0);

  // Five minutes before the sea-level sunrise: night at the beach, and up at
  // 2,500 m the sun has been up for a few minutes already.
  const dark = sunrise - 5 * MINUTE;
  assert.equal(isDaylight(dark, 45, 0), false, 'sea level');
  assert.equal(isDaylight(dark, 45, 0, 2500), true, 'at 2,500 m');
});

// --- the moon -----------------------------------------------------------------

test('the moon phase matches the almanac at the four turning points', () => {
  // Four dates with a name, each read at the moment the phase was exact. Nothing
  // here is tuned to the implementation: these are published times.
  const cases = [
    [Date.UTC(2025, 5, 11, 7, 44), '\u{1F315}', 'full, 11 June 2025'],
    [Date.UTC(2025, 5, 25, 10, 31), '\u{1F311}', 'new, 25 June 2025'],
    [Date.UTC(2025, 6, 2, 19, 30), '\u{1F313}', 'first quarter, 2 July 2025'],
    [Date.UTC(2025, 6, 18, 0, 38), '\u{1F317}', 'last quarter, 18 July 2025'],
    [Date.UTC(2026, 2, 3, 11, 38), '\u{1F315}', 'full, 3 March 2026'],
    [Date.UTC(2024, 0, 11, 11, 57), '\u{1F311}', 'new, 11 January 2024']
  ];

  for (const [t, want, what] of cases) {
    assert.equal(moonPhase(t, 45), want, what);
  }
});

test('the phase advances through all eight over one synodic month', () => {
  // From a new moon, sampled every three hours for 30 days: every glyph appears,
  // each in one unbroken run, and in order. That is a stronger statement than any
  // single date — it says the index is a fraction of a month and not a lookup that
  // happens to land.
  const start = Date.UTC(2025, 5, 25, 10, 31);
  const seen = [];
  for (let h = 0; h < 30 * 24; h += 3) {
    const glyph = moonPhase(start + h * HOUR, 45);
    if (glyph !== seen[seen.length - 1]) seen.push(glyph);
  }

  const order = ['\u{1F311}', '\u{1F312}', '\u{1F313}', '\u{1F314}',
    '\u{1F315}', '\u{1F316}', '\u{1F317}', '\u{1F318}'];
  // A 30-day window from a new moon runs a full cycle and starts the next one, so
  // the first glyph comes round again at the end.
  assert.deepEqual(seen, [...order, order[0]]);
});

test('below the equator the crescent leans the other way', () => {
  // The same moon, seen from Chamonix and from Réunion. Waxing and waning swap;
  // the new and full moons, which are symmetric, do not move.
  const swaps = [
    [Date.UTC(2025, 5, 28, 12), '\u{1F312}', '\u{1F318}'],  // waxing crescent
    [Date.UTC(2025, 6, 2, 19, 30), '\u{1F313}', '\u{1F317}'], // first quarter
    [Date.UTC(2025, 6, 7, 12), '\u{1F314}', '\u{1F316}']    // waxing gibbous
  ];

  for (const [t, north, south] of swaps) {
    assert.equal(moonPhase(t, 45), north, `north at ${hhmm(t)}`);
    assert.equal(moonPhase(t, -21), south, `south at ${hhmm(t)}`);
  }

  for (const t of [Date.UTC(2025, 5, 11, 7, 44), Date.UTC(2025, 5, 25, 10, 31)]) {
    assert.equal(moonPhase(t, -21), moonPhase(t, 45), 'new and full are symmetric');
  }
});

test('the moon is always up to something', () => {
  // No absence to report and no gap in the eight: every moment resolves, including
  // ones far outside any race this page will see.
  const eight = new Set(['\u{1F311}', '\u{1F312}', '\u{1F313}', '\u{1F314}',
    '\u{1F315}', '\u{1F316}', '\u{1F317}', '\u{1F318}']);

  for (const t of [0, Date.UTC(1969, 6, 20), Date.UTC(2026, 6, 31, 4, 17),
    Date.UTC(2099, 11, 31)]) {
    for (const lat of [-89, -21, 0, 45, 89]) {
      assert.ok(eight.has(moonPhase(t, lat)), `${t} at ${lat}`);
    }
  }

  // The default hemisphere is the northern one, not a third answer.
  const t = Date.UTC(2025, 5, 28, 12);
  assert.equal(moonPhase(t), moonPhase(t, 45));
});

test('standing high up brings sunrise forward and holds sunset back', () => {
  // The horizon dip: at 2,500 m it is 1.7° down, which is the better part of ten
  // minutes at these latitudes. This is why the course's own elevation is worth
  // passing in rather than assuming sea level.
  const valley = sunTimes(Date.UTC(2026, 7, 22, 12), 45, 0);
  const col = sunTimes(Date.UTC(2026, 7, 22, 12), 45, 0, 2500);

  const earlier = (valley.sunrise - col.sunrise) / MINUTE;
  const later = (col.sunset - valley.sunset) / MINUTE;
  assert.ok(earlier > 5 && earlier < 15, `sunrise moved ${earlier.toFixed(1)} min`);
  assert.ok(later > 5 && later < 15, `sunset moved ${later.toFixed(1)} min`);
  // Symmetric, because the sun is at the same altitude either side of noon.
  assert.ok(Math.abs(earlier - later) < 0.5, `${earlier} vs ${later}`);

  // Sea level and no reading at all are the same thing.
  assert.equal(sunTimes(Date.UTC(2026, 7, 22, 12), 45, 0, 0).sunrise, valley.sunrise);
  assert.equal(sunTimes(Date.UTC(2026, 7, 22, 12), 45, 0, null).sunrise, valley.sunrise);
});

// --- and where the run was ----------------------------------------------------

const LAT0 = 42.79;                 // the Pyrenees, where the real courses are
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);

/** 20 km due east, flat, a vertex every 100 m. */
function flatCourse() {
  const segments = [Array.from({ length: 201 }, (_, i) => ({
    lat: LAT0, lon: (i * 100) / M_LON, ele: 1200
  }))];
  return buildCourse({ segments, waypoints: [], hasElevation: true }, 'sha');
}

/**
 * A run through one night: pings every half hour from 20:00 local (18:00 UTC) to
 * 08:00, covering the course at a steady 1.67 km/h. Slow, but the point is that it
 * is out there in the dark.
 */
function overnight(course, hours = 12) {
  const start = Date.UTC(2026, 7, 22, 18);
  const legs = hours * 2;
  return Array.from({ length: legs + 1 }, (_, i) => {
    const along = (i / legs) * course.length;
    const at = pointAt(course, along);
    return {
      name: `p${i}`, t: start + i * 30 * MINUTE, lat: at.lat, lon: at.lon,
      snap: { along, lat: at.lat, lon: at.lon, ele: at.ele, off: 3 }
    };
  });
}

test('a run through the night gets a sunset and then a sunrise', () => {
  const course = flatCourse();
  const points = overnight(course);
  const pois = sunPois(points, course);

  assert.equal(pois.length, 2, pois.map(p => `${p.event} ${hhmm(p.t)}`).join(', '));
  assert.equal(pois[0].event, 'sunset');
  assert.equal(pois[1].event, 'sunrise');
  assert.ok(pois[0].t < pois[1].t);
  assert.equal(pois[0].kind, 'sun');

  for (const poi of pois) {
    // Inside the measured span, and on the course somewhere neither at the start
    // nor at the finish.
    assert.ok(poi.t >= points[0].t && poi.t <= points[points.length - 1].t, hhmm(poi.t));
    assert.ok(poi.along > 0 && poi.along < course.length, `${poi.along} m in`);
    assert.equal(poi.ele, 1200);
    assert.equal(poi.gap, 30 * MINUTE);
    // The position agrees with where the course is at that distance.
    const at = pointAt(course, poi.along);
    assert.ok(Math.abs(poi.lon - at.lon) < 1e-9);
  }

  // In the valley on 22 August at this longitude the almanac says 20:53 and 07:15
  // local. This course sits at 1,200 m, which is worth seven minutes at each end —
  // so the marks land at 21:00 and 07:08, and the fact that they are NOT the
  // sea-level figures is the elevation correction showing up where it matters.
  near(pois[0].t, Date.UTC(2026, 7, 22, 19, 0), 5, 'sunset on the course');
  near(pois[1].t, Date.UTC(2026, 7, 23, 5, 8), 5, 'sunrise on the course');
});

test('a run entirely in daylight is not marked at all', () => {
  const course = flatCourse();
  const start = Date.UTC(2026, 7, 22, 8);      // 10:00 local, well after sunrise
  const points = Array.from({ length: 9 }, (_, i) => {
    const along = i * 500;
    const at = pointAt(course, along);
    return {
      name: `p${i}`, t: start + i * 30 * MINUTE, lat: at.lat, lon: at.lon,
      snap: { along, lat: at.lat, lon: at.lon, ele: at.ele, off: 3 }
    };
  });

  assert.deepEqual(sunPois(points, course), []);
});

test('a run with no course is still marked, from the raw fixes', () => {
  const points = overnight(flatCourse()).map(({ snap, ...p }) => p);
  const pois = sunPois(points, null);

  assert.equal(pois.length, 2);
  for (const poi of pois) {
    assert.equal(poi.along, null, 'invented a distance with no course to measure on');
    assert.equal(poi.ele, null);
    assert.ok(Number.isFinite(poi.lat) && Number.isFinite(poi.lon));
  }
});

test('the placement converges, wherever it is seeded from', () => {
  // The circularity — sunrise depends on the position, the position on the time —
  // is settled by iterating. A course spanning a degree of longitude is four
  // minutes of solar time end to end, so a seed at the wrong end has something to
  // converge from; the answer must not depend on which end.
  const wide = buildCourse({
    segments: [Array.from({ length: 201 }, (_, i) => ({
      lat: LAT0, lon: i * 0.005, ele: 1200
    }))],
    waypoints: [], hasElevation: true
  }, 'sha');

  const forwards = sunPois(overnight(wide), wide);
  // The same run in reverse: the same ground at the same times, covered the other
  // way, so every seed position is the mirror of the one before.
  const backwards = sunPois(overnight(wide).map((p, i, all) => {
    const mirror = all[all.length - 1 - i];
    return { ...mirror, name: p.name, t: p.t };
  }), wide);

  assert.equal(forwards.length, 2);
  assert.equal(backwards.length, 2);
  for (let i = 0; i < 2; i++) {
    assert.equal(forwards[i].event, backwards[i].event);
    // Different ground at the moment of the event, so different times — but both
    // must be settled answers rather than the seed showing through, which is what
    // an unconverged iteration looks like: a whole leg's worth of drift.
    assert.ok(apart(forwards[i].t, backwards[i].t) < 5,
      `${forwards[i].event}: ${hhmm(forwards[i].t)} vs ${hhmm(backwards[i].t)}`);
  }
});

test('a two-night run gets four marks, in order, one per crossing', () => {
  const course = flatCourse();
  const points = overnight(course, 36);       // 18:00 UTC to 06:00 two days later
  const pois = sunPois(points, course);

  assert.deepEqual(pois.map(p => p.event), ['sunset', 'sunrise', 'sunset', 'sunrise']);
  for (let i = 1; i < pois.length; i++) {
    assert.ok(pois[i].t > pois[i - 1].t, 'out of order');
    // And no crossing counted twice — the scan runs over UTC days and the events
    // belong to solar ones.
    assert.ok(pois[i].t - pois[i - 1].t > HOUR, `two marks ${hhmm(pois[i].t)} apart`);
  }
});

test('sunPois copes with a run too small to have a span', () => {
  const course = flatCourse();
  assert.deepEqual(sunPois([], course), []);
  assert.deepEqual(sunPois(undefined, course), []);
  // One ping is a span of zero length. Either it happens to BE the moment of a
  // crossing, to the minute, or there is nothing to mark — and no crash either way.
  const single = overnight(course).slice(0, 1);
  assert.ok(Array.isArray(sunPois(single, course)));
});
