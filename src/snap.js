// Pinning each ping onto the course.
//
// The hard case is a CIRCULAR course. Where start and finish coincide — or where
// a route's last kilometres retrace its first — a fix is a metre from two places
// on the route that are most of a lap apart, and no amount of geometry can tell
// them apart. The two candidates are genuinely equidistant. What separates them
// is the rest of the run: a fix at the start of the race is at the start of the
// course, one at the end is at the end.
//
// This used to be done GREEDILY. Each ping was scored against wherever the
// previous one landed, the best candidate won, and that was that. The trouble is
// that a greedy matcher has no way back. One bad fix — and a trail runner under
// tree cover produces them — moves `prevAlong` somewhere the runner never was,
// and every later ping is then scored against a lie. It cannot be tuned out:
// whatever the weights, the ping that would have exposed the error is judged by
// the error. On `test_run` a single 251 m outlier put the runner 25 km ahead at
// 09:05, and the next forty minutes of perfectly good fixes — several of them
// within 5 m of the route — were dragged along behind it at up to 300 km/h.
//
// So snapping is now GLOBAL. Every candidate for every ping goes into a trellis,
// and Viterbi finds the cheapest path through the whole run at once. An outlier
// no longer has to be judged in isolation, because the pings on either side of it
// are already in evidence when it is judged — which is what lets a lone bad fix
// be recognised as a lone bad fix and stepped over, rather than believed and
// followed. This also means past snaps are RE-DERIVED whenever a new ping
// arrives, so a fix that looked plausible at the time can be revised once the
// run makes clear that it wasn't.
//
// The costs are Newson & Krumm's, in metres throughout so they add up honestly:
// how far a fix is from the course, against how far the course says the runner
// went versus how far the raw fixes say they moved.

import { CONFIG } from './config.js';
import { courseCandidates } from './course.js';

/**
 * What it costs to have been at `from` on the course and then at `to`.
 *
 * @param {number} d      metres along the course, signed — negative is backwards
 * @param {number} chord  straight-line metres between the two RAW fixes
 * @param {number} dt     seconds between them
 * @param {number} vmax   metres per second the runner is allowed to imply
 * @param {number} loop   course length if it is CIRCULAR, else 0
 */
function transition(d, chord, dt, vmax, loop) {
  // On a closed course the two ends of `along` are the same piece of ground, so a
  // step from 3.9 km to 0.1 km on a 4 km loop is 200 m of running through the
  // junction and not 3.8 km of it. That matters to the two terms below that ask
  // whether the runner COULD have moved this far, and measuring it the long way
  // round charges a lap's worth of speed for a couple of minutes of running.
  //
  // It deliberately does NOT apply to the backward penalty. `along` has a second
  // job besides locating a fix: it is the run's progress, and `distTotal`, the
  // profile and the forecast all read it as a distance from the start rather than
  // a position on a circle. Letting the wrap be free there makes the last ping of
  // a loop as happy to report 3 m as 28,594 — the same patch of ground, and the
  // difference between a finished race and one that never began. So crossing the
  // junction stays a real cost, paid on the reading the rest of the app uses.
  const moved = Math.abs(loop
    ? (d < -loop / 2 ? d + loop : d > loop / 2 ? d - loop : d)
    : d);

  return (
    // The route between two points cannot be shorter than the straight line
    // between them. This is the term that kills teleporting, and the only one
    // charged at full rate, because it is a fact about two GPS fixes rather than
    // an assumption about a runner: a candidate 25 km along from the last one,
    // when the two fixes are 858 m apart, is charged 24 km and never wins again.
    // It replaces the old forward/backward asymmetry outright.
    Math.max(0, chord - 2 * CONFIG.snapSigmaM - moved)
    // Nor may a leg imply a speed nobody could hold. Soft — see the config note.
    + CONFIG.snapSpeedPenalty * Math.max(0, moved - vmax * dt)
    // And forwards is preferred, just enough to break a tie.
    + CONFIG.snapBackPenalty * Math.max(0, -d)
  );
}

/**
 * The last vertex of the course, in the shape of a candidate.
 *
 * `perp` is the true distance from the raw fix, because that is what the tooltip
 * and the dashed link to the real position both need — a finish taken 400 m from
 * the line should say so. It is `forced`, so the trellis may not weigh it against
 * anything: an ordinary candidate that far out would lose to the off-course state,
 * and a finish is not a candidate, it is the device asserting the course is done.
 */
function courseEnd(course, point) {
  const { path, proj } = course;
  const end = path[path.length - 1];
  return {
    along: course.length,
    // Measured the same way `buildCourse` measures the start/finish gap.
    perp: Math.hypot(proj.x(point.lon) - proj.x(end.lon), proj.y(point.lat) - proj.y(end.lat)),
    lon: end.lon,
    lat: end.lat,
    ele: end.ele,
    forced: true
  };
}

