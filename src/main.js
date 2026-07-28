// Entry point: wires the data layer to the map and the status panel, and owns
// the polling lifecycle. This is the only file that knows about all the others.

import { CONFIG, LS_REFRESH } from './config.js';
import {
  cachedIndex, defaultRun, hydrate, loadCache, RateLimitError, refreshIndex
} from './github.js';
import { buildPoints } from './points.js';
import { createMap } from './map.js';
import { createUi } from './ui.js';
import { pinnedRun, urlFor } from './route.js';
import { fmtClock, persistedAt, throttle } from './util.js';

// An explicit ?run= in the URL, which pins the view. Null means "show whichever
// run is newest" — and that stays true as the page runs, so a plain link left
// open picks up a race that starts later.
const pinned = pinnedRun();

let index = cachedIndex();
let run = null;
let backoffUntil = 0;

const map = createMap(document.getElementById('map'), {
  // The map turns following off when the user pans; keep the button in sync.
  onFollowChange: on => ui.setFollowPressed(on)
});

const ui = createUi({
  onFollowClick: () => (map.isFollowing() ? map.stopFollowing() : map.recenter()),
  // Picking a run pins it in the URL, so just navigate: a fresh load reads it
  // back out and paints from that run's own cache. Nothing to tear down.
  onRunPick: name => { location.href = urlFor(name); }
});

function show(cache) {
  const points = buildPoints(cache);
  map.setPoints(points);
  ui.setPoints(points);
}

/**
 * A pinned run wins, unless the index says it doesn't exist — then fall back to
 * the newest rather than showing a permanently empty map. Before the first
 * index lands there's nothing to check the pin against, so it's trusted.
 */
function resolve() {
  if (pinned && index[pinned]) return pinned;
  return defaultRun(index) ?? pinned;
}

/**
 * Bring the screen in line with the current index: pick the run, then fill in
 * its points. Every request this makes goes to the CDN, so it is free against
 * the API budget — which is why opening a run is instant and unthrottled.
 */
async function reconcile() {
  const next = resolve();

  if (next !== run) {
    run = next;
    map.refit();              // a different run is a different place
    ui.setRun(run);
    show(loadCache(run));     // paint that run's cache before the CDN answers
  }
  ui.setRuns(index, run);

  if (run) show(await hydrate(run, index));
}

// Serialised, so a poll landing mid-hydrate can't have two passes writing the
// same run's cache over each other.
let queue = Promise.resolve();
function apply() {
  queue = queue.then(reconcile, reconcile);
  return queue;
}

async function poll() {
  if (Date.now() < backoffUntil) return;

  ui.setState('loading');
  try {
    const { index: next, truncated } = await refreshIndex();
    index = next;
    await apply();

    ui.setError(truncated
      ? 'Too many pings for one listing — older ones are missing. See the README.'
      : '');
    ui.setState('ok');
    ui.setUpdatedNow();
  } catch (err) {
    if (err instanceof RateLimitError) {
      backoffUntil = err.retryAt;
      ui.setError(`GitHub rate limit reached — retrying at ${fmtClock.format(err.retryAt)}`);
    } else {
      ui.setError(err.message);
    }
    ui.setState('error', 'Update failed');
  }
}

/**
 * Every path below funnels through this, and it guards the one rate-limited
 * call in the app. `focus` and `visibilitychange` both fire when a tab comes
 * forward, and someone flipping between tabs fires them over and over —
 * unthrottled, a couple of minutes of that spends the whole hourly budget and
 * locks the map out.
 *
 * The interval is persisted, so it also survives a reload: hammering the browser
 * refresh button repaints from cache instead of spending a request each time.
 * One key covers every run, because switching run doesn't need this call at all.
 */
const refresh = throttle(poll, CONFIG.minRefreshMs, { store: persistedAt(LS_REFRESH) });

function frame() {
  map.tick();
  requestAnimationFrame(frame);
}

// Paint from cache immediately and top it up from the CDN, both free, then go
// and see whether GitHub has anything newer.
ui.setState('loading');
apply();
refresh();

setInterval(() => { if (!document.hidden) refresh(); }, CONFIG.pollMs);
setInterval(() => ui.refreshRelativeTime(), 15000);

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
addEventListener('focus', refresh);

requestAnimationFrame(frame);
