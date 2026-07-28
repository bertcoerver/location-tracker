// Entry point: wires the data layer to the map and the status panel, and owns
// the polling lifecycle. This is the only file that knows about all the others.

import { CONFIG } from './config.js';
import { loadCache, RateLimitError, sync } from './github.js';
import { buildPoints } from './points.js';
import { createMap } from './map.js';
import { createUi } from './ui.js';
import { fmtClock } from './util.js';

const map = createMap(document.getElementById('map'), {
  // The map turns following off when the user pans; keep the button in sync.
  onFollowChange: on => ui.setFollowPressed(on)
});

const ui = createUi({
  onFollowClick: () => (map.isFollowing() ? map.stopFollowing() : map.recenter())
});

let backoffUntil = 0;

function show(cache) {
  const points = buildPoints(cache);
  map.setPoints(points);
  ui.setPoints(points);
}

async function refresh() {
  if (Date.now() < backoffUntil) return;

  ui.setState('loading');
  try {
    const { changed, cache } = await sync();
    if (changed) show(cache);

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
show(loadCache());
ui.setState('loading');
refresh();

setInterval(() => { if (!document.hidden) refresh(); }, CONFIG.pollMs);
setInterval(() => ui.refreshRelativeTime(), 15000);

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
addEventListener('focus', refresh);

requestAnimationFrame(frame);
