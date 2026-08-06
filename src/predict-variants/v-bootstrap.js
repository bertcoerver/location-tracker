// Candidate: run the rest of the race a few hundred times and read the answer
// off the results.
//
// No pace model at all. The run so far is cut into blocks of gross pace
// ([effort.js](effort.js)); the course ahead is cut into nodes of the same size;
// and the remaining race is then SIMULATED, each node taking a pace drawn from
// the blocks the runner has actually produced. Two hundred simulated finishes
// later, the forecast for any point on the course is the median of what happened
// there, and the band is the 10th and 90th percentiles of it.
//
// What that buys, against every other model here:
//
// THE BAND STOPS BEING SYMMETRIC. Every forecast in this directory quotes
// t ± z·sd, which says a runner is exactly as likely to be an hour early as an
// hour late. He is not. He can blow up, get lost, sit down at an aid station and
// lose two hours; he cannot finish two hours early. Remaining-time distributions
// are right-skewed, and empirical percentiles are skewed the same way for free,
// because they are just what the simulations did.
//
// STOPS COME BACK AS EVENTS, NOT AS A RATE. [v-stoprate.js](v-stoprate.js)
// measures stopped time and smears it evenly over every future metre — the right
// mean, the wrong shape. Here an aid station is a slow block sitting in the pool,
// drawn now and then, landing in one place and not another. That is what makes
// the upper tail the right length.
//
// AUTOCORRELATION SURVIVES. Blocks are drawn in RUNS of `BOOT_RUN_BLOCKS`
// consecutive ones rather than independently — a moving-block bootstrap. Bad
// patches in running are not independent minute to minute: the climb that is
// slowing him down now is still there in ten minutes. Drawing singly would
// average that away and give a band far too narrow.
//
// Two things the resampling cannot supply on its own, and both are honest parts
// of the simulation rather than corrections bolted onto it:
//
//   the LEVEL WANDERS. A pure resample assumes the runner keeps drawing from
//   today's pool for ever, so its band converges as the square root of the
//   distance and would be far too confident twelve hours out. Each simulated
//   path therefore carries a multiplicative level that random-walks as it goes
//   (`BOOT_DRIFT_SD` per 10 km of effort), which is the "he may simply not be
//   the same runner by then" term. It is symmetric in log — this model has no
//   opinion about which way he will change, which is exactly what separates it
//   from [v-kalman.js](v-kalman.js) and its directional trend.
//
//   and TODAY'S POOL IS ITSELF A SAMPLE. `BOOT_LEVEL_MIN` is the irreducible
//   doubt about the level a run of any length starts with.
//
// Blocks are drawn with probability proportional to their own effort metres and
// to the same recency weight the regression uses. The effort weighting is not
// cosmetic: it is what makes the expected simulated pace equal total time over
// total effort — the run's true gross pace — instead of over-counting whichever
// blocks happened to be short.
//
// Deterministic: one fixed seed, so the same run always produces the same band
// rather than a figure that shivers on every repaint.

import { CONFIG } from '../config.js';
import { finishOf } from '../points.js';
import { effortBlocks, effortNodes } from './effort.js';
import { clamp } from './shared.js';

/** Sweep hook, as in [v-calibrated.js](v-calibrated.js): the backtest can
 *  override a constant from the environment. Browser-safe. */
const tuned = (name, value) => Number(globalThis.process?.env?.[name]) || value;

/** Simulated completions per forecast. Two hundred puts the 10th and 90th
 *  percentiles on twenty draws each — enough for a band that is stable to well
 *  under a minute, and about two milliseconds of work on the longest course in
 *  the repo. */
const BOOT_SIMS = 200;
/** Consecutive pool blocks per draw. Three blocks is a kilometre or two of
 *  correlated going, which is about how long a climb, a bad patch or a stretch
 *  of good track actually lasts. */
