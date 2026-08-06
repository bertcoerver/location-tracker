// Candidate: v-fade's mean with an empirically-sized band.
//
// The backtest's calibration table says the model's claimed sd is several times
// too small far out: real error grows roughly in PROPORTION to the time still
// to run, while the fitted variance — parameter quadratic plus per-leg noise —
// grows too slowly to keep up. This wrapper leaves the mean exactly as
// [v-fade.js](v-fade.js) produces it and floors the sd at a fraction of the
// predicted remaining time,
//
//   sd = max( sd_model, CAL_C · T_remaining · infl )
//
// where `infl` widens the floor for a run that has already shown itself hard to
// predict — the gross-inflation ratio from [shared.js](shared.js), capped at 2.
// Near the anchor the model's own sd usually wins and nothing changes; hours
// out the floor takes over, which is where the coverage was collapsing.
//
// CAL_C is a tuned constant with the same status as the fit's half-life: chosen
// against the backtest, shipped in the file, fitted to nobody in particular.

import { CONFIG } from '../config.js';
import { buildForecast as fadeBuild, predictAt as fadePredict } from './v-fade.js';
import { clamp, grossRatio } from './shared.js';

/** sd floor as a fraction of predicted remaining time. Overridable from the
 *  environment so the backtest can sweep it; in a browser there is no
 *  `process` and the constant stands. */
const CAL_C = Number(globalThis.process?.env?.CAL_C) || 0.15;
/** Horizon exponent: 1 = proportional to remaining time. */
const CAL_P = Number(globalThis.process?.env?.CAL_P) || 1.0;

export function buildForecast(points, course) {
  const base = fadeBuild(points, course);
  if (!base) return null;

  return { ...base, infl: clamp(grossRatio(points, course, base), 1, 2) };
}

export function predictAt(forecast, along) {
  const at = fadePredict(forecast, along);
  if (!at) return null;

  const remaining = (at.t - forecast.from.t) / 1000;
  const floor = 1000 * CAL_C * remaining ** CAL_P * (forecast.infl ?? 1);
  if (at.sd >= floor) return at;

  const half = CONFIG.predictBandZ * floor;
  return { t: at.t, lo: at.t - half, hi: at.t + half, sd: floor };
}
