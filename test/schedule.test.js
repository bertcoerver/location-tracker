// When the page decides to ask GitHub anything. All of schedule.js is pure, so
// all of it is testable without a timer or a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { dueInMs, nextPollMs, pingIntervalMs } from '../src/schedule.js';

const MIN = 60000;
const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);

/** A ping `agoMin` minutes old, with a battery. */
const ping = (agoMin, btry) => ({ t: NOW - agoMin * MIN, btry });

// --- the phone's curve --------------------------------------------------------

test('pingIntervalMs matches the phone at every point on the curve', () => {
  // These are the phone's own numbers, not this implementation's: evaluate
  // min + (max-min)/(1+e^(0.3(b-25))) by hand and floor it to the minute, which
  // is what its scheduler does. Exact equality, because the phone's schedule
  // really is these whole minutes — if a constant drifts from the phone's
  // script, this is what fails.
  const expected = [
    [100, 5], [45, 5], [40, 5], [35, 6], [30, 9],
    [25, 17], [20, 25], [15, 28], [10, 29], [0, 29]
  ];
  for (const [btry, minutes] of expected) {
    assert.equal(pingIntervalMs(btry), minutes * MIN, `at ${btry}%`);
  }
});

test('pingIntervalMs lands on whole minutes, which is all the phone can schedule', () => {
  for (let b = 0; b <= 100; b++) {
    assert.equal(pingIntervalMs(b) % MIN, 0, `${b}% should be a whole number of minutes`);
  }
});

test('flooring never drops a full battery below the phone`s minimum', () => {
  // The curve sits a hair ABOVE minPingMs at full charge, so this leans on the
  // sign of a floating-point residue: were it ever a hair below, flooring would
  // silently produce a 4-minute interval and the page would poll early forever.
  for (let b = 0; b <= 100; b++) {
    assert.ok(pingIntervalMs(b) >= CONFIG.minPingMs, `${b}% fell under the minimum`);
  }
});

test('the maximum interval is an asymptote, so a flat battery pings every 29 min', () => {
  // Worth stating rather than discovering: the curve approaches maxPingMs
  // without reaching it, and flooring takes the last minute off.
  assert.equal(pingIntervalMs(0), 29 * MIN);
  assert.ok(pingIntervalMs(0) < CONFIG.maxPingMs);
});

test('pingIntervalMs is flat at both ends and steep in the middle', () => {
  // The shape is the whole reason this can't be inferred from recent gaps: it
  // barely moves for most of a battery's life, then does nearly all its moving
  // between 15% and 35%. Stated as a ratio rather than an absolute rate, since
  // "flat" and "steep" are only meaningful relative to each other.
  const perPercent = (a, b) => Math.abs(pingIntervalMs(a) - pingIntervalMs(b)) / Math.abs(a - b);
  const knee = perPercent(30, 25);
  assert.ok(knee > 50 * perPercent(10, 0), 'the knee should dwarf the flat on a dying battery');
  assert.ok(knee > 50 * perPercent(100, 60), 'and the flat on a full one');
  assert.ok(knee > MIN, 'a minute per percent or more through the knee');
});

test('pingIntervalMs never speeds up as the battery drains', () => {
  // Not strictly increasing: quantised to the minute, neighbouring percentages
  // often share an interval. What must never happen is the phone appearing to
  // ping MORE often on less charge.
  for (let b = 100; b > 0; b--) {
    assert.ok(pingIntervalMs(b - 1) >= pingIntervalMs(b), `${b}% -> ${b - 1}% must not speed up`);
  }
  // Through the knee it moves fast enough to clear the quantisation every time.
  for (let b = 35; b > 15; b -= 5) {
    assert.ok(pingIntervalMs(b - 5) > pingIntervalMs(b), `${b}% -> ${b - 5}% should be slower`);
  }
});

test('pingIntervalMs stays inside the phone`s own bounds', () => {
  assert.ok(pingIntervalMs(100) >= CONFIG.minPingMs);
  assert.ok(pingIntervalMs(0) <= CONFIG.maxPingMs);
});

// --- waiting for a ping that is not due yet ----------------------------------

test('nextPollMs sleeps until the ping is due, plus the guard', () => {
  // Fresh battery, so a 5 minute cadence; the ping landed 1 minute ago.
  const wait = nextPollMs(ping(1, 90), NOW);
  assert.equal(wait, 4 * MIN + CONFIG.pollGuardMs);
});

