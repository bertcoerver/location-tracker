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
import { accent, course as courseColor, crew as crewColor, surface } from './colors.js';
import { pointAt } from './course.js';
import { glyph, inkOf, loadGlyphs } from './glyphs.js';
import { hoverTooltipHtml, tooltipHtml } from './layers.js';
import { clampLeft, createPin } from './pin.js';
import { latestOf, posOf } from './points.js';
import { positionAt } from './predict.js';
import { interpolateAt, originOf } from './stats.js';

// Room above the terrain for the waypoint labels.
const PAD_TOP = 14;
// Room below the terrain for the distance axis and its labels.
const PAD_BOTTOM = 22;
// Breathing room at both ends, so the start and the finish of the course — the
// two most interesting bits of it — aren't half off the edge of the canvas.
const PAD_LEFT = 14;
const PAD_RIGHT = 14;

/**
 * How close the cursor has to get to a dot, HORIZONTALLY, to pick it up.
 *
 * Wider than it was, because the old radius was a mouse's aim and a thumb has
 * none — see `hitTest` for why the vertical half of the test went away.
 */
const HIT_RADIUS = 18;

/**
 * How long the hover tooltip survives the cursor leaving the strip.
 *
 * The whole reason it survives at all is that its Google Maps link has to be
 * reachable, and reaching it means crossing off the canvas. See `leaveSoon`.
 */
const TIP_GRACE_MS = 320;

/**
 * How far a press has to travel before it counts as a drag rather than a tap.
 *
 * A finger held still on a screen still reports movement, and every pixel of
 * that used to be a drag — which swallowed the click that puts a pinned point
 * down, so on a phone a point could be pinned and then never dismissed by
 * tapping it again.
 */
const DRAG_SLOP_PX = 4;

/**
 * How big a drawn mark is on the strip, a side.
 *
 * Smaller than the map's, and that is the strip all over: 112 px tall with the
 * axis and the waypoint names already in it, so a mark has to be readable at a
 * glance and then get out of the way. No halo on any of them — this canvas owns
 * its own background, unlike the map, which sits on whatever imagery it is given.
 */
const MARK_PX = 15;

/**
 * How long after a tap has been dealt with a `click` is still assumed to belong
 * to that same tap rather than to a new one.
 *
 * A synthesised click follows its touch within a frame or two; nobody taps the
 * same strip twice inside a quarter of a second.
 */
const GHOST_CLICK_MS = 250;

/**
 * How far the "probably here, now" marker has to slide before the strip is
 * redrawn for it. Below half a pixel nothing on the screen would change, and the
 * clock asks once a second forever.
 */
const MARKER_STEP_PX = 0.5;

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
 * **Horizontal distance only**, so each dot's target is a full-height column of the
 * chart rather than a disc around the dot itself. The strip's x-axis is distance and
 * its y-axis is height, which means the only question a press on it can be asking is
 * "which point on the course" — the height at that distance is not something anyone
 * chooses. Aiming at a 4 px dot that also sits at whatever altitude the terrain
 * happens to have was two degrees of freedom for a one-dimensional question, and on a
 * phone it mostly missed.
 *
 * The cost is deliberate and known: hovering the terrain *between* two pings, which
 * gives the course's own tooltip, is now hard wherever the trail is dense. The pings
 * are the readings, and the ground between them is still reachable from the map.
 *
 * Unsnapped pings are not candidates: they have no distance along the course, so
 * they aren't drawn here at all.
 *
 * @param {Array}  points sorted oldest-first
 * @param {object} course
 * @param {object} scale  from `scaleFor`
 * @param {number} px,py  cursor position in canvas pixels
 *
 * `course` and `py` are both accepted and ignored — they are what the vertical half of
 * the test needed. Kept in the signature so that every caller goes on handing over the
 * whole cursor it actually has, and the day this wants the height back is a change in
 * this function and nowhere else.
 */
