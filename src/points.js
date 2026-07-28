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
