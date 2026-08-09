// Candidate: an explicit stopped-time budget per metre of course.
//
// Where [v-gross-blend.js](v-gross-blend.js) prices stops with one whole-run
// ratio, this candidate measures them the way the fit measures pace: from the
// legs, recency-weighted with the same half-life. Whatever duration a leg had
// that the fitted coefficients cannot explain — the positive part of its
// residual — is stopped or slowed time, and dividing the weighted sum of it by
// the weighted metres covered gives a rate `s` in seconds per metre:
//
//   s = Σ w·(dt − fitted)⁺ / Σ w·dist,      t(d) = base(d) + s·d
//
// A zero-distance leg (an aid station, a phone on a table) puts its whole
// duration into the numerator and nothing into the denominator — exactly the
// time the no-intercept design row discards, recovered. Because the weights are
// the fit's own, `s` tracks RECENT stop behaviour: a race whose back half has
// longer and more frequent stops budgets more than its front half did.
//
// The one-sided (·)⁺ collects only unexplained SLOWNESS, so noise biases `s`
// slightly high; the clamp and the recency weights bound that, and the steady
// tests demand s ≈ 0 on a clean run.
//
// Stops are lumpy — a compound-Poisson process, not smooth noise — so the
// budget also carries its own variance term, a fixed fraction of itself.

import { buildForecast as baseBuild, predictAt as basePredict, legsOf } from './classic.js';
import { CONFIG } from '../config.js';
import { clamp } from './shared.js';

/** sd of the stop budget as a fraction of the budget itself. */
const STOP_SD_FRAC = 0.5;
/** The budget may not exceed this multiple of flat pace — a guardrail. */
const STOP_RATE_CAP = 3;
/**
 * Metres over which the budget phases in. A runner moving right now is
 * unlikely to stop in the next kilometre — the anchor ping is evidence of
 * motion — so charging the full rate from the first metre made the shortest
 * horizons pessimistic. The ramp d/(d+STOP_RAMP_M) starts the budget near
 * zero and hands it its full rate a few kilometres out, where "how often does
 * he stop" beats "is he moving now" as the better question.
 */
const STOP_RAMP_M = 2000;

/** The recency-weighted unexplained-slowness rate, seconds per metre. */
export function stopRate(legs, fit, anchorAlong) {
  let slow = 0;
  let metres = 0;
  for (const leg of legs) {
    const w = 2 ** (-Math.max(0, anchorAlong - leg.along) / CONFIG.predictHalfLifeM);
    const fitted = fit.flat * leg.dist + fit.up * leg.up + fit.down * leg.down;
    slow += w * Math.max(0, leg.dt - fitted);
    metres += w * leg.dist;
  }
  if (!(metres > 0)) return 0;
  return clamp(slow / metres, 0, STOP_RATE_CAP * fit.flat);
}

export function buildForecast(points, course, options) {
  const base = baseBuild(points, course, options);
  if (!base) return null;

  const snapped = points.filter(p => p.snap);
  const rate = stopRate(legsOf(snapped, course), base, base.from.along);
  return { ...base, stopRate: rate };
}

export function predictAt(forecast, along) {
  const at = basePredict(forecast, along);
  if (!at) return null;

  const dist = along - forecast.from.along;
  const budget = forecast.stopRate * dist * (dist / (dist + STOP_RAMP_M));

  const t = at.t + budget * 1000;
  const sd = Math.sqrt(at.sd ** 2 + (STOP_SD_FRAC * budget * 1000) ** 2);
  const half = CONFIG.predictBandZ * sd;

  return { t, lo: t - half, hi: t + half, sd };
}
