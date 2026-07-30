// What each ping says about the run so far: how long it has been going, and how
// much climbing it has taken.
//
// Pure and recomputed on every paint. Unlike snapping — which is sequential,
// expensive, and therefore cached per ping for life — this is one pass over a
// few hundred points reading arrays the course already built. Caching it would
// only mean versioning a cache against `eleThresholdM`.

import { CONFIG } from './config.js';
import { gainAt, pointAt } from './course.js';
import { predictAt } from './predict.js';

/**
 * Hang a `stats` object off each point, in place.
 *
 * @param {Array}       points sorted oldest-first
 * @param {object|null} course the run's course, if it has one
 * @param {number|null} [start] the scheduled gun, when the run has one. Elapsed
 *   time is measured from it rather than from the first ping, which is the whole
 *   difference between a race clock and the age of the oldest file in a folder —
 *   pings written on the way to the start line used to become the start.
 *
 * Each `stats` carries, when it can:
 *   sinceStart  ms since the gun, or since the first ping when there wasn't one.
 *               ABSENT on a ping from before the gun: that ping has no elapsed
 *               time, and "-0:12:00" is not a thing a race clock says.
 *   sincePrev   ms since the previous ping — absent on the first
 *   distTotal   metres along the course
 *   dist        metres of course covered since the previous SNAPPED ping
 *   pace        ms per kilometre over that same stretch
 *   upTotal     metres climbed from the start of the course to here
 *   downTotal   and descended
 *   up, down    the same over the stretch since the previous SNAPPED ping
 *
 * The elevation figures need a course with elevation and a ping that snapped to
 * it, so they are absent rather than zero when there is nothing to measure —
 * a zero would read as "flat", which is a different claim from "unknown".
 */
export function deriveStats(points, course, start = null) {
  if (!points.length) return points;

  const climbable = Boolean(course?.hasElevation);
  // With no gun the first ping is the start, which is what this always did.
  const origin = start ?? points[0].t;

  // The previous ping that actually landed on the course. Not simply the
  // previous ping: a fix that missed the course has no distance along it, and
  // measuring from the one before that makes the next ping's climb span the gap
  // rather than silently dropping the ground underneath it.
  let previousSnapped = null;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const stats = {};
    // Left out entirely before the gun rather than reported as a negative. See the
    // note on `sinceStart` above.
    if (point.t >= origin) stats.sinceStart = point.t - origin;
    // Wall-clock questions use the previous ping whether or not it snapped — and
    // whether or not either of them raced. The gap between two fixes is a fact
    // about two fixes, and it reads the same either side of the start.
    if (i > 0) stats.sincePrev = point.t - points[i - 1].t;

    if (point.snap) {
      stats.distTotal = point.snap.along;
      // Absolute, for the same reason `between()` swaps up and down below: a
      // ping that snapped backwards still covered that ground on the way.
      stats.dist = previousSnapped
        ? Math.abs(point.snap.along - previousSnapped.snap.along)
        : 0;

      // How fast that stretch went, in ms per kilometre.
      //
      // Timed against the previous SNAPPED ping rather than the previous one,
      // because the numerator is course distance: `dist` measures from the last fix
      // that landed on the route, so a gap timed from a fix that missed it would be
      // dividing this stretch of ground by less than the time it took.
      //
      // Absent rather than zero whenever there is nothing to divide — the first
      // snapped ping, a runner who hasn't moved along the course, two fixes sharing
      // a timestamp. A pace of 0:00/km is a claim about speed, and "no pace yet" is
      // a different statement from "infinitely fast".
      //
      // And absent below `paceMinMeters`, which is the same objection at the other
      // end: dividing a 24-metre leg by five minutes reports "209:47/km", a number
      // that is exactly right about nothing. See config.js.
      const legMs = previousSnapped ? point.t - previousSnapped.t : 0;
      if (stats.dist >= CONFIG.paceMinMeters && legMs > 0) {
        stats.pace = legMs / (stats.dist / 1000);
      }

      if (climbable) {
        const total = gainAt(course, point.snap.along);
        stats.upTotal = total.up;
        stats.downTotal = total.down;

        const previous = previousSnapped
          ? gainAt(course, previousSnapped.snap.along)
          : { up: 0, down: 0 };
        const leg = between(previous, total);
        stats.up = leg.up;
        stats.down = leg.down;
      }

      previousSnapped = point;
    }

    point.stats = stats;
  }

  return points;
}

/**
 * The moment elapsed times are measured from — the gun if the run had one, else
 * its first ping.
 *
 * Recovered from what `deriveStats` already wrote rather than taken as an
 * argument, so that exactly one function decides where a run starts and everything
 * else asks it what it decided. The alternative was threading `start` through
 * `interpolateAt` and so through every hover path in map.js and profile.js, to
 * arrive at the same number by a longer route.
 *
 * @returns {number|null} null when no point has an elapsed time yet, which means
 *   either no points or nothing but pre-start ones.
 */
