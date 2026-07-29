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
import { accent, course as courseColor, point as pointColor, surface } from './colors.js';
import { pointAt } from './course.js';
import { hoverTooltipHtml, tooltipHtml } from './layers.js';
import { clampLeft, createPin } from './pin.js';
import { latestOf, posOf } from './points.js';
import { interpolateAt } from './stats.js';

// Room above the terrain for the waypoint labels.
const PAD_TOP = 14;
// Room below the terrain for the distance axis and its labels.
const PAD_BOTTOM = 22;
// Breathing room at both ends, so the start and the finish of the course — the
// two most interesting bits of it — aren't half off the edge of the canvas.
const PAD_LEFT = 14;
const PAD_RIGHT = 14;

/** How close the cursor has to get to a dot, in pixels, to pick it up. */
const HIT_RADIUS = 14;

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
 * Box blur over a column series, for drawing only.
 *
 * A per-pixel maximum is a faithful summary but an ugly line: consecutive
 * columns come from different GPS samples, so a flat road arrives as a picket
 * fence. Averaging a few columns together turns that back into terrain.
 *
 * Edges clamp — the window shrinks rather than reaching past the ends — because
 * the alternative (treating off-array as zero) drags the start and finish of the
 * course down towards sea level, which is a visible lie at both ends.
 *
 * Deliberately NOT folded into `columns()`: that stays the honest min/max, and
 * this is a drawing decision applied on top of it.
 *
 * @param {ArrayLike<number>} values
 * @param {number} radius columns either side; 0 is the identity.
 */
export function smooth(values, radius) {
  const n = values.length;
  const r = Math.floor(radius);
  if (r < 1 || n === 0) return Float64Array.from(values);

  // Prefix sums, so the cost is independent of the radius and there is no
  // window to slide in and out of the array's ends incorrectly.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];

  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - r);
    const hi = Math.min(n - 1, i + r);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }

  return out;
}

/**
 * The snapped ping nearest a point on the strip, or null if none is close enough.
 *
 * Pure and canvas-free so the hit geometry is testable — getting this subtly
 * wrong shows up as a tooltip for the neighbouring dot, which is the kind of bug
 * that survives a visual check.
 *
 * Unsnapped pings are not candidates: they have no distance along the course, so
 * they aren't drawn here at all.
 *
 * @param {Array}  points sorted oldest-first
 * @param {object} course
 * @param {object} scale  from `scaleFor`
 * @param {number} px,py  cursor position in canvas pixels
 */
export function hitTest(points, course, scale, px, py, radius = HIT_RADIUS) {
  let best = null;
  let bestD = radius * radius;

  for (const p of points) {
    if (!p.snap) continue;
    const dx = scale.x(p.snap.along) - px;
    const dy = scale.y(p.snap.ele ?? elevationAt(course, p.snap.along)) - py;
    const d = dx * dx + dy * dy;
    // `<=` so that among dots at the same spot — a stationary phone produces a
    // pile of them — the newest wins, which is the one the eye is on top of.
    if (d <= bestD) { bestD = d; best = p; }
  }

  return best;
}

/**
 * How wide the strip wants to be, in CSS pixels, for a course of this length.
 *
 * The chart used to be exactly as wide as the window, which quietly made the
 * x-axis mean something different for every course: 150 km and 2 km got the same
 * pixels, so on the long one a climb worth twenty minutes of somebody's day was
 * three pixels of noise. A floor on pixels-per-kilometre gives distance a fixed
 * scale instead, and the strip scrolls when that runs past the window.
 *
 * `profileMinWidth` still wins for anything short — a 3 km course drawn 72 px
 * wide would be honouring the rule and showing nothing.
 *
 * @param {object|null} course
 * @returns {number} CSS pixels
 */
export function stripWidth(course) {
  if (!course?.length) return CONFIG.profileMinWidth;
  return Math.max(CONFIG.profileMinWidth, (course.length / 1000) * CONFIG.profilePxPerKm);
}

