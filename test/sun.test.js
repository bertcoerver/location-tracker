import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse, pointAt } from '../src/course.js';
import { sunPois, sunTimes } from '../src/sun.js';

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
