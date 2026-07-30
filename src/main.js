// Entry point: wires the data layer to the map and the status panel, and owns
// the polling lifecycle. This is the only file that knows about all the others.

import { CONFIG, keysFor, LS_REFRESH } from './config.js';
import { buildCourse } from './course.js';
import {
  cachedBeacons, cachedIndex, defaultRun, fetchCourse, hydrate, loadCache, RateLimitError,
  refreshBeacons, refreshIndex
} from './github.js';
import { parseGpx } from './gpx.js';
import { buildPoints, latestOf } from './points.js';
import { buildForecast, deriveForecastErrors } from './predict.js';
import { nextPollMs } from './schedule.js';
import { applySnaps, snapAll } from './snap.js';
import { deriveStats } from './stats.js';
import { createMap } from './map.js';
import { createProfile } from './profile.js';
import { same } from './pin.js';
import { createUi } from './ui.js';
import { pinnedRun, pushRun } from './route.js';
import { fmtClock, persistedAt, storage, throttle } from './util.js';

// An explicit ?run= in the URL, which pins the view. Null means "show whichever
// run is newest" — and that stays true as the page runs, so a plain link left
// open picks up a race that starts later.
//
// Not a constant: picking another run rewrites this and pushes the matching URL,
// rather than navigating to it. See `openRun`.
let pinned = pinnedRun();

let index = cachedIndex();
let run = null;
let backoffUntil = 0;

// The newest ping on screen. It carries the phone's battery, which is what says
// when the next ping is due — see [schedule.js](./schedule.js).
let latest = null;

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
  onSelect: select,
  onScrub: scrub,
  // Clicking another run's dot is the second way to change run, and it goes
  // through exactly the same door as the dropdown.
  onBeaconPick: name => openRun(name)
});

