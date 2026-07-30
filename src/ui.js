// The status panel and the run picker — all DOM, no map, no network.

import { byRecency, isLive } from './github.js';
import { finishOf, latestOf } from './points.js';
import { dueInMs } from './schedule.js';
import { predictAt } from './predict.js';
import { ago, coarse, fmtCountdown, fmtElapsed, fmtHm } from './util.js';

/**
 * What the race clock should say, as data rather than DOM.
 *
 * Pure and exported so the one genuinely branchy thing in this file can be tested
 * without a document — everything else here is a text node assignment, and this
 * has six cases.
 *
 * Two sources for "when did this start", in order of authority:
 *
 *   1. the SCHEDULED start, which the course filename declared. It is a stated fact
 *      about the race and is known before anybody has moved — which is what lets
 *      this box speak for a run with no pings at all, and that is most of the point
 *      of a course-only folder being a run: the route is on the map, the height
 *      profile is drawn, and this says when it begins.
 *   2. the first ping, the only thing available for a run whose course said nothing,
 *      and exactly what this box has always counted from.
 *
 * Neither, and there is nothing to count.
 *
 * Warm-up pings arriving before the gun do not start the clock — the gun does,
 * which is why the countdown never looks at `points`.
 *
 * @param {number|null} start the scheduled gun, or null
 * @param {Array}       points sorted oldest-first
 * @param {object|null} finish the ping the phone marked as its last, if any
 * @param {boolean}     live whether the run counts as still underway
 * @param {number}      now
 * @returns {{label: string, value: string}|null} null to hide the box entirely.
 */
export function clockReading({ start, points, finish, live, now }) {
  const scheduled = Number.isFinite(start);
  if (!scheduled && !points.length) return null;

  if (scheduled && now < start) {
    return { label: 'Starts in', value: fmtCountdown(start - now) };
  }

  const from = scheduled ? start : points[0].t;

  // The gun has gone and nothing has reported. The clock RUNS anyway: the timetable
  // says the race is on, and with no ping to show it is the only thing on screen
  // saying so — freezing at 0:00:00 would be claiming it hadn't started. That is a
  // claim from the schedule rather than from the phone, and the honest one to make
  // while waiting for a first fix, at the cost that a race whose phone never reports
  // at all counts up for ever. `live` cannot help here: it is ping-based by design,
  // so a started run with no pings is never live.
  if (!points.length) return { label: 'Elapsed', value: fmtElapsed(now - from) };

  // The finish rather than the newest point, which is the same thing unless a ping
  // that failed to upload turns up after it — then the race still ended when the
  // phone said it did.
  const to = live ? now : (finish || latestOf(points)).t;
  return { label: live ? 'Elapsed' : 'Total', value: fmtElapsed(to - from) };
}

