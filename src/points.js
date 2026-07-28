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

/** Bounding box as [[minLon, minLat], [maxLon, maxLat]]. */
export function boundsOf(points) {
  const lons = points.map(p => p.lon);
  const lats = points.map(p => p.lat);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)]
  ];
}