/**
 * The distance -> x and elevation -> y mappings for a strip of this size.
 *
 * The single place that knows about the strip's padding: everything that draws
 * goes through `x` and `y`, so the margins and the axis gutter can't be applied
 * in one place and forgotten in another.
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

  const tall = Math.max(1, height - PAD_TOP - PAD_BOTTOM);
  const wide = Math.max(1, width - PAD_LEFT - PAD_RIGHT);

  return {
    lo: mid - span / 2,
    hi: top,
    /** Left edge of the plot, and how many pixel columns wide it is. */
    plotLeft: PAD_LEFT,
    plotWidth: wide,
    /** The y the terrain sits on — the axis lives below it. */
    floor: height - PAD_BOTTOM,
    x: d => PAD_LEFT + (course.length > 0 ? (d / course.length) * wide : 0),
    y: ele => PAD_TOP + ((top - ele) / span) * tall,
    /**
     * Inverse of x, for turning a mouse position back into a distance.
     * Clamped, because the cursor can now sit in the margins and a negative
     * distance along the course is not a thing.
     */
    distanceAt: px => {
      if (course.length <= 0) return 0;
      const d = ((px - PAD_LEFT) / wide) * course.length;
      return d < 0 ? 0 : d > course.length ? course.length : d;
    }
  };
}

/**
 * Nicely-rounded distances to mark on the x-axis: the coarsest step on the
 * 1 / 2 / 5 x 10^n ladder that still leaves `minSpacingPx` between ticks.
 *
 * The ladder rather than "length / 8" because a tick at 1,104 m is not a
 * landmark. The point of the axis is to let you tie a bump on the profile to a
 * distance you can hold in your head.
 *
 * @returns {number[]} always starting at 0 and never past `length`.
 */
export function axisTicks(length, plotWidth, minSpacingPx = 60) {
  if (!(length > 0) || !(plotWidth > 0)) return [0];

  const perPixel = length / plotWidth;
  const wanted = perPixel * minSpacingPx;

  let step = 0;
  for (let power = -1; power <= 9 && !step; power++) {
    for (const mult of [1, 2, 5]) {
      const candidate = mult * 10 ** power;
      if (candidate >= wanted) { step = candidate; break; }
    }
  }
  if (!step) return [0];

  const out = [];
  // `i * step` rather than accumulating, so the last tick of a long course
  // isn't a float's-worth short of where it belongs.
  for (let i = 0; i * step <= length + 1e-6; i++) out.push(i * step);
  return out;
}

/**
 * An axis label: "0", "500 m", "2 km", "1.5 km". At most one decimal, which is
 * all the 1/2/5 ladder can produce.
 */
export function tickLabel(m) {
  if (m === 0) return '0';
  return m < 1000 ? `${Math.round(m)} m` : `${Math.round(m / 100) / 10} km`;
}

/**
 * Elevation of the course at a given distance along it.
 *
 * Kept as its own name because that is what the drawing code is asking for, but
 * the search itself lives in [course.js](course.js) alongside the other two
 * questions with the same answer.
 */
export function elevationAt(course, distance) {
  return pointAt(course, distance).ele;
}

/**
 * @param {HTMLElement} root  the `#profile` panel
 */