const BOOT_RUN_BLOCKS = 3;
/** How far a simulated path's pace level random-walks per 10 km of effort. This
 *  is the term that stops the band converging as the square root of the
 *  distance, and 0.18 is where the tuning runs put the 80% window at 80%. */
const BOOT_DRIFT_SD = tuned('BOOT_DRIFT_SD', 0.18);
const BOOT_DRIFT_REF_M = 10000;
/** Floor and cap on the run-level doubt each path starts with, in log units. */
const BOOT_LEVEL_MIN = tuned('BOOT_LEVEL_MIN', 0.08);
const BOOT_LEVEL_MAX = 0.35;
/**
 * Riegel's endurance exponent and how unsure of it each path is.
 *
 * The one thing resampling cannot supply. Every pace in the pool was run by a
 * fresher runner than the one who will run the rest, and no amount of drawing
 * from it will produce a slowdown that has not happened yet — which is why a
 * pure bootstrap comes in ten to twenty per cent optimistic on the long races,
 * measured. So each simulated path draws its OWN exponent, and its pace grows
 * with total distance as D^(k−1) as it goes.
 *
 * Drawing k rather than fixing it is the point, and it is what this model can
 * say that [v-kalman.js](v-kalman.js) cannot: some of these paths belong to a
 * runner who barely fades and some to one who falls apart, in the proportions
 * the spread allows, and the band inherits the difference instead of being told
 * about it. `BOOT_K_SD` is a little wider than the disagreement between
 * published values, because the runner is one person rather than a field.
 */
const BOOT_K0 = tuned('BOOT_K0', 1.06);
const BOOT_K_SD = tuned('BOOT_K_SD', 0.06);
const BOOT_K_MAX = 1.35;
/** Fixed seed: a forecast that changes when nothing has changed is a bug. */
const BOOT_SEED = 0x9e3779b9;
/** The band may never be quoted narrower than this, in ms, so the estimate
 *  always sits strictly inside it — a synthetic run with no scatter at all
 *  would otherwise produce three identical curves. */
const BOOT_MIN_HALF_MS = 1000;

export function buildForecast(points, course) {
  if (!course || !points?.length) return null;
  if (finishOf(points)) return null;

  const snapped = points.filter(p => p.snap);
  if (snapped.length <= CONFIG.predictMinLegs) return null;

  const blocks = effortBlocks(points, course);
  if (!blocks.length) return null;

  const anchor = snapped[snapped.length - 1];
  const pool = poolOf(blocks, anchor.snap.along);
  const nodes = effortNodes(course, anchor.snap.along);
  const covered = blocks.reduce((sum, block) => sum + block.e, 0);
  const curves = simulate(pool, nodes, covered);

  return {
    course,
    from: { t: anchor.t, along: anchor.snap.along },
    curves,
    tau: pool.tau,
    // What the backtest reads. `flat` is the effort-weighted gross pace — total
    // time over total effort — which is the number the whole simulation is
    // built to have as its mean.
    flat: pool.mean,
    up: CONFIG.predictClimbFactor * pool.mean,
    down: 0,
    sigma2: (pool.sd * pool.meanEffort) ** 2,
    legs: blocks.length
  };
}

export function predictAt(forecast, along) {
  if (!forecast || !Number.isFinite(along)) return null;

  const { from } = forecast;
  const dist = along - from.along;
  if (!(dist > 0)) return null;

  const at = sampleCurves(forecast.curves, along);
  if (!at) return null;

  // The floor and the two guards are each a maximum or a minimum of two
  // non-decreasing functions of `along`, so all three stay non-decreasing —
  // which is what the position bisection needs from this model.
  const t = from.t + Math.max(at.mid, dist * CONFIG.predictMinPaceSpm) * 1000;
  const lo = Math.min(from.t + at.lo * 1000, t - BOOT_MIN_HALF_MS);
  const hi = Math.max(from.t + at.hi * 1000, t + BOOT_MIN_HALF_MS);

  // Quoted back as a standard deviation for the sake of everything downstream
  // that reads one — it is the Gaussian band of the same width, not a claim
  // that this distribution is Gaussian. `lo` and `hi` are the real answer, and
  // they are not symmetric about `t`.
  return { t, lo, hi, sd: (hi - lo) / (2 * CONFIG.predictBandZ) };
}

