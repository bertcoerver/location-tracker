// The status panel and the follow button — all DOM, no map, no network.

import { ago, fmtClock } from './util.js';
import { latestOf } from './points.js';

export function createUi({ onFollowClick }) {
  const el = id => document.getElementById(id);
  const countEl   = el('count');
  const updatedEl = el('updated-text');
  const errorEl   = el('error');
  const followEl  = el('follow');

  let points = [];

  followEl.addEventListener('click', onFollowClick);

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
