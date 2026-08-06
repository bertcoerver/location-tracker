// Helpers shared by the candidate forecasters in this directory.
//
// The candidates all keep [predict.js](../predict.js)'s ridge fit as their
// short-horizon backbone — it is well tested and right about hills — and differ
// in how stopped time and fatigue enter on top of it. What they need beyond the
// baseline's own exports is a stop-inclusive view of the run so far: gross
// elapsed time, and when the run passed a given point. Both live here.
//
// Same rule as everything in predict.js: fitted from ONE run's own pings only.

import { gainAt } from '../course.js';

/** Climb over a stretch, both figures positive — a copy of the private
 *  `between` in [predict.js](../predict.js), same reverse-travel rule. */
export function between(from, to) {
  const up = to.up - from.up;
  const down = to.down - from.down;
  if (up >= 0 && down >= 0) return { up, down };
  return { up: -down || 0, down: -up || 0 };
}

/** Terrain between two points along the course: distance, ascent, descent. */
export function terrainBetween(course, fromAlong, toAlong) {
  const climb = course.hasElevation
    ? between(gainAt(course, fromAlong), gainAt(course, toAlong))
    : { up: 0, down: 0 };
  return { dist: toAlong - fromAlong, up: climb.up, down: climb.down };
}

/**
 * The run so far, stops included: gross elapsed seconds and ground covered
 * between the first and the newest snapped ping.
 *
 * Measured from the first SNAPPED ping rather than the gun, because the gun is
 * an optional setting and the first ping is a fact this run actually recorded.
 *
 * @returns {{elapsed, along, firstAlong}|null} null when the run is too short
 *   to say anything gross about — under 200 m covered, or no time elapsed.
 */
export function grossStats(points) {
  const snapped = points.filter(p => p.snap);
  if (snapped.length < 2) return null;

  const first = snapped[0];
  const last = snapped[snapped.length - 1];
  const elapsed = (last.t - first.t) / 1000;
  const along = last.snap.along - first.snap.along;
  if (!(along >= 200) || !(elapsed > 0)) return null;

  return { elapsed, along, firstAlong: first.snap.along };
}

/**
 * Gross seconds from the first snapped ping until the run first reached
 * `along`, interpolated between the two pings that straddle it.
 *
 * Progress is read as the running maximum of `along`, so a ping that snapped
 * backwards cannot make the run reach a point twice — "first reached" stays
 * monotone, which is all the fade estimate needs from it.
 *
 * @returns {number|null} seconds, or null when the run never got that far.
 */
export function cumTimeAt(points, along) {
  const snapped = points.filter(p => p.snap);
  if (!snapped.length) return null;

  const t0 = snapped[0].t;
  let prev = { t: t0, along: snapped[0].snap.along };
  if (along <= prev.along) return 0;

  for (const point of snapped) {
    const reached = Math.max(prev.along, point.snap.along);
    if (reached >= along) {
      const span = reached - prev.along;
      const frac = span > 0 ? (along - prev.along) / span : 1;
      return (prev.t + frac * (point.t - prev.t) - t0) / 1000;
    }
    prev = { t: point.t, along: reached };
  }

  return null;
}

/**
 * The gross-inflation ratio: real elapsed time over what the fitted moving-pace
 * model says the ground covered should have taken. Everything the moving-pace
 * fit does not bill — aid stations, faffing, a systematic slowdown — lands in
 * this one number. 1 means the fit explains the run; 2 means half the race so
 * far was spent not covered by it.
 *
 * Clamped below at 1: a ratio under 1 says the fit over-explains the past,
 * which the ridge prior already handles, and letting it speed the forecast up
 * would trade a guarantee (the blend multiplier is non-decreasing in distance,
 * which downstream bisection relies on) for nothing.
 *
 * @returns {number} in [1, hi]; 1 whenever there is too little run to judge.
 */
export function grossRatio(points, course, fit, hi = 3) {
  const gross = grossStats(points);
  if (!gross) return 1;

  const covered = terrainBetween(course, gross.firstAlong, gross.firstAlong + gross.along);
  const explained = fit.flat * covered.dist + fit.up * covered.up + fit.down * covered.down;
  if (!(explained > 0)) return 1;

  return clamp(gross.elapsed / explained, 1, hi);
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