export function createProfile(root, {
  onHover = () => {}, onSelect = () => {}, onScrub = () => {}
} = {}) {
  const scroller = root.querySelector('#profile-scroll');
  const canvas = root.querySelector('#profile-canvas');
  // Outside the panel: the strip has `overflow: hidden`, so a tooltip parented
  // to it would be clipped to a 112 px band.
  const tip = document.getElementById('profile-tip');
  const pin = createPin();
  const ctx = canvas.getContext('2d');

  let course = null;
  let points = [];
  let hover = null;      // distance in metres under the cursor, or null
  // The pinned point, from a click in either view. While one is held, hovering
  // is suspended everywhere: the user has said which point they want to read,
  // and a crosshair chasing the cursor across it is just noise.
  let selection = null;
  // Whether the cursor is on the strip itself. The map can also drive `hover`,
  // and without this the two would overwrite each other on every mouse move —
  // whoever the pointer is actually over has to win.
  let owned = false;
  // Mid-drag: the pinned point is being slid along the course. Nothing else may
  // touch `hover` while this is true — the whole gesture is one long statement
  // about where the selection is.
  let dragging = false;
  // A drag ends with a `click`, and the click handler's job is to toggle the pin
  // off. Without this flag, letting go of a point you had just dragged would put
  // it down — the one thing the gesture must not do.
  //
  // Set only once the point has actually MOVED. A press on the pinned point that
  // goes nowhere is not a drag, it is the click that puts it down, and swallowing
  // that would take the toggle away from every pinned point on the strip.
  let justDragged = false;
  // Which optional layers the panel's toggles have switched on. The waypoint
  // one governs both views, so a feed station is either shown in both or in
  // neither rather than only on the map.
  let layers = { waypoints: true, raw: true };

  // The axis ink, read from the page's own palette once. `draw` runs on every
  // pointermove, and a getComputedStyle in there is a style recalculation per
  // frame for a colour that doesn't change. Same bargain colors.js makes.
  let muted = null;
  const mutedInk = () => (muted ??=
    getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#888');

  /**
   * Show the strip only when there is something to show. A course without
   * elevation is a perfectly good course — it just has no profile, and half a
   * chart is worse than none.
   */
  function visible() {
    return Boolean(course?.hasElevation && course.length > 0);
  }

  /**
   * Whether there is more course off either end, which is what the fading edges
   * say now that there is no scrollbar to say it. Both ends are reported, so the
   * fade appears only where there is something to reach.
   */
  function syncFades() {
    const slack = scroller.scrollWidth - scroller.clientWidth;
    root.dataset.moreLeft = String(scroller.scrollLeft > 1);
    root.dataset.moreRight = String(scroller.scrollLeft < slack - 1);
  }

  function sync() {
    const on = visible();
    root.hidden = !on;
    // The map, legend and Follow button all read this to keep clear of the
    // strip; it's the single place that says how tall it is right now.
    const style = document.documentElement.style;
    style.setProperty('--profile-h', on ? `${CONFIG.profileHeight}px` : '0px');
    // How wide the canvas wants to be for THIS course. The CSS takes it as a
    // floor — `width: max(100%, var(--profile-min-w))` — so a short course on a
    // wide screen still fills the window, and a long one overflows and scrolls.
    style.setProperty('--profile-min-w', `${stripWidth(course)}px`);
    if (on) {
      draw();
      syncFades();
    }
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
    const { max } = columns(course, scale.plotWidth);
    // Fill and stroke share one smoothed series, so the shaded band can't drift
    // away from the line drawn on its edge.
    const ridge = smooth(max, CONFIG.profileSmoothPx);
    const line = courseColor();

    const left = scale.plotLeft;
    const right = left + scale.plotWidth;

    // The terrain: a filled band down to the axis, with the top edge drawn over
    // it so the skyline stays crisp.
    ctx.beginPath();
    ctx.moveTo(left, scale.floor);
    for (let i = 0; i < scale.plotWidth; i++) ctx.lineTo(left + i + 0.5, scale.y(ridge[i]));
    ctx.lineTo(right, scale.floor);
    ctx.closePath();
    ctx.fillStyle = `rgba(${line.join(',')}, 0.20)`;
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < scale.plotWidth; i++) {
      const y = scale.y(ridge[i]);
      if (i === 0) ctx.moveTo(left + 0.5, y); else ctx.lineTo(left + i + 0.5, y);
    }
    ctx.strokeStyle = `rgba(${line.join(',')}, 0.85)`;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    drawAxis(scale);
    if (layers.waypoints) drawWaypoints(scale);
    drawHover(scale, scale.floor, ridge);
    drawPoints(scale);
    placePin(scale);
  }

  /**
   * Keep the pinned tooltip over its point.
   *
   * Only when the pin was set from THIS view — the map owns it otherwise, and
   * two views writing one element is how you get a tooltip that flickers
   * between two positions. Called from `draw` and on scroll, because the canvas
   * slides under a fixed-position tooltip when the strip is panned.
   */
  function placePin(scale) {
    if (selection?.view !== 'profile' || selection.along === null) return;
    const rect = canvas.getBoundingClientRect();
    pin.place(
      rect.left + scale.x(selection.along),
      rect.top + scale.y(elevationAt(course, selection.along))
    );
  }

  /**
   * A distance axis under the terrain: a tick and a rounded label, and nothing
   * else — no baseline, no grid. It exists to tie a bump on the profile to a
   * number, not to be looked at.
   */
  function drawAxis(scale) {
    const ink = mutedInk();
    ctx.strokeStyle = ink;
    ctx.fillStyle = ink;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'top';

    for (const d of axisTicks(course.length, scale.plotWidth)) {
      const x = Math.round(scale.x(d)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, scale.floor);
      ctx.lineTo(x, scale.floor + 3);
      ctx.stroke();

      // The first and last labels are pulled inside the plot rather than
      // centred, or half of "0" hangs off the canvas.
      const text = tickLabel(d);
      const half = ctx.measureText(text).width / 2;
      const min = 1;
      const max = scale.plotLeft + scale.plotWidth + PAD_RIGHT - 2 * half - 1;
      ctx.fillText(text, Math.max(min, Math.min(max, x - half)), scale.floor + 5);
    }
  }

  /**
   * Waypoints as faint ticks with their names above them, so a feed station is
   * both findable and identifiable on the profile.
   *
   * Overlap is handled by the one rule that matters: a label that would run into
   * the previous one is dropped rather than drawn on top of it.
   */
  function drawWaypoints(scale) {
    if (!course.waypoints.length) return;
    const line = courseColor();
    ctx.strokeStyle = `rgba(${line.join(',')}, 0.35)`;
    ctx.fillStyle = `rgba(${line.join(',')}, 0.9)`;
    ctx.lineWidth = 1;
    ctx.font = '10px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textBaseline = 'top';

    const right = scale.plotLeft + scale.plotWidth;
    let taken = -Infinity;

    // Left to right, so "dropped because the one before it was there" is a rule
    // about reading order rather than about GPX document order.
    const ordered = course.waypoints
      .filter(w => w.along !== undefined && w.along !== null)
      .sort((a, b) => a.along - b.along);

    for (const w of ordered) {
      const x = Math.round(scale.x(w.along)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP);
      ctx.lineTo(x, scale.floor);
      ctx.stroke();

      const text = (w.name || w.sym || '').trim();
      if (!text) continue;
      const width = ctx.measureText(text).width;
      const at = x - width / 2;
      if (at < taken + 4 || at < scale.plotLeft - PAD_LEFT || at + width > right + PAD_RIGHT) continue;
      ctx.fillText(text, at, 1);
      taken = at + width;
    }
  }

  /**
   * The pings, at their distance along the course and the course's height there
   * — the same colours as the map, so the two views read as one dataset.
   * Unsnapped pings have no distance, so they simply aren't here.
   */
  function drawPoints(scale) {
    const latest = latestOf(points);
    const ring = surface();
    const fill = `rgb(${pointColor().join(',')})`;

    for (const p of points) {
      if (!p.snap) continue;
      const x = scale.x(p.snap.along);
      const y = scale.y(p.snap.ele ?? elevationAt(course, p.snap.along));
      const isLatest = latest && latest.name === p.name;

      ctx.beginPath();
      ctx.arc(x, y, isLatest ? 5 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = isLatest ? `rgb(${accent().join(',')})` : fill;
      ctx.fill();

      if (isLatest) {
        ctx.strokeStyle = `rgb(${ring.join(',')})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  function drawHover(scale, floor, ridge) {
    if (hover === null) return;
    const x = Math.round(scale.x(hover)) + 0.5;
    const ink = `rgb(${accent().join(',')})`;

    ctx.beginPath();
    ctx.moveTo(x, PAD_TOP - 4);
    ctx.lineTo(x, floor + 4);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 1;
    ctx.stroke();

    // A bead where the crosshair meets the terrain, read off the SMOOTHED series
    // the line was actually drawn from — the raw elevation there can be a couple
    // of metres away, and a bead floating beside its own line looks like a bug.
    // `ridge` is indexed in PLOT columns, so the left margin comes off first.
    const column = Math.round(scale.x(hover)) - scale.plotLeft;
    const ele = ridge[Math.min(ridge.length - 1, Math.max(0, column))];
    ctx.beginPath();
    ctx.arc(x, scale.y(ele), 3, 0, Math.PI * 2);
    ctx.fillStyle = ink;
    ctx.fill();
  }

  /**
   * Show one ping's tooltip above the strip.
   *
   * The markup is `tooltipHtml` — the very same function the map's tooltip uses
   * — so a ping reads identically whichever of the two you happen to hover.
   * Positioning is ours because deck.gl isn't involved here, and because the
   * canvas lives inside a horizontally scrolled container: canvas coordinates
   * are not page coordinates, so this works from the raw client position.
   */
  function showTip(html, clientX) {
    tip.innerHTML = html;
    tip.hidden = false;

    // Centred on the cursor, then pushed back inside the window — at the far
    // end of a scrolled strip the dot is near the edge and the tip would
    // otherwise hang off it. Same rule the pinned tooltip uses.
    tip.style.left = `${clampLeft(clientX, tip.offsetWidth, innerWidth)}px`;
  }

  function hideTip() {
    tip.hidden = true;
    tip.innerHTML = '';
  }

  /**
   * What is under the cursor: a ping if there's one close enough, otherwise the
   * ground itself. The two branches differ only in where the numbers come from,
   * so hovering and clicking ask this the same question and can't disagree
   * about the answer.
   *
   * @returns {{along: number, html: string, lat: number, lon: number}}
   */
  function readAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const scale = scaleFor(course, rect.width, rect.height);

    const hit = hitTest(points, course, scale, clientX - rect.left, clientY - rect.top);
    if (hit) {
      const latest = latestOf(points);
      // The DRAWN position, so that pinning the same ping from either view
      // means the same thing. The raw fix is inside the tooltip.
      const [lon, lat] = posOf(hit);
      return {
        along: hit.snap.along,
        html: tooltipHtml(hit, !!latest && latest.name === hit.name),
        lat,
        lon
      };
    }

    // Not on a ping, so describe the ground: how far in, how high, and —
    // interpolated between the pings either side — when the run was here.
    const along = scale.distanceAt(clientX - rect.left);
    const at = interpolateAt(points, course, along);
    return { along, html: hoverTooltipHtml(at), lat: at.lat, lon: at.lon };
  }

  /**
   * How far, in pixels, the pointer is from the pinned point — or null when
   * there is nothing to be near.
   *
   * A selection with no `along` has no place on a chart of distance, so it can
   * never be grabbed here. That is a ping the snapper left alone: it has a
   * position on the map and none on the course.
   */
  function grabDistance(clientX) {
    if (!visible() || selection?.along == null) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = scaleFor(course, rect.width, rect.height);
    return Math.abs(clientX - rect.left - scale.x(selection.along));
  }

  canvas.addEventListener('pointermove', event => {
    // Sliding the pinned point along the course. It reads through `readAt`, the
    // same function the hover and click paths use, so a scrub passing over a
    // ping shows that ping rather than the ground beneath it.
    if (dragging) {
      justDragged = true;
      const at = readAt(event.clientX, event.clientY);
      onScrub({ view: 'profile', html: at.html, lat: at.lat, lon: at.lon, along: at.along });
      return;
    }

    if (!visible()) return;

    // A pinned point is pickable: say so before it is picked up, since nothing
    // else on this strip can be dragged and there would otherwise be no hint.
    if (selection) {
      const near = grabDistance(event.clientX);
      canvas.style.cursor = near !== null && near <= CONFIG.dragGrabPx ? 'grab' : '';
      return;
    }
    canvas.style.cursor = '';
    owned = true;

    const at = readAt(event.clientX, event.clientY);
    hover = at.along;
    showTip(at.html, event.clientX);
    onHover(hover);
    draw();
  });

  /** Pick the pinned point up, if that is what this press is aimed at. */
  canvas.addEventListener('pointerdown', event => {
    const near = grabDistance(event.clientX);
    if (near === null || near > CONFIG.dragGrabPx) return;

    dragging = true;
    justDragged = false;
    root.dataset.dragging = 'true';
    // So the gesture keeps arriving here even when the pointer runs off the
    // canvas, which on a 112 px strip is most drags.
    canvas.setPointerCapture(event.pointerId);
    // And so the press doesn't start a text selection on the way past.
    event.preventDefault();
  });

  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    delete root.dataset.dragging;
    canvas.style.cursor = 'grab';
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  }

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /**
   * Pin what's under the cursor. Every click on the strip selects something —
   * a ping if there is one, the ground if there isn't — so there is nothing to
   * miss. Putting a selection down again is a click on the same point, or
   * Escape, or a click on empty map; main.js owns that rule.
   */
  canvas.addEventListener('click', event => {
    if (!visible()) return;
    // The click that ends a drag is the release, not a new choice. Swallow it
    // once — letting it through would toggle off the point just dragged.
    if (justDragged) {
      justDragged = false;
      return;
    }
    const at = readAt(event.clientX, event.clientY);
    onSelect({ view: 'profile', html: at.html, lat: at.lat, lon: at.lon, along: at.along });
  });

  scroller.addEventListener('scroll', () => {
    syncFades();
    // A fixed-position tooltip doesn't move with the canvas underneath it.
    if (selection?.view === 'profile') {
      placePin(scaleFor(course, canvas.clientWidth, canvas.clientHeight));
    }
  });

  /**
   * @param {PointerEvent} [event] present when this came from the pointer
   *   leaving something. Moving UP from the canvas into the tooltip has to be
   *   allowed, or its Google Maps link is unreachable — the tip sits directly
   *   above the strip, so on the way to the link the cursor leaves the canvas.
   */
  function leave(event) {
    if (event?.relatedTarget && tip.contains(event.relatedTarget)) return;
    owned = false;
    hideTip();
    // A pinned point outlives the cursor — that is the whole point of pinning
    // it — so the crosshair stays where the selection put it.
    if (selection) return;
    hover = null;
    onHover(null);
    draw();
  }

  canvas.addEventListener('pointerleave', leave);
  // Touch doesn't reliably deliver `pointerleave` — a tap elsewhere is how a
  // phone says "done", and without this the tip would stay up for good.
  canvas.addEventListener('pointercancel', leave);
  // And leaving the tooltip itself, for anywhere that isn't back on the canvas.
  tip.addEventListener('pointerleave', leave);
  document.addEventListener('pointerdown', event => {
    // The pin is exempt as well as the hover tip: clicking the Google Maps link
    // inside it must not be read as a click somewhere else.
    if (!canvas.contains(event.target) && !tip.contains(event.target) &&
        !pin.contains(event.target)) leave();
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
      hideTip();
      sync();
    },

    setPoints(next) {
      points = next;
      draw();
    },

    /**
     * Which optional layers are on, from the panel's toggles. Only `waypoints`
     * means anything here — the raw fixes have no place on a height profile,
     * which plots distance along the course rather than position.
     */
    setLayers(next) {
      layers = { ...layers, ...next };
      draw();
    },

    /**
     * The pinned point, or null. Told to BOTH views whichever one was clicked:
     * the one that owns it draws the tooltip, and the other still marks the
     * place, which is what makes a click in one view legible in the other.
     *
     * @param {import('./pin.js').Selection|null} next
     */
    setSelection(next) {
      selection = next;
      hideTip();      // no hover tooltip beside a pinned one
      owned = false;

      if (!selection) {
        pin.hide();
        hover = null;
        draw();
        return;
      }

      // The crosshair goes to the selection and stays there. An unsnapped ping
      // has no place on a chart of distance along the course, so there is
      // nothing to mark — the map still shows it.
      hover = selection.along;
      // Only this view's own selections get a tooltip here; the map owns its.
      if (selection.view === 'profile') pin.show(selection.html);
      draw();
    },

    /**
     * Mark a distance along the course, or clear it with null. This is the map
     * pointing at the strip.
     *
     * Ignored while the cursor is on the strip itself: the pointer is only ever
     * in one place, and whichever view it is over owns the crosshair.
     *
     * @param {number|null} along metres along the course.
     */
    setHover(along) {
      // A selection outranks a hover from either view — it is the point the
      // user asked to keep looking at.
      if (owned || selection || !visible()) return;
      const next = along === null || along === undefined ? null : along;
      if (next === hover) return;

      hover = next;
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

      const scale = scaleFor(course, canvas.clientWidth, canvas.clientHeight);
      const target = scale.x(latest.snap.along) - scroller.clientWidth / 2;
      const max = canvas.clientWidth - scroller.clientWidth;
      if (max > 0) scroller.scrollLeft = Math.max(0, Math.min(max, target));
      syncFades();
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
