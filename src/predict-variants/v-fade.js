// Candidate: a within-run fatigue exponent on top of the stop budget.
//
// Stops are not the whole story on long races — the runner between the stops is
// also slower at 120 km than at 20. [v-stoprate.js](v-stoprate.js) recovers the
// stopped time; this candidate adds the fade, Riegel-style: gross time grows as
// a power of distance, T(D) ∝ D^k, with k = 1 an even-paced run and k > 1 a
// positive split. The exponent is read from the run's own gross halves,
//
//   k = log2( T(covered) / T(covered / 2) )
//
// then shrunk towards Riegel's published endurance exponent K0 = 1.06 — a
// physiological constant from the literature, not a fit to anyone's history —
// with a pseudo-count of pings, and clamped to [1, 1.25]. A negative split may
// bring k̂ back to 1 but never below it: this term only ever slows the forecast
// down, which keeps it monotone in distance.
//
// The remaining time is then scaled by the fade evaluated at the MIDPOINT of
// the stretch being predicted,
//
//   φ(d) = ((covered + d/2) / covered)^(k̂ − 1)
//
// — the mean-value shortcut for integrating a slowly-varying pace multiplier —
// and the band picks up both the scale (φ on the sd) and the doubt about k̂
// itself, which is what finally makes long-horizon bands grow the way
// long-horizon errors do.

import { CONFIG } from '../config.js';
import { buildForecast as stopBuild, predictAt as stopPredict } from './v-stoprate.js';
import { clamp, cumTimeAt, grossStats } from './shared.js';

/** Riegel's endurance exponent — literature default, the shrinkage target. */
const FADE_K0 = 1.06;
/** Pseudo-count of pings behind the halfway split that K0 is worth. */
const FADE_PRIOR_PINGS = 8;
/** No fade claim below this much covered ground or this many pings. */
const FADE_MIN_ALONG_M = 2000;
const FADE_MIN_PINGS = 6;
/** Doubt about the exponent itself, in k units. */
const FADE_SD_K = 0.05;
const FADE_K_MAX = 1.25;

/** The shrunk, clamped exponent for this run so far; 1 when there is no basis. */
export function fadeExponent(points) {
  const gross = grossStats(points);
  if (!gross || gross.along < FADE_MIN_ALONG_M) return 1;

  const snapped = points.filter(p => p.snap);
  if (snapped.length < FADE_MIN_PINGS) return 1;

  const half = gross.firstAlong + gross.along / 2;
  const tHalf = cumTimeAt(points, half);
  if (!(tHalf > 0)) return 1;

  const k = Math.log2(gross.elapsed / tHalf);
  if (!Number.isFinite(k)) return 1;

  const behind = snapped.filter(p => p.snap.along <= half).length;
  const shrunk = (behind * k + FADE_PRIOR_PINGS * FADE_K0) / (behind + FADE_PRIOR_PINGS);
  return clamp(shrunk, 1, FADE_K_MAX);
}

export function buildForecast(points, course, options) {
  const base = stopBuild(points, course, options);
  if (!base) return null;

  const gross = grossStats(points);
  return { ...base, fadeK: fadeExponent(points), covered: gross ? gross.along : 0 };
}

export function predictAt(forecast, along) {
  const at = stopPredict(forecast, along);
  if (!at) return null;
  if (!(forecast.fadeK > 1) || !(forecast.covered > 0)) return at;

  const { from } = forecast;
  const dist = along - from.along;
  const stretch = (forecast.covered + dist / 2) / forecast.covered;
  const phi = stretch ** (forecast.fadeK - 1);

  const seconds = ((at.t - from.t) / 1000) * phi;
  const t = from.t + seconds * 1000;
  // dT/dk = T·ln(stretch), so doubt in k̂ becomes this much doubt in seconds.
  const kDoubt = seconds * Math.log(stretch) * FADE_SD_K;
  const sd = Math.sqrt((at.sd * phi) ** 2 + (kDoubt * 1000) ** 2);
  const half = CONFIG.predictBandZ * sd;

  return { t, lo: t - half, hi: t + half, sd };
}
