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

/** Straight pieces per ping-to-ping span. Twelve is well past the point where
 *  the curve stops looking like a chain of chords at any zoom this map reaches,
 *  and a run is hundreds of pings at most — the whole path costs microseconds. */
const SMOOTH_STEPS = 12;

/**
 * A line through the pings, for a run that has no course to draw instead.
 *
 * Without a GPX the map has only the dots, and a dot every five minutes on a
 * trail is a constellation: it says where the runner WAS but not which way they
 * went, and on a switchback it reads in the wrong order. A line through them says
 * the one thing the dots can't. It is drawn dashed — see `traceLayers` — because
 * unlike a course this is not the route: nobody surveyed the ground between two
 * pings, and the line is the map's guess at it.
 *
 * Smoothed with a centripetal Catmull-Rom spline, which is the cheap way to get a
 * curve that (a) passes THROUGH every ping rather than near it — these are
 * measurements, and a curve that misses them would be inventing a position where
 * one is known — and (b) cannot loop or cusp, which the uniform variant of the
 * same spline does the moment two pings sit close together and a third is far
 * off. That is not a hypothetical on a run: a stop at an aid station puts three
 * fixes inside twenty metres and the next one a kilometre away.
 *
 * Consecutive duplicate positions are dropped first, because a stationary phone
 * genuinely repeats a coordinate and the spline's parameterisation divides by the
 * gap between knots. The ends get a mirrored phantom point each, so the curve
 * starts and finishes at the first and last ping instead of a step inside them.
 *
 * Every point given is a knot, photographs included: what reaches the points
 * array is a picture that recorded its own coordinates and its own moment, which
 * is a reading of where the runner was and not a guess at it. `traceLayers` says
 * more about why this is the one caller that doesn't reach for `fixesOf`.
 *
 * @param {Array} points sorted oldest-first, as from `buildPoints`.
 * @returns {Array<[number, number]>} lon/lat, or [] when there's nothing to join.
 */
export function tracePath(points) {
  const knots = [];
  for (const p of points) {
    const at = posOf(p);
    const last = knots[knots.length - 1];
    if (!last || last[0] !== at[0] || last[1] !== at[1]) knots.push(at);
  }
  if (knots.length < 2) return [];

  // Degrees of longitude are shorter than degrees of latitude everywhere but the
  // equator, and the spline's knot spacing is a DISTANCE — left in raw degrees it
  // would treat an east-west leg as longer than the identical north-south one and
  // curve accordingly. One cosine, taken at the first fix, is plenty over a race.
  const kx = Math.cos((knots[0][1] * Math.PI) / 180);
  // Reflections of the second and second-last points, so the first and last spans
  // are drawn by the same code as every other one.
  const phantom = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1]];
  const pts = [phantom(knots[0], knots[1]), ...knots,
    phantom(knots[knots.length - 1], knots[knots.length - 2])];

  // Centripetal: the exponent on each span's length is 1/2, hence the sqrt of a
  // hypotenuse. It is what rules out the loops and cusps described above.
  //
  // The `||` is belt and braces — consecutive knots are distinct by construction,
  // so the only way a span measures zero is two coordinates close enough for the
  // subtraction to underflow, and a knot that doesn't advance is a divide by zero
  // three lines further down.
  const knot = (t, a, b) => {
    const span = Math.sqrt(Math.hypot((b[0] - a[0]) * kx, b[1] - a[1]));
    return t + (span || Number.EPSILON);
  };

  const path = [knots[0]];
  for (let i = 1; i < pts.length - 2; i++) {
    const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
    const t0 = 0;
    const t1 = knot(t0, p0, p1);
    const t2 = knot(t1, p1, p2);
    const t3 = knot(t2, p2, p3);

    // Barry-Goldman: three nested linear blends, which is the non-uniform spline
    // written as repeated interpolation. Every denominator is a difference of
    // knots, and `knot` above guarantees each of those is non-zero.
    const mix = (a, b, ta, tb, t) => [
      ((tb - t) * a[0] + (t - ta) * b[0]) / (tb - ta),
      ((tb - t) * a[1] + (t - ta) * b[1]) / (tb - ta)
    ];

    for (let s = 1; s <= SMOOTH_STEPS; s++) {
      // The far end of the span is the ping itself rather than what six divisions
      // and a nested blend make of it. Same place to a millionth of a millimetre
      // either way — but exactly, and this is a measured position: the curve
      // should be able to say it passes THROUGH the fixes without a tolerance.
      if (s === SMOOTH_STEPS) { path.push(p2); break; }

      const t = t1 + ((t2 - t1) * s) / SMOOTH_STEPS;
      const a1 = mix(p0, p1, t0, t1, t);
      const a2 = mix(p1, p2, t1, t2, t);
      const a3 = mix(p2, p3, t2, t3, t);
      const b1 = mix(a1, a2, t0, t2, t);
      const b2 = mix(a2, a3, t1, t3, t);
      path.push(mix(b1, b2, t1, t2, t));
    }
  }

  return path;
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
