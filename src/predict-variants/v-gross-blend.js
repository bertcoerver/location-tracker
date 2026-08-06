// Candidate: blend the moving-pace forecast with the run's gross pace.
//
// The baseline's known failure is optimism that grows with distance: `flat` is
// MOVING pace, so stopped time widens the band but never pushes the ETA later.
// This candidate keeps the baseline fit untouched and multiplies its answer by
// how much slower the run has actually been than the fit says it should have
// been — the gross-inflation ratio `r` from [shared.js](shared.js).
//
// The multiplier is horizon-dependent:
//
//   m(d) = 1 + λ(d) · (r − 1),   λ(d) = d / (d + BLEND_HALF_M)
//
// Close by, λ ≈ 0 and the recent moving pace stands — the runner just left an
// aid station; the next kilometre probably has no stop in it. Far out, λ → 1
// and the forecast converges to the whole-run gross pace, which has every stop
// and every slow patch already priced in. On a stop-free evenly-run race r ≈ 1
// and this file predicts exactly what the baseline does.
//
// The band scales by the same multiplier: the uncertainty was estimated on the
// moving-pace scale, and stretching the mean stretches the scatter with it.

import { buildForecast as baseBuild, predictAt as basePredict } from './classic.js';
import { CONFIG } from '../config.js';
import { grossRatio } from './shared.js';

/** Metres at which the blend is half way to gross pace. */
const BLEND_HALF_M = 10000;

export function buildForecast(points, course) {
  const base = baseBuild(points, course);
  if (!base) return null;

  return { ...base, gross: grossRatio(points, course, base) };
}

export function predictAt(forecast, along) {
  const at = basePredict(forecast, along);
  if (!at) return null;

  const { from } = forecast;
  const dist = along - from.along;
  const m = 1 + (dist / (dist + BLEND_HALF_M)) * (forecast.gross - 1);

  const seconds = ((at.t - from.t) / 1000) * m;
  const t = from.t + Math.max(seconds, dist * CONFIG.predictMinPaceSpm) * 1000;
  const sd = at.sd * m;
  const half = CONFIG.predictBandZ * sd;

  return { t, lo: t - half, hi: t + half, sd };
}
