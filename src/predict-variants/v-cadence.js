// Candidate: v-calibrated corrected for how often the phone actually pings.
//
// Every model in this directory was fitted and judged on runs that ping every
// five minutes — the 33 usable runs in `locations/` sit at a 5.1-minute native
// cadence, and nothing in the registry has ever seen anything else. A phone set
// to 25 or 40 minutes hands the same estimator legs three to eight times longer,
// and three of its quantities are counted in LEGS or PINGS rather than in ground
// or time. Those three come apart when a leg stops being five minutes.
//
// A backtest thinning every run 3:1 and 5:1 — scored on the 252,725 cells every
// configuration answered, so a coarse cadence cannot flatter itself by starting
// later and skipping the hardest early columns — found the ESTIMATE survives and
// two things break. This model fixes those two and nothing else.
//
// THE BAND, which is the real regression. [classic.js](classic.js) prices leg
// noise as `(dist / meanDist) · sigma2`: one leg's scatter per remaining leg,
// which is the right sum only if leg residuals are independent. They are not.
// Measured over 33 runs at three cut-points, per-leg sigma grows 2.46x for a 3x
// longer leg and 4.11x for 5x, where independence predicts 1.73x and 2.24x — a
// long leg swallows a stop and a recovery whole, and the two do not cancel. So a
// coarse cadence counts noise it has already absorbed, and the nominal-80% band
// covered 92% at 5-minute pings, 94% at 15 and 98% at 25, reaching 100% by 45.
// A band that always contains the answer has stopped saying anything.
//
// THE COLD START. `predictMinLegs` counts legs, so the first forecast slipped
// from 10 minutes into the race to 31 to 52 — 23% of the way through — while
// holding five times more evidence than the 5-minute run had when it started
// answering. `predictHalfLifeM` is denominated in metres for exactly this
// reason and the gate never was. Re-asking it in ground and time is the fix; see
// `warmEnough` and the `minLegs` option on `classic.buildForecast`.
//
// THE MEAN IS LEFT ALONE, deliberately. Paired per-run MAE is only x1.09 at 15
// minutes and x1.16 at 25, with bias unchanged, and both candidate corrections
// lost: `stopRate` scaled by a power of rho is a coin flip, and `predictPriorLegs`
// divided by rho is worse on 19 of 33 runs. Coarse cadence turns out to be
// self-compensating — flat pace comes back 3-6% slower and the climb coefficient
// 23-29% higher as the ridge prior takes over. See the README.
//
// The whole model is the IDENTITY at five-minute pings: rho is 1, the early
// return below hands back `calibrated`'s forecast untouched, and `warmEnough`
// cannot open on legs that short. That is what makes it safe as the default —
// every run already in this repo forecasts exactly as it did before.

import { buildForecast as calBuild } from './v-calibrated.js';
import { clamp } from './shared.js';

/**
 * The cadence everything upstream was tuned at, in seconds.
 *
 * Not five minutes, and not `CONFIG.minPingMs`, for two separate reasons.
 *
 * MEASURED, not configured. The phone is set to five minutes and delivers
 * 307-308 seconds: scheduling slack plus the fixed upload lag, on every run in
 * `locations/` bar one. A 300-second reference sits BELOW that band, so every
 * recorded run would come back at rho 1.02 and take a small shrink — the
 * correction switching itself on, very slightly, for every race ever run. 310
 * clears the whole observed spread (300-308) with a couple of seconds of room,
 * so a phone doing what it has always done is the identity and stays the
 * identity. The cost is that rho at 25-minute pings reads 4.84 rather than
 * 4.90, which is nothing beside a `BAND_BETA` swept in steps of 0.2.
 *
 * And a LITERAL rather than `CONFIG.minPingMs`, because that constant is
 * overridable per run by `ping_min_interval` in a settings file — so a race
 * declaring 25-minute pings would move the reference to 25 minutes, rho would
 * come back as 1, and the correction would switch itself off on precisely the
 * run it exists for. The reference is a fact about how the model was fitted,
 * not about how any particular phone is configured.
 */
const PING_REF_S = 310;

/**
 * Ceiling on rho. UTMB's 40-minute end implies 7.8, but the backtest only
 * measured the effect directly out to ~25 minutes (rho 4.9), with the thinning
 * sweep beyond that reading on MAE rather than on coverage. Past the clamp the
 * band shrinks by less than the power law asks for, which leaves it wider than
 * the extrapolation would — the safe direction to be wrong in.
 */
