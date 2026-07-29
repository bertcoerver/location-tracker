// The status panel and the run picker — all DOM, no map, no network.

import { LS_LAYERS } from './config.js';
import { isLive } from './github.js';
import { latestOf } from './points.js';
import { ago, fmtElapsed, storage } from './util.js';

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
   * How long since the last ping — the only number on the page.
   *
   * Not how long since the browser last talked to GitHub: that is the page's
   * business, not the viewer's, and the coloured dot beside this already says
   * whether it's healthy.
   */
  function renderTicker(state) {
    if (points.length) {
      tickerTextEl.textContent = `Last ping ${ago(latestOf(points).t)}`;
    } else if (state === 'loading') {
      tickerTextEl.textContent = 'Loading…';
    } else {
      tickerTextEl.textContent = run ? 'No locations yet' : 'No runs yet';
    }
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

    const live = isLive(index[run], Date.now());
    const from = points[0].t;
    const to = live ? Date.now() : latestOf(points).t;

    clockLabelEl.textContent = live ? 'Elapsed' : 'Total';
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
    dotEl.dataset.live = String(isLive(index[run], now));
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
      renderTicker(document.body.dataset.state);
      renderClock();
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