export function hitTest(points, course, scale, px, py, radius = HIT_RADIUS) {
  let best = null;
  let bestD = radius;

  for (const p of points) {
    if (!p.snap) continue;
    const d = Math.abs(scale.x(p.snap.along) - px);
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
 * Where to scroll a strip of `contentWidth` so that `x` lands in the middle of
 * the `viewportWidth` on screen.
 *
 * Pure, because "centred, but not past either end" is the whole of the rule and
 * the off-by-a-viewport version of it is invisible until a course is long enough
 * to need it. A strip that fits has nowhere to go: 0.
 */
export function centerScrollLeft(x, viewportWidth, contentWidth) {
  const max = contentWidth - viewportWidth;
  if (!(max > 0)) return 0;
  return Math.max(0, Math.min(max, x - viewportWidth / 2));
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
 * The DRAWN height at a distance along the course.
 *
 * Read off the smoothed column series the skyline was actually stroked from,
 * because the raw elevation there can be a couple of metres away from it — and a
 * mark floating beside its own line looks like a bug. Everything that has to sit
 * ON the terrain goes through this, so the crosshair's bead and the forecast
 * marker can't end up on two different lines.
 *
 * `ridge` is indexed in PLOT columns, so the left margin comes off the x first,
 * and the ends clamp: a distance at the very edge of the course rounds to a
 * column just past the array.
 *
 * @param {ArrayLike<number>} ridge from `smooth(columns(...).max, ...)`
 * @param {object} scale from `scaleFor`
 * @param {number} along metres from the start of the course
 */
export function ridgeAt(ridge, scale, along) {
  const column = Math.round(scale.x(along)) - scale.plotLeft;
  return ridge[Math.min(ridge.length - 1, Math.max(0, column))];
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
  // The run's pace model, and where it says the runner is AT THIS MOMENT —
  // `{ along, lo, hi }` in metres, or null when there is nothing to say. The
  // marker is the one thing on this strip that moves without any data arriving,
  // so it is kept here and refreshed from the clock rather than recomputed
  // inside `draw`, which runs on every pointermove.
  let forecast = null;
  let marker = null;
  // Sunrise and sunset, from `sunPois` — the same array the map draws, so a mark
  // here and a mark there are the same moment.
  let sun = [];
  // Photographs and clips, from `placeMedia` — again the very array the map is
  // given. The map draws each one's own thumbnail; there is no room for a picture
  // on a 112 px strip, so here they are one repeated camera mark saying only
  // "there is a photograph from this point of the course".
  let media = [];
  let hover = null;      // distance in metres under the cursor, or null
  // A pending dismissal of the hover tooltip, from the cursor having left the strip.
  // See `leaveSoon`.
  let leaveTimer = null;
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
  // Where the current drag was pressed, so `justDragged` can be about real
  // movement rather than about a fingertip's worth of noise. See `DRAG_SLOP_PX`.
  let dragFromX = 0;
  // Until when a `click` is to be read as the tail of a tap `endDrag` has already
  // answered, rather than as a new one. See `GHOST_CLICK_MS`.
  let ghostUntil = 0;
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

    // The terrain: a filled band down to the axis, with the top edge drawn over
    // it so the skyline stays crisp.
    //
    // Ground already covered is filled solidly and ground still to come faintly,
    // so the strip says at a glance how much race is left. The split is at the
    // newest ping — the same place the forecast is anchored, so the faint half is
    // exactly the half the marker and the ETAs are talking about.
    const reached = reachedColumn(scale);
    fillTerrain(scale, ridge, line, 0, reached, 0.20);
    fillTerrain(scale, ridge, line, reached, scale.plotWidth, 0.07);

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
    drawWaypoints(scale);
    drawSun(scale);
    // After the sun and before the crosshair: a camera sits on the terrain, so it
    // is part of the picture the crosshair and the pings are read against.
    drawMedia(scale, ridge);
    drawHover(scale, scale.floor, ridge);
    drawForecast(scale, ridge);
    drawPoints(scale);
    placePin(scale);
  }

  /**
   * The plot column the newest ping reached, which is where covered ground stops.
   *
   * The newest SNAPPED ping rather than the furthest one: this is a statement
   * about where the runner is, and on a course that doubles back the furthest
   * place they have been is not it. Without a course position — every ping off
   * the route — the whole strip counts as unreached, which is honest.
   */
  function reachedColumn(scale) {
    const latest = latestOf(points);
    if (!latest?.snap) return 0;
    const column = Math.round(scale.x(latest.snap.along)) - scale.plotLeft;
    return Math.max(0, Math.min(scale.plotWidth, column));
  }

  /** One span of terrain, filled. Split out so covered and remaining ground can
   *  be drawn at two weights from one smoothed series — two `ridge` reads would
   *  eventually disagree at the seam. */
  function fillTerrain(scale, ridge, line, fromCol, toCol, alpha) {
    if (toCol <= fromCol) return;
    const left = scale.plotLeft;

    ctx.beginPath();
    ctx.moveTo(left + fromCol, scale.floor);
    for (let i = fromCol; i < toCol; i++) ctx.lineTo(left + i + 0.5, scale.y(ridge[i]));
    ctx.lineTo(left + toCol, scale.floor);
    ctx.closePath();
    ctx.fillStyle = `rgba(${line.join(',')}, ${alpha})`;
    ctx.fill();
  }

  /**
   * Where the runner probably is right now: the 80% range, and nothing else.
   *
   * This is the forecast read the way round a distance axis can answer. The
   * tooltips ask "when will he be HERE"; the chart has no axis for a time, but it
   * has one for a place, so the marker asks "where is he NOW" instead — the same
   * model, inverted by `positionAt`.
   *
   * Drawn over the skyline for its whole span rather than beside it, so what it
   * marks is the stretch of profile the runner is probably somewhere on. A flat
   * bar in the axis gutter was using this chart's x-axis while sitting nowhere on
   * its chart.
   *
   * Deliberately just the one mark: a dot at the mean and end caps at the bounds
   * both draw the eye to exact positions the model does not actually claim. The
   * range is the whole of what it knows, so the range is the whole of what it
   * says — opaque and heavier than the terrain line so it reads as an assertion
   * over the profile rather than a shadow of it.
   *
   * @param {object} scale from `scaleFor`
   * @param {ArrayLike<number>} ridge the smoothed series the skyline was drawn
   *   from, so the mark lands ON the line rather than near it.
   */
  function drawForecast(scale, ridge) {
    if (!marker) return;

    const ink = accent();
    const left = scale.plotLeft;
    // Plot columns, since that is what `ridge` is indexed in. At least one column
    // wide: a band this narrow is a very confident forecast, not an absent one.
    const from = Math.max(0, Math.min(ridge.length - 1, Math.round(scale.x(marker.lo)) - left));
    const to = Math.max(from + 1, Math.min(ridge.length, Math.round(scale.x(marker.hi)) - left));

    ctx.strokeStyle = `rgb(${ink.join(',')})`;
    ctx.lineWidth = 4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = from; i < to; i++) {
      const y = scale.y(ridge[i]);
      if (i === from) ctx.moveTo(left + i + 0.5, y); else ctx.lineTo(left + i + 0.5, y);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /**
   * Recompute where the runner probably is, and say whether that has moved far
   * enough to be worth a redraw.
   *
   * `positionAt` returns null once the prediction has run off the end of the
   * course, which is what takes the marker away when a run goes quiet: a phone
   * that stopped reporting three days ago is not "probably at the finish line",
   * it is not on the chart at all.
   */
  function refreshMarker() {
    const next = visible() && forecast ? positionAt(forecast, Date.now()) : null;
    const perPx = course?.length > 0
      ? course.length / Math.max(1, canvas.clientWidth)
      : Infinity;
    const moved = Boolean(marker) !== Boolean(next) ||
      (marker && next && Math.abs(next.along - marker.along) / perPx >= MARKER_STEP_PX);

    marker = next;
    return moved;
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
      rect.top + scale.y(elevationAt(course, selection.along)),
      // Clear of the strip, not merely clear of the point. A point in a valley
      // sits low in the band, and "above the point" for that one is on top of
      // the terrain — the tooltip covering the chart it is describing.
      root.getBoundingClientRect().top - 8
    );
  }

  /**
   * Pan the strip so a distance along the course sits in the middle of it.
   *
   * Instant rather than smooth: this also runs from a drag on the map, once per
   * pointermove, and a smooth scroll would spend every frame animating towards a
   * target that has already moved.
   *
   * @param {number} along metres along the course.
   */
  function centerOn(along) {
    if (!visible()) return;
    const scale = scaleFor(course, canvas.clientWidth, canvas.clientHeight);
    scroller.scrollLeft = centerScrollLeft(
      scale.x(along), scroller.clientWidth, canvas.clientWidth
    );
    syncFades();
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
   * Sunrise and sunset, at the distance the run had reached when they happened.
   *
   * A tick like a waypoint's, and the mark on it — in a band of its own just under
   * the waypoint names rather than among them. Two labels of different kinds
   * competing for one row is how the collision rule above ends up dropping the
   * interesting one, and there was no need: nothing else uses this strip of pixels.
   *
   * No time beside it and no tooltip on it, exactly as a waypoint here has a tick
   * and no tooltip. The drawing is unambiguous — a sun rising and a moon rising
   * are not the same picture — and the map is where a mark is asked what else it
   * knows.
   *
   * Marks with no distance are skipped: an axis of distance along the course has
   * nowhere to put a moment that happened off it.
   */
  function drawSun(scale) {
    if (!sun.length) return;

    const line = courseColor();
    ctx.strokeStyle = `rgba(${line.join(',')}, 0.35)`;
    ctx.lineWidth = 1;

    for (const poi of sun) {
      if (poi.along === null || poi.along === undefined) continue;

      const x = Math.round(scale.x(poi.along)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, PAD_TOP);
      ctx.lineTo(x, scale.floor);
      ctx.stroke();
      // Centred on its own tick and hanging off the top of the plot, which is the
      // band `PAD_TOP` was reserved for.
      stamp(poi.event, inkOf(line), x, PAD_TOP + MARK_PX / 2);
    }
  }

  /**
   * The photographs, at the distance along the course each one was taken.
   *
   * On the map a photograph is its own thumbnail — the one mark on this page that
   * shows you what it is without being asked. There is no room for that here, so
   * the strip gets a camera instead, and its job is smaller and different: it says
   * that this climb, this descent, this stretch of the course is one somebody has
   * a picture of, and it says it while you are reading the profile rather than the
   * map.
   *
   * Sat ON the terrain rather than in the sun's band at the top, and lifted just
   * clear of it with a stem down to the line — the same idiom the map uses to keep
   * a 44 px thumbnail from covering the route it belongs to. A photograph is about
   * a PLACE on the course; a sunrise is about a moment that happened to fall
   * somewhere on it, and the two bands keep that difference visible.
   *
   * Coloured by where the position came from, exactly as the map's anchor dots are:
   * the accent for a file that carried its own GPS, the course purple for one
   * placed between the pings either side, magenta for a crew member's. Reserving
   * the accent for real readings is what stops an interpolation from looking like
   * evidence — and a mark that is one colour here and another there would undo it.
   *
   * A photo with no distance — a crew shot from off the route — has nowhere to go
   * on an axis of distance, and is left to the map.
   */
  function drawMedia(scale, ridge) {
    if (!media.length) return;

    const measured = accent();
    const inferred = courseColor();
    const theirs = crewColor();

    for (const poi of media) {
      if (poi.along === null || poi.along === undefined) continue;

      const rgb =
        poi.source === 'exif' ? measured :
        poi.source === 'crew' ? theirs : inferred;

      const x = Math.round(scale.x(poi.along)) + 0.5;
      // The DRAWN skyline, so the stem ends on the line rather than near it —
      // see `ridgeAt`.
      const ground = scale.y(ridgeAt(ridge, scale, poi.along));
      // Clamped into the plot: a picture taken on the highest point of the course
      // would otherwise float off the top of a 112 px strip.
      const centre = Math.max(PAD_TOP + MARK_PX / 2, ground - MARK_PX / 2 - 3);

      ctx.strokeStyle = `rgba(${rgb.join(',')}, 0.55)`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, centre);
      ctx.lineTo(x, ground);
      ctx.stroke();

      stamp('photo', inkOf(rgb), x, centre);
    }
  }

  /**
   * One drawn mark, centred on a point.
   *
   * Silently nothing until the SVGs have loaded — `loadGlyphs` redraws when they
   * have, so the miss lasts one paint. Everything around a mark is drawn from the
   * data alone and is on screen already; this is the decoration arriving late.
   */
  function stamp(name, ink, x, y) {
    const mark = glyph(name, ink);
    if (!mark) return;
    ctx.drawImage(mark, x - MARK_PX / 2, y - MARK_PX / 2, MARK_PX, MARK_PX);
  }

  /**
   * The pings, at their distance along the course and the course's height there
   * — the same colour as the map, so the two views read as one dataset. That is
   * one colour for all of them now, the newest included; here as there, it is the
   * size and the ring that say which one is newest. Unsnapped pings have no
   * distance, so they simply aren't here.
   */
  function drawPoints(scale) {
    const latest = latestOf(points);
    const ring = surface();

    ctx.fillStyle = `rgb(${accent().join(',')})`;

    for (const p of points) {
      if (!p.snap) continue;
      const x = scale.x(p.snap.along);
      const y = scale.y(p.snap.ele ?? elevationAt(course, p.snap.along));
      const isLatest = latest && latest.name === p.name;

      ctx.beginPath();
      ctx.arc(x, y, isLatest ? 5 : 3.2, 0, Math.PI * 2);
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

    // A bead where the crosshair meets the terrain — see `ridgeAt` for why it is
    // read off the smoothed series rather than from the elevation there.
    ctx.beginPath();
    ctx.arc(x, scale.y(ridgeAt(ridge, scale, hover)), 3, 0, Math.PI * 2);
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
   * Dismiss the hover tooltip, but not yet — see the `pointerleave` handler below
   * for why the delay is what makes the tooltip's own link reachable at all.
   *
   * `TIP_GRACE_MS` is long enough to cross the gap between the strip and the tip at
   * any human speed, and short enough that a tooltip left behind by a cursor which
   * went somewhere else is gone before anybody wonders why it is still there.
   */
  function leaveSoon() {
    cancelLeave();
    leaveTimer = setTimeout(leave, TIP_GRACE_MS);
  }

  function cancelLeave() {
    clearTimeout(leaveTimer);
    leaveTimer = null;
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
        html: tooltipHtml(hit, !!latest && latest.name === hit.name, originOf(points)),
        lat,
        lon
      };
    }

    // Not on a ping, so describe the ground: how far in, how high, and —
    // interpolated between the pings either side — when the run was here.
    const along = scale.distanceAt(clientX - rect.left);
    const at = interpolateAt(points, course, along, forecast);
    return { along, html: hoverTooltipHtml(at), lat: at.lat, lon: at.lon };
  }

  /**
   * How far, in pixels, the pointer is from the pinned point — or null when
   * there is nothing to be near.
   *
   * A selection with no `along` has no place on a chart of distance, so it can
   * never be grabbed here. That is a ping the snapper left alone: it has a
   * position on the map and none on the course. A `fixed` one is marked here and
   * still not draggable — a photograph's distance is a measurement, and the same
   * gate holds on the map. See `Selection` in [pin.js](pin.js).
   */
  function grabDistance(clientX) {
    if (!visible() || selection?.along == null || selection.fixed) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = scaleFor(course, rect.width, rect.height);
    return Math.abs(clientX - rect.left - scale.x(selection.along));
  }

  canvas.addEventListener('pointermove', event => {
    // Back on the strip, so whatever leaving it started is off.
    cancelLeave();
    // Sliding the pinned point along the course. It reads through `readAt`, the
    // same function the hover and click paths use, so a scrub passing over a
    // ping shows that ping rather than the ground beneath it.
    if (dragging) {
      if (Math.abs(event.clientX - dragFromX) > DRAG_SLOP_PX) justDragged = true;
      const at = readAt(event.clientX, event.clientY);
      onScrub({ view: 'profile', html: at.html, lat: at.lat, lon: at.lon, along: at.along });
      return;
    }

    if (!visible()) return;

    // A pinned point is pickable: say so before it is picked up, since nothing
    // else on this strip can be dragged and there would otherwise be no hint.
    if (selection) {
      const near = grabDistance(event.clientX);
      canvas.style.cursor = near !== null && near <= grabRadius(event) ? 'grab' : '';
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

  /**
   * How close this pointer has to get. A thumb gets a much wider band than a
   * mouse — see `dragGrabTouchPx`.
   */
  const grabRadius = event =>
    event.pointerType === 'mouse' ? CONFIG.dragGrabPx : CONFIG.dragGrabTouchPx;

  /** Pick the pinned point up, if that is what this press is aimed at. */
  canvas.addEventListener('pointerdown', event => {
    const near = grabDistance(event.clientX);
    if (near === null || near > grabRadius(event)) return;

    dragging = true;
    justDragged = false;
    dragFromX = event.clientX;
    root.dataset.dragging = 'true';
    // So the gesture keeps arriving here even when the pointer runs off the
    // canvas, which on a 112 px strip is most drags.
    canvas.setPointerCapture(event.pointerId);
    // And so the press doesn't start a text selection on the way past.
    event.preventDefault();
  });

  /**
   * The same press, again, as a touch — and this is what actually makes dragging
   * work on a phone.
   *
   * `pointerdown` above cannot win the gesture on iOS. Safari decides on the
   * first touchmove whether the finger is scrolling the strip, and when it says
   * yes it fires `pointercancel` and the drag is over before it moved. Only
   * cancelling the touch takes that decision away from it. `touch-action: none`
   * is the declarative version and is not enough here: it is read when the
   * gesture starts, so setting it in `pointerdown` — one event too late — is a
   * race we lose about half the time.
   *
   * Cancelling the touch also stops the OTHER thing Safari does with an
   * unclaimed press on a canvas: start a text selection, which brings up the
   * magnifying lens and highlights whatever text it can find nearby.
   *
   * Pointer events fire before their touch counterparts, so `dragging` is
   * already the answer to "was that press aimed at the pinned point".
   */
  canvas.addEventListener('touchstart', event => {
    if (dragging && event.cancelable) event.preventDefault();
  }, { passive: false });

  /**
   * @param {PointerEvent} event
   * @param {boolean} released whether the finger was actually lifted. A gesture
   *   the SYSTEM took away — a cancel — is not a tap, and must not be read as
   *   one: an interrupted press would otherwise put the pinned point down.
   */
  function endDrag(event, released = false) {
    if (!dragging) return;
    dragging = false;
    delete root.dataset.dragging;
    canvas.style.cursor = 'grab';
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

    // On touch there is no click coming — cancelling the touchstart above is
    // exactly what stops Safari synthesising one — so both of the click
    // handler's jobs have to be done here instead.
    //
    // A touch that went nowhere is the tap that puts the point down. Handing the
    // CURRENT selection back to `onSelect` is how: `same()` matches it against
    // itself and main.js reads that as a dismissal, so there is still one rule
    // in the codebase about what putting a point down means. Same reasoning as
    // map.js, for the same reason — a press we took off the browser.
    //
    // And a touch that DID drag has no click to swallow, so the `justDragged`
    // latch is cleared here rather than left armed for the next tap.
    if (event.pointerType !== 'mouse') {
      const tapped = released && !justDragged;
      justDragged = false;
      // Should a click arrive after all — the spec says it won't, Safari has
      // been known to disagree — it must not be read as a new one.
      ghostUntil = Date.now() + GHOST_CLICK_MS;
      if (tapped) onSelect(selection);
    }
  }

  canvas.addEventListener('pointerup', event => endDrag(event, true));
  canvas.addEventListener('pointercancel', event => endDrag(event));

  /**
   * Pin what's under the cursor. Every click on the strip selects something —
   * a ping if there is one, the ground if there isn't — so there is nothing to
   * miss. Putting a selection down again is a click on the same point, or
   * Escape, or a click on empty map; main.js owns that rule.
   */
  canvas.addEventListener('click', event => {
    if (!visible()) return;
    // A compatibility click for a tap `endDrag` has already answered.
    if (Date.now() < ghostUntil) {
      ghostUntil = 0;
      return;
    }
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
    cancelLeave();
    owned = false;
    hideTip();
    // A pinned point outlives the cursor — that is the whole point of pinning
    // it — so the crosshair stays where the selection put it.
    if (selection) return;
    hover = null;
    onHover(null);
    draw();
  }

  // Leaving the strip is not the same as being finished with it, and the
  // difference is a few hundred milliseconds wide.
  //
  // `relatedTarget` alone was supposed to allow the move from the strip into the
  // tooltip, and in principle it does — but the tip sits ABOVE the strip and is
  // only as wide as its own contents, so the cursor on its way to the Google Maps
  // link crosses whatever is beside or below it: the gap, the map, the panel. Every
  // one of those is a `relatedTarget` that is not the tip, and the tooltip vanished
  // before the cursor arrived. The link was there and could not be reached.
  //
  // So leaving schedules the dismissal instead of performing it, and getting to the
  // tip — or back onto the strip — cancels it. A pointer that really has gone
  // somewhere else simply never cancels, and the tip goes away a moment later.
  canvas.addEventListener('pointerleave', event => {
    if (event.relatedTarget && tip.contains(event.relatedTarget)) return;
    leaveSoon();
  });
  // Touch doesn't reliably deliver `pointerleave` — a tap elsewhere is how a
  // phone says "done", and without this the tip would stay up for good.
  canvas.addEventListener('pointercancel', leave);
  // Arriving is what the grace period was held open for.
  tip.addEventListener('pointerenter', cancelLeave);
  // And leaving the tooltip itself, for anywhere that isn't back on the canvas.
  // Immediate: the cursor was already there, so there is nothing to reach for.
  tip.addEventListener('pointerleave', leave);
  document.addEventListener('pointerdown', event => {
    // The pin is exempt as well as the hover tip: clicking the Google Maps link
    // inside it must not be read as a click somewhere else.
    if (!canvas.contains(event.target) && !tip.contains(event.target) &&
        !pin.contains(event.target)) leave();
  });

  addEventListener('resize', sync);

  // The sun and camera marks are SVG files and land a moment after the first
  // paint. One redraw when they do — see `stamp`, which draws nothing until then.
  loadGlyphs().then(draw);

  return {
    /** @param {object|null} next the run's course, or null when it has none. */
    setCourse(next) {
      course = next;
      // The along-distance of each waypoint is only knowable once there's a
      // course to measure against, and it never changes after that.
      if (course) locateWaypoints(course);
      hover = null;
      // A distance along the old course means nothing on the new one, and that
      // goes for the forecast as much as for the crosshair. `show()` fits a
      // fresh one straight after this, so the gap is one paint.
      forecast = null;
      marker = null;
      hideTip();
      sync();
    },

    setPoints(next) {
      points = next;
      draw();
    },

    /**
     * The run's sun events, from `sunPois` — the same array the map is given, so
     * the two views cannot mark different moments.
     */
    setSun(next) {
      sun = next;
      draw();
    },

    /**
     * The run's photographs, from `placeMedia` — the same array the map is given,
     * so a picture is at one distance along the course rather than at two.
     */
    setMedia(next) {
      media = next;
      draw();
    },

    /**
     * The run's pace model, or null. Drives the "probably here, now" marker and
     * the ETAs in this view's own tooltips.
     *
     * @param {object|null} next from `buildForecast`.
     */
    setForecast(next) {
      forecast = next;
      refreshMarker();
      draw();
    },

    /**
     * Slide the marker along as the clock runs. Called once a second from
     * main.js, beside the elapsed clock, because both are the same kind of thing:
     * a number that changes without any data having arrived.
     *
     * Redraws only when the marker has actually moved a pixel, so a live run
     * costs a redraw every few seconds rather than sixty a minute.
     */
    tickForecast() {
      if (refreshMarker()) draw();
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
      // A point picked on the MAP is very often off the visible end of the strip
      // — that is the whole problem with two views of one course on a phone — so
      // bring it into the middle. Not for this view's own selections: the point
      // is already under the finger that chose it, and re-centring mid-drag pans
      // the canvas out from under that finger.
      if (selection.view === 'map' && selection.along !== null) centerOn(selection.along);
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
     *
     * A pinned point outranks it. This is called on every paint, so a poll
     * landing while someone is reading a point 40 km back would otherwise pan
     * the strip out from under them.
     */
    scrollToLatest() {
      if (!visible() || selection) return;
      const latest = latestOf(points);
      if (!latest?.snap) return;
      centerOn(latest.snap.along);
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
