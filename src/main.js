// Entry point: wires the data layer to the map and the status panel, and owns
// the polling lifecycle. This is the only file that knows about all the others.

import { CONFIG, keysFor, LS_REFRESH } from './config.js';
import { buildCourse } from './course.js';
import {
  cachedBeacons, cachedIndex, cachedSettings, defaultRun, fetchCourse, hydrate, loadCache,
  RateLimitError, refreshBeacons, refreshIndex, refreshSettings
} from './github.js';
import { createGeo, geoMessage, isDenied, viewerFrom } from './geo.js';
import { parseGpx } from './gpx.js';
import { createNews } from './news.js';
import { buildPoints, latestOf } from './points.js';
import { buildForecast } from './predict.js';
import { nextPollMs } from './schedule.js';
import { applySnaps, snapAll } from './snap.js';
import { deriveStats } from './stats.js';
import { sunPois } from './sun.js';
import { createMap } from './map.js';
import { createProfile } from './profile.js';
import { same } from './pin.js';
import { createUi } from './ui.js';
import { pinnedRun, pushRun } from './route.js';
import { maybeShowDiag } from './diag.js';
import { registerSw } from './sw-register.js';
import { fmtClock, persistedAt, storage, throttle } from './util.js';

// An explicit ?run= in the URL, which pins the view. Null means "show whichever
// run is newest" — and that stays true as the page runs, so a plain link left
// open picks up a race that starts later.
//
// Not a constant: picking another run rewrites this and pushes the matching URL,
// rather than navigating to it. See `openRun`.
let pinned = pinnedRun();

let index = cachedIndex();
// What every run says about itself. Read off disk here, synchronously, for the same
// reason the index is: the first paint happens before any network call, and it has to
// paint against the right gun time, the right name and the right ping curve. A run's
// settings are a few hundred bytes, so holding all of them costs nothing.
let settings = cachedSettings();
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

// The one thing on screen that a person wrote. It owns its own height, which
// everything anchored to the bottom of the window adds in — see `bottomInset`.
const news = createNews(document.getElementById('news'));

const ui = createUi({
  // The ticker is the Follow button now. Clicking it always means "take me to
  // the runner" — following is switched OFF by panning the map, which is the
  // gesture that actually means "leave the camera alone".
  onRecenter: () => map.recenter(),
  onRunPick: name => openRun(name)
});

// The offline cache. Last in the wiring and first thing that can be deleted: the
// page behaves identically without it, right up until the signal goes.
registerSw();

// Throwaway: viewport variant readout. Triple-tap the panel. See src/diag.js.
addEventListener('load', maybeShowDiag);

// Asking the device where it is — the one thing here that isn't the network. The
// dot it produces is not part of the run: no cache, nothing persisted about the
// position itself, and no effect on the camera.
const geo = createGeo({
  onPosition: position => {
    map.setViewer(viewerFrom(position));
    ui.setViewerState('on');
  },
  // A failure takes the dot away rather than leaving the last known position
  // sitting there: a stale "you are here" is a worse answer than none, and this
  // one would be stale without saying so.
  onError: error => {
    map.setViewer(null);
    if (!isDenied(error)) return ui.setViewerState('error', geoMessage(error));
    // A refusal is final until the browser's own settings change, so let the watch
    // go rather than leaving one running that can never report anything. Nothing
    // in this page will ask again: the prompt is raised once, on load, and a "no"
    // ends it for good — only the browser's own site settings can undo it.
    ui.setViewerState('denied');
    geo.enable(false);
  }
});

