// The status panel, the run picker and the follow button — all DOM, no map, no network.

import { ago, fmtClock } from './util.js';
import { latestOf } from './points.js';
import { urlFor } from './route.js';

export function createUi({ onFollowClick, run }) {
  const el = id => document.getElementById(id);
  const titleEl   = el('title');
  const countEl   = el('count');
  const updatedEl = el('updated-text');
  const errorEl   = el('error');
  const followEl  = el('follow');
  const runEl     = el('run');

  let points = [];

  followEl.addEventListener('click', onFollowClick);

  // Switching run changes the URL, so just navigate: a fresh load reads the new
  // run out of the URL and paints from its own cache. Nothing to tear down.
  runEl.addEventListener('change', () => { location.href = urlFor(runEl.value || null); });

  titleEl.textContent = run || 'Location Tracker';
  document.title = run ? `${run} · Location Tracker` : 'Location Tracker';

  function renderCount(state) {
    const n = points.length;
    if (n) {
      const plural = n === 1 ? '' : 's';
      countEl.innerHTML =
        `${n.toLocaleString()} <small>point${plural} &middot; last ${ago(latestOf(points).t)}</small>`;
    } else {
      countEl.innerHTML = state === 'loading' ? '&mdash;' : '<small>No locations yet</small>';
    }
  }

  return {
    setPoints(next) {
      points = next;
      renderCount(document.body.dataset.state);
    },

    /**
     * @param {string[]} runs subfolder names. The picker stays hidden until
     *   there's somewhere to go, so a repo with no runs looks exactly as before.
     */
    setRuns(runs) {
      // A run named in the URL but missing upstream still belongs in the list,
      // otherwise the picker would silently show the wrong selection.
      const names = run && !runs.includes(run) ? [run, ...runs] : runs;
      if (!names.length) return;

      runEl.innerHTML = '';
      for (const [value, label] of [['', 'Unsorted'], ...names.map(n => [n, n])]) {
        const option = new Option(label, value, false, value === (run || ''));
        runEl.add(option);
      }
      runEl.parentElement.hidden = false;
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

    /** Keep "last 3m ago" honest between polls. */
    refreshRelativeTime() {
      if (points.length) renderCount(document.body.dataset.state);
    }
  };
}
