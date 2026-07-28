// The height profile strip along the bottom of the page.
//
// Canvas 2D rather than deck.gl: this is a chart, not a map, and it wants a
// pixel-space x-axis (distance along the course) that has nothing to do with
// the map's projection. It also has to stay cheap — it redraws on every new
// ping and on every resize.
//
// The two functions that decide what gets drawn are pure and exported, so the
// arithmetic is tested without a canvas anywhere near it.

import { CONFIG } from './config.js';
import { accent, course as courseColor, rampAt, surface } from './colors.js';
import { fmtDistance } from './layers.js';
import { latestOf } from './points.js';

const PAD_TOP = 10;
const PAD_BOTTOM = 14;

/**
 * Collapse the course's elevations into one min/max pair per pixel column.
 *
 * This is what keeps a 10,000-point route as cheap to draw as a 300-point one:
 * a single pass over the vertices, and the drawing loop then runs over `width`
 * columns regardless. Columns the course doesn't reach (it can't happen, but
 * floating point at the edges can) inherit their neighbour rather than showing
 * a gap.
 *
 * @returns {{min: Float64Array, max: Float64Array}} both `width` long.
 */
export function columns(course, width) {
  const w = Math.max(1, Math.floor(width));
  const min = new Float64Array(w).fill(Infinity);
  const max = new Float64Array(w).fill(-Infinity);

  const { cum, path, length } = course;
  for (let i = 0; i < path.length; i++) {
    const col = length > 0
      ? Math.min(w - 1, Math.floor((cum[i] / length) * w))
      : 0;
    const ele = path[i].ele;
    if (ele < min[col]) min[col] = ele;
    if (ele > max[col]) max[col] = ele;
  }

  // Carry the last real value forward across any column the sampling skipped,
  // which happens when the course has fewer vertices than the strip has pixels.
  let lastMin = min[0] === Infinity ? course.minEle : min[0];
  let lastMax = max[0] === -Infinity ? course.maxEle : max[0];
  for (let i = 0; i < w; i++) {
    if (min[i] === Infinity) min[i] = lastMin; else lastMin = min[i];
    if (max[i] === -Infinity) max[i] = lastMax; else lastMax = max[i];
  }

  return { min, max };
}

/**
 * The distance -> x and elevation -> y mappings for a strip of this size.
 *
 * Elevation gets a floor of 20 m of range, so a pancake-flat course doesn't get
 * its centimetre of noise amplified into a mountain range.
 */
export function scaleFor(course, width, height) {
  const lo = course.minEle;
  const hi = course.maxEle;
  const mid = (lo + hi) / 2;
  const span = Math.max(hi - lo, 20);
  const top = mid + span / 2;

  const plot = Math.max(1, height - PAD_TOP - PAD_BOTTOM);

  return {
    lo: mid - span / 2,
    hi: top,
    x: d => (course.length > 0 ? (d / course.length) * width : 0),
    y: ele => PAD_TOP + ((top - ele) / span) * plot,
    /** Inverse of x, for turning a mouse position back into a distance. */
    distanceAt: px => (course.length > 0 ? (px / width) * course.length : 0)
  };
}

/** Elevation of the course at a given distance along it, by linear search hint. */
export function elevationAt(course, distance) {
  const { cum, path } = course;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= distance) lo = mid; else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t = span > 0 ? (distance - cum[lo]) / span : 0;
  return path[lo].ele + (path[hi].ele - path[lo].ele) * t;
}

/**
 * @param {HTMLElement} root  the `#profile` panel
 */
