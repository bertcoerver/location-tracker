// Entry point: wires the data layer to the map and the status panel, and owns
// the polling lifecycle. This is the only file that knows about all the others.

import { CONFIG } from './config.js';
import { cachedRuns, listRuns, loadCache, RateLimitError, sync } from './github.js';
import { buildPoints } from './points.js';
import { createMap } from './map.js';
import { createUi } from './ui.js';
import { currentRun } from './route.js';
import { fmtClock } from './util.js';

// Which run we're showing is fixed for the life of the page — switching one
// navigates, so everything below can treat it as a constant.
const run = currentRun();

const map = createMap(document.getElementById('map'), {
  // The map turns following off when the user pans; keep the button in sync.
  onFollowChange: on => ui.setFollowPressed(on)
});

const ui = createUi({
  run,
  onFollowClick: () => (map.isFollowing() ? map.stopFollowing() : map.recenter())
});

let backoffUntil = 0;
let runsLoaded = false;

function show(cache) {
  const points = buildPoints(cache);
  map.setPoints(points);
  ui.setPoints(points);
}

/**
 * Populate the run picker, once. Polling a run lists only that run's folder, so
 * its siblings need a separate listing — but polling the root already returned
 * them, and then `dirs` arrives free.
 */
async function showRuns(dirs) {
  if (runsLoaded) return;
  const names = dirs ?? await listRuns().catch(() => null);
  if (!names) return;          // a later poll will try again
  runsLoaded = true;
  ui.setRuns(names);
}

async function refresh() {
  if (Date.now() < backoffUntil) return;

  ui.setState('loading');
  try {
    const { changed, cache, dirs } = await sync(run);
    if (changed) show(cache);
    showRuns(dirs);

    ui.setError('');
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

function frame() {
  map.tick();
  requestAnimationFrame(frame);
}

// Paint from cache immediately, then verify against GitHub.
show(loadCache(run));
ui.setRuns(cachedRuns());
ui.setState('loading');
refresh();

setInterval(() => { if (!document.hidden) refresh(); }, CONFIG.pollMs);
setInterval(() => ui.refreshRelativeTime(), 15000);

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
addEventListener('focus', refresh);

requestAnimationFrame(frame);
