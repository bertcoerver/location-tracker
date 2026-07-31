// When to ask GitHub whether anything has changed.
//
// The page used to poll on a fixed timer, which had no relationship to when the
// phone actually commits. It doesn't ping on a fixed timer either: it picks its
// interval from a logistic on its own battery, from 5 minutes on a full charge
// out to 30 on a nearly dead one. That number is derivable from `btry`, which
// every ping already carries — so the page can sleep until the next one is
// genuinely due instead of guessing fifteen times an hour.
//
// Everything here is PURE. No timers, no counters, no memory of how many
// expectations have been missed: `nextPollMs` is a function of the newest point
// and the clock, so it cannot drift out of step with the throttle, with a poll
// that got dropped, or with a tab that was asleep for an hour. main.js may call
// it as often as it likes and always gets the same answer for the same state.

import { CONFIG } from './config.js';

/**
 * The interval the phone is currently using, from the battery it reported.
 *
 *   interval = min + (max - min) / (1 + e^(k * (battery - mid)))
 *
 * The constants default to [config.js](./config.js), which mirrors the phone's
 * script. Note the shape: it is FLAT for most of a battery's life and does nearly
 * all its moving between 15% and 35%, which is exactly why the interval can't be
 * inferred from the gaps between recent pings — through that band each gap is
 * several minutes longer than the one before it, so inference is not merely
 * noisy but biased short, and would poll early and collect 304s.
 *
 * @param {number} btry battery percentage, as the phone reported it.
 * @param {object} [tuning] this run's own four constants, from its
 *   `course_settings.json`. Passed in rather than looked up, so this file stays
 *   pure and stays testable — and so a run tracked by a differently-configured
 *   phone can be scheduled correctly alongside one that isn't. Defaulting to
 *   CONFIG is what makes every caller that has no per-run curve unchanged.
 */
export function pingIntervalMs(btry, tuning = CONFIG) {
  const { minPingMs, maxPingMs, batteryK, batteryMid } = tuning;
  const ms = minPingMs + (maxPingMs - minPingMs) / (1 + Math.exp(batteryK * (btry - batteryMid)));
  // FLOORED to the whole minute, because that is what the phone's scheduler
  // does — not rounded, which would put the prediction up to half a minute
  // after the ping it is predicting. Carrying seconds the phone cannot act on
  // would be false precision anyway, and it would stop `t + interval - now`
  // being exact arithmetic.
  //
  // One consequence worth knowing: the curve approaches `maxPingMs` without
  // reaching it, so a flat battery pings every 29 minutes, never 30.
  return Math.floor(ms / 60000) * 60000;
}

/**
 * How long to wait before the next poll.
 *
 * Three cases:
 *
 *   waiting     — the ping isn't due yet, so sleep until it is.
 *   just late   — try again shortly; this is jitter, not a lost connection.
 *   truly late  — the phone missed a slot, so wait for its NEXT one.
 *
 * The last case is the one that saves requests, and it comes out of how the
 * phone behaves when an upload fails: it does not retry on its own, it retries
 * on its next poll. So once a ping is properly late, nothing can appear in the
 * repo until the phone wakes again — a whole interval away — and every request
 * made in between is guaranteed to come back empty. Hence `pingIntervalMs` as
 * the floor rather than a few seconds.
 *
 * That estimate is a LOWER bound, which is the safe direction. A phone that has
 * been offline has also been draining, and a flatter battery means a longer
 * interval, so the real next slot is at or after the one predicted here. Being
 * early costs one 304; being late costs staleness.
 *
 * `overdue / 2` then takes over for a long silence, so a run that ended
 * yesterday backs off towards the cap instead of asking every five minutes
 * forever. It carries no state: "how overdue are we" already encodes how many
 * slots have gone by.
 *
 * Every branch is clamped. The ceiling is the backoff cap, and on the waiting
 * branch it doubles as a floor poll: at 30-minute cadence we look once in the
 * middle of the wait, which costs one request and is what notices a NEW run
 * starting while you're watching an old one. The floor stops us scheduling a
 * wake-up that `minRefreshMs` would only throw away.
 *
 * Only the four logistic constants are per-run. Everything else here — the fallback
 * rate, the floor, the cap, the guard, the jitter window — is a property of THIS
 * PAGE's relationship with the GitHub API rather than of any phone, and belongs to
 * the browser doing the asking. A settings file gets to say how often its phone
 * pings; it does not get to say how often the map polls.
 *
 * @param {{t: number, btry?: number}|null} latest the newest point on screen.
 * @param {number} [now] injectable clock.
 * @param {object} [tuning] this run's ping curve — see `pingIntervalMs`.
 * @returns {number} milliseconds to wait.
 */
export function nextPollMs(latest, now = Date.now(), tuning = CONFIG) {
  // The run has declared itself over, so nothing more is coming and the whole
  // ladder below is beside the point. Straight to the cap — which is still a
  // poll, because a NEW run starting is the one thing left worth noticing.
  if (latest?.is_finish) return CONFIG.maxPollMs;

  // Nothing to go on: no points yet, or a ping written before `btry` existed.
  // Fall back to the fixed rate, which is what the whole page used to do.
  if (!latest || !Number.isFinite(latest.btry)) return CONFIG.pollMs;

  const interval = pingIntervalMs(latest.btry, tuning);
  const expected = latest.t + interval + CONFIG.pollGuardMs;
  const overdue = now - expected;

  const wait = overdue < 0 ? -overdue
    // Barely late: the interval above predicts when the phone WAKES, and after
    // that it still has to take a fix, upload it, and have the commit reach the
    // tree API. So this much slippage is normal and the ping is probably
    // seconds away — worth one cheap look rather than a five-minute wait.
    : overdue < CONFIG.lateJitterMs ? CONFIG.minRefreshMs
    : Math.max(interval, overdue / 2);

  return Math.min(CONFIG.maxPollMs, Math.max(CONFIG.minRefreshMs, wait));
}

/**
 * When the next ping is expected — for the panel, which says so out loud.
 *
 * Null when there's nothing to predict from, and negative once the ping is
 * late, which is the caller's cue to say "overdue" rather than count downwards
 * past zero.
 *
 * Deliberately WITHOUT `pollGuardMs`: that is slack the page gives itself so it
 * doesn't ask too early, and it has no business being in a number shown to a
 * reader as the phone's own schedule.
 *
 * @param {object} [tuning] this run's ping curve — see `pingIntervalMs`.
 * @returns {number|null} milliseconds until the next ping, or null.
 */
export function dueInMs(latest, now = Date.now(), tuning = CONFIG) {
  // A finished run has no next ping to predict, whatever its battery said.
  if (!latest || latest.is_finish || !Number.isFinite(latest.btry)) return null;
  return latest.t + pingIntervalMs(latest.btry, tuning) - now;
}
