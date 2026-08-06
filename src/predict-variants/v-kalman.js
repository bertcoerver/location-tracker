// Candidate: a local-linear-trend Kalman filter on log gross pace.
//
// Every other model in this directory is the ridge regression with something
// bolted on top. This one replaces it. There is no batch fit, no half-life, no
// stop budget and no fatigue exponent — there is one recursive estimator that
// walks the run block by block ([effort.js](effort.js)) and carries two numbers:
//
//   a  log pace, in log seconds per EFFORT metre — gross, stops included
//   r  how fast that log pace is drifting, per effort metre
//
//     a' = a + r·Δe        r' = r        (+ process noise, scaled by Δe)
//
// Two things follow from that shape, and they are the argument for the model:
//
// STOPS ARE NOT A SPECIAL CASE. A block's pace is its gross pace, so an aid
// station is simply a slow block. Nothing has to notice it, classify it, or
// budget for it separately; the level tracks what the runner is actually
// managing per metre, which is what a forecast needs.
//
// THE BAND WIDENS BECAUSE OF THE PHYSICS, NOT A FLOOR. Forecast uncertainty is
// the state covariance plus the process noise that will accumulate between here
// and there. A drifting level contributes variance growing with the cube of the
// horizon and a drifting TREND with the fifth power, so hours out the band opens
// up on its own — where [v-calibrated.js](v-calibrated.js) has to impose that by
// hand. Measured, this works: over the tuning runs the 80% band covers 81% with
// nothing propping it up.
//
// LOGS, which is the one departure from the textbook filter. Pace is positive
// and its scatter is multiplicative — a stop makes a block three times slower,
// not forty seconds slower — so the filter runs on log pace. That keeps the
// estimate positive without clamping and stops one aid station dragging the
// level by a fixed number of seconds.
//
//   The price is Jensen's inequality: exponentiating a log-scale mean gives the
//   GEOMETRIC mean pace, and what a forecast needs is the arithmetic one. So the
//   pace is corrected by exp(σ²/2), with σ² measured from the run's own block
//   scatter. On a smooth road run σ² is small and the correction is nil; on a
//   race with lumpy aid stations σ² is large and the correction is the filter's
//   version of a stop budget — derived from the spread of what has happened
//   rather than from a one-sided residual.
//
// WHAT DID NOT SURVIVE THE BACKTEST is worth recording, because the file was
// built around it. The trend `r` was meant to supply the fade as well: measured
// from this run rather than assumed, a runner holding pace reporting r ≈ 0 where
// [v-fade.js](v-fade.js) has to talk a literature exponent down. It forecast
// worse. A slope estimated from a couple of dozen noisy blocks and then
// extrapolated over the rest of an ultra swings the finish by hours between one
// ping and the next, and on the tuning runs any weight on it at all cost both
// accuracy and calibration against simply believing Riegel. So the fade the
// model quotes is Riegel's constant, and `r` survives where it earns its place:
// inside the filter, where it smooths, and in the variance, where "he may be
// drifting and I cannot yet see it" is exactly what the long-horizon band is
// for. Thirty-three runs are not enough to learn a slope that a century of race
// results already knows.
//
// Fitted, as ever, from ONE run's own pings.

import { CONFIG } from '../config.js';
import { finishOf } from '../points.js';
import { BLOCK_EFFORT_M, effortBetween, effortBlocks } from './effort.js';
import { clamp } from './shared.js';

/** Sweep hook, the same one [v-calibrated.js](v-calibrated.js) uses: the
 *  backtest can override a constant from the environment without editing this
 *  file. Browser-safe, because there `process` simply is not there. */
const tuned = (name, value) => Number(globalThis.process?.env?.[name]) || value;

/** How far ahead the drift's doubt keeps compounding before it levels off, in
 *  effort metres. Without a limit the trend's contribution to the variance grows
 *  with the fifth power of the horizon and swamps everything else on a
 *  hundred-miler; with it, "he may be drifting" is worth about a day's running
 *  of doubt and no more. */
const KAL_DAMP_M = tuned('KAL_DAMP_M', 20000);

/** Reference distance the process-noise constants are quoted over. */
const KAL_REF_M = 10000;
/** How much the pace LEVEL may wander over `KAL_REF_M`, as a fraction, with no
 *  trend to explain it: 5% per 10 km of effort. This is what gives the filter a
 *  finite memory — the older a block, the less it is worth — in place of the
 *  regression's explicit half-life. */
const KAL_LEVEL_SD = tuned('KAL_LEVEL_SD', 0.05);
/** And how much the DRIFT itself may wander over the same distance, quoted as
 *  the fade-per-10 km it implies: the runner who is holding pace now may be
 *  losing 12% per 10 km by then. This is the constant that sets the band hours
 *  out, and 0.12 is where the tuning runs put the 80% window nearest 80%. */
const KAL_TREND_SD = tuned('KAL_TREND_SD', 0.12);

/** Initial spread of the level, before any block but the first has spoken.
 *  Deliberately vague: the first block is one observation, not a fact. */