/**
 * The draw pool: one pace per block, with the weight it is drawn at.
 *
 * Weight is recency (the regression's own half-life, in metres of course) times
 * the block's effort, so the expected pace of a draw is the effort-weighted mean
 * — total time over total effort — rather than the mean of a set of ratios.
 */
function poolOf(blocks, anchorAlong) {
  const pace = new Float64Array(blocks.length);
  const cumulative = new Float64Array(blocks.length);

  let total = 0;
  let sumW2 = 0;
  let sumTime = 0;
  let sumEffort = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const recency = 2 ** (-Math.max(0, anchorAlong - block.along) / CONFIG.predictHalfLifeM);
    const w = recency * block.e;
    pace[i] = block.dt / block.e;
    total += w;
    cumulative[i] = total;
    sumW2 += w * w;
    sumTime += recency * block.dt;
    sumEffort += w;
  }

  const mean = sumEffort > 0 ? sumTime / sumEffort : 0;

  let variance = 0;
  for (let i = 0; i < blocks.length; i++) {
    const w = i ? cumulative[i] - cumulative[i - 1] : cumulative[0];
    variance += w * (pace[i] - mean) ** 2;
  }
  variance = total > 0 ? variance / total : 0;
  const sd = Math.sqrt(variance);

  // How uncertain the LEVEL is: the standard error of that weighted mean, over
  // the effective sample size, and never less than `BOOT_LEVEL_MIN`. A hundred
  // blocks of remarkably even running still do not prove the next hundred will
  // match them.
  const nEff = sumW2 > 0 ? (total * total) / sumW2 : 1;
  const cv = mean > 0 ? sd / mean : 0;
  const tau = clamp(Math.sqrt((cv * cv) / nEff + BOOT_LEVEL_MIN ** 2), 0, BOOT_LEVEL_MAX);

  return {
    pace,
    cumulative,
    total,
    mean,
    sd,
    tau,
    meanEffort: blocks.reduce((s, b) => s + b.e, 0) / blocks.length
  };
}

/**
 * Walk the course `BOOT_SIMS` times and keep the three percentile curves.
 *
 * The level draws are ANTITHETIC — every path is paired with its mirror image,
 * one drawn `+z` where the other draws `−z`. That is not only variance
 * reduction: it pins the median of the level distribution at exactly 1, so a
 * runner with no scatter in his history gets back precisely the pace he has been
 * holding, and the band around it rather than a fifteen-second lurch off it.
 *
 * @returns {{along, lo, mid, hi}} seconds from the anchor, one entry per node.
 */