test('nextPollMs waits longer for a phone that is pinging less often', () => {
  // The point of the whole exercise: at 12% the phone pings twice an hour, so
  // asking fifteen times an hour is thirteen wasted requests.
  const dying = nextPollMs(ping(1, 12), NOW);
  const fresh = nextPollMs(ping(1, 90), NOW);
  assert.ok(dying > fresh * 2, `${dying} should be far longer than ${fresh}`);
});

test('nextPollMs looks again shortly for a ping that is only just late', () => {
  // The phone schedules to the whole minute and a commit takes a moment to
  // reach the API, so a few seconds of slippage is normal — the ping is
  // probably about to appear, and one cheap look is worth it.
  const justLate = NOW - (5 * MIN + CONFIG.pollGuardMs + 1000);
  assert.equal(nextPollMs({ t: justLate, btry: 90 }, NOW), CONFIG.minRefreshMs);
});

test('the waiting branch bottoms out at the guard, which is already above the floor', () => {
  // Worth pinning down: a ping that is due this instant still gets pollGuardMs
  // of slack, and that happens to be exactly minRefreshMs. So on the waiting
  // side the floor never binds — it exists for the overdue side above.
  const dueNow = NOW - 5 * MIN;
  assert.equal(nextPollMs({ t: dueNow, btry: 90 }, NOW), CONFIG.pollGuardMs);
  assert.ok(CONFIG.pollGuardMs >= CONFIG.minRefreshMs);
});

test('nextPollMs looks once in the middle of a long wait', () => {
  // A 30 minute cadence would otherwise mean half an hour of not looking at the
  // repo at all — long enough to miss a whole new run starting.
  assert.equal(nextPollMs(ping(0, 5), NOW), CONFIG.maxPollMs);
});

// --- a ping that has not turned up -------------------------------------------

test('nextPollMs waits a whole interval once a ping has properly missed its slot', () => {
  // THE point of this branch. A failed upload is not retried on its own — the
  // phone retries it on its next poll — so between slots there is provably
  // nothing to find, and a request made now would come back empty by
  // construction. Due at 5 min + guard; at 9 minutes old it is 3.5 late, half
  // of which is under one interval, so the interval wins.
  assert.equal(nextPollMs(ping(9, 90), NOW), 5 * MIN);
});

test('nextPollMs checks at half the age of the problem once the silence is long', () => {
  // Past the point where waiting one interval is enough, a run that has simply
  // ended must not keep costing one request every five minutes forever.
  const late = 25 * MIN - (5 * MIN + CONFIG.pollGuardMs);
  assert.equal(nextPollMs(ping(25, 90), NOW), late / 2);
  assert.ok(late / 2 > 5 * MIN, 'and by now that is longer than an interval');
});

test('nextPollMs backs off further the longer the silence goes on', () => {
  const delays = [10, 20, 40, 80].map(m => nextPollMs(ping(m, 90), NOW));
  for (let i = 1; i < delays.length; i++) {
    assert.ok(delays[i] >= delays[i - 1], 'each check should be no keener than the last');
  }
  // It really is growing, until the cap takes over — which by 80 minutes it has.
  assert.ok(delays[1] > delays[0]);
  assert.equal(delays[3], CONFIG.maxPollMs);
});

test('nextPollMs caps the backoff, so a forgotten tab still looks occasionally', () => {
  // A run that ended a week ago. Without a cap this would drift towards days.
  assert.equal(nextPollMs(ping(7 * 24 * 60, 90), NOW), CONFIG.maxPollMs);
});

test('a long silence costs only a handful of requests', () => {
  // Walk the whole ladder from the moment a ping is due and count the polls. The
  // fixed 4-minute timer spends 15 an hour on this forever; this reaches the cap
  // in a few and then settles at four an hour.
  const t = NOW;
  let at = t + 5 * MIN + CONFIG.pollGuardMs;
  let polls = 0;
  while (nextPollMs({ t, btry: 90 }, at) < CONFIG.maxPollMs && polls < 100) {
    at += nextPollMs({ t, btry: 90 }, at);
    polls++;
  }
  // Nine: four cheap looks across the jitter window, where the ping really might
  // be seconds away, then five interval-aligned ones out to the cap. After that
  // it is four an hour indefinitely.
  assert.ok(polls <= 10, `${polls} polls to reach the cap`);
  assert.ok(at - t > 30 * MIN, 'and it should have taken a good while to get there');
});