const KAL_P0_SD = 0.4;
/** Initial spread of the trend, again as fade-per-10 km. Centred on zero: the
 *  filter's own drift starts at "no evidence either way", and what fills that
 *  vacuum is the constant below rather than a guess. */
const KAL_R0_SD = 0.08;
/** Riegel's endurance exponent, the same literature constant
 *  [v-fade.js](v-fade.js) shrinks towards: gross time grows as D^1.06.
 *
 *  It is here because a filter with no opinion about fatigue holds a worse
 *  opinion than the field does. Everybody fades, and on a hundred-miler the
 *  twentieth hour is unlike the first by a margin no amount of watching the
 *  first hour can reveal. The note at the top of this file records what happened
 *  when the run's own drift was asked to supply this instead. */
const KAL_RIEGEL_K = tuned('KAL_RIEGEL_K', 1.06);

/** Bounds on the measured block scatter σ. The floor stops a three-block run
 *  claiming certainty and is the main thing holding the short-horizon band open,
 *  since over a kilometre or two nothing else has had room to drift; the cap
 *  bounds the Jensen correction at e^0.5, so no amount of lumpiness can inflate
 *  the pace by more than 65%. */
const KAL_OBS_MIN = tuned('KAL_OBS_MIN', 0.28);
const KAL_OBS_MAX = tuned('KAL_OBS_MAX', 1.0);
/** How much to distrust one block's pace ON TOP of its measured scatter, in
 *  variance. The filter's responsiveness is the ratio of process noise to this,
 *  and a filter that believes each block is a fair reading of the runner's
 *  current pace chases the terrain: one long climb and the whole rest of the
 *  race is repriced. Blocks are not independent draws around a slowly-moving
 *  level — they are correlated by the ground they happen to be on — and this is
 *  the price of pretending otherwise. Two, measured: at one the finish forecast
 *  swings by hours between pings, and past about eight the filter stops
 *  listening to the race at all. */
const KAL_R_MULT = tuned('KAL_R_MULT', 2);

/**
 * Block-to-block scatter of log pace, σ², by the variogram estimator: half the
 * mean squared FIRST DIFFERENCE.
 *
 * Differencing is the point. The plain variance around a mean would count a
 * runner who started fast and finished slow as enormously scattered, when what
 * he actually did was drift — and drift is the trend's job, not the noise's.
 * Consecutive blocks are minutes apart, so the level has barely moved between
 * them and what is left in the difference is the wobble.
 *
 * @returns {number} σ², capped, in log units. The FLOOR is applied by the caller
 *   rather than here, because it was worth asking whether it belonged: floored,
 *   this figure also inflates the forecast a little on a run with no measured
 *   lumpiness at all, which reads like an assumption nobody asked for. Unfloored
 *   it scored worse on both splits — a road marathon whose blocks look perfect
 *   still loses time this estimator cannot see — so the floor stays.
 */
export function blockScatter(blocks) {
  let sum = 0;
  let n = 0;
  for (let i = 1; i < blocks.length; i++) {
    const d = Math.log(blocks[i].dt / blocks[i].e) - Math.log(blocks[i - 1].dt / blocks[i - 1].e);
    sum += d * d;
    n++;
  }
  return clamp(n ? sum / (2 * n) : 0, 0, KAL_OBS_MAX ** 2);
}

/**
 * Run the filter over the blocks, oldest first.
 *
 * Initialised from the first block rather than from a prior — one observation
 * pins the level and nothing pins the trend, which is honest about what a run
 * that has just started actually knows.
 *
 * @returns {{a, r, p00, p01, p11, obsVar, qLevel, qTrend}} the posterior at the
 *   newest block, and the noise intensities the forecast needs to keep
 *   accumulating past it.
 */
export function filterPace(blocks) {
  const obsVar = Math.max(blockScatter(blocks), KAL_OBS_MIN ** 2);
  const qLevel = KAL_LEVEL_SD ** 2 / KAL_REF_M;
  const qTrend = KAL_TREND_SD ** 2 / KAL_REF_M ** 3;

  let a = Math.log(blocks[0].dt / blocks[0].e);
  let r = 0;
  let p00 = KAL_P0_SD ** 2;
  let p01 = 0;
  let p11 = (KAL_R0_SD / KAL_REF_M) ** 2;

  for (let i = 1; i < blocks.length; i++) {
    const de = blocks[i].e;

    // Predict: carry the level forward along the trend, and let both grow
    // vaguer by the distance travelled.
    a += r * de;
    const n00 = p00 + 2 * de * p01 + de * de * p11 + (qTrend * de ** 3) / 3 + qLevel * de;
    const n01 = p01 + de * p11 + (qTrend * de * de) / 2;
    const n11 = p11 + qTrend * de;
    p00 = n00;
    p01 = n01;
    p11 = n11;

    // Update. R scales with 1/e: a long block averages more ground and its pace
    // is that much better measured, which is what lets a filter run on blocks of
    // whatever size the pings happened to give it.
    const innovation = Math.log(blocks[i].dt / blocks[i].e) - a;
    const R = KAL_R_MULT * obsVar * (BLOCK_EFFORT_M / de);
    const s = p00 + R;
    const k0 = p00 / s;
    const k1 = p01 / s;
    a += k0 * innovation;
    r += k1 * innovation;
    // (I − KH)P with H = [1, 0]. Symmetry survives because k1·p00 == k0·p01.
    const was01 = p01;
    p00 -= k0 * p00;
    p01 -= k0 * was01;
    p11 -= k1 * was01;
  }

  return { a, r, p00, p01, p11, obsVar, qLevel, qTrend };
}

