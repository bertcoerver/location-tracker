// The model registry: every forecaster the site can run, by name.
//
// Each entry is the same two-function contract — `buildForecast(points,
// course)` and `predictAt(forecast, along)` — and [predict.js](../predict.js)
// dispatches to whichever entry `?model=` (or `CONFIG.predictModel`) names.
// The imports are static on purpose: the files are small, there is no build
// step to split them, and a model that fails to load should fail at page load
// rather than at the moment a visitor flips to it.
//
// The names are the vocabulary of the URL switch, so they are short and stay
// stable: `classic` the original moving-pace regression, `blend` the
// gross-pace blend, `stoprate` the stop budget, `fade` the fatigue exponent on
// top of it, `calibrated` fade with the empirically-sized band, and `cadence`
// calibrated corrected for how often the phone actually pings — the same model
// whenever that is every five minutes, which is every run recorded so far, and
// a narrower band with an earlier first answer when it is not. The backtests
// behind the ranking live in the prediction-diag repo.
//
// The last two are a different family altogether. `kalman` and `bootstrap` do
// not use the regression at all — they run on gross-pace blocks of course
// ([effort.js](effort.js)), one as a recursive filter with a fade state, the
// other as a few hundred simulated finishes with percentile bands. They are here
// because the first five all inherit the same estimator, and therefore the same
// blind spots.

import * as classic from './classic.js';
import * as blend from './v-gross-blend.js';
import * as stoprate from './v-stoprate.js';
import * as fade from './v-fade.js';
import * as calibrated from './v-calibrated.js';
import * as cadence from './v-cadence.js';
import * as kalman from './v-kalman.js';
import * as bootstrap from './v-bootstrap.js';

export const MODELS = {
  classic, blend, stoprate, fade, calibrated, cadence, kalman, bootstrap
};