test('the phone`s own grid is never checked more than once', () => {
  // A stronger version of the same claim: from the first properly-late check
  // onwards, no two polls fall inside the same five-minute slot. Anything
  // closer would be asking twice about a repo that provably cannot have
  // changed in between.
  const t = NOW;
  let at = t + 5 * MIN + CONFIG.pollGuardMs + CONFIG.lateJitterMs;
  let previous = at;
  for (let i = 0; i < 6; i++) {
    at += nextPollMs({ t, btry: 90 }, at);
    assert.ok(at - previous >= 5 * MIN, `poll ${i} came ${(at - previous) / 1000}s after the last`);
    previous = at;
  }
});

// --- a run that has declared itself over ---------------------------------------

test('a finished run goes straight to the cap, skipping the whole ladder', () => {
  // The saving this feature is for. Without the flag, a run that has just ended
  // spends nine requests climbing the overdue ladder before it settles; with it,
  // the first poll after the finish lands is already at four an hour.
  assert.equal(nextPollMs({ ...ping(0, 90), is_finish: true }, NOW), CONFIG.maxPollMs);
  assert.equal(nextPollMs({ ...ping(9, 90), is_finish: true }, NOW), CONFIG.maxPollMs);
  assert.equal(nextPollMs({ ...ping(7 * 24 * 60, 5), is_finish: true }, NOW), CONFIG.maxPollMs);
});

test('a finished run is still polled, because a NEW run could start', () => {
  // The cap rather than never: this page is left open, and the thing worth
  // noticing after a race ends is the next one beginning.
  assert.ok(nextPollMs({ ...ping(1, 90), is_finish: true }, NOW) < Infinity);
  assert.ok(nextPollMs({ ...ping(1, 90), is_finish: true }, NOW) >= CONFIG.minRefreshMs);
});

test('the finish is checked before the battery, so a finish with no battery still counts', () => {
  assert.equal(nextPollMs({ t: NOW - MIN, is_finish: true }, NOW), CONFIG.maxPollMs);
});

test('dueInMs has nothing to predict once the run has finished', () => {
  // Whatever the battery said, there is no next ping. The panel says "Finished
  // 12m ago" instead, and an expectation beside it would be a contradiction.
  assert.equal(dueInMs({ ...ping(1, 90), is_finish: true }, NOW), null);
});

// --- nothing to predict from --------------------------------------------------

test('nextPollMs falls back to the fixed rate for a ping with no battery', () => {
  // Every file written before `btry` existed. There is no schedule to derive.
  assert.equal(nextPollMs({ t: NOW - MIN }, NOW), CONFIG.pollMs);
});

test('nextPollMs falls back to the fixed rate before any points have loaded', () => {
  assert.equal(nextPollMs(null, NOW), CONFIG.pollMs);
});

// --- the property main.js relies on -------------------------------------------

test('nextPollMs is pure, so calling it from three places cannot drift', () => {
  // main.js reschedules after every refresh, including ones the throttle
  // dropped. That is only safe because there is no counter being advanced.
  const p = ping(9, 40);
  assert.equal(nextPollMs(p, NOW), nextPollMs(p, NOW));
  assert.equal(nextPollMs(p, NOW), nextPollMs({ ...p }, NOW));
});

// --- what the panel says ------------------------------------------------------

test('dueInMs counts down to the next ping and then goes negative', () => {
  assert.equal(dueInMs(ping(2, 90), NOW), 3 * MIN);
  assert.ok(dueInMs(ping(9, 90), NOW) < 0, 'a late ping reads as overdue, not as zero');
});

test('dueInMs leaves the guard out of what the reader is told', () => {
  // The guard is slack the PAGE gives itself so it does not ask too early. It is
  // not part of the phone's schedule and has no business in a countdown.
  assert.equal(dueInMs(ping(0, 90), NOW), pingIntervalMs(90));
});

test('dueInMs has nothing to say without a battery', () => {
  assert.equal(dueInMs({ t: NOW }, NOW), null);
  assert.equal(dueInMs(null, NOW), null);
});