// Ask where the visitor is, now, on load.
//
// This used to be behind a checkbox, off by default, on the argument that a page
// which demands your location before you have asked it for anything is a page
// nobody trusts. The argument lost to what actually happened: the tick was the
// one control on the panel nobody found, and the dot it draws is half of what the
// page is for — the pings say where the runner is, and this says where you are
// relative to them. The browser's own prompt is the consent, it is asked once per
// site, and a refusal is honoured permanently by `onError` below.
//
// Nothing happens at all where asking is pointless: no geolocation API, or a page
// served over plain http from anything but localhost. `enable` guards that itself,
// so the only reason to test it here is to keep the panel from saying it is
// locating someone it will never locate. See `supported`.
if (geo.supported()) {
  ui.setViewerState('locating');
  geo.enable(true);
}

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

  // The gun, when this run's settings declared one. Read off the SETTINGS cache
  // rather than off the parsed course, because that cache is what arrives first and
  // what survives in localStorage: the cached points paint before the GPX has even
  // been asked for, and they have to paint against the right start.
  const start = settings[run]?.start ?? null;

  if (course) {
    const key = keysFor(run).snap;
    const { cache: snaps, snapped } = snapAll(course, points, storage.get(key), { start });
    if (snapped) storage.set(key, snaps);
    applySnaps(points, snaps);
  }

  // Elapsed time and climb, hung off each point for the tooltip. Cheap, and it
  // depends on the snaps above, so it goes here rather than being cached.
  deriveStats(points, course, start);

  // Then the pace model, fitted to THIS run and nothing else. Derived on every
  // paint rather than cached: it is a few hundred floating-point operations over
  // arrays already in hand, and a cached forecast is one that can disagree with the
  // pings it was fitted to.
  const forecast = buildForecast(points, course);

  // And where the light was. Derived per paint like the forecast, and for the same
  // reason: a few dozen trig calls over arrays already in hand, and a cached mark is
  // one that can disagree with the pings it was placed from. Both views get the same
  // array, so neither can mark a moment the other doesn't.
  const sun = sunPois(points, course);

  latest = latestOf(points);

  map.setPoints(points);
  map.setForecast(forecast);
  map.setSun(sun);
  profile.setPoints(points);
  profile.setForecast(forecast);
  profile.setSun(sun);
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
  // The panel too, now that it has a figures line to draw — and it is the one view
  // that can show something useful without a course at all, when the settings state
  // the distance themselves. See `courseFigures`.
  ui.setCourse(course);
  return true;
}

/**
 * A pinned run wins, unless the index says it doesn't exist — then fall back to
 * the newest rather than showing a permanently empty map. Before the first
 * index lands there's nothing to check the pin against, so it's trusted.
 */
function resolve() {
  if (pinned && index[pinned]) return pinned;
  return defaultRun(index, settings) ?? pinned;
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
  const switching = next !== run;

  if (switching) {
    run = next;
    // The destination, so the camera can set off from the dot already drawn for
    // that run instead of waiting for its files.
    map.refit(fly, next);     // a different run is a different place
    select(null);             // and a point pinned on the old one is gone

    course = null;
    courseSha = null;
    map.setCourse(null);
    profile.setCourse(null);
    ui.setCourse(null);
    ui.setRun(run);
    // Before painting, because painting an empty cache is what makes the panel
    // speak. "No locations yet" is a claim about the RUN; with nothing fetched
    // yet the true statement is that we are fetching. A switch is a load, and
    // `poll` brackets its own the same way.
    ui.setState('loading');
    show(loadCache(run));     // paint that run's cache before the CDN answers
  }
  ui.setRuns(index, settings, run);
  // Whatever this run has to say, if anything. Outside the `switching` branch, so
  // editing a banner mid-race reaches the screen on the next poll rather than only
  // when somebody changes run; `setBanner` is idempotent, so the repeat costs
  // nothing and — crucially — does not restart a scrolling message.
  news.setBanner(settings[run]?.banner);
  if (!run) return;

  // Points first: they're the live data, and they're already half in hand. The
  // course only changes what the pings are drawn ON, so it can land second.
  show(await hydrate(run, index));
  if (await loadCourse()) show(loadCache(run));

  // This pass started the load, so this pass has to end it — otherwise the dot
  // pulses forever, claiming a run is live when all it means is that the page is
  // still thinking. Only when we were the one switching: a poll owns the state
  // otherwise, and stamping 'ok' over an error it just reported would hide it.
  if (switching) ui.setState('ok');

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

    // Immediately after the listing, and deliberately NOT inside `reconcile`. That
    // function runs on every run switch and every press of the back button, and
    // settings are not a per-navigation fact — they change once or twice in a run's
    // life. `refreshIndex` is also what produced the shas this diffs against, so
    // pairing them is what lets `apply()` see one consistent (index, settings) pair
    // rather than a pair that shifts under it mid-pass.
    //
    // In the steady state every sha matches what is already stored, so this makes no
    // requests at all and adds nothing to the time before the map is repainted.
    //
    // `prune` off on a truncated listing: a tree that hit GitHub's cap and dropped
    // entries is indistinguishable from a repo where those files were deleted, and
    // acting on it would strip the gun times off runs whose settings are right there.
    settings = await refreshSettings(index, { prune: !truncated });

    await apply();

    ui.setError(truncated
      ? 'Too many pings for one listing — older ones are missing. See the README.'
      : courseError);
    ui.setState('ok');
  } catch (err) {
    if (err instanceof RateLimitError) {
      backoffUntil = err.retryAt;
      ui.setError(`GitHub rate limit reached — retrying at ${fmtClock(err.retryAt)}`);
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
  // Against THIS run's ping curve when its settings named one, so a race tracked by a
  // phone on a different schedule is polled on that schedule rather than on the one
  // in config.js. Undefined falls back there, which is every run that says nothing.
  timer = setTimeout(tick, nextPollMs(latest, Date.now(), settings[run]?.ping));
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
