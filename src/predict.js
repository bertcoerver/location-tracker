// Forecasting the rest of the course from the run so far.
//
// Everything here is fitted from ONE run's own pings. Nothing is shared between
// runs, cached across them or seeded from them — a course is run differently by
// different people on different days, and borrowing yesterday's pace is how a
// forecast becomes confident and wrong.
//
// The model is a weighted ridge regression of leg DURATION on distance, ascent
// and descent, with no intercept:
//
//   dt = flat * dist + up * ascent + down * descent          (seconds, metres)
//
// Three coefficients, each in seconds per metre, each directly readable: `flat`
// is flat pace, `up` is what a metre of climbing costs on top of it, `down` what
// a metre of descent does. It is the classic Naismith shape, and the smallest
// model that can tell a climb from a drop — which is the whole point of fitting
// anything at all rather than dividing distance by time.
//
// Regressing TIME rather than pace is what makes it robust. With no intercept, a
// leg where the runner didn't move — an aid station, a phone on a table, a ping
// that snapped backwards — has an all-zero row in the design matrix. Such a row
// contributes exactly nothing to the coefficients and exactly its own residual to
// the scatter. So a stop widens the uncertainty, as it should, and cannot drag
// the pace anywhere. There is no "ignore short legs" threshold here because none
// is needed, which is the same reason there is no threshold in `climb()`.

import { CONFIG } from './config.js';
import { gainAt } from './course.js';
import { finishOf } from './points.js';

/**
 * How far the climb coefficients may stray from flat pace before the fit has
 * plainly gone wrong. 40 x flat pace is roughly 300 m of ascent an hour — slower
 * than anyone walks uphill, so it is a guardrail rather than a modelling
 * assumption. The lower bound says a metre of descent may pay for at most a
 * metre of flat running, which is about where real grade-adjustment curves put
 * their fastest gradient.
 */
const CLIMB_COEF_CAP = 40;

/** Ridge floor per regressor, in squared metres. Negligible beside any real
 *  data, and the only thing standing between a dead-flat course and a singular
 *  matrix — with it, an unobservable coefficient sits on its prior instead. */
const PRECISION_FLOOR = 1;

/**
 * The run cut into legs: one per pair of consecutive SNAPPED pings.
 *
 * Ascent and descent come from [`gainAt`](course.js), so they are the same
 * threshold-filtered figures the tooltips already show — a leg's climb means the
 * same thing here as it does two rows further down the same tooltip.
 *
 * A leg that went backwards keeps its duration and loses its distance. That is
 * the all-zero row described at the top of this file: real elapsed time, no
 * claim about pace.
 *
 * @param {Array}  points sorted oldest-first
 * @param {object} course
 * @returns {Array<{t, along, dt, dist, up, down}>} `t` and `along` are the
 *   CLOSING ping's, which is what the recency weight is measured from.
 */
export function legsOf(points, course) {
  const out = [];
  let previous = null;

  for (const point of points) {
    if (!point.snap) continue;

    if (previous) {
      const dist = point.snap.along - previous.snap.along;
      const climb = course.hasElevation && dist > 0
        ? between(gainAt(course, previous.snap.along), gainAt(course, point.snap.along))
        : { up: 0, down: 0 };

      out.push({
        t: point.t,
        along: point.snap.along,
        dt: (point.t - previous.t) / 1000,
        dist: dist > 0 ? dist : 0,
        up: climb.up,
        down: climb.down
      });
    }

    previous = point;
  }

  return out;
}

/** Climb over a stretch, both figures positive. The same rule as `between` in
 *  [stats.js](stats.js): ground covered in reverse turns its ascent into
 *  descent, and negative climb is arithmetic rather than a fact about a hill. */
function between(from, to) {
  const up = to.up - from.up;
  const down = to.down - from.down;
  if (up >= 0 && down >= 0) return { up, down };
  return { up: -down || 0, down: -up || 0 };
}

