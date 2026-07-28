// The status panel and the run picker — all DOM, no map, no network.

import { isLive } from './github.js';
import { latestOf } from './points.js';
import { ago } from './util.js';

export function createUi({ onRecenter, onRunPick }) {
  const el = id => document.getElementById(id);
  const titleEl  = el('title-text');
  const dotEl    = el('dot');
  const tickerEl = el('ticker');
  const tickerTextEl = el('ticker-text');
  const errorEl  = el('error');
  const runEl    = el('run');

  let points = [];
  let index = {};
  let run = null;

  tickerEl.addEventListener('click', onRecenter);
  runEl.addEventListener('change', () => onRunPick(runEl.value));

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
    },

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
