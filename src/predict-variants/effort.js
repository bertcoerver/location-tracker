// Effort metres, and the blocks the two non-regression models run on.
//
// [v-kalman.js](v-kalman.js) and [v-bootstrap.js](v-bootstrap.js) do not fit the
// three-coefficient regression that every other model here builds on. They work
// on one number per stretch of course instead: EFFORT METRES, a metre of climb
// counted as `predictClimbFactor` metres of flat, descent free. That is exactly
// the shape of the regression's own prior — `[flat0, 7.92 * flat0, 0]` — frozen
// into the axis rather than fitted, which is the trade: a course's hills stop
// being three parameters to estimate and become the ruler everything else is
// measured against, and what is left to estimate is one pace.
//
// The second idea here is the BLOCK. A leg is whatever two consecutive pings
// happen to bracket, and the awkward ones are the legs that went nowhere — an
// aid station, a phone on a table — which have real duration and no distance, so
// a pace cannot be divided out of them at all. The regression's answer is to
// give them an all-zero design row, which is what makes `flat` a MOVING pace and
// is the root of the optimism these two models exist to fix. The answer here is
// to merge: accumulate legs until at least `BLOCK_EFFORT_M` of effort has gone
// by, and report the whole parcel's GROSS pace. A stop cannot then be a block of
// its own; it is time inside the block it happened in, billed to the metres
// around it, and every pace in the pool includes whatever standing about came
// with it.
//
// Same rule as everything else in this directory: built from ONE run's own
// pings, nothing shared or seeded between runs.

import { CONFIG } from '../config.js';
import { gainAt } from '../course.js';

/**
 * Nominal block size, in effort metres.
 *
 * A floor rather than a target: pings on these runs are five to thirty minutes
 * apart, which is 600 m to several kilometres of course, so on most runs a block
 * IS a leg and this changes nothing. What it changes is the legs that went
 * nowhere, which get folded into their neighbour rather than dividing a duration
 * by no distance. 250 m is well under the closest spacing any of these phones
 * produce, so it merges the degenerate legs and nothing else.
 */
export const BLOCK_EFFORT_M = 250;

/** How finely the course is walked when laying out forecast nodes. 100 m is
 *  finer than any hill the elevation threshold admits, and a 165 km course is
 *  still only ~1,650 steps. */
const NODE_STEP_M = 100;

/**
 * Effort metres between two points on the course: distance, plus climb at
 * `predictClimbFactor`. Descent is free, which is the regression prior's own
 * position on the matter — and unlike the fitted `down` coefficient it cannot
 * come back negative and start paying the runner back for going downhill.
 */
export function effortBetween(course, fromAlong, toAlong) {
  const dist = toAlong - fromAlong;
  if (!(dist > 0)) return 0;
  if (!course.hasElevation) return dist;

  const up = gainAt(course, toAlong).up - gainAt(course, fromAlong).up;
  return dist + climbFactor() * Math.max(0, up);
}

/** The ruler's climb cost. `CONFIG.predictClimbFactor` unless the backtest is
 *  sweeping it — the same environment hook the models use, and browser-safe for
 *  the same reason. */
function climbFactor() {
  return Number(globalThis.process?.env?.EFFORT_CLIMB) || CONFIG.predictClimbFactor;
}

/**
 * The run so far as blocks of at least `blockM` effort metres, each carrying the
 * GROSS seconds it took — stops, faff and all.
 *
 * The tail is merged into the last block rather than dropped. It is the freshest
 * ground on the run and the models care most about it; a whole block of slack at
 * the newest end would be the one place a forecast cannot afford a blind spot.
 *
 * @param {Array}  points sorted oldest-first
 * @param {object} course
 * @returns {Array<{along, e, dt}>} `along` is the closing ping's, which is what
 *   recency is measured from. Empty when the run has not moved.
 */
export function effortBlocks(points, course, blockM = BLOCK_EFFORT_M) {
  const snapped = points.filter(p => p.snap);
  if (snapped.length < 2) return [];

  const out = [];
  let e = 0;
  let dt = 0;
  let previous = snapped[0];

  for (let i = 1; i < snapped.length; i++) {
    const point = snapped[i];
    e += effortBetween(course, previous.snap.along, point.snap.along);
    dt += (point.t - previous.t) / 1000;
    previous = point;

    if (e >= blockM) {
      out.push({ along: point.snap.along, e, dt });
      e = 0;
      dt = 0;
    }
  }

  if (dt > 0) {
    if (out.length) {
      const last = out[out.length - 1];
      last.e += e;
      last.dt += dt;
      last.along = previous.snap.along;
    } else if (e > 0) {
      out.push({ along: previous.snap.along, e, dt });
    }
  }

  return out.filter(block => block.e > 0 && block.dt > 0);
}

/**
 * The course ahead of `fromAlong`, cut into nodes of about `blockM` effort
 * metres — the grid a simulation walks and stores its answers on.
 *
 * The first node is the anchor itself with no effort in it, and the last is
 * always the finish, so a curve built on these nodes spans exactly the ground a
 * forecast can be asked about.
 *
 * @returns {Array<{along, e}>} `e` is the effort of the step INTO that node.
 */
export function effortNodes(course, fromAlong, blockM = BLOCK_EFFORT_M) {
  const nodes = [{ along: fromAlong, e: 0 }];
  if (!(course.length > fromAlong)) return nodes;

  let previousAlong = fromAlong;
  let previousUp = course.hasElevation ? gainAt(course, fromAlong).up : 0;
  let e = 0;

  for (let step = fromAlong + NODE_STEP_M; ; step += NODE_STEP_M) {
    const along = Math.min(step, course.length);
    const up = course.hasElevation ? gainAt(course, along).up : 0;
    e += (along - previousAlong) + climbFactor() * Math.max(0, up - previousUp);
    previousAlong = along;
    previousUp = up;

    if (along >= course.length) {
      if (e > 0) nodes.push({ along, e });
      break;
    }
    if (e >= blockM) {
      nodes.push({ along, e });
      e = 0;
    }
  }

  return nodes;
}