/**
 * The candidate places one ping could be — the geometry, and nothing else.
 *
 * Deliberately free of history, which is what lets the result be cached per ping
 * and reused forever while the CHOICE among them is remade on every load.
 *
 * `is_finish` is the exception: it collapses to a single candidate at the end of
 * the course, and `CONFIG.snapMeters` does not apply. For an ordinary ping, being
 * beyond the threshold is evidence the phone isn't on the route, and leaving the
 * fix where it is says so honestly. A finish is not evidence — it is an assertion
 * by the device that the course is done — so it is pinned whatever the geometry
 * says. Forcing it as the ping's ONLY candidate rather than bypassing the trellis
 * is what makes the pings around it be reconciled with it instead of ignoring it.
 */
export function candidatesFor(course, point) {
  return point.is_finish ? [courseEnd(course, point)] : courseCandidates(course, point.lon, point.lat);
}

/** A cache that will match nothing — the shape `snapAll` expects when starting over. */
function emptyCache(course, start, maxSpeed) {
  return { courseSha: course.sha, snapMeters: CONFIG.snapMeters, start, maxSpeed, byName: {} };
}

/**
 * Viterbi over the whole run.
 *
 * Each ping contributes its candidates plus ONE off-course state, which is the
 * escape hatch that makes a lone bad fix survivable. That state carries the
 * previous position, time and raw coordinate forward untouched, so the ping after
 * an outlier is measured from the last fix that was actually believed — not from
 * the outlier, and not from a stale position paired with a fresh clock. Getting
 * that pairing wrong is subtle and expensive: measuring the chord from the
 * skipped ping instead of the last good one falsely rejects the fixes on the far
 * side of every gap.
 *
 * @returns {Array<object|null>} one snap per point, positionally
 */
function viterbi(course, points, candidates, vmax) {
  const { proj } = course;
  const loop = course.closed ? course.length : 0;
  const trellis = [];
  let prev = null;

  for (let i = 0; i < points.length; i++) {
    // `null` is the off-course state. It goes last so that on an exact tie a real
    // place on the course wins, and it is withheld entirely from a forced finish,
    // which has no business being second-guessed on distance.
    const forced = candidates[i].some(c => c.forced);
    const states = forced ? candidates[i] : [...candidates[i], null];

    // This ping's own place in the metre plane, hoisted out of the inner loop —
    // it is the same for every pair of states considered below.
    const px = proj.x(points[i].lon);
    const py = proj.y(points[i].lat);

    const layer = states.map(cand => {
      const emit = cand ? cand.perp : CONFIG.snapOffCourseCost;

      // The first ping has no history, so a loop's junction is decided by the only
      // thing that distinguishes its two candidates: one of them is the start. A
      // faint preference for a low `along` is enough, and it is the last surviving
      // trace of the old forward bias.
      if (!prev) {
        return {
          cand,
          along: cand ? cand.along : 0,
          cost: emit + (cand ? 0.02 * cand.along : 0),
          from: -1,
          src: points[i],
          t: points[i].t
        };
      }

      let best = Infinity;
      let from = 0;
      for (let j = 0; j < prev.length; j++) {
        if (!Number.isFinite(prev[j].cost)) continue;
        let step = 0;
        if (cand) {
          const chord = Math.hypot(px - proj.x(prev[j].src.lon), py - proj.y(prev[j].src.lat));
          const dt = Math.max(1, (points[i].t - prev[j].t) / 1000);
          step = transition(cand.along - prev[j].along, chord, dt, vmax, loop);
        }
        const total = prev[j].cost + step;
        if (total < best) {
          best = total;
          from = j;
        }
      }

      return {
        cand,
        along: cand ? cand.along : prev[from].along,
        cost: best + emit,
        from,
        // An off-course ping is not evidence of anything, so it hands the previous
        // ping's position AND its clock straight through.
        src: cand ? points[i] : prev[from].src,
        t: cand ? points[i].t : prev[from].t
      };
    });

    trellis.push(layer);
    prev = layer;
  }

  if (!prev) return [];

  let at = 0;
  for (let i = 1; i < prev.length; i++) if (prev[i].cost < prev[at].cost) at = i;

  const out = new Array(points.length);
  for (let i = points.length - 1; i >= 0; i--) {
    const state = trellis[i][at];
    const c = state.cand;
    out[i] = c
      ? { along: c.along, lon: c.lon, lat: c.lat, ele: c.ele ?? null, off: c.perp }
      : null;
    at = state.from;
  }
  return out;
}

