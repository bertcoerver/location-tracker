// Turns a parsed GPX into the geometry snapping and the profile need.
//
// Everything downstream works in METRES on a local plane, not in degrees. That
// single decision is what keeps the snapping loop cheap: distances become plain
// Pythagoras instead of haversine, and "within 500 m" is a comparison rather
// than a calculation.

import { CONFIG } from './config.js';

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON = 111320;

/**
 * Equirectangular projection about a fixed origin. Over a race — tens of
 * kilometres — the error against a proper geodesic is well under a metre, which
 * is an order of magnitude below GPS noise and two below the snap threshold.
 */
function projector(lat0, lon0) {
  const kx = M_PER_DEG_LON * Math.cos((lat0 * Math.PI) / 180);
  return {
    x: lon => (lon - lon0) * kx,
    y: lat => (lat - lat0) * M_PER_DEG_LAT,
    lon: x => lon0 + x / kx,
    lat: y => lat0 + y / M_PER_DEG_LAT
  };
}

/**
 * A uniform grid over the course's segments, so a snap looks at a handful of
 * candidates instead of all of them. Cell size is the snap threshold, which
 * means every segment that could possibly be in range lives in one of the nine
 * cells around the query point.
 *
 * A segment is registered in every cell its bounding box touches — segments are
 * short relative to a 500 m cell, so that's usually one or two.
 */
function gridIndex(xy, cell, breaks) {
  const buckets = new Map();
  const key = (cx, cy) => `${cx},${cy}`;

  for (let i = 0; i < xy.length / 2 - 1; i++) {
    if (breaks.has(i)) continue;    // the phantom hop between two track segments

    const x0 = xy[i * 2], y0 = xy[i * 2 + 1];
    const x1 = xy[i * 2 + 2], y1 = xy[i * 2 + 3];

    const cx0 = Math.floor(Math.min(x0, x1) / cell);
    const cx1 = Math.floor(Math.max(x0, x1) / cell);
    const cy0 = Math.floor(Math.min(y0, y1) / cell);
    const cy1 = Math.floor(Math.max(y0, y1) / cell);

    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const k = key(cx, cy);
        const bucket = buckets.get(k);
        if (bucket) bucket.push(i);
        else buckets.set(k, [i]);
      }
    }
  }

  return { cell, buckets, key };
}

/**
 * @param {object} parsed  from [gpx.js](gpx.js)
 * @param {string} sha     the blob SHA, so a cached snap knows which course it belongs to
 * @returns a course, or null if the GPX had no usable geometry.
 */
export function buildCourse(parsed, sha = null) {
  if (!parsed?.segments?.length) return null;

  // Segments stay separate for DRAWING, but distance-along runs across the whole
  // course in document order — a two-part course is still one race.
  const path = parsed.segments.flat();
  if (path.length < 2) return null;

  // Index of the pair that straddles a segment join. Distance still accumulates
  // across it, so `along` stays monotone, but nothing may SNAP to it: that line
  // isn't part of the course, it's just where one segment stops and the next
  // starts. Empty for the single-segment case, which is nearly all of them.
  const breaks = new Set();
  for (let i = 0, at = 0; i < parsed.segments.length - 1; i++) {
    at += parsed.segments[i].length;
    breaks.add(at - 1);
  }

  const lat0 = path.reduce((s, p) => s + p.lat, 0) / path.length;
  const lon0 = path.reduce((s, p) => s + p.lon, 0) / path.length;
  const proj = projector(lat0, lon0);

  const n = path.length;
  const xy = new Float64Array(n * 2);
  const cum = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    xy[i * 2] = proj.x(path[i].lon);
    xy[i * 2 + 1] = proj.y(path[i].lat);
    if (i) {
      const dx = xy[i * 2] - xy[i * 2 - 2];
      const dy = xy[i * 2 + 1] - xy[i * 2 - 1];
      cum[i] = cum[i - 1] + Math.hypot(dx, dy);
    }
  }

  const length = cum[n - 1];
  const first = path[0];
  const last = path[n - 1];
  const gap = Math.hypot(
    proj.x(last.lon) - proj.x(first.lon),
    proj.y(last.lat) - proj.y(first.lat)
  );

  const eles = parsed.hasElevation ? path.map(p => p.ele) : [];

  return {
    sha,
    name: parsed.name,
    segments: parsed.segments,
    waypoints: parsed.waypoints || [],
    hasElevation: Boolean(parsed.hasElevation),
    path,
    xy,
    cum,
    length,
    proj,

    /** Start and finish coincide — the case where `along` is genuinely ambiguous. */
    closed: gap <= CONFIG.loopMeters,

    minEle: eles.length ? Math.min(...eles) : 0,
    maxEle: eles.length ? Math.max(...eles) : 0,

    grid: gridIndex(xy, CONFIG.snapMeters, breaks)
  };
}

/** Bounding box of the course as [[minLon, minLat], [maxLon, maxLat]]. */
export function courseBounds(course) {
  const lons = course.path.map(p => p.lon);
  const lats = course.path.map(p => p.lat);
  return [
    [Math.min(...lons), Math.min(...lats)],
    [Math.max(...lons), Math.max(...lats)]
  ];
}

/**
 * Every place on the course within `maxPerp` metres of (lon, lat) — one
 * candidate per nearby segment.
 *
 * It returns ALL of them rather than just the closest, because on a circular
 * course the closest is not always the right one: at the start/finish junction
 * two candidates sit metres apart but half a lap apart in `along`. Choosing
 * between them needs history, which is [snap.js](snap.js)'s job.
 */
export function nearestOnCourse(course, lon, lat, maxPerp = CONFIG.snapMeters) {
  const { xy, cum, grid, proj } = course;
  const px = proj.x(lon);
  const py = proj.y(lat);

  const cx = Math.floor(px / grid.cell);
  const cy = Math.floor(py / grid.cell);

  const seen = new Set();
  const out = [];

  for (let ix = cx - 1; ix <= cx + 1; ix++) {
    for (let iy = cy - 1; iy <= cy + 1; iy++) {
      const bucket = grid.buckets.get(grid.key(ix, iy));
      if (!bucket) continue;

      for (const i of bucket) {
        if (seen.has(i)) continue;      // a segment can span several cells
        seen.add(i);

        const x0 = xy[i * 2], y0 = xy[i * 2 + 1];
        const dx = xy[i * 2 + 2] - x0;
        const dy = xy[i * 2 + 3] - y0;
        const len2 = dx * dx + dy * dy;

        // Duplicate consecutive vertices are common in exported tracks; treat a
        // zero-length segment as its start point rather than dividing by zero.
        const t = len2 ? clamp01(((px - x0) * dx + (py - y0) * dy) / len2) : 0;
        const qx = x0 + dx * t;
        const qy = y0 + dy * t;
        const perp = Math.hypot(px - qx, py - qy);
        if (perp > maxPerp) continue;

        const a = course.path[i];
        const b = course.path[i + 1];
        out.push({
          along: cum[i] + Math.sqrt(len2) * t,
          perp,
          lon: proj.lon(qx),
          lat: proj.lat(qy),
          ele: course.hasElevation ? a.ele + (b.ele - a.ele) * t : null
        });
      }
    }
  }

  return out;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
