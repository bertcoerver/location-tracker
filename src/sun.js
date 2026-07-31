// When the sun rose and set on a run, and where the runner was standing when it
// did.
//
// Two halves that could be two files and are deliberately one, because the second
// is the only caller the first will ever have. Below the divider is astronomy —
// pure trig, no knowledge of pings — and above it the composition: every ping
// carries a position and a moment, so the page already holds everything needed to
// put a mark on the ground where the light arrived.

import { traceAt } from './stats.js';

const DAY = 86400000;
const RAD = Math.PI / 180;

/** Obliquity of the ecliptic, degrees. */
const OBLIQUITY = 23.4397;

/** Refraction at the horizon plus the sun's apparent radius, degrees. */
const HORIZON = -0.833;

/**
 * The constant offset in the approximate transit below — 0.0009 of a day, 78
 * seconds.
 *
 * It stands in for an iteration this reduction does not perform: the transit is
 * solved once from an approximate position rather than refined, and this is the
 * conventional seed that makes the single pass land within a minute. Dropping it
 * costs seconds, and only near the poles.
 */
const J0 = 0.0009;

/**
 * Days from J2000 (2000-01-01 12:00 UTC) to a Unix timestamp.
 *
 * Julian day numbers are the conventional bookkeeping here and they cancel out of
 * every formula below, so this skips them: 1970-01-01 00:00 UTC is 10,957.5 days
 * before the epoch this reduction counts from, and that is the whole conversion.
 */
function toDays(t) {
  return t / DAY - 10957.5;
}

/** Back again — the inverse, so a computed day lands on a timestamp. */
function fromDays(d) {
  return (d + 10957.5) * DAY;
}

/**
 * When the sun crosses the horizon on the solar day containing `t`, at a place.
 *
 * The standard low-precision reduction (Meeus, chapter 25 and the sunrise equation
 * that follows it) — mean anomaly, ecliptic longitude, declination, then the hour
 * angle at which the sun's centre reaches the horizon. Good to about a minute at
 * the latitudes these races are run at, which is well inside what a mark on a map
 * can claim: the position it is placed at is interpolated between two pings that
 * are minutes apart in the first place.
 *
 * Not a dependency, and not because dependencies are bad — this page has no build
 * step and no bundler, so a library would be a script tag and a third-party
 * origin in the CSP, for fifty lines of arithmetic that has not changed since
 * 1991.
 *
 * @param {number} t     any moment in the day wanted
 * @param {number} lat   degrees, north positive
 * @param {number} lon   degrees, east positive
 * @param {number|null} [ele] metres above sea level, when the course knows it
 * @returns {{sunrise: number|null, sunset: number|null, polar: 'day'|'night'|null}}
 *   both events null on a day the sun does not cross the horizon at all. A run
 *   inside a polar summer is then simply unmarked, rather than marked at a moment
 *   nothing happened — see the note on `acos` below. They are null as a pair
 *   because this reduction finds sunrise by reflecting sunset about noon, so there
 *   is one crossing to fail to find rather than two. `polar` says WHICH sky that
 *   was — a sun that never set or one that never rose — and is null whenever there
 *   were crossings to report.
 */
export function sunTimes(t, lat, lon, ele = null) {
  // Longitude measured WESTWARD in radians, which is the convention the transit
  // formulas below are written in — hence the negation, and hence this being the
  // one place a sign is easy to get wrong.
  const lw = RAD * -lon;
  const phi = RAD * lat;

  // The solar day whose noon is nearest `t`, as a whole number of cycles from
  // J2000. This is what makes "the day containing t" mean a solar day at this
  // longitude rather than a UTC one: at 170°E the two are eleven hours apart.
  const cycle = Math.round(toDays(t) - J0 - lw / (2 * Math.PI));

  const approx = transit(0, lw, cycle);
  const anomaly = meanAnomaly(approx);
  const longitude = eclipticLongitude(anomaly);
  const dec = Math.asin(Math.sin(RAD * OBLIQUITY) * Math.sin(longitude));
  const noon = solarTransit(approx, anomaly, longitude);

  // How far below a level horizon the sun's CENTRE sits at the moment its upper
  // limb appears to touch it: half a degree of solar radius plus the atmosphere
  // bending the light around the curve of the earth.
  //
  // Plus the horizon DIP from standing above sea level, which is where the
  // course's own elevation is spent: at 2,500 m the horizon is 1.7° down, and
  // sunrise comes the better part of ten minutes earlier than the almanac's
  // figure for the valley. The races this page is for spend their nights at
  // altitude and the course already knows the height, so using sea level would
  // be discarding a number we hold. It does assume the horizon is actually
  // visible, which in a valley it is not — an approximation, but a much closer
  // one than pretending the runner is at the beach.
  const h0 = RAD * (HORIZON - 2.076 * Math.sqrt(Math.max(0, ele ?? 0)) / 60);

  // The hour angle the sun is at that altitude — and out of range exactly when
  // there is no such moment, which is the polar case arriving as a NaN rather
  // than as a latitude test. A midsummer sun at 80°N never gets that low and a
  // midwinter one never gets that high; both are `|cos| > 1` here, and both are
  // honestly answered by "no such crossing".
  //
  // WHICH way out of range says which of the two opposite skies it was, and it
  // costs nothing to hand back: the hour angle needed to reach the horizon is
  // more than half a turn — the sun never gets round to it — for a midnight sun,
  // and less than nothing for a polar night. Exactly at the pole the denominator
  // vanishes and the division hands back an infinity, which lands on the correct
  // side of the range on its own — measured, at 90°N in June and in December. A
  // NaN needs the numerator to vanish in the same breath, and midwinter is the
  // safer thing to call that: "dark" is what an unmarked polar stretch already
  // looks like on this page.
  const cosH = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) /
    (Math.cos(phi) * Math.cos(dec));
  if (!(cosH >= -1 && cosH <= 1)) {
    return { sunrise: null, sunset: null, polar: cosH < -1 ? 'day' : 'night' };
  }

  const w = Math.acos(cosH);
  const set = solarTransit(transit(w, lw, cycle), anomaly, longitude);

  return {
    // Sunrise as sunset reflected about solar noon. The two are symmetric about
    // it by construction — the sun is at the same altitude at the same hour angle
    // either side — and computing it that way is what keeps the pair exactly
    // symmetric instead of a second's worth of rounding apart.
    sunrise: fromDays(noon - (set - noon)),
    sunset: fromDays(set),
    polar: null
  };
}

