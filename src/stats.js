// What each ping says about the run so far: how long it has been going, and how
// much climbing it has taken.
//
// Pure and recomputed on every paint. Unlike snapping — which is sequential,
// expensive, and therefore cached per ping for life — this is one pass over a
// few hundred points reading arrays the course already built. Caching it would
// only mean versioning a cache against `eleThresholdM`.

import { gainAt, pointAt } from './course.js';

/**
 * Hang a `stats` object off each point, in place.
 *
 * @param {Array}       points sorted oldest-first
 * @param {object|null} course the run's course, if it has one
 *
 * Each `stats` carries, when it can:
 *   sinceStart  ms since the first ping
 *   sincePrev   ms since the previous ping — absent on the first
 *   distTotal   metres along the course
 *   dist        metres of course covered since the previous SNAPPED ping
 *   upTotal     metres climbed from the start of the course to here
 *   downTotal   and descended
 *   up, down    the same over the stretch since the previous SNAPPED ping
 *
 * The elevation figures need a course with elevation and a ping that snapped to
 * it, so they are absent rather than zero when there is nothing to measure —
 * a zero would read as "flat", which is a different claim from "unknown".
 */
export function deriveStats(points, course) {
  if (!points.length) return points;

  const climbable = Boolean(course?.hasElevation);
  const first = points[0];

  // The previous ping that actually landed on the course. Not simply the
  // previous ping: a fix that missed the course has no distance along it, and
  // measuring from the one before that makes the next ping's climb span the gap
  // rather than silently dropping the ground underneath it.
  let previousSnapped = null;

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    const stats = { sinceStart: point.t - first.t };
    // Wall-clock questions use the previous ping whether or not it snapped.
    if (i > 0) stats.sincePrev = point.t - points[i - 1].t;

    if (point.snap) {
      stats.distTotal = point.snap.along;
      // Absolute, for the same reason `between()` swaps up and down below: a
      // ping that snapped backwards still covered that ground on the way.
      stats.dist = previousSnapped
        ? Math.abs(point.snap.along - previousSnapped.snap.along)
        : 0;

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
 * What is known about an arbitrary distance along the course — the thing under
 * the cursor when it is on the route rather than on a ping.
 *
 * Two different kinds of fact come back together here, and the distinction is
 * the whole design:
 *
 *   - Height and climb are properties of the COURSE. They are known everywhere
 *     on it, whether or not anyone has been there yet.
 *   - The time is a property of the RUN, and it is only known where the run has
 *     actually been. Between two pings it is interpolated; past the last one
 *     there is nothing to interpolate from, and `state` says so instead of
 *     extrapolating a number nobody measured.
 *
 * @param {Array}       points sorted oldest-first
 * @param {object|null} course
 * @param {number|null} along  metres along the course
 * @returns {{along, lat, lon, ele, upTotal, downTotal, state, sinceStart?}|null}
 *   `state` is one of:
 *     'between' — bracketed by two pings; `sinceStart` is interpolated
 *     'beyond'  — past the furthest point the run has reached
 *     'before'  — short of the earliest point it has reached
 *     'unknown' — no ping has landed on the course at all
 */
export function interpolateAt(points, course, along) {
  if (!course || along === null || along === undefined || !Number.isFinite(along)) return null;

  const at = pointAt(course, along);
  const total = course.hasElevation ? gainAt(course, along) : null;
  const base = {
    along,
    lat: at.lat,
    lon: at.lon,
    ele: at.ele,
    upTotal: total ? total.up : undefined,
    downTotal: total ? total.down : undefined
  };

  const snapped = points.filter(p => p.snap);
  if (!snapped.length) return { ...base, state: 'unknown' };

  const alongs = snapped.map(p => p.snap.along);
  if (along > Math.max(...alongs)) return { ...base, state: 'beyond' };
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

  return { ...base, state: 'between', sinceStart: t - points[0].t };
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
