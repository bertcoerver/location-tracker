// The status panel and the run picker — all DOM, no map, no network.

import { LS_LAYERS } from './config.js';
import { isLive } from './github.js';
import { finishOf, latestOf } from './points.js';
import { dueInMs } from './schedule.js';
import { ago, coarse, fmtElapsed, storage } from './util.js';

export function createUi({ onRecenter, onRunPick, onLayers = () => {} }) {
  const el = id => document.getElementById(id);
  const titleEl  = el('title-text');
  const dotEl    = el('dot');
  const tickerEl = el('ticker');
  const tickerTextEl = el('ticker-text');
  const errorEl  = el('error');
  const runEl    = el('run');
  const clockEl     = el('clock');
  const clockTimeEl = el('clock-time');
  const clockLabelEl = el('clock-label');
  const togglesEl = el('toggles');
  const boxes = { waypoints: el('t-waypoints'), raw: el('t-raw') };

  let points = [];
  // The ping the phone marked as its last, when there is one. Derived rather
  // than pushed in, so there is no second source of truth about it.
  let finish = null;
  let index = {};
  let run = null;
  // Which toggles have anything to toggle: no waypoints in the GPX, no
  // waypoints checkbox. Same rule as the run picker below.
  let available = { waypoints: false, raw: false };

  tickerEl.addEventListener('click', onRecenter);
  runEl.addEventListener('change', () => onRunPick(runEl.value));

  /**
   * The layer toggles, restored from the last visit.
   *
   * Not per-run: whether you want to see the raw fixes behind the snapped ones
   * is a preference about how you read a map, not a fact about a race. Missing
   * or unreadable storage means both on, which is what the map looked like
   * before this existed.
   */
  const saved = storage.get(LS_LAYERS) || {};
  const flags = {
    waypoints: saved.waypoints !== false,
    raw: saved.raw !== false
  };

  for (const [name, box] of Object.entries(boxes)) {
    box.checked = flags[name];
    box.addEventListener('change', () => {
      flags[name] = box.checked;
      storage.set(LS_LAYERS, flags);
      onLayers({ ...flags });
    });
  }

  function renderToggles() {
    for (const [name, box] of Object.entries(boxes)) {
      box.parentElement.hidden = !available[name];
    }
    togglesEl.hidden = !available.waypoints && !available.raw;
  }

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
   * What the phone is doing: how long since the last ping, when the next one is
   * due, and the battery that decides the gap between them.
   *
   * Not how long since the BROWSER last talked to GitHub: that is the page's
   * business, not the viewer's, and the coloured dot beside this already says
   * whether it's healthy.
   *
   * The last two parts are there because the phone slows down as it drains —
   * five minutes on a full charge, half an hour on a dying one. Without them a
   * 30-minute silence is indistinguishable from a broken tracker; with them it
   * reads as a system working exactly as designed, and says how long to wait.
   *
   * A finished run says so instead. The finish is the most recent thing that
   * happened, so how old the last ping is has stopped being the question.
   *
   *   ● Last ping 1m ago · next ~16m · 25%
   *   ● Last ping 34m ago · overdue · 25%
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
    } else {
      tickerTextEl.textContent = run ? 'No locations yet' : 'No runs yet';
    }
  }

  /**
   * The " · next ~16m · 25%" half of the ticker, or nothing at all.
   *
   * Nothing for a run that has finished: an expectation is a claim about a phone
   * that is still out there, and one saying "overdue" a week later is noise —
   * "3d ago" has already said everything there is to say. Nothing either for a
   * ping with no battery in it, which is every file written before the field
   * existed; there is simply no schedule to predict from.
   */
  function expectation(last) {
    if (!live()) return '';
    const due = dueInMs(last);
    if (due === null) return '';
    return `${due > 0 ? ` · next ~${coarse(due)}` : ' · overdue'} · ${last.btry}%`;
  }

  /**
   * Time since the first ping of the run.
   *
   * Running while the run is live, frozen at first-to-last once it goes quiet.
   * A clock that keeps counting after the finish is claiming the race is still
   * on, which is the one thing this box must never say — so the label changes
   * with it, and a stopped clock reads "Total" rather than "Elapsed".
   *
   * Recomputed from the timestamps every tick rather than counted up, so it
   * can't drift and a backgrounded tab comes back with the right number.
   */
  function renderClock() {
    const on = points.length > 0;
    clockEl.hidden = !on;
    if (!on) return;

    const running = live();
    const from = points[0].t;
    // The finish rather than the newest point, which is the same thing unless a
    // ping that failed to upload turns up after it — then the race still ended
    // when the phone said it did.
    const to = running ? Date.now() : (finish || latestOf(points)).t;

    clockLabelEl.textContent = running ? 'Elapsed' : 'Total';
    clockTimeEl.textContent = fmtElapsed(to - from);
  }

  /**
   * Rebuild the picker. Newest run first, so whatever is happening now is at the
   * top, and a live one is marked — a plain `<select>` can't be styled per
   * option in any portable way, so the marker has to be in the text.
   *
   * Re-rendered on a timer as well as on new data, so a run stops claiming to be
   * live an hour after its last ping without waiting for a poll.
   */
  function renderRuns() {
    const now = Date.now();
    const names = Object.keys(index).sort((a, b) => index[b].latest - index[a].latest);

    // The status dot doubles as the live indicator: its COLOUR is whether the
    // last poll worked, and it PULSES while the run is still going. Two dots
    // side by side read as decoration rather than as two separate signals.
    dotEl.dataset.live = String(live(now));
    // Liveness is also what decides whether the clock runs or shows a total.
    renderClock();

    // One run is not a choice. Two are.
    runEl.parentElement.hidden = names.length < 2;
    if (names.length < 2) return;

    runEl.innerHTML = '';
    for (const name of names) {
      const label = isLive(index[name], now) ? `● ${name}` : name;
      runEl.add(new Option(label, name, false, name === run));
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

    /** The seconds hand. Called once a second; it touches one text node. */
    tickClock() {
      renderClock();
    },

    /** What the current run's course actually offers, so a toggle with nothing
     *  to toggle stays out of the way. */
    setAvailable(next) {
      available = { ...available, ...next };
      renderToggles();
    },

    /** The current toggle state, for whoever needs it before the first change. */
    layers: () => ({ ...flags }),

    /** @param {string|null} next the run now on screen, null when there are none. */
    setRun(next) {
      run = next;
      titleEl.textContent = run || 'Location Tracker';
      document.title = run ? `${run} · Location Tracker` : 'Location Tracker';
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