function simulate(pool, nodes, covered) {
  const n = nodes.length;
  const along = new Float64Array(n);
  const lo = new Float64Array(n);
  const mid = new Float64Array(n);
  const hi = new Float64Array(n);
  for (let j = 0; j < n; j++) along[j] = nodes[j].along;
  if (n < 2) return { along, lo, mid, hi };

  const random = mulberry32(BOOT_SEED);
  const samples = [];
  for (let j = 0; j < n; j++) samples.push(new Float64Array(BOOT_SIMS));

  // Half the paths are drawn; the other half mirror them.
  const half = Math.ceil(BOOT_SIMS / 2);
  const noise = [];
  for (let s = 0; s < half; s++) {
    const path = new Float64Array(n);
    for (let j = 1; j < n; j++) {
      path[j] = gauss(random) * BOOT_DRIFT_SD * Math.sqrt(nodes[j].e / BOOT_DRIFT_REF_M);
    }
    noise.push({ level: gauss(random) * pool.tau, fade: gauss(random) * BOOT_K_SD, path });
  }

  for (let s = 0; s < BOOT_SIMS; s++) {
    const { level, fade, path } = noise[s >> 1];
    const sign = s % 2 === 0 ? 1 : -1;
    // This path's runner: how he fades, and how his level wanders on the way.
    const k = clamp(BOOT_K0 + sign * fade, 1, BOOT_K_MAX);

    let index = 0;
    let left = 0;
    let logLevel = sign * level;
    let seconds = 0;
    let ahead = 0;

    for (let j = 1; j < n; j++) {
      if (left === 0) {
        index = drawBlock(pool, random() * pool.total);
        left = BOOT_RUN_BLOCKS;
      }
      logLevel += sign * path[j];
      // Riegel, differentiated: at total distance D the pace stands at D^(k−1)
      // of what it was. Evaluated at the middle of the node, which is the same
      // shortcut every model here uses to integrate a slowly-varying multiplier
      // — except that here it is applied node by node, so over a long course it
      // is a genuine integration rather than one multiplier at the midpoint.
      const tired = covered > 0
        ? ((covered + ahead + nodes[j].e / 2) / covered) ** (k - 1)
        : 1;
      seconds += pool.pace[index] * Math.exp(logLevel) * tired * nodes[j].e;
      ahead += nodes[j].e;
      samples[j][s] = seconds;
      index = (index + 1) % pool.pace.length;
      left--;
    }
  }

  // The band means whatever `predictBandZ` means everywhere else on the site:
  // read the central mass it names off the normal, then take that share of the
  // simulations. Nothing here has to be told the band is 80% wide.
  const upper = normalCdf(CONFIG.predictBandZ);
  const sorted = new Float64Array(BOOT_SIMS);
  for (let j = 1; j < n; j++) {
    sorted.set(samples[j]);
    sorted.sort();
    lo[j] = quantile(sorted, 1 - upper);
    mid[j] = quantile(sorted, 0.5);
    hi[j] = quantile(sorted, upper);
  }

  return { along, lo, mid, hi };
}

/** Where a point on the course falls between two nodes, in all three curves.
 *  Past the last node — which is the finish — the final segment's rate carries
 *  on, so a rounding error at the very end cannot produce a null. */
function sampleCurves(curves, along) {
  const { along: xs } = curves;
  const n = xs.length;
  if (n < 2) return null;

  let lo = 0;
  let hi = n - 1;
  if (along >= xs[n - 1]) {
    lo = n - 2;
    hi = n - 1;
  } else {
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= along) lo = mid;
      else hi = mid;
    }
  }

  const span = xs[hi] - xs[lo];
  const f = span > 0 ? (along - xs[lo]) / span : 0;
  return {
    lo: curves.lo[lo] + f * (curves.lo[hi] - curves.lo[lo]),
    mid: curves.mid[lo] + f * (curves.mid[hi] - curves.mid[lo]),
    hi: curves.hi[lo] + f * (curves.hi[hi] - curves.hi[lo])
  };
}

/** The block whose cumulative weight covers `u`. */
function drawBlock(pool, u) {
  const { cumulative } = pool;
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < u) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Linear-interpolated quantile of an ascending array. */
function quantile(sorted, p) {
  const pos = clamp(p, 0, 1) * (sorted.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < sorted.length ? sorted[i] + f * (sorted[i + 1] - sorted[i]) : sorted[i];
}

/** Φ(z), Abramowitz & Stegun 7.1.26 — the same approximation the diagnostics
 *  use, so "the 80% band" means one thing in both repos. */
function normalCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
    0.254829592) * t * Math.exp(-x * x);
  const erf = z >= 0 ? y : -y;
  return 0.5 * (1 + erf);
}

/** mulberry32: 32 bits of state, good enough for resampling, and four lines. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One standard normal, Box-Muller. The second value is thrown away; at two
 *  hundred paths the arithmetic is free and the bookkeeping is not. */
function gauss(random) {
  const u = 1 - random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}