/**
 * Fit the three coefficients.
 *
 * WEIGHTING is by metres of course still to come, not by minutes elapsed. What
 * makes the last hour of a race unlike the first is fatigue and terrain, and both
 * track distance; a phone that drops to half-hourly pings as its battery fades
 * would otherwise silently halve how much history the model looks at, exactly
 * when it can least afford to. `predictHalfLifeM` is the half-life.
 *
 * SHRINKAGE is towards the run's own overall pace, worth `predictPriorLegs`
 * pseudo-legs. The prior's precision is scaled by each regressor's own weighted
 * sum of squares, so its pull is `tau / (tau + n)` in the marginal — fading to
 * nothing as a long run accumulates data — and much stronger than that along
 * whatever direction the data happens not to pin down. On a course with no
 * descent, the descent coefficient is pinned down by nothing at all and comes
 * back as its prior, which is the honest answer.
 *
 * The prior itself is empirical: flat pace is what this run has averaged so far,
 * climbing costs `predictClimbFactor` times that, and descent is free. Shrinking
 * a recency-weighted fit towards the whole-run average is the term that stops one
 * slow patch running away with the forecast.
 *
 * @param {Array}  legs from `legsOf`
 * @param {number} anchorAlong metres — where recency is measured back from
 * @returns {{flat, up, down, cov, sigma2, meanDist, meanDt, legs}|null} null when
 *   there is nothing to fit: too few legs, or a run that has not moved.
 */
export function fitPace(legs, anchorAlong, halfLifeM = CONFIG.predictHalfLifeM) {
  const n = legs.length;
  if (n < CONFIG.predictMinLegs) return null;

  let totalDist = 0;
  let totalDt = 0;
  // Deliberately only the legs that went somewhere. This is what the whole
  // no-intercept form buys, and the prior has to honour it too or a stop would
  // slip into the pace through the back door — unable to move the regression,
  // but quietly dragging the thing the regression is shrunk towards.
  //
  // The consequence is worth stating plainly: `flat` is MOVING pace, and time
  // spent standing at an aid station is not modelled in the estimate at all. It
  // widens the band, because it is real scatter, but it does not push the ETA
  // later. On a race with long stops the forecast will run optimistic, and the
  // per-ping scores in the tooltips are where that shows up — consistently
  // "late" errors are this, and the fix would be a stoppage term rather than a
  // tweak to any number here.
  let movingDist = 0;
  let movingDt = 0;
  for (const leg of legs) {
    totalDist += leg.dist;
    totalDt += leg.dt;
    if (leg.dist > 0) {
      movingDist += leg.dist;
      movingDt += leg.dt;
    }
  }
  // A run that has not moved has no pace to estimate and no ground to forecast
  // over. Saying nothing is the only honest option.
  if (!(movingDist > 0)) return null;

  // Normalised so they sum to the leg count, which keeps `sigma2` on the plain
  // seconds-squared scale a residual is naturally read on.
  const weights = new Float64Array(n);
  let sumW = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = 2 ** (-Math.max(0, anchorAlong - legs[i].along) / halfLifeM);
    sumW += weights[i];
  }
  if (!(sumW > 0)) return null;
  for (let i = 0; i < n; i++) weights[i] *= n / sumW;

  // Normal equations. Symmetric, so only the upper triangle is accumulated.
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const b = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const w = weights[i];
    const x = [legs[i].dist, legs[i].up, legs[i].down];
    for (let j = 0; j < 3; j++) {
      b[j] += w * x[j] * legs[i].dt;
      for (let k = j; k < 3; k++) A[j][k] += w * x[j] * x[k];
    }
  }
  A[1][0] = A[0][1];
  A[2][0] = A[0][2];
  A[2][1] = A[1][2];

  const flat0 = movingDt / movingDist;
  const prior = [flat0, CONFIG.predictClimbFactor * flat0, 0];

  for (let j = 0; j < 3; j++) {
    const precision = CONFIG.predictPriorLegs * (A[j][j] / n + PRECISION_FLOOR);
    A[j][j] += precision;
    b[j] += precision * prior[j];
  }

  const inverse = invert3(A);
  if (!inverse) return null;

  const beta = multiply3(inverse, b);
  if (!beta.every(Number.isFinite)) return null;

  // Guardrails, not modelling. A fit that reaches one of these has gone wrong,
  // and the point is only that it fails as a plausible pace rather than as an
  // ETA some time next week.
  const flat = clamp(beta[0], CONFIG.predictMinPaceSpm, CONFIG.predictMaxPaceSpm);
  const up = clamp(beta[1], 0, CLIMB_COEF_CAP * flat);
  const down = clamp(beta[2], -flat, CLIMB_COEF_CAP * flat);

  // Residual scatter, against the coefficients actually used. Zero-movement legs
  // are in here — that is what they are for.
  let rss = 0;
  for (let i = 0; i < n; i++) {
    const leg = legs[i];
    const r = leg.dt - (flat * leg.dist + up * leg.up + down * leg.down);
    rss += weights[i] * r * r;
  }
  const meanDt = totalDt / n;
  // Floored twice over: three legs can be fitted almost perfectly by three
  // coefficients, and a band claiming ten seconds of certainty an hour out would
  // be the most misleading thing on the screen.
  const sigma2 = Math.max(
    rss / Math.max(1, n - 3),
    (CONFIG.predictMinSigmaMs / 1000) ** 2,
    (CONFIG.predictSigmaFloorFrac * meanDt) ** 2
  );

  return {
    flat,
    up,
    down,
    // Covariance of the coefficients. `sigma2 * A^-1` with the ridge already in
    // A, which is what makes a poorly-determined coefficient come back with a
    // wide interval rather than a confident wrong one.
    cov: scale3(inverse, sigma2),
    sigma2,
    // Both means are over legs, so `meanDist` is how much course a typical leg
    // covers — the unit the remaining distance is counted in below.
    meanDist: totalDist / n,
    meanDt,
    legs: n
  };
}

