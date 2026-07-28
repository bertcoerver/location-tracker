// deck.gl layer construction. `deck` is a global from the UMD bundle loaded by
// index.html, not an import.

import { accent, course as courseColor, point as pointColor, surface, prefersDark } from './colors.js';
import { escapeHtml, fmtDuration, fmtTime } from './util.js';
import { latestOf, posOf } from './points.js';

/** Keyless CARTO raster basemap, light or dark to match the page. */
export function basemapLayer() {
  const style = prefersDark() ? 'dark_all' : 'light_all';

  return new deck.TileLayer({
    id: 'basemap',
    data: ['a', 'b', 'c'].map(sub =>
      `https://${sub}.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}@2x.png`),
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: props => {
      const { boundingBox } = props.tile;
      return new deck.BitmapLayer(props, {
        data: null,
        image: props.data,
        bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]]
      });
    }
  });
}

/**
 * The course itself: the route, then its waypoints on top.
 *
 * Track segments are drawn as separate paths rather than one, so a two-part
 * course doesn't grow a line between the end of one leg and the start of the
 * next. Returns nothing when the run has no course, which is the common case.
 */
export function courseLayers(course) {
  if (!course) return [];

  const line = courseColor();
  const ring = surface();

  const layers = [
    new deck.PathLayer({
      id: 'course',
      data: course.segments,
      getPath: seg => seg.map(p => [p.lon, p.lat]),
      // Pickable not for a tooltip — it hasn't got one — but so that hovering
      // the route reports a coordinate, which drives the height profile's
      // crosshair. `makeTooltip` returns null for this layer by id.
      pickable: true,
      widthUnits: 'pixels',
      getWidth: 3,
      widthMinPixels: 2,
      capRounded: true,
      jointRounded: true,
      getColor: [...line, 180]
    })
  ];

  if (course.waypoints.length) {
    layers.push(new deck.ScatterplotLayer({
      id: 'waypoints',
      // `kind` is what the tooltip dispatches on — a waypoint is not a fix and
      // shouldn't be described like one.
      data: course.waypoints.map(w => ({ ...w, kind: 'waypoint' })),
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: w => [w.lon, w.lat],
      getRadius: 6,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      getLineColor: [...ring, 255],
      getFillColor: [...line, 255]
    }));
  }

  return layers;
}

/**
 * The point layers.
 *
 * When a run has a course, each ping is drawn three times: faintly where the GPS
 * actually put it, a dashed line from there to the course, and solidly where it
 * snapped to. The first two are the honesty — they show how far the snap moved
 * things, and which real fix each snapped dot came from — but the snapped one is
 * what the eye should land on, so it carries all the weight and the tooltip.
 *
 * @param {Array} points sorted oldest-first, each maybe carrying `snap`
 * @param {number} pulse 0..1, drives the halo on the newest fix
 */
export function pointLayers(points, pulse) {
  const latest = latestOf(points);
  const latestData = latest ? [latest] : [];
  const ring = surface();
  const fill = pointColor();

  // Only the ones that actually moved. For an unsnapped ping the two positions
  // are the same, so there is nothing to draw faintly and nothing to join up.
  const moved = points.filter(p => p.snap);

  return [
    // Which faint dot belongs to which snapped one. Dashed rather than solid so
    // it reads as an annotation and can't be mistaken for a leg of the route.
    // `PathStyleExtension` ships inside the deck.gl UMD bundle index.html
    // already loads — this costs no extra script.
    new deck.PathLayer({
      id: 'snap-link',
      data: moved,
      getPath: p => [[p.lon, p.lat], [p.snap.lon, p.snap.lat]],
      widthUnits: 'pixels',
      getWidth: 1,
      widthMinPixels: 1,
      getColor: [...fill, 90],
      extensions: [new deck.PathStyleExtension({ dash: true })],
      getDashArray: [4, 3],
      dashJustified: true
    }),

    new deck.ScatterplotLayer({
      id: 'raw',
      data: moved,
      // Not pickable: the snapped dot sitting on top of it owns the tooltip.
      radiusUnits: 'pixels',
      getPosition: p => [p.lon, p.lat],
      getRadius: 3,
      getFillColor: [...fill, 70]
    }),

    new deck.ScatterplotLayer({
      id: 'trail',
      data: points,
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: posOf,
      getRadius: 5,
      radiusMinPixels: 5,
      // A surface-coloured ring keeps overlapping fixes readable as separate marks.
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      getLineColor: [...ring, 235],
      getFillColor: [...fill, 232]
    }),

    // Pulsing halo, so a newly arrived fix is visible without hunting for it.
    new deck.ScatterplotLayer({
      id: 'latest-halo',
      data: latestData,
      radiusUnits: 'pixels',
      getPosition: posOf,
      getRadius: 11 + pulse * 9,
      getFillColor: [...accent(), Math.round(70 - pulse * 45)],
      updateTriggers: { getRadius: pulse, getFillColor: pulse }
    }),

    new deck.ScatterplotLayer({
      id: 'latest',
      data: latestData,
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: posOf,
      getRadius: 7,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      getLineColor: [...ring, 255],
      getFillColor: [...accent(), 255]
    })
  ];
}

