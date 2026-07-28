// The status panel, the run picker and the follow button — all DOM, no map, no network.

import { isLive } from './github.js';
import { latestOf } from './points.js';
import { ago, fmtClock } from './util.js';

export function createUi({ onFollowClick, onRunPick }) {
  const el = id => document.getElementById(id);
  const titleEl   = el('title-text');
  const liveEl    = el('live');
  const countEl   = el('count');
  const updatedEl = el('updated-text');
  const errorEl   = el('error');
  const followEl  = el('follow');
  const runEl     = el('run');

  let points = [];
  let index = {};
  let run = null;

  followEl.addEventListener('click', onFollowClick);
  runEl.addEventListener('change', () => onRunPick(runEl.value));

  function renderCount(state) {
    const n = points.length;
    if (n) {
      const plural = n === 1 ? '' : 's';
      countEl.innerHTML =
        `${n.toLocaleString()} <small>point${plural} &middot; last ${ago(latestOf(points).t)}</small>`;
    } else if (state === 'loading') {
      countEl.innerHTML = '&mdash;';
    } else {
      countEl.innerHTML = run ? '<small>No locations yet</small>' : '<small>No runs yet</small>';
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

    liveEl.hidden = !isLive(index[run], now);

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
      renderCount(document.body.dataset.state);
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

    /** @param {'loading'|'ok'|'error'} state drives the coloured dot via CSS. */
    setState(state, text) {
      document.body.dataset.state = state;
      if (text) updatedEl.textContent = text;
      else if (state === 'loading') updatedEl.textContent = 'Checking…';
      renderCount(state);
    },

    setUpdatedNow() {
      updatedEl.textContent = `Updated ${fmtClock.format(new Date())}`;
    },

    setError(message) {
      errorEl.textContent = message || '';
    },

    setFollowPressed(on) {
      followEl.setAttribute('aria-pressed', String(on));
    },

    /** Keep "last 3m ago" honest between polls — and the live markers with it. */
    refreshRelativeTime() {
      if (points.length) renderCount(document.body.dataset.state);
      renderRuns();
    }
  };
}