export function buildForecast(points, course) {
  if (!course || !points?.length) return null;
  if (finishOf(points)) return null;

  const snapped = points.filter(p => p.snap);
  if (snapped.length <= CONFIG.predictMinLegs) return null;

  const blocks = effortBlocks(points, course);
  if (!blocks.length) return null;

  const state = filterPace(blocks);
  const pace = clamp(Math.exp(state.a), CONFIG.predictMinPaceSpm, CONFIG.predictMaxPaceSpm);

  return {
    ...state,
    course,
    from: { t: snapped[snapped.length - 1].t, along: snapped[snapped.length - 1].snap.along },
    pace,
    // Effort covered so far, which is the denominator Riegel's fade is measured
    // against: the same stretch means a different amount of fatigue depending on
    // how much race is already behind it.
    covered: blocks.reduce((sum, block) => sum + block.e, 0),
    // What the backtest reads. `pace` is per EFFORT metre, so on flat ground it
    // is flat pace and the climb coefficient is whatever the effort metric says
    // a metre of ascent costs — the same three numbers, read off a fixed ruler
    // instead of fitted.
    flat: pace * Math.exp(state.obsVar / 2),
    up: CONFIG.predictClimbFactor * pace * Math.exp(state.obsVar / 2),
    down: 0,
    sigma2: (pace * BLOCK_EFFORT_M) ** 2 * state.obsVar,
    legs: blocks.length
  };
}

export function predictAt(forecast, along) {
  if (!forecast || !Number.isFinite(along)) return null;

  const { course, from } = forecast;
  const dist = along - from.along;
  if (!(dist > 0)) return null;

  const E = effortBetween(course, from.along, along);
  if (!(E > 0)) return null;

  // How far the trend could have carried the pace by the far end, damped — the
  // lever arm the drift's uncertainty acts through. See the variance below.
  const c = KAL_DAMP_M * (1 - Math.exp(-E / (2 * KAL_DAMP_M)));

  // Fade, as the log of a multiplier, and Riegel's rather than the filter's own.
  // Increasing in the distance ahead, which is what keeps the model monotone.
  const fade = forecast.covered > 0
    ? (KAL_RIEGEL_K - 1) * Math.log((forecast.covered + E / 2) / forecast.covered)
    : 0;

  // The lognormal mean correction, phased in with the horizon. exp(σ²/2) is what
  // turns the filter's geometric mean into the arithmetic one, and the
  // arithmetic mean is what governs a SUM of many blocks — a finish six hours
  // out will contain its share of aid stations whether or not he is standing in
  // one now. Over a single block ahead it is the wrong correction entirely:
  // there is one draw to come, not an average of thirty, and the middle of the
  // distribution is the better guess. Which is the same thing the stop budget in
  // [v-stoprate.js](v-stoprate.js) has to say with a ramp, arrived at from the
  // arithmetic instead of from a constant.
  const n = E / BLOCK_EFFORT_M;
  const jensen = (forecast.obsVar / 2) * (n / (n + 1));

  const seconds = forecast.pace * E * Math.exp(fade + jensen);

  const t = from.t + Math.max(seconds, dist * CONFIG.predictMinPaceSpm) * 1000;

  // Everything below is a RELATIVE variance — of the answer, not of a pace —
  // because the model is multiplicative from end to end. Four sources:
  //
  //   state     what the filter still doesn't know about level and trend
  //   level     how far the level will wander before he gets there  (∝ E)
  //   trend     how far the trend will wander, levered by c         (∝ E·c²)
  //   blocks    plain block-to-block wobble, which AVERAGES AWAY over many
  //             blocks and so shrinks as 1/E — the only term that does
  //
  // The first three grow, which is the point: an hour out this is dominated by
  // scatter, a day out by the possibility that the runner is simply not the same
  // runner by then.
  const relVar =
    Math.max(0, forecast.p00 + 2 * c * forecast.p01 + c * c * forecast.p11) +
    (forecast.qLevel * E) / 3 +
    (forecast.qTrend * E * c * c) / 3 +
    (forecast.obsVar * BLOCK_EFFORT_M) / E;

  const sd = seconds * Math.sqrt(relVar) * 1000;
  const half = CONFIG.predictBandZ * sd;

  return { t, lo: t - half, hi: t + half, sd };
}
