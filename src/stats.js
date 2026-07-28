// What each ping says about the run so far: how long it has been going, and how
// much climbing it has taken.
//
// Pure and recomputed on every paint. Unlike snapping — which is sequential,
// expensive, and therefore cached per ping for life — this is one pass over a
// few hundred points reading arrays the course already built. Caching it would
// only mean versioning a cache against `eleThresholdM`.

import { gainAt } from './course.js';

/**
 * Hang a `stats` object off each point, in place.
 *
 * @param {Array}       points sorted oldest-first
 * @param {object|null} course the run's course, if it has one
 *
 * Each `stats` carries, when it can:
 *   sinceStart  ms since the first ping
 *   sincePrev   ms since the previous ping — absent on the first
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

    if (climbable && point.snap) {
      const total = gainAt(course, point.snap.along);
      stats.upTotal = total.up;
      stats.downTotal = total.down;

      const previous = previousSnapped
        ? gainAt(course, previousSnapped.snap.along)
        : { up: 0, down: 0 };
      const leg = between(previous, total);
      stats.up = leg.up;
      stats.down = leg.down;

      previousSnapped = point;
    }

    point.stats = stats;
  }

  return points;
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
