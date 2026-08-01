// Turns the name-keyed cache into the array the map draws.

/**
 * Sorts points oldest-first — which is the order everything downstream assumes,
 * the snapper most of all: it scores each ping against where the previous one
 * ended up, so out of order it would give a different (wrong) answer.
 *
 * @param {Object} cache name -> point record
 * @returns {Array} sorted points
 */
export function buildPoints(cache) {
  return Object.values(cache).sort((a, b) => a.t - b.t);
}

export function latestOf(points) {
  return points.length ? points[points.length - 1] : null;
}

/**
 * The pings, and only the pings.
 *
 * A photograph that recorded its own coordinates is a fix for the purposes of
 * distance, pace and climb — it happened, at a place, at a time, and the run
 * genuinely passed through it. It is NOT a fix for the four purposes below, and
 * each one breaks differently:
 *
 *   the camera fit (`fitView`), because a photo that came out of the wrong folder
 *     is still 350 km away and would open the map on a continent;
 *   the poll schedule (`main.js`), because `nextPollMs` reads the newest fix's
 *     battery, and a photograph does not report one;
 *   the finish (`finishOf`), because that reads the LAST element's `is_finish`,
 *     so a photo taken after the line silently un-finishes a finished race;
 *   the dots (`pointLayers`), because a media POI draws its own thumbnail and an
 *     orange dot underneath it would be the same mark claimed twice.
 *
 * Allocation-free for the overwhelmingly common case of a run with no media at
 * all, which is why the `some` is worth the line.
 */
export function fixesOf(points) {
  return points.some(p => p.kind === 'media') ? points.filter(p => p.kind !== 'media') : points;
}

/**
 * The run's finish, if it has one — the ping the phone marked as its last.
 *
 * Deliberately only the NEWEST point, not `points.some(...)`: a finish with
 * pings after it is a phone that was restarted, and the run is plainly going
 * again. Reading it off the last element is also what stops the panel and the
 * poll schedule ever disagreeing, since both are looking at the same point.
 */
export function finishOf(points) {
  const last = latestOf(points);
  return last?.is_finish ? last : null;
}

/**
 * Where a point is DRAWN: its place on the course if it snapped there, otherwise
 * the raw fix. Everything that positions a point goes through this — layers, the
 * camera, the fit — so "focus on the snapped points" holds for the map as a
 * whole and not just the dots.
 */
export function posOf(p) {
  return p.snap ? [p.snap.lon, p.snap.lat] : [p.lon, p.lat];
}

/** Bounding box as [[minLon, minLat], [maxLon, maxLat]]. */
export function boundsOf(points) {
  const pos = points.map(posOf);
  const lons = pos.map(p => p[0]);
  const lats = pos.map(p => p[1]);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)]
  ];
}

/** The smallest box containing both, ignoring either if it's absent. */
export function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return [
    [Math.min(a[0][0], b[0][0]), Math.min(a[0][1], b[0][1])],
    [Math.max(a[1][0], b[1][0]), Math.max(a[1][1], b[1][1])]
  ];
}