export function createProfile(root) {
  const scroller = root.querySelector('#profile-scroll');
  const canvas = root.querySelector('#profile-canvas');
  const readout = root.querySelector('#profile-readout');
  const ctx = canvas.getContext('2d');

  let course = null;
  let points = [];
  let hover = null;      // distance in metres under the cursor, or null

  /**
   * Show the strip only when there is something to show. A course without
   * elevation is a perfectly good course — it just has no profile, and half a
   * chart is worse than none.
   */
  function visible() {
    return Boolean(course?.hasElevation && course.length > 0);
  }

  function sync() {
    const on = visible();
    root.hidden = !on;
    // The map, legend and Follow button all read this to keep clear of the
    // strip; it's the single place that says how tall it is right now.
    const style = document.documentElement.style;
    style.setProperty('--profile-h', on ? `${CONFIG.profileHeight}px` : '0px');
    style.setProperty('--profile-min-w', `${CONFIG.profileMinWidth}px`);
    if (on) draw();
  }

  function draw() {
    if (!visible()) return;

    // CSS decides the width — it's `max(100%, profileMinWidth)`, so on a phone
    // the canvas is wider than the window and the scroller pans it.
    const width = Math.max(1, Math.round(canvas.clientWidth));
    const height = Math.max(1, Math.round(canvas.clientHeight));
    const dpr = globalThis.devicePixelRatio || 1;

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const scale = scaleFor(course, width, height);
    const { min, max } = columns(course, width);
    const line = courseColor();

    // The terrain: a filled band from the column's low to the strip's floor,
    // with the high edge drawn on top so ridges stay crisp.
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x < width; x++) ctx.lineTo(x + 0.5, scale.y(max[x]));
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = `rgba(${line.join(',')}, 0.20)`;
    ctx.fill();

    ctx.beginPath();
    for (let x = 0; x < width; x++) {
      const y = scale.y(max[x]);
      if (x === 0) ctx.moveTo(0.5, y); else ctx.lineTo(x + 0.5, y);
    }
    ctx.strokeStyle = `rgba(${line.join(',')}, 0.85)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    drawWaypoints(scale, height);
    drawHover(scale, width, height);
    drawPoints(scale);
  }

  /** Waypoints as faint ticks, so a feed station is findable on the profile too. */
  function drawWaypoints(scale, height) {
    if (!course.waypoints.length) return;
    const line = courseColor();
    ctx.strokeStyle = `rgba(${line.join(',')}, 0.35)`;
    ctx.lineWidth = 1;

    for (const w of course.waypoints) {
      if (w.along === undefined || w.along === null) continue;
      const x = Math.round(scale.x(w.along)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP);
      ctx.lineTo(x, height - PAD_BOTTOM);
      ctx.stroke();
    }
  }

  /**
   * The pings, at their distance along the course and the course's height there
   * — the same ramp as the map, so the two views read as one dataset. Unsnapped
   * pings have no distance, so they simply aren't here.
   */
  function drawPoints(scale) {
    const latest = latestOf(points);
    const ring = surface();

    for (const p of points) {
      if (!p.snap) continue;
      const x = scale.x(p.snap.along);
      const y = scale.y(p.snap.ele ?? elevationAt(course, p.snap.along));
      const isLatest = latest && latest.name === p.name;

      ctx.beginPath();
      ctx.arc(x, y, isLatest ? 5 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${(isLatest ? accent() : rampAt(p.k)).join(',')})`;
      ctx.fill();

      if (isLatest) {
        ctx.strokeStyle = `rgb(${ring.join(',')})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  function drawHover(scale, width, height) {
    if (hover === null) return;
    const x = Math.round(scale.x(hover)) + 0.5;
    if (x < 0 || x > width) return;

    ctx.beginPath();
    ctx.moveTo(x, PAD_TOP - 4);
    ctx.lineTo(x, height - PAD_BOTTOM + 4);
    ctx.strokeStyle = `rgb(${accent().join(',')})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  canvas.addEventListener('pointermove', event => {
    if (!visible()) return;
    const rect = canvas.getBoundingClientRect();
    const scale = scaleFor(course, rect.width, rect.height);
    hover = scale.distanceAt(event.clientX - rect.left);
    readout.textContent = `${fmtDistance(hover)} · ${Math.round(elevationAt(course, hover))} m`;
    draw();
  });

  canvas.addEventListener('pointerleave', () => {
    hover = null;
    readout.textContent = '';
    draw();
  });

  addEventListener('resize', sync);

  return {
    /** @param {object|null} next the run's course, or null when it has none. */
    setCourse(next) {
      course = next;
      // The along-distance of each waypoint is only knowable once there's a
      // course to measure against, and it never changes after that.
      if (course) locateWaypoints(course);
      hover = null;
      readout.textContent = '';
      sync();
    },

    setPoints(next) {
      points = next;
      draw();
    },

    /**
     * Keep the newest ping in view on a narrow screen, where the strip is wider
     * than the window and most of the course is off to one side.
     */
    scrollToLatest() {
      if (!visible()) return;
      const latest = latestOf(points);
      if (!latest?.snap) return;

      const x = (latest.snap.along / course.length) * canvas.clientWidth;
      const target = x - scroller.clientWidth / 2;
      const max = canvas.clientWidth - scroller.clientWidth;
      if (max > 0) scroller.scrollLeft = Math.max(0, Math.min(max, target));
    }
  };
}

/**
 * Give each waypoint its distance along the course, by finding the nearest
 * vertex. Approximate on purpose — a tick mark a metre out is invisible, and
 * this saves running the full projection machinery for decorations.
 */
function locateWaypoints(course) {
  for (const w of course.waypoints) {
    if (w.along !== undefined) continue;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < course.path.length; i++) {
      const p = course.path[i];
      const d = (p.lat - w.lat) ** 2 + (p.lon - w.lon) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    }
    w.along = course.cum[best];
  }
}