/**
 * The place on the course the height profile is being hovered over.
 *
 * A hollow ring rather than a filled dot: it has to sit on top of the route
 * without hiding whatever ping might be underneath it, and it is a cursor, not
 * a reading.
 *
 * @param {[number, number]|null} position lon/lat, or null when nothing is hovered.
 */
export function hoverLayers(position) {
  if (!position) return [];

  return [new deck.ScatterplotLayer({
    id: 'hover',
    data: [position],
    radiusUnits: 'pixels',
    getPosition: p => p,
    getRadius: 8,
    filled: false,
    stroked: true,
    lineWidthUnits: 'pixels',
    getLineWidth: 2,
    getLineColor: [...accent(), 255],
    // The ring follows the cursor, so its position changes without the array
    // identity saying anything useful about it.
    updateTriggers: { getPosition: String(position) }
  })];
}

/** Tooltip markup for one fix. Pure and DOM-free, so it's directly testable. */
export function tooltipHtml(point, isLatest) {
  const rows = [
    `<div class="t">${fmtTime.format(point.t)}${isLatest ? ' &middot; latest' : ''}</div>`,
    `<div class="r">${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}</div>`
  ];
  // The raw coordinates above are the truth; this says how far the drawn dot is
  // from them, so a suspicious snap is visible rather than silently believed.
  if (point.snap) {
    rows.push(`<div class="r">${fmtDistance(point.snap.along)} in &middot; ` +
      `snapped ${Math.round(point.snap.off)} m</div>`);
  }

  // How long the run had been going when this fix arrived, and how long since
  // the one before it — a long gap is usually a phone that lost signal, which is
  // worth seeing next to the fix that ended it.
  const stats = point.stats;
  if (stats) {
    const times = [`${fmtDuration(stats.sinceStart)} in`];
    if (stats.sincePrev !== undefined) times.push(`${fmtDuration(stats.sincePrev)} since last`);
    rows.push(`<div class="r">${times.join(' &middot; ')}</div>`);
  }
  // Climb, when the course has elevation and this fix landed on it. Totals
  // first: that's the number the run is measured by, and the leg since the last
  // ping is the detail underneath it.
  if (stats && stats.upTotal !== undefined) {
    rows.push(`<div class="r">${climbHtml(stats.upTotal, stats.downTotal)}</div>`);
    rows.push(`<div class="r">${climbHtml(stats.up, stats.down)} since last</div>`);
  }

  if (point.btry !== undefined) rows.push(`<div class="r">Battery ${point.btry}%</div>`);
  if (point.msg) rows.push(`<div class="m">${escapeHtml(point.msg)}</div>`);
  if (point.img) rows.push(`<img src="${encodeURI(point.img)}" alt="">`);
  return rows.join('');
}

/** Tooltip markup for a course waypoint — a place, not a moment. */
export function waypointTooltipHtml(waypoint) {
  const rows = [`<div class="t">${escapeHtml(waypoint.name || waypoint.sym || 'Waypoint')}</div>`];
  if (waypoint.ele !== null && waypoint.ele !== undefined) {
    rows.push(`<div class="r">${Math.round(waypoint.ele)} m</div>`);
  }
  rows.push(`<div class="r">${waypoint.lat.toFixed(6)}, ${waypoint.lon.toFixed(6)}</div>`);
  return rows.join('');
}

/** "&uarr; 1,240 m &darr; 980 m" — arrows rather than +/-, which reads as arithmetic. */
function climbHtml(up, down) {
  const m = v => Math.round(v).toLocaleString();
  return `&uarr;&#8202;${m(up)} m &nbsp;&darr;&#8202;${m(down)} m`;
}

/** "850 m" / "12.4 km" — the same wording the profile readout uses. */
export function fmtDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/** deck.gl's getTooltip callback, bound to a live accessor for the current points. */
export function makeTooltip(getPoints) {
  return ({ object, layer }) => {
    if (!object) return null;
    // The route is pickable so that hovering it can move the profile crosshair.
    // What comes back is a segment — an array of vertices, not a fix — and
    // describing it as one would read `undefined.toFixed`.
    if (layer?.id === 'course') return null;
    if (object.kind === 'waypoint') {
      return { html: waypointTooltipHtml(object), className: 'tip' };
    }
    const latest = latestOf(getPoints());
    return {
      html: tooltipHtml(object, !!latest && latest.name === object.name),
      className: 'tip'
    };
  };
}