export function createUi({ onRecenter, onRunPick }) {
  const el = id => document.getElementById(id);
  // The heading IS the run picker — see `renderRuns`. `titleEl` is its wrapper,
  // carrying the flag that decides whether the control looks like a control;
  // `titleTextEl` is the hidden sizer that gives the wrapper its width.
  const titleEl  = el('title');
  const titleTextEl = el('title-text');
  const dotEl    = el('dot');
  const tickerEl = el('ticker');
  const tickerTextEl = el('ticker-text');
  const errorEl  = el('error');
  const runEl    = el('run');
  const clockEl     = el('clock');
  const clockTimeEl = el('clock-time');
  const clockLabelEl = el('clock-label');
  const finishEl      = el('finish');
  const finishTimeEl  = el('finish-time');
  const finishRangeEl = el('finish-range');
  const viewerNoteEl = el('viewer-note');

  let points = [];
  // The ping the phone marked as its last, when there is one. Derived rather
  // than pushed in, so there is no second source of truth about it.
  let finish = null;
  // The run's pace model, or null. `buildForecast` already refuses to produce one
  // for a finished run, so the panel never has to decide between the two.
  let forecast = null;
  let index = {};
  let run = null;

  tickerEl.addEventListener('click', onRecenter);
  runEl.addEventListener('change', () => onRunPick(runEl.value));

  /**
   * Is the phone still out there?
   *
   * Two conditions, and the second is the one worth having. `isLive` can only
   * guess from the clock — a run stays "live" for an hour after its last ping —
   * so it cannot tell a finished race from a phone in a tunnel. A finish marker
   * can, and it says so the instant it lands rather than an hour later.
   *
   * Only for the run on screen. The picker's per-run marker keeps plain
   * `isLive`, because the index is built from the tree API and knows nothing
   * about file contents; a run has to be opened before its finish is visible.
   */
  function live(now = Date.now()) {
    return !finish && isLive(index[run], now);
  }

  /**
   * What the phone is doing: how long since the last ping, and when the next
   * one is due.
   *
   * Not how long since the BROWSER last talked to GitHub: that is the page's
   * business, not the viewer's, and the coloured dot beside this already says
   * whether it's healthy.
   *
   * The second part is there because the phone slows down as it drains — five
   * minutes on a full charge, half an hour on a dying one. Without it a
   * 30-minute silence is indistinguishable from a broken tracker; with it the
   * same silence reads as a system working exactly as designed, and says how
   * long to wait.
   *
   * A finished run says so instead. The finish is the most recent thing that
   * happened, so how old the last ping is has stopped being the question.
   *
   *   ● Last ping 1m ago · next ~16m
   *   ● Last ping 34m ago · overdue
   *   ● Finished 12m ago
   */
  function renderTicker(state) {
    if (points.length) {
      const last = latestOf(points);
      tickerTextEl.textContent = finish
        ? `Finished ${ago(finish.t)}`
        : `Last ping ${ago(last.t)}${expectation(last)}`;
    } else if (state === 'loading') {
      tickerTextEl.textContent = 'Loading…';
    } else if (!run) {
      tickerTextEl.textContent = 'No runs yet';
    } else {
      // "No locations yet" is true of a race that hasn't started, but it reads as a
      // fault — and for an upcoming race, having not pinged is the expected state
      // rather than a problem. So this says which of the two silences it is and
      // leaves the number to the clock beside it, which already has the countdown.
      const start = index[run]?.start ?? null;
      tickerTextEl.textContent = Number.isFinite(start) && Date.now() < start
        ? 'Not started yet'
        : 'No locations yet';
    }
  }

  /**
   * The " · next ~16m" half of the ticker, or nothing at all.
   *
   * Nothing for a run that has finished: an expectation is a claim about a phone
   * that is still out there, and one saying "overdue" a week later is noise —
   * "3d ago" has already said everything there is to say. Nothing either for a
   * ping with no battery in it, which is every file written before the field
   * existed; there is simply no schedule to predict from.
   *
   * The battery itself is not shown. It is what DECIDES this number rather than
   * something to act on, and "next ~16m" is already the useful half of that
   * answer; the figure is still in each ping's own tooltip for anyone who wants
   * it. See `dueInMs` in [schedule.js](./schedule.js).
   */
  function expectation(last) {
    if (!live()) return '';
    const due = dueInMs(last);
    if (due === null) return '';
    return due > 0 ? ` · next ~${coarse(due)}` : ' · overdue';
  }

  /**
   * The race clock: a countdown before the gun, elapsed time after it, a total once
   * the run has gone quiet.
   *
   * A clock that keeps counting after the finish is claiming the race is still on,
   * which is the one thing this box must never say — so the label changes with it,
   * and a stopped clock reads "Total" rather than "Elapsed".
   *
   * Every decision is in [`clockReading`](#clockReading); this puts the answer on
   * screen. Recomputed from the timestamps every tick rather than counted up, so it
   * can't drift and a backgrounded tab comes back with the right number.
   */
  function renderClock(now = Date.now()) {
    const reading = clockReading({
      start: index[run]?.start ?? null, points, finish, live: live(now), now
    });

    clockEl.hidden = !reading;
    if (!reading) return;

    clockLabelEl.textContent = reading.label;
    clockTimeEl.textContent = reading.value;
  }

  /**
   * When the run is expected to end, and how sure that is.
   *
   * Sits directly under the elapsed clock because it is the same question turned
   * round: one counts what has happened, the other guesses what is left. The
   * range beneath is not decoration — it is the part that stops a single number
   * being read as a promise.
   *
   * Shown only while the run is live. A forecast is a claim about a phone that is
   * still out there, and one left on screen after the run went quiet an hour ago
   * is the panel's version of a stopped clock still ticking. `buildForecast`
   * separately refuses to produce anything for a run that has actually finished,
   * so there is no case where this and the "Finished" ticker both speak.
   */
  function renderFinish() {
    const at = forecast && live() ? predictAt(forecast, forecast.course.length) : null;
    finishEl.hidden = !at;
    if (!at) return;

    // The tilde is doing real work: it is the difference between "13:24" and
    // "about 13:24", and this box has no room to say the second one in words.
    finishTimeEl.textContent = `~${fmtHm.format(at.t)}`;
    finishRangeEl.textContent = `${fmtHm.format(at.lo)} – ${fmtHm.format(at.hi)}`;
  }

  /**
   * Rebuild the picker, which is also the heading.
   *
   * The name of the run and the way to change it used to be two stacked
   * controls saying the same word twice. They are one now: the `<select>` is
   * styled as the h1, and only grows a border and a chevron when pointed at, so
   * at rest it reads as a title and on approach it admits to being a menu.
   *
   * Newest run first, so whatever is happening now is at the top, and a live one
   * is marked — a plain `<select>` can't be styled per option in any portable
   * way, so the marker has to be in the text.
   *
   * Re-rendered on a timer as well as on new data, so a run stops claiming to be
   * live an hour after its last ping without waiting for a poll.
   */
  function renderRuns() {
    const now = Date.now();
    // An upcoming race sorts by its scheduled start, so it sits at the top of the
    // list where it can be found rather than at the bottom among the finished ones.
    // Being top of the PICKER is not being the default view — see `defaultRun`.
    const names = Object.keys(index).sort(byRecency(index));

    // The status dot doubles as the live indicator: its COLOUR is whether the
    // last poll worked, and it PULSES while the run is still going. Two dots
    // side by side read as decoration rather than as two separate signals.
    dotEl.dataset.live = String(live(now));
    // Liveness is also what decides whether the clock runs or shows a total, and
    // whether there is still a finish worth predicting.
    renderClock(now);
    renderFinish();

    // One run is not a choice — but it is still the heading, so the control
    // stays and merely stops being one. Hiding it, as the old separate picker
    // did, would now take the run's name off the screen with it.
    const single = names.length < 2;
    runEl.disabled = single;
    titleEl.dataset.single = String(single);

    runEl.innerHTML = '';
    // Nothing to list yet: the heading still has to say something, and the
    // option carries no value because there is no run to navigate to.
    if (!names.length) {
      const label = run || 'Location Tracker';
      runEl.add(new Option(label, '', false, true));
      titleTextEl.textContent = label;
      return;
    }

    // What the closed control will be showing, which is what has to be measured.
    // The live marker is deliberately not part of it — see the loop below.
    titleTextEl.textContent = run || names[0];

    for (const name of names) {
      // The live marker, but never on the run being shown. Its own liveness is
      // already the pulsing dot one line above, and a `●` in the closed control
      // sits directly under that dot — two marks for one fact, which is what the
      // panel has always refused to do. Inside the open list it earns its place:
      // there it is the only thing saying which of the others is still running.
      const current = name === run;
      const label = !current && isLive(index[name], now) ? `● ${name}` : name;
      runEl.add(new Option(label, name, false, current));
    }
  }

  return {
    setPoints(next) {
      points = next;
      finish = finishOf(points);
      renderTicker(document.body.dataset.state);
      // The dot and the picker's markers are downstream of liveness too, and a
      // finish changes that without the index having moved at all.
      renderRuns();
    },

    /**
     * The run's pace model, or null.
     *
     * @param {object|null} next from `buildForecast`.
     */
    setForecast(next) {
      forecast = next;
      renderFinish();
    },

    /** The seconds hand. Called once a second; it touches one text node. */
    tickClock() {
      renderClock();
    },

    /**
     * How the request for the visitor's own position is getting on, in one muted
     * line at the foot of the panel.
     *
     * There is no checkbox to hang it off any more — the page asks on load, so the
     * only thing left worth saying is why there is no blue dot when there isn't
     * one. "Locating you…" is worth saying too: it arrives at the same moment as
     * the browser's permission prompt and is the only thing on screen explaining
     * what that prompt is for.
     *
     * Deliberately not `setError`: that line belongs to the poll loop, which
     * rewrites it on every pass, so a permission message put there would flicker
     * out within the minute.
     *
     * @param {'locating'|'on'|'denied'|'error'} state
     * @param {string} [note] from `geoMessage`, for the 'error' case.
     */
    setViewerState(state, note = '') {
      viewerNoteEl.textContent =
        state === 'locating' ? 'Locating you…' :
        state === 'denied' ? 'Your location: blocked' :
        state === 'error' ? `Your location: ${note}` : '';
    },

    /** @param {string|null} next the run now on screen, null when there are none. */
    setRun(next) {
      run = next;
      document.title = run ? `${run} · Location Tracker` : 'Location Tracker';
      // The visible name is the picker's own selected option now, so there is
      // one place it comes from rather than a text node to keep in step.
      renderRuns();
    },

    /** @param {Object} next the run index: name -> { files, latest }. */
    setRuns(next, current) {
      index = next;
      run = current;
      renderRuns();
    },

    /**
     * @param {'loading'|'ok'|'error'} state drives the coloured dot via CSS.
     *
     * State no longer has any text of its own: the ticker always shows the ping
     * age, and a failure has a message, which goes to `setError`.
     */
    setState(state) {
      document.body.dataset.state = state;
      renderTicker(state);
    },

    setError(message) {
      errorEl.textContent = message || '';
    },

    setFollowPressed(on) {
      tickerEl.setAttribute('aria-pressed', String(on));
    },

    /** Keep "Last ping 3m ago" honest between polls — and the live markers with it. */
    refreshRelativeTime() {
      if (points.length) renderTicker(document.body.dataset.state);
      renderRuns();
    }
  };
}