export function originOf(points) {
  const first = points.find(p => p.stats?.sinceStart !== undefined);
  return first ? first.t - first.stats.sinceStart : null;
}

/**
 * What is known about an arbitrary distance along the course — the thing under
 * the cursor when it is on the route rather than on a ping.
 *
 * Two different kinds of fact come back together here, and the distinction is
 * the whole design:
 *
 *   - Height and climb are properties of the COURSE. They are known everywhere
 *     on it, whether or not anyone has been there yet.
 *   - The time is a property of the RUN, and it is only known where the run has
 *     actually been. Between two pings it is interpolated; past the last one it
 *     is FORECAST, from a model fitted to this run and nothing else, and the
 *     answer arrives with its own uncertainty attached rather than pretending to
 *     be a measurement. See [predict.js](predict.js).
 *
 * @param {Array}       points sorted oldest-first
 * @param {object|null} course
 * @param {number|null} along  metres along the course
 * @param {object|null} forecast from `buildForecast`, when the run has one. Left
 *   out, ground past the last ping simply reads as not reached — which is what
 *   every caller did before there was a model, and still the right answer for a
 *   run too young to fit one.
 * @returns {{along, lat, lon, ele, origin, upTotal, downTotal, state, sinceStart?, predicted?}|null}
 *   `state` is one of:
 *     'between' — bracketed by two pings; `sinceStart` is interpolated
 *     'beyond'  — past the furthest point the run has reached; `predicted`
 *                 carries the forecast when there is one
 *     'before'  — short of the earliest point it has reached
 *     'unknown' — no ping has landed on the course at all
 */
export function interpolateAt(points, course, along, forecast = null) {
  if (!course || along === null || along === undefined || !Number.isFinite(along)) return null;

  const at = pointAt(course, along);
  const total = course.hasElevation ? gainAt(course, along) : null;
  // Every elapsed figure below is measured from `origin`, so a course hovered on a
  // run with a scheduled start reads the same as the pings on it do. The `??`
  // fallback is for a caller that skipped `deriveStats`; snapped pings always have
  // stats in the app itself, since `show()` derives them one line after it snaps.
  //
  // Handed back on the result as well as used here, so that a caller with a
  // predicted time to typeset can say which DAY it lands on without re-deriving the
  // race start from the points it already gave us. See `dayTag`.
  const origin = points.length ? originOf(points) ?? points[0].t : null;
  const base = {
    along,
    lat: at.lat,
    lon: at.lon,
    ele: at.ele,
    origin,
    upTotal: total ? total.up : undefined,
    downTotal: total ? total.down : undefined
  };

  const snapped = points.filter(p => p.snap);
  if (!snapped.length) return { ...base, state: 'unknown' };

  const alongs = snapped.map(p => p.snap.along);
  if (along > Math.max(...alongs)) {
    // `predictAt` anchors at the newest ping rather than the furthest one, and
    // returns null for anything already behind it — so on the rare course where
    // a ping snapped backwards past the leader, the two agree by construction
    // that there is nothing to forecast.
    const predicted = predictAt(forecast, along);
    return predicted
      ? { ...base, state: 'beyond', predicted: { ...predicted, sinceStart: predicted.t - origin } }
      : { ...base, state: 'beyond' };
  }
  if (along < Math.min(...alongs)) return { ...base, state: 'before' };

  // The LATEST straddling pair, not the first: on a lap course the cursor may
  // sit somewhere the runner has passed twice, and the interesting answer is
  // when they were last there.
  let pair = null;
  for (let i = 1; i < snapped.length; i++) {
    const lo = Math.min(alongs[i - 1], alongs[i]);
    const hi = Math.max(alongs[i - 1], alongs[i]);
    if (along >= lo && along <= hi) pair = i;
  }
  if (pair === null) return { ...base, state: 'unknown' };

  const a = snapped[pair - 1];
  const b = snapped[pair];
  const span = b.snap.along - a.snap.along;
  // Time runs linearly in distance across the leg. A constant pace between two
  // fixes minutes apart is a guess, but it is the only one the data supports —
  // which is why the tooltip labels it as an estimate.
  const f = span === 0 ? 0 : (along - a.snap.along) / span;
  const t = a.t + (b.t - a.t) * f;

  return { ...base, state: 'between', sinceStart: t - origin };
}

/**
 * The climb between two points on the course, in the direction actually
 * travelled.
 *
 * `along` normally advances, but the backwards penalty in [snap.js](snap.js) is
 * a cost rather than a prohibition, so a ping can land behind its predecessor.
 * Covering a stretch in reverse turns its ascent into descent, so the two swap —
 * which keeps both figures positive. Reporting minus 40 m of ascent would be
 * arithmetic, not a fact about the ground.
 */
function between(from, to) {
  const up = to.up - from.up;
  const down = to.down - from.down;
  if (up >= 0 && down >= 0) return { up, down };
  // `|| 0` only to turn a negated zero back into a plain one: -0 formats with a
  // minus sign, and "-0 m of climb" is a silly thing to show anyone.
  return { up: -down || 0, down: -up || 0 };
}