/**
 * Snaps a whole run, doing as little work as possible.
 *
 * The expensive half is projecting a fix onto the course, and every ping is
 * projected EXACTLY ONCE in its lifetime: its candidates are keyed by filename in
 * `cache.byName` and survive reloads through localStorage. The cheap half is
 * choosing among them, and that is redone from scratch on every call — which is
 * the point. It is how a snap made when a ping was the newest thing known gets
 * revised once forty minutes of later fixes have made it look absurd.
 *
 * Note what is NOT here any more: an invalidation for a backfilled ping. Under
 * the old greedy matcher a ping arriving out of order could not be scored against
 * a sequence that had already moved past it, so the only correct answer was to
 * throw everything away. Now it simply takes its place in the trellis in time
 * order and the whole path is refound around it, for the price of the one
 * projection it needs.
 *
 * Three things still invalidate the cached GEOMETRY, because each makes the
 * stored candidates themselves wrong rather than merely stale:
 *   - a different course file (`courseSha`),
 *   - a different threshold (`snapMeters`), which changes what was collected,
 *   - a different scheduled `start`, which changes which pings belong on the
 *     course at all. This one cannot be folded into `courseSha`: a tree entry's
 *     sha is a hash of the CONTENT, so renaming a GPX to move the gun from 09:00
 *     to 08:00 leaves the sha untouched.
 * `maxSpeed` rides along with them so a run that changes its ceiling is rescored,
 * though it costs only the Viterbi pass to honour it.
 *
 * @param {object}  course
 * @param {Array}   points  sorted oldest-first, as `buildPoints()` returns them
 * @param {object}  cache   the previous result; pass a stale or empty one freely
 * @param {object}  [opts]
 * @param {number|null} [opts.start] the gun, when the run's settings named one.
 * @param {number} [opts.maxSpeed] km/h ceiling, from `course_settings.json`.
 * @param {Function} [opts.candidates] injectable, for the tests.
 * @returns {{cache: object, snapped: number}}
 */
export function snapAll(course, points, cache, {
  start = null,
  maxSpeed = CONFIG.snapMaxSpeedKmh,
  candidates = candidatesFor
} = {}) {
  let next = cache;

  const stale = !next
    || next.courseSha !== course.sha
    || next.snapMeters !== CONFIG.snapMeters
    || (next.start ?? null) !== start
    || next.maxSpeed !== maxSpeed
    || !next.byName;

  if (stale) next = emptyCache(course, start, maxSpeed);

  const byName = { ...next.byName };
  let snapped = 0;

  // Before the gun: drawn where the GPS put it, placed nowhere on the course. A
  // fix taken in the start pen an hour early is metres from the route and would
  // snap to it perfectly — and then every distance, pace, climb and forecast built
  // on it would be counting a warm-up as race progress.
  //
  // This is the whole of the exclusion. `deriveStats`' distance and climb,
  // `buildForecast`, `interpolateAt` and both of the height strip's loops all key
  // on `snap`, so a ping without one is already invisible to every one of them;
  // nothing downstream has to learn what a gun is.
  //
  // Recorded as an explicit empty candidate list rather than skipped, for the same
  // reason an off-course ping is: a name missing from `byName` means "never seen",
  // and this one has been seen and decided about. It also has to count towards
  // `snapped`, or `show()` never persists the cache, the new `start` never reaches
  // the version tuple above, and every paint finds it stale and re-snaps the run.
  for (const point of points) {
    if (point.name in byName) continue;
    byName[point.name] = start !== null && point.t < start ? [] : candidates(course, point);
    snapped++;
  }

  // Mirror deletions, so a removed file doesn't keep a slot in the cache forever.
  const live = new Set(points.map(p => p.name));
  for (const name of Object.keys(byName)) if (!live.has(name)) delete byName[name];

  // A ping with no candidates at all — off-course, or before the gun — is left out
  // of the trellis entirely rather than given a state in it. Both mean the same
  // thing to Viterbi, and keeping them out means an hour in the start pen cannot
  // accumulate off-course cost that later argues against a real candidate.
  const racing = points.filter(p => byName[p.name]?.length);
  const path = viterbi(course, racing, racing.map(p => byName[p.name]), maxSpeed / 3.6);

  const snaps = {};
  for (const point of points) snaps[point.name] = null;
  racing.forEach((point, i) => { snaps[point.name] = path[i]; });

  return {
    cache: { courseSha: course.sha, snapMeters: CONFIG.snapMeters, start, maxSpeed, byName, snaps },
    snapped
  };
}

/** Hangs each cached snap off its point, in place. Cheap enough to redo on every paint. */
export function applySnaps(points, cache) {
  const snaps = cache?.snaps || {};
  for (const point of points) {
    const snap = snaps[point.name];
    if (snap) point.snap = snap;
    else delete point.snap;
  }
  return points;
}
