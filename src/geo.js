// Where the person LOOKING at the page is — the browser's own geolocation, and
// the only thing in this codebase that asks the device a question.
//
// Everything else on the map is the race: the pings, the course, the forecast,
// the other runs. This is the other half of a spectator's question, and the only
// mark on screen that isn't about the runner at all.
//
// It costs nothing against the GitHub budget — it never touches the network — and
// `watchPosition` is push-based, so a stationary phone spends nothing to be
// watched and a moving one updates itself without being asked.

import { CONFIG } from './config.js';

/**
 * A browser `GeolocationPosition` as something drawable, or null if it isn't.
 *
 * Pure, and the reason this file has a testable half at all: a position object
 * comes from outside and the coordinates inside it are only conventionally
 * numbers. A NaN latitude reaches a layer as a dot at an undefined place, which
 * is worse than no dot.
 *
 * `accuracy` is metres, as the API reports it, and it stays null unless it is a
 * positive finite number. A circle drawn from a missing or nonsensical radius
 * would be a claim about precision made out of nothing, which is the one thing
 * this marker exists not to do.
 *
 * @param {GeolocationPosition|null} position
 */
export function viewerFrom(position) {
  const c = position?.coords;
  if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return null;

  const accuracy = Number.isFinite(c.accuracy) && c.accuracy > 0 ? c.accuracy : null;
  return {
    lat: c.latitude,
    lon: c.longitude,
    accuracy,
    // Whatever the browser said, falling back to now: this is only ever read to
    // know how stale the fix is, and a missing timestamp shouldn't make it
    // arrive from 1970.
    t: Number.isFinite(position.timestamp) ? position.timestamp : Date.now()
  };
}

/**
 * Why the location isn't showing, in two or three words.
 *
 * Short because of where it goes: after "Your location: " on one muted line at
 * the foot of the status panel. The alternative was the panel's `#error` line, and
 * that belongs to the poll loop — which overwrites it on every pass, so a
 * permission message put there would vanish within the minute and look like a
 * flicker rather than an explanation.
 *
 * Pure, and dispatching on the numeric `code` rather than the message the browser
 * supplies: those differ by browser and by locale, and one of them is the string
 * "User denied Geolocation", which is not what a person needs to read.
 *
 * @param {GeolocationPositionError|null} error
 */
export function geoMessage(error) {
  switch (error?.code) {
    case 1: return 'blocked';      // PERMISSION_DENIED
    case 2: return 'unavailable';  // POSITION_UNAVAILABLE
    case 3: return 'no signal';    // TIMEOUT
    default: return 'unavailable';
  }
}

/** Whether a permission denial is permanent — the one error worth not retrying. */
export const isDenied = error => error?.code === 1;

/**
 * Whether asking is even possible.
 *
 * Both halves matter. `isSecureContext` is the one that catches people out: over
 * plain `http://` from a LAN address — which is how you open a page on your phone
 * to test it — `navigator.geolocation` exists in full and every call to it fails.
 * Asking there could only ever disappoint, so the page doesn't ask — and doesn't
 * claim to be locating you either. `localhost` counts as secure; `192.168.x.x`
 * does not.
 */
export const supported = () =>
  Boolean(globalThis.navigator?.geolocation) && globalThis.isSecureContext === true;

/**
 * Take ownership of the geolocation watch.
 *
 * @param {object} handlers
 * @param {(position: GeolocationPosition) => void} handlers.onPosition
 * @param {(error: GeolocationPositionError) => void} handlers.onError
 */
export function createGeo({ onPosition = () => {}, onError = () => {} } = {}) {
  // The live watch, or 0. Held here rather than passed around: there is exactly
  // one visitor, so there is exactly one watch, and two of them running would
  // report the same position twice and leak the first.
  let watch = 0;

  return {
    supported,

    /**
     * Start or stop watching. Idempotent in both directions: it is called once on
     * load to start, and again to stop if the visitor says no.
     *
     * Starting is what triggers the browser's permission prompt, and that now
     * happens as the page opens. The prompt is the consent — it is the browser's
     * own, asked once per site, and a refusal is final: `main.js` stops the watch
     * and nothing here asks a second time.
     */
    enable(on) {
      // Nothing to start and nothing to stop. Worth a guard rather than a caller's
      // promise to check first: this is called unconditionally at startup, and in
      // a context where the API isn't there at all — the same page opened over
      // http from a phone on the LAN — reaching `watchPosition` on a missing
      // `geolocation` would throw before the map ever drew.
      if (!supported()) return;
      if (on === Boolean(watch)) return;

      if (!on) {
        navigator.geolocation.clearWatch(watch);
        watch = 0;
        return;
      }

      watch = navigator.geolocation.watchPosition(onPosition, onError, {
        enableHighAccuracy: CONFIG.viewerHighAccuracy,
        maximumAge: CONFIG.viewerMaxAgeMs,
        timeout: CONFIG.viewerTimeoutMs
      });
    }
  };
}
