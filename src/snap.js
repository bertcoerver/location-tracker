// Pinning each ping onto the course.
//
// The hard case is a CIRCULAR course. Where start and finish coincide, a fix at
// the junction is a metre from two places on the route that are a whole lap
// apart, and no amount of geometry can tell them apart — the two candidates are
// genuinely equidistant. What separates them is history: a fix at the start of
// the race is at the start of the course, one at the end is at the end.
//
// So snapping is sequential. Each ping is scored against where the previous one
// landed, and the cost function is what encodes "runners move forwards".

import { CONFIG } from './config.js';
import { nearestOnCourse } from './course.js';

/**
 * Choose one of the candidate positions, given how far along the previous ping
 * got. All three terms are in metres, so they add up honestly.
 *
 *   perp      how far the fix is from the course — the geometric fit
 *   backward  moving back down the course is close to forbidden
 *   forward   and jumping ahead is mildly discouraged
 *
 * The forward bias is the term that resolves a loop. Seeded at `prevAlong = 0`,
 * the finish-line candidate carries a penalty of `bias * length` that the start
 * does not, so the FIRST ping snaps to the start. By the last lap `prevAlong` is
 * near `length` and the same junction resolves the other way, for free.
 *
 * It's deliberately small: two pings five minutes apart are perhaps a kilometre
 * of real progress, which costs 20 m of penalty here — never enough to lose to a
 * wrong branch that's tens of metres closer.
 */
function pick(candidates, prevAlong) {
  let best = null;
  let bestCost = Infinity;

  for (const c of candidates) {
    const cost = c.perp
      + CONFIG.snapBackPenalty * Math.max(0, prevAlong - c.along)
      + CONFIG.snapForwardBias * Math.max(0, c.along - prevAlong);

    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }

  return best;
}

/**
 * The last vertex of the course, in the shape of a snap.
 *
 * `CONFIG.snapMeters` deliberately does NOT apply here. For an ordinary ping,
 * being half a kilometre off the route is evidence the phone isn't on it, and
 * leaving the fix where it is says so honestly. A finish is not evidence — it is
 * an assertion by the device that the course is done — so it is pinned whatever
 * the geometry says, and `off` is left to tell the truth about the distance.
 *
 * On a CIRCULAR course this is the whole ballgame. The junction where start and
 * finish coincide is precisely the ambiguity this file exists to fight, and the
 * last ping of a lap is the case where `snapForwardBias` has the least margin.
 * An explicit finish settles it outright instead of arguing about it.
 */
function courseEnd(course, point) {
  const { path, proj } = course;
  const end = path[path.length - 1];
  return {
    along: course.length,
    lon: end.lon,
    lat: end.lat,
    ele: end.ele,
    // Measured the same way `buildCourse` measures the start/finish gap.
    off: Math.hypot(proj.x(point.lon) - proj.x(end.lon), proj.y(point.lat) - proj.y(end.lat))
  };
}

/** One ping -> its place on the course, or null if it's simply not near it. */
export function snapOne(course, point, prevAlong, nearest = nearestOnCourse) {
  if (point.is_finish) return courseEnd(course, point);

  const best = pick(nearest(course, point.lon, point.lat, CONFIG.snapMeters), prevAlong);
  if (!best) return null;
  return { along: best.along, lon: best.lon, lat: best.lat, ele: best.ele, off: best.perp };
}

/** A cache that will match nothing — the shape `snapAll` expects when starting over. */
function emptyCache(course, start) {
  return {
    courseSha: course.sha,
    snapMeters: CONFIG.snapMeters,
    start,
    last: null,
    byName: {}
  };
}