/**
 * Was the sun up at this place, at this moment?
 *
 * Answered from the crossings themselves rather than from the sun's altitude,
 * which is the longer way round and the one that cannot drift: it is the SAME
 * arithmetic, at the same `h0`, that puts the 🌅 and 🌃 marks on the course — so a
 * ping a minute after the sunrise mark is daylight by construction, rather than by
 * two formulas agreeing to within a few seconds.
 *
 * `sunTimes` is asked about the solar day containing `t`, so a `t` before that
 * day's sunrise is the night before it and a `t` after its sunset the night after.
 * Both are simply outside the pair, and no day arithmetic is needed to say so.
 *
 * @param {number} t
 * @param {number} lat degrees, north positive
 * @param {number} lon degrees, east positive
 * @param {number|null} [ele] metres, when it is known — the same horizon dip the
 *   marks are placed with, so at 2,500 m a minute that is night at sea level can
 *   be daylight here, and correctly.
 * @returns {boolean} on a day with no crossings, whether it was the sun that never
 *   set rather than the one that never rose.
 */
export function isDaylight(t, lat, lon, ele = null) {
  const { sunrise, sunset, polar } = sunTimes(t, lat, lon, ele);
  if (sunrise === null) return polar === 'day';
  return t >= sunrise && t <= sunset;
}

/** The sun's mean anomaly, radians. */
function meanAnomaly(d) {
  return RAD * (357.5291 + 0.98560028 * d);
}

/**
 * Apparent ecliptic longitude, radians: the mean anomaly plus the equation of the
 * centre — the earth's orbit being an ellipse rather than a circle — plus the
 * longitude of perihelion.
 */
function eclipticLongitude(m) {
  const centre = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) +
    0.0003 * Math.sin(3 * m));
  return m + centre + RAD * 102.9372 + Math.PI;
}

/** Where a given hour angle falls, in days from J2000, before correction. */
function transit(w, lw, cycle) {
  return J0 + (w + lw) / (2 * Math.PI) + cycle;
}

/** The same, corrected for the equation of time. */
function solarTransit(d, m, l) {
  return d + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l);
}

/**
 * The eight moons, new first and then waxing round to a waning crescent.
 *
 * In this order because the index below is a fraction of a synodic month, and
 * that is what a synodic month does. Northern order: 🌒 is lit on its right.
 */
const MOONS = [
  '\u{1F311}', // 🌑 new
  '\u{1F312}', // 🌒 waxing crescent
  '\u{1F313}', // 🌓 first quarter
  '\u{1F314}', // 🌔 waxing gibbous
  '\u{1F315}', // 🌕 full
  '\u{1F316}', // 🌖 waning gibbous
  '\u{1F317}', // 🌗 last quarter
  '\u{1F318}'  // 🌘 waning crescent
];

/**
 * Which of the eight moon glyphs the sky held, and which way round.
 *
 * The phase from the ELONGATION — how far round the sky the moon has moved from
 * the sun — which is what a phase physically is: 0° is a new moon between us and
 * the sun, 180° a full one opposite it. Both longitudes are ecliptic, and the
 * moon's ecliptic LATITUDE is dropped: it never exceeds 5°, which is worth well
 * under one percent of the angle, against buckets three and a half days wide.
 *
 * The moon's longitude is its mean longitude plus the equation of the centre,
 * omitting evection and variation — a degree and a half at worst, three hours of
 * lunar motion, which cannot move a bucket that a whole day does not. The sun's
 * comes from the reduction above, which is why this is eight lines and not thirty.
 *
 * `lat` mirrors it. 🌒 is a crescent lit on the right, which is a crescent seen
 * from the north; the same moon from Réunion — where La Diagonale is run — leans
 * the other way. Reflecting the index swaps waxing for waning and leaves the new
 * and full moons alone, which is exactly the transformation crossing the equator
 * performs on the sky.
 *
 * @param {number} t
 * @param {number} [lat] degrees, north positive. Zero, the default, is northern:
 *   the equator sees the terminator lie flat and neither glyph is right there.
 * @returns {string} one of the eight, always — the moon is up to something at
 *   every moment, and there is no absence to report.
 */