/**
 * The run's forecast, or null when there isn't one to be had.
 *
 * Anchored at the newest SNAPPED ping: that is the last place the runner is
 * actually known to have been, and every prediction below is measured forward
 * from it. Deliberately not adjusted for how long ago that was — the phone is
 * the only thing that knows where he is, and inventing progress since it last
 * spoke would be exactly the kind of extrapolation this file exists to do
 * carefully.
 *
 * @param {Array}       points sorted oldest-first
 * @param {object|null} course
 */
export function buildForecast(points, course) {
  if (!course || !points?.length) return null;
  // A finished run has no rest of the course. Same rule as the panel's clock:
  // the finish is an assertion by the phone, and it outranks the arithmetic.
  if (finishOf(points)) return null;

  const snapped = points.filter(p => p.snap);
  if (snapped.length <= CONFIG.predictMinLegs) return null;

  return assemble(course, snapped[snapped.length - 1], legsOf(snapped, course));
}

/** The fit plus its anchor, which is what everything downstream needs. Separate
 *  from `buildForecast` so the backtest can build one per ping off legs it has
 *  already cut, rather than re-cutting them n times. */
function assemble(course, anchor, legs) {
  const fit = fitPace(legs, anchor.snap.along);
  if (!fit) return null;
  return { ...fit, course, from: { t: anchor.t, along: anchor.snap.along } };
}

/**
 * When the runner is likely to reach a distance along the course.
 *
 * The band has two sources, and they are genuinely different things:
 *
 *   parameter  z'Cz — "I don't know your true pace". Grows with the SQUARE of
 *              the distance ahead, because a pace error compounds all the way.
 *   leg noise  one leg's worth of scatter per remaining leg — "even knowing
 *              your pace, you'll wobble". Grows linearly, so its contribution to
 *              the width grows as the square root.
 *
 * Adding the variances assumes they're independent, which they roughly are: one
 * is about the estimate, the other about the world.
 *
 * @param {object|null} forecast from `buildForecast`
 * @param {number}      along metres from the start of the course
 * @returns {{t, lo, hi, sd}|null} epoch ms, and null for ground already passed —
 *   there the run's own record is the answer and a model has nothing to add.
 */
export function predictAt(forecast, along) {
  if (!forecast || !Number.isFinite(along)) return null;

  const { course, from } = forecast;
  const dist = along - from.along;
  if (!(dist > 0)) return null;

  const climb = course.hasElevation
    ? between(gainAt(course, from.along), gainAt(course, along))
    : { up: 0, down: 0 };
  const z = [dist, climb.up, climb.down];

  const seconds = z[0] * forecast.flat + z[1] * forecast.up + z[2] * forecast.down;
  // Belt and braces over the coefficient clamps: whatever the mix of climb and
  // descent, the answer may not come out faster than a human being can run.
  const t = from.t + Math.max(seconds, dist * CONFIG.predictMinPaceSpm) * 1000;

  const variance = quadratic(forecast.cov, z) +
    (dist / Math.max(1, forecast.meanDist)) * forecast.sigma2;
  const sd = Math.sqrt(Math.max(0, variance)) * 1000;
  const half = CONFIG.predictBandZ * sd;

  return { t, lo: t - half, hi: t + half, sd };
}

