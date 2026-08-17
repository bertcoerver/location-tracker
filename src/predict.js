// Forecasting the rest of the course from the run so far.
//
// Everything here is fitted from ONE run's own pings. Nothing is shared between
// runs, cached across them or seeded from them — a course is run differently by
// different people on different days, and borrowing yesterday's pace is how a
// forecast becomes confident and wrong.
//
// The models themselves live in [predict-variants/](predict-variants/), one
// file per forecaster, all honouring the same two-function contract. This file
// picks the active one — `?model=<name>` in the URL, `CONFIG.predictModel`
// otherwise — and owns the two questions that are the same whatever the model:
// the inverse "where is he now?" and the liveness rule. The rest of the app
// imports from here and never learns which model answered.
//
// A forecast remembers the model that built it. `predictAt` dispatches on the
// forecast, not on the URL, so a forecast is coherent for its whole life even
// if the question is asked again in a different context.

import { CONFIG } from './config.js';
import { isLive } from './github.js';
import { MODELS } from './predict-variants/index.js';

export { legsOf, fitPace } from './predict-variants/classic.js';

/** The model the page asked for, resolved once — a URL lasts a page load. */
let active = null;
function activeModel() {
  if (active) return active;

  let name = CONFIG.predictModel;
  if (typeof location !== 'undefined') {
    const asked = new URLSearchParams(location.search).get('model');
    if (asked) {
      if (MODELS[asked]) name = asked;
      else console.warn(`unknown model "${asked}", using "${name}"`);
    }
  }
  active = MODELS[name] ?? MODELS.classic;
  return active;
}

function modelOf(forecast) {
  return forecast?.model ?? MODELS.classic;
}

/** The run's forecast by the active model, or null when there isn't one. */
export function buildForecast(points, course) {
  const model = activeModel();
  const forecast = model.buildForecast(points, course);
  return forecast ? { ...forecast, model } : null;
}

/** When the runner is likely to reach a distance along the course —
 *  `{t, lo, hi, sd}` in epoch ms, answered by the model that built the
 *  forecast. Null for ground already passed. */
export function predictAt(forecast, along) {
  if (!forecast) return null;
  return modelOf(forecast).predictAt(forecast, along);
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
 * The band is then CUT to `uncertaintyRefMs` of running, half an hour, centred on
 * the estimate. An hour of silence on a mountain course widens the 80% range until
 * it covers most of the route, and a mark that long has quietly changed what it
 * says: "probably somewhere along here" is a claim about a stretch of trail, and a
 * stretch of trail the length of the race is the same statement as no mark at all.
 * Half an hour is where the tooltips already draw the line — a window wider than
 * `uncertaintyRefMs` pins their bar at full width for the same reason — so the two
 * marks give up at the same point, and the bar being full is exactly the condition
 * under which the band is cut.
 *
 * Centred on the estimate rather than trimmed off one end, because the estimate is
 * the one position in the range the model actually prefers, and cutting only the far
 * end would leave the near edge looking like a bound that had been measured.
 *
 * Both edges are solved off the MEAN, not off the band: what is being asked for is
 * the ground half an hour of running either side of the estimate covers, and the
 * band edges answer a different question. `solve` clamps to the anchor and the
 * finish, so an estimate less than fifteen minutes past the last ping simply reaches
 * back to the ping and no further.
 *
 * @param {object|null} forecast
 * @param {number}      when epoch ms
 * @returns {{along, lo, hi, cutLo, cutHi}|null} null once the whole course is behind
 *   the prediction — past that there is nothing left to be in the middle of.
 *   `cutLo`/`cutHi` are how much ground the cap took off each end, in metres, and 0
 *   at an end it did not reach. The views fade a cut end by that much rather than
 *   ending it square — the amount, not just the fact, because a band that has just
 *   crossed the half hour has lost nothing worth drawing a fade for.
 */
export function positionAt(forecast, when) {
  if (!forecast || !Number.isFinite(when)) return null;

  const end = forecast.course.length;
  const finish = predictAt(forecast, end);
  if (!finish || when >= finish.t) return null;
  if (when <= forecast.from.t) return null;

  const reach = CONFIG.uncertaintyRefMs / 2;
  const along = solve(forecast, end, when, at => at.t);
  const lo = solve(forecast, end, when, at => at.hi);
  const hi = solve(forecast, end, when, at => at.lo);
  const near = solve(forecast, end, when - reach, at => at.t);
  const far = solve(forecast, end, when + reach, at => at.t);

  return {
    along,
    lo: Math.max(lo, near),
    hi: Math.min(hi, far),
    cutLo: Math.max(0, near - lo),
    cutHi: Math.max(0, hi - far)
  };
}

/**
 * Is the run on screen still underway?
 *
 * Pure and exported for the same reason `clockReading` is: it is a decision, three
 * of its cases take hours of real time to reach, and everything downstream of it —
 * the pulsing dot, the elapsed clock, the "next ping" estimate, the predicted
 * finish — says something different depending on the answer.
 *
 * It lives here rather than in ui.js, where it started, because the map asks it
 * too: the pulsing halo under the newest fix is the same claim the panel's clock
 * makes, and two liveness rules would eventually make them say different things
 * about one run. This file owns the forecast the rule consults, and both callers
 * import it from here.
 *
 * Three conditions, and only the first is a fact. A finish marker is an assertion by
 * the phone that the race is over, and it outranks everything: it says so the instant
 * it lands rather than an hour later.
 *
 * After that there are two ways to still be running, and either will do:
 *
 *   1. a recent ping. `isLive` can only guess from the clock, and its hour is a guess
 *      about a phone that pings every few minutes.
 *   2. a prediction that has not yet reached the finish line. `positionAt` returns
 *      null once the forecast has walked off the end of the course, so this is
 *      exactly the condition that keeps the orange marker on the map: the clock and
 *      the marker stop together, which they did not before.
 *
 * The second is there because an hour of silence is normal on the terrain this page
 * is for. A mountain section with no network beat the ping-only rule outright — the
 * elapsed clock froze mid-race, relabelled itself "Total", and the panel announced a
 * finish two ridges early, which is the one thing it must never do. Judging from the
 * forecast instead keeps the run live for as long as the runner could plausibly still
 * be out there, and no longer: a phone that dies at 20 km of 160 keeps the clock
 * going, but only until the predicted position crosses the line, and then every
 * reading reverts at once.
 *
 * A run with no course has no forecast, so it gets the ping-only rule. That is the
 * honest answer there: with no route there is no finish line to predict crossing, and
 * nothing but the clock to go on.
 *
 * Only for the run on screen. The picker's per-run marker keeps plain `isLive`,
 * because the index is built from the tree API and knows nothing about file contents;
 * a run has to be opened before its finish or its course is visible.
 *
 * @param {object|null} finish   the ping the phone marked as its last, if any
 * @param {object|null} record   this run's index entry, for its `latest`
 * @param {object|null} forecast from `buildForecast`, or null with no course
 * @param {number}      now
 */
export function stillRunning({ finish, record, forecast, now }) {
  if (finish) return false;
  return isLive(record, now) || Boolean(forecast && positionAt(forecast, now));
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