export function moonPhase(t, lat = 0) {
  const d = toDays(t);

  // Mean longitude and mean anomaly, degrees, then the equation of the centre.
  const mean = 218.316 + 13.176396 * d;
  const anomaly = RAD * (134.963 + 13.064993 * d);
  const moon = RAD * mean + RAD * 6.289 * Math.sin(anomaly);

  const sun = eclipticLongitude(meanAnomaly(d));

  // Into [0, 1): 0 new, 0.5 full. `%` keeps the sign of its left operand in this
  // language, hence the second wrap rather than a bare modulo.
  const turns = 2 * Math.PI;
  const phase = (((moon - sun) % turns) + turns) % turns / turns;

  // Round rather than floor, so each glyph owns the eighth of the month CENTRED
  // on the phase it depicts: a full moon is 🌕 for the day and a half either side
  // of full, which is how long it looks full for.
  const i = Math.round(phase * 8) % 8;
  return MOONS[lat < 0 ? (8 - i) % 8 : i];
}

// --- and where the run was when it happened ----------------------------------

/** How close two passes have to agree before the iteration below is done. */
const SETTLE_MS = 30000;

/**
 * The sun events the run passed through, each placed where the run was.
 *
 * A chicken and egg: when the sun rises depends on where the runner is, and where
 * the runner is depends on the time. Solved by iterating — seed with the position
 * at the middle of the day, ask the sun, ask the trace where that puts us, ask the
 * sun again. It converges immediately because it barely has to: a runner covers a
 * couple of kilometres in the minutes at stake, and a tenth of a degree of
 * longitude is 24 seconds of solar time. Two passes, and a third only if the
 * second moved the answer more than half a minute.
 *
 * Only events inside the MEASURED span are returned — between the first ping and
 * the last. Tonight's sunset on a live run is deliberately not projected onto the
 * forecast: it would move every time the model refits, and it would be drawn in
 * the same idiom as the marks either side of it that are measurements.
 *
 * @param {Array}       points sorted oldest-first
 * @param {object|null} course when the run has one — not needed, but with it the
 *   marks sit on the route rather than on a line between two fixes.
 * @returns {Array<{kind, event, t, lat, lon, along, ele, gap}>} oldest first.
 *   `kind` is `'sun'`, which is what the map's tooltips dispatch on; `event` is
 *   `'sunrise'` or `'sunset'`.
 */
export function sunPois(points, course = null) {
  if (!points?.length) return [];

  const from = points[0].t;
  const to = points[points.length - 1].t;

  const out = [];
  // Which event at which minute, so the same crossing found twice is kept once.
  // Two adjacent day indices genuinely can arrive at one event: the scan is over
  // UTC days and the events belong to SOLAR days, which at 170°E are most of a
  // day apart. A day either side of the span for the same reason.
  const seen = new Set();

  for (let day = Math.floor(from / DAY) - 1; day <= Math.floor(to / DAY) + 1; day++) {
    for (const event of ['sunrise', 'sunset']) {
      const poi = settle(points, course, day * DAY + DAY / 2, event, from, to);
      if (!poi) continue;

      const key = `${event}:${Math.round(poi.t / 60000)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(poi);
    }
  }

  return out.sort((a, b) => a.t - b.t);
}

/**
 * One event, iterated to a fixed point and then placed.
 *
 * `dayAt` is held fixed across the passes rather than following the refined time.
 * It is what decides WHICH crossing is being solved for, so letting it drift is
 * how a sunrise a minute after midnight would hop to the next day's and the loop
 * would chase itself.
 *
 * The trace is read at a CLAMPED time during the iteration and at the real one
 * only at the end. An event seconds outside the span would otherwise abandon
 * itself mid-refinement, on the strength of a seed position that was always going
 * to move — so the question "is this inside the run" is asked once, of the answer,
 * rather than of every guess on the way to it.
 */
function settle(points, course, dayAt, event, from, to) {
  const read = when => traceAt(points, course, Math.min(to, Math.max(from, when)));

  let where = read(dayAt);
  if (!where) return null;

  let t = null;
  for (let pass = 0; pass < 3; pass++) {
    const next = sunTimes(dayAt, where.lat, where.lon, where.ele)[event];
    if (next === null) return null;

    const settled = t !== null && Math.abs(next - t) < SETTLE_MS;
    t = next;
    where = read(t) ?? where;
    if (settled) break;
  }

  const at = traceAt(points, course, t);
  return at ? { kind: 'sun', event, t, ...at } : null;
}
