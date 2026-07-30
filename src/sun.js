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
 * @returns {{sunrise: number|null, sunset: number|null}} both null on a day the
 *   sun does not cross the horizon at all. A run inside a polar summer is then
 *   simply unmarked, rather than marked at a moment nothing happened — see the
 *   note on `acos` below. They are null as a pair because this reduction finds
 *   sunrise by reflecting sunset about noon, so there is one crossing to fail to
 *   find rather than two.
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
  const cosH = (Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) /
    (Math.cos(phi) * Math.cos(dec));
  if (!(cosH >= -1 && cosH <= 1)) return { sunrise: null, sunset: null };

  const w = Math.acos(cosH);
  const set = solarTransit(transit(w, lw, cycle), anomaly, longitude);

  return {
    // Sunrise as sunset reflected about solar noon. The two are symmetric about
    // it by construction — the sun is at the same altitude at the same hour angle
    // either side — and computing it that way is what keeps the pair exactly
    // symmetric instead of a second's worth of rounding apart.
    sunrise: fromDays(noon - (set - noon)),
    sunset: fromDays(set)
  };
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