const profile = createProfile(document.getElementById('profile'), {
  onHover: along => map.setHover(along),
  onSelect: select,
  onScrub: scrub
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

/**
 * The same selection, moved: a pinned point being dragged along the course.
 *
 * Separate from `select` for one reason, and it is the whole reason. `select`
 * treats "the same place again" as a dismissal, which is what makes a click a
 * toggle — and a drag passes through its own starting point constantly. Routing
 * a scrub through it would put the pin down mid-gesture.
 *
 * @param {import('./pin.js').Selection} next
 */
function scrub(next) {
  selection = next;
  // `false`: the camera follows a point dragged on the strip, and it has to keep
  // up with the finger rather than setting off on a flight per pointermove.
  map.setSelection(selection, false);
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
  onRunPick: name => openRun(name),
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

  // Then the pace model, fitted to THIS run and nothing else, and each ping's
  // score against the forecast that was made before it arrived. Both derived on
  // every paint rather than cached: they are a few hundred floating-point
  // operations over arrays already in hand, and a cached forecast is one that
  // can disagree with the pings it was fitted to.
  //
  // After `deriveStats`, because the errors are hung off the `stats` object it
  // creates — and that object is rebuilt from scratch each time through.
  const forecast = buildForecast(points, course);
  deriveForecastErrors(points, course);

  latest = latestOf(points);

  map.setPoints(points);
  map.setForecast(forecast);
  profile.setPoints(points);
  profile.setForecast(forecast);
  profile.scrollToLatest();
  ui.setPoints(points);
  ui.setForecast(forecast);
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

// Whether the run change now being reconciled was ASKED for, and so should be
// flown to rather than jumped to. Set by `openRun` and by the back button; read
// and cleared by `reconcile`, which is the only thing that knows a change is
// actually happening. A first load, or the newest run quietly changing under an
// unpinned view, is not a request and lands without a flight.
let flyToNext = false;

/**
 * Bring the screen in line with the current index: pick the run, then fill in
 * its points. Every request this makes goes to the CDN, so it is free against
 * the API budget — which is why opening a run is instant and unthrottled.
 */
async function reconcile() {
  const next = resolve();
  // Consumed whether or not the run actually changed: a request that turned out
  // to be for the run already on screen is spent, not saved up for the next one.
  const fly = flyToNext;
  flyToNext = false;

  if (next !== run) {
    run = next;
    map.refit(fly);           // a different run is a different place
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

  // The other runs go last, always. They are a signpost to somewhere else, and
  // nothing about them may hold up the race being looked at — even though in the
  // steady state this makes no requests at all. See `refreshBeacons`.
  map.setBeacons(await refreshBeacons(index, run));
}

// Serialised, so a poll landing mid-hydrate can't have two passes writing the
// same run's cache over each other.
let queue = Promise.resolve();
function apply() {
  queue = queue.then(reconcile, reconcile);
  return queue;
}

/**
 * Show a different run, without loading a page.
 *
 * This used to be `location.href = urlFor(name)`, which is why switching felt
 * like a reload — it was one, and it threw away a warm index, a fetched course
 * and every parsed cache to rebuild them all from scratch.
 *
 * Nothing about that was necessary. The index already covers every run, each has
 * its own cache, and `reconcile` already knows how to change run: it re-fits the
 * camera, drops the selection, clears the course and paints the new run from disk
 * before the CDN answers. All that was missing was a way to ask it to.
 *
 * The URL is still rewritten, because a link to the run on screen has to keep
 * working — pushed rather than replaced, so the back button walks back through
 * the runs you looked at.
 *
 * @param {string} name a run from the index. Both the picker and the dots on the
 *   map arrive here.
 */
function openRun(name) {
  // Re-picking the run already on screen is not a change. Worth saying, because
  // the picker fires `change` on any interaction and `reconcile` would otherwise
  // do nothing while the camera flew off to where it already was.
  if (!name || name === run) return;
  pinned = name;
  pushRun(name);
  flyToNext = true;
  apply();
}

// The back button, which now goes somewhere: a run switch is a history entry
// rather than a page load, so this is the only thing that makes it undoable.
// Flown, like any other asked-for change — the gesture means "take me back
// there", not "reload that".
addEventListener('popstate', () => {
  pinned = pinnedRun();
  flyToNext = true;
  apply();
});

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

/**
 * The poll timer, which reschedules itself after every attempt.
 *
 * Not a fixed interval: `nextPollMs` works out when the phone's next ping is
 * actually due from the battery the last one reported, so a phone at 12% is
 * asked about twice an hour instead of fifteen times, and a live one is read
 * within seconds of committing instead of an average of two minutes later.
 *
 * Rescheduling after EVERY refresh matters, including ones the throttle dropped
 * and ones triggered by a tab coming forward: a poll changes the newest point,
 * which is the thing the schedule is computed from. Since that computation is
 * pure, recomputing it more often than necessary costs nothing and can't drift.
 */
let timer = 0;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(tick, nextPollMs(latest));
}

async function tick() {
  // A backgrounded tab still keeps its schedule, it just doesn't spend requests
  // on it — `visibilitychange` below refreshes the moment it comes forward.
  if (!document.hidden) await refresh();
  schedule();
}

/** Refresh now, then work out when to do it next. Every entry point uses this. */
function refreshNow() {
  return refresh().finally(schedule);
}

function frame() {
  map.tick();
  requestAnimationFrame(frame);
}

// Paint from cache immediately and top it up from the CDN, both free, then go
// and see whether GitHub has anything newer.
ui.setState('loading');
// The other runs' dots straight off disk, before any network call at all, so the
// map doesn't open claiming to be the only race there has ever been.
//
// Filtered against `resolve()` rather than trusted as stored: the cache was
// written when some OTHER run was on screen, so the one about to be shown here
// may well be in it — and a dot marking the course you are looking at is just a
// blob on the start line. `reconcile` replaces the whole list a moment later.
map.setBeacons(cachedBeacons().filter(b => b.run !== resolve()));
apply();
refreshNow();

setInterval(() => ui.refreshRelativeTime(), 15000);
// The elapsed clock separately, and faster: a seconds display that only moves
// every 15 s is a broken clock, and running the 15 s job at 1 Hz would rebuild
// the run picker sixty times a minute to no purpose.
// The "probably here, now" marker rides the same beat, in both views: it is the
// other thing on screen that moves without any data having arrived. The strip
// redraws only when it has actually shifted a pixel, and the map repaints every
// frame anyway, so most of these ticks cost nothing.
setInterval(() => { ui.tickClock(); profile.tickForecast(); map.tickForecast(); }, 1000);

document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshNow(); });
addEventListener('focus', refreshNow);

requestAnimationFrame(frame);