/**
 * The inverse question: where is the runner at a given moment?
 *
 * A height profile has distance along its x-axis, so this is the form the strip
 * can actually draw — "probably somewhere in here, now" rather than a time it has
 * no axis for.
 *
 * `lo` and `hi` are the same 80% band read the other way round. A pessimistic
 * pace means arriving LATE, so the position where the late edge of the band
 * reaches `when` is the nearest the runner might have got — which is why the two
 * are solved off opposite edges.
 *
 * @param {object|null} forecast
 * @param {number}      when epoch ms
 * @returns {{along, lo, hi}|null} null once the whole course is behind the
 *   prediction — past that there is nothing left to be in the middle of.
 */
export function positionAt(forecast, when) {
  if (!forecast || !Number.isFinite(when)) return null;

  const end = forecast.course.length;
  const finish = predictAt(forecast, end);
  if (!finish || when >= finish.t) return null;
  if (when <= forecast.from.t) return null;

  return {
    along: solve(forecast, end, when, at => at.t),
    lo: solve(forecast, end, when, at => at.hi),
    hi: solve(forecast, end, when, at => at.lo)
  };
}

/**
 * The distance at which `edge` of the prediction reaches `when`, by bisection.
 *
 * All three edges rise monotonically with distance — more course means more time
 * and more uncertainty — so bisection is exact to the metre in the 40-odd steps
 * below, and needs none of the derivatives a smarter root-finder would want.
 */
function solve(forecast, end, when, edge) {
  let lo = forecast.from.along;
  let hi = end;
  for (let i = 0; i < 40 && hi - lo > 0.5; i++) {
    const mid = (lo + hi) / 2;
    const at = predictAt(forecast, mid);
    if (at && edge(at) < when) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * Hang each ping's own prediction error off its stats, in place.
 *
 * A walk-forward backtest, and strictly so: the forecast for ping *i* is fitted
 * on pings `0..i-1` and anchored at ping `i-1`, so nothing from ping *i* or after
 * it reaches the fit. That is what makes the figure in the tooltip a test of the
 * model rather than a look at its own residuals — and it is the regime the model
 * was actually in when that ping landed, which is the thing worth knowing.
 *
 * One leg ahead is a modest test, and that is the point: it is the only forecast
 * the data supported at the time.
 *
 * Cost is quadratic — n fits over up to n legs — but the legs are cut once and
 * this runs on a poll rather than on a frame, so a few hundred pings is a
 * few hundred thousand floating-point operations and nobody notices.
 *
 * @param {Array}       points sorted oldest-first, already through `deriveStats`
 * @param {object|null} course
 */
export function deriveForecastErrors(points, course) {
  if (!course || !points?.length) return points;

  const snapped = points.filter(p => p.snap);
  const legs = legsOf(snapped, course);

  // legs[k] runs from snapped[k] to snapped[k+1], so the legs known before ping
  // i are legs[0..i-2] — i-1 of them. Needing `predictMinLegs` of those is what
  // puts the first error on the fourth snapped ping of a run.
  for (let i = CONFIG.predictMinLegs + 1; i < snapped.length; i++) {
    const forecast = assemble(course, snapped[i - 1], legs.slice(0, i - 1));
    const at = predictAt(forecast, snapped[i].snap.along);
    if (!at) continue;

    const point = snapped[i];
    // Positive means the runner arrived later than predicted, which reads as
    // "late" in the tooltip. The sign convention is the tooltip's, not the
    // model's — a residual would have it the other way round.
    //
    // `??=` only so that calling this without `deriveStats` first is a missing
    // row in a tooltip rather than a thrown exception that takes the paint with
    // it. Ordinarily the object is already there.
    (point.stats ??= {}).forecast = { t: at.t, error: point.t - at.t, lo: at.lo, hi: at.hi };
  }

  return points;
}

// --- 3x3 linear algebra, which is all this model ever needs ------------------

/** Inverse by adjugate, or null if the matrix is singular. */
function invert3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || det === 0) return null;

  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det]
  ];
}

function multiply3(m, v) {
  return m.map(row => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
}

function scale3(m, k) {
  return m.map(row => row.map(value => value * k));
}

/** z' M z — the variance of a linear combination of the coefficients. */
function quadratic(m, z) {
  let sum = 0;
  for (let j = 0; j < 3; j++) {
    for (let k = 0; k < 3; k++) sum += z[j] * m[j][k] * z[k];
  }
  return sum;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}