/**
 * Snaps a whole run, doing as little work as possible.
 *
 * Every ping is projected onto the course EXACTLY ONCE in its lifetime: the
 * result is keyed by filename in `cache.byName` and survives reloads through
 * localStorage. Because location files are immutable and arrive in time order,
 * resuming from the last cached ping gives bit-identical results to recomputing
 * the lot — which the tests assert rather than assume.
 *
 * Four things invalidate the whole cache, because each makes the stored
 * `along` values meaningless:
 *   - a different course file (`courseSha`),
 *   - a different threshold (`snapMeters`),
 *   - a different scheduled `start`, which changes which pings belong on the
 *     course at all. This one cannot be folded into `courseSha`: a tree entry's
 *     sha is a hash of the CONTENT, so renaming a GPX to move the gun from 09:00
 *     to 08:00 leaves the sha untouched, and every stored `along` would keep the
 *     answer computed under the old start.
 *   - a ping appearing that is OLDER than the last one we snapped. That's a
 *     backfill, and the sequence it should have been scored against never ran.
 *
 * @param {object}  course
 * @param {Array}   points  sorted oldest-first, as `buildPoints()` returns them
 * @param {object}  cache   the previous result; pass a stale or empty one freely
 * @param {object}  [opts]
 * @param {number|null} [opts.start] the gun, when the course filename named one.
 *   Pings before it are left off the course entirely — see the loop below.
 * @param {Function} [opts.nearest] injectable, for the tests.
 * @returns {{cache: object, snapped: number}}
 */
export function snapAll(course, points, cache, { start = null, nearest = nearestOnCourse } = {}) {
  let next = cache;

  const stale = !next
    || next.courseSha !== course.sha
    || next.snapMeters !== CONFIG.snapMeters
    || (next.start ?? null) !== start
    || !next.byName;

  if (stale) next = emptyCache(course, start);

  // A backfilled ping can't be scored against a sequence that already moved past
  // it, so the only correct answer is to run the sequence again.
  if (next.last && points.some(p => !(p.name in next.byName) && p.t < next.last.t)) {
    next = emptyCache(course, start);
  }

  const byName = { ...next.byName };
  let last = next.last;
  let snapped = 0;

  for (const point of points) {
    if (point.name in byName) continue;

    // Before the gun: drawn where the GPS put it, placed nowhere on the course. A
    // fix taken in the start pen an hour early is metres from the route and would
    // snap to it perfectly — and then every distance, pace, climb and forecast
    // built on it would be counting a warm-up as race progress.
    //
    // This is the whole of the exclusion. `deriveStats`' distance and climb,
    // `buildForecast`, `interpolateAt` and both of the
    // height strip's loops all key on `snap`, so a ping without one is already
    // invisible to every one of them; nothing downstream has to learn what a gun is.
    //
    // Recorded as an explicit null rather than skipped, for the same reason an
    // off-course ping is: a name missing from `byName` means "never seen", and this
    // one has been seen and decided about. It also has to count towards `snapped`,
    // or `show()` never persists the cache, the new `start` never reaches the
    // version tuple above, and every paint finds it stale and re-snaps the run.
    const result = start !== null && point.t < start
      ? null
      : snapOne(course, point, last ? last.along : 0, nearest);

    byName[point.name] = result;
    snapped++;

    // A ping off the course leaves progress where it was. Otherwise a detour
    // through a tunnel would drag the runner back to the start line on the far
    // side of it.
    if (result) last = { t: point.t, along: result.along };
  }

  // Mirror deletions, so a removed file doesn't keep a slot in the cache forever.
  const live = new Set(points.map(p => p.name));
  for (const name of Object.keys(byName)) if (!live.has(name)) delete byName[name];

  return {
    cache: { courseSha: course.sha, snapMeters: CONFIG.snapMeters, start, last, byName },
    snapped
  };
}

/** Hangs each cached snap off its point, in place. Cheap enough to redo on every paint. */
export function applySnaps(points, cache) {
  const byName = cache?.byName || {};
  for (const point of points) {
    const snap = byName[point.name];
    if (snap) point.snap = snap;
    else delete point.snap;
  }
  return points;
}
