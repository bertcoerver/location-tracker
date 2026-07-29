// Entry point: wires the data layer to the map and the status panel, and owns
// the polling lifecycle. This is the only file that knows about all the others.

import { CONFIG, keysFor, LS_REFRESH } from './config.js';
import { buildCourse } from './course.js';
import {
  cachedIndex, defaultRun, fetchCourse, hydrate, loadCache, RateLimitError, refreshIndex
} from './github.js';
import { parseGpx } from './gpx.js';
import { buildPoints } from './points.js';
import { applySnaps, snapAll } from './snap.js';
import { deriveStats } from './stats.js';
import { createMap } from './map.js';
import { createProfile } from './profile.js';
import { same } from './pin.js';
import { createUi } from './ui.js';
import { pinnedRun, urlFor } from './route.js';
import { fmtClock, persistedAt, storage, throttle } from './util.js';

// An explicit ?run= in the URL, which pins the view. Null means "show whichever
// run is newest" — and that stays true as the page runs, so a plain link left
// open picks up a race that starts later.
const pinned = pinnedRun();

let index = cachedIndex();
let run = null;
let backoffUntil = 0;

// The run's course, once its GPX has been fetched and parsed. Held in memory
// only — the snap RESULTS are what's worth persisting, and they're much smaller.
let course = null;
let courseSha = null;
let courseError = '';

// The map and the height strip are two views of one run, so pointing at a place
// in either marks it in the other. Each only reports what its OWN pointer is
// over, and each ignores the other while it holds the cursor itself, so the two
// callbacks below can't chase each other in a loop.
const map = createMap(document.getElementById('map'), {
  // The map turns following off when the user pans; keep the button in sync.
  onFollowChange: on => ui.setFollowPressed(on),
  onCourseHover: along => profile.setHover(along),
  onSelect: select
});

const profile = createProfile(document.getElementById('profile'), {
  onHover: along => map.setHover(along),
  onSelect: select
});

// The pinned point, if any. Hover is a fine way to glance at a point and a poor
// way to READ one — the cursor has to be held still, and the Google Maps link
// inside can't be reached before the tooltip evaporates. On a phone there is no
// hover at all. So a click pins the tooltip, and hovering is suspended in both
// views until it's put down.
//
// It lives here for the same reason the hover does: it is one fact about one
// place, and both views have to agree about it.
let selection = null;

/** @param {import('./pin.js').Selection|null} next */
function select(next) {
  // Clicking a point you have already pinned is how you put it down. Clicking
  // bare basemap arrives here as null, which does the same.
  selection = same(selection, next) ? null : next;
  map.setSelection(selection);
  profile.setSelection(selection);
}

// The keyboard way out, for when the thing you'd have to click is under the
// tooltip you're trying to dismiss.
addEventListener('keydown', event => {
  if (event.key === 'Escape' && selection) select(null);
});

const ui = createUi({
  // The ticker is the Follow button now. Clicking it always means "take me to
  // the runner" — following is switched OFF by panning the map, which is the
  // gesture that actually means "leave the camera alone".
  onRecenter: () => map.recenter(),
  // Picking a run pins it in the URL, so just navigate: a fresh load reads it
  // back out and paints from that run's own cache. Nothing to tear down.
  onRunPick: name => { location.href = urlFor(name); },
  // One switch, two views: hiding the waypoints has to hide them on the height
  // strip too, or the toggle would be lying about half the screen.
  onLayers: flags => { map.setLayers(flags); profile.setLayers(flags); }
});

// The panel restores its toggles from the last visit, so both views need to be
// told once at startup — a checkbox that comes back unticked has to arrive with
// its layer already gone.
map.setLayers(ui.layers());
profile.setLayers(ui.layers());

/**
 * Paint one run's points, snapped to its course if it has one.
 *
 * `snapAll` is given the persisted cache, so a ping is projected onto the course
 * exactly ONCE in its life — every later paint, poll and reload reads the stored
 * answer. That also means a reload draws the snapped positions immediately,
 * before the GPX itself has finished downloading.
 */
function show(cache) {
  const points = buildPoints(cache);

  if (course) {
    const key = keysFor(run).snap;
    const { cache: snaps, snapped } = snapAll(course, points, storage.get(key));
    if (snapped) storage.set(key, snaps);
    applySnaps(points, snaps);
  }

  // Elapsed time and climb, hung off each point for the tooltip. Cheap, and it
  // depends on the snaps above, so it goes here rather than being cached.
  deriveStats(points, course);

  map.setPoints(points);
  profile.setPoints(points);
  profile.scrollToLatest();
  ui.setPoints(points);
}

/**
 * Fetch and parse this run's course, if it has one we haven't already got. Free
 * against the API budget — it's a CDN file, discovered by a tree request we were
 * making anyway.
 *
 * A course that won't load or won't parse is reported and then forgotten: the
 * map falls back to plain unsnapped pings rather than showing nothing.
 */
async function loadCourse() {
  const wanted = index[run]?.course?.sha ?? null;
  if (wanted === courseSha) return false;

  courseSha = wanted;
  course = null;
  courseError = '';

  if (wanted) {
    try {
      const file = await fetchCourse(run, index);
      course = buildCourse(parseGpx(file.text), file.sha);
      if (!course) throw new Error('no usable track in it');
    } catch (err) {
      courseError = `Course file could not be read — ${err.message}`;
      ui.setError(courseError);
    }
  }

  map.setCourse(course);
  profile.setCourse(course);
  // A toggle for something this run hasn't got isn't a choice, it's furniture.
  ui.setAvailable({
    waypoints: Boolean(course?.waypoints?.length),
    raw: Boolean(course)
  });
  return true;
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
    select(null);             // and a point pinned on the old one is gone

    course = null;
    courseSha = null;
    map.setCourse(null);
    profile.setCourse(null);
    ui.setAvailable({ waypoints: false, raw: false });
    ui.setRun(run);
    show(loadCache(run));     // paint that run's cache before the CDN answers
  }
  ui.setRuns(index, run);
  if (!run) return;

  // Points first: they're the live data, and they're already half in hand. The
  // course only changes what the pings are drawn ON, so it can land second.
  show(await hydrate(run, index));
  if (await loadCourse()) show(loadCache(run));
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
      : courseError);
    ui.setState('ok');
  } catch (err) {
    if (err instanceof RateLimitError) {
      backoffUntil = err.retryAt;
      ui.setError(`GitHub rate limit reached — retrying at ${fmtClock.format(err.retryAt)}`);
    } else {
      ui.setError(err.message);
    }
    ui.setState('error');
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
// The elapsed clock separately, and faster: a seconds display that only moves
// every 15 s is a broken clock, and running the 15 s job at 1 Hz would rebuild
// the run picker sixty times a minute to no purpose.
setInterval(() => ui.tickClock(), 1000);

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
addEventListener('focus', refresh);

requestAnimationFrame(frame);
