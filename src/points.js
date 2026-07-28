// Turns the name-keyed cache into the array the map draws.

/**
 * Sorts points oldest-first and annotates each with `k` — its position in the
 * time span, 0..1 — which is what the colour ramp reads.
 *
 * @param {Object} cache name -> point record
 * @returns {Array} sorted points, each with `k`
 */
export function buildPoints(cache) {
  const points = Object.values(cache).sort((a, b) => a.t - b.t);
  if (!points.length) return points;

  const first = points[0].t;
  const span = points[points.length - 1].t - first;

  // A single point (or several sharing one timestamp) is "newest" by definition.
  for (const p of points) p.k = span ? (p.t - first) / span : 1;

  return points;
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