const RHO_MAX = 6;

/**
 * How the band shrinks: `sigma2 / rho^BAND_BETA`.
 *
 * Swept over {0, 0.3, 0.5, 0.63, 0.8, 1}. 0.5 minimises the gap to the
 * 5-minute coverage profile — 1.3 and 1.7 points at 15 and 25 minutes, against
 * 2.3 and 3.0 uncorrected — and it restores that profile bin for bin rather
 * than merely on the median. Its paired MAE ratio is exactly 1.000 on all 33
 * runs, which is the point: this touches the band and cannot move the estimate.
 *
 * Note it is not the 0.63 the sigma growth measures directly. Some of that
 * growth is real scatter the band SHOULD carry; 0.63 over-corrected.
 */
const BAND_BETA = 0.5;

/**
 * What a run must have covered, in metres and seconds, before one leg is
 * evidence enough to fit from.
 *
 * Both, not either. Ground alone would let a downhill opening kilometre through
 * on almost no time, and time alone would let a phone sitting still at the start
 * line claim a pace. Together they say the runner has been running for a while
 * and has got somewhere, which is the thing the leg count was standing in for.
 *
 * The cells this unlocks are genuinely worse — about twice the MAE of the run's
 * later ones — but they cover at 84-86% against a nominal 80%, so the window
 * drawn there is wide and honest. The alternative is a blank panel for the first
 * 52 minutes of a 25-minute-cadence race.
 */
const COLD_METRES = 2500;
const COLD_SECONDS = 900;

/**
 * How coarsely this run is pinging, relative to the cadence the model was tuned
 * at. 1 means five-minute pings or faster, and 1 is the identity.
 *
 * The MEDIAN gap rather than the mean: a run has network holes in it, and one
 * two-hour gap through a col should not convince the model that the whole race
 * is being sampled two-hourly. Read from the pings themselves rather than from
 * the `ping_*` settings, which name the ENDS of a battery curve — a phone
 * declaring 25 and 40 is somewhere between the two all race, and only the pings
 * know where.
 *
 * @param {Array} snapped the run's snapped pings, oldest first
 */
function cadenceRatio(snapped) {
  const gaps = [];
  for (let i = 1; i < snapped.length; i++) {
    const gap = (snapped[i].t - snapped[i - 1].t) / 1000;
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 1;

  gaps.sort((a, b) => a - b);
  const mid = (gaps.length - 1) / 2;
  const median = (gaps[Math.floor(mid)] + gaps[Math.ceil(mid)]) / 2;

  return clamp(median / PING_REF_S, 1, RHO_MAX);
}

/** Has this run covered enough ground, over enough time, to fit from one leg? */
function warmEnough(snapped) {
  if (snapped.length < 2) return false;

  const first = snapped[0];
  const last = snapped[snapped.length - 1];
  return last.snap.along - first.snap.along >= COLD_METRES &&
    (last.t - first.t) / 1000 >= COLD_SECONDS;
}

export function buildForecast(points, course) {
  if (!points?.length) return null;

  const snapped = points.filter(p => p.snap);
  const options = warmEnough(snapped) ? { minLegs: 1 } : undefined;

  const base = calBuild(points, course, options);
  if (!base) return null;

  // The identity path, written as its own return so that "a five-minute run is
  // untouched" is something you can check by reading rather than by arithmetic.
  const rho = cadenceRatio(snapped);
  if (rho === 1) return { ...base, rho };

  // Both, not just `sigma2`. `cov` is `sigma2 · A⁻¹` — the same over-counted
  // scatter, scaled — and shrinking one without the other would leave the
  // parameter half of the band answering a different question from the leg half.
  const shrink = rho ** BAND_BETA;
  return {
    ...base,
    rho,
    sigma2: base.sigma2 / shrink,
    cov: base.cov.map(row => row.map(value => value / shrink))
  };
}

// Unchanged from `calibrated`, and re-exported rather than wrapped because there
// is nothing to add: the correction is entirely in the fitted quantities above.
// In particular the `CAL_C · remaining` sd floor still applies on top of the
// shrunk band, which is the composition the backtest measured.
export { predictAt } from './v-calibrated.js';
