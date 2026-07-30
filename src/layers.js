// deck.gl layer construction. `deck` is a global from the UMD bundle loaded by
// index.html, not an import.

import { CONFIG } from './config.js';
import { accent, course as courseColor, point as pointColor, surface, prefersDark } from './colors.js';
import { courseHoverAt, pathsBetween } from './course.js';
import { isLive } from './github.js';
import { interpolateAt } from './stats.js';
import { ago, escapeHtml, fmtClock, fmtDuration, fmtHm, fmtTime, mapsUrl } from './util.js';
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
 * The course itself: an invisible band to point at, the route, then its
 * waypoints and their names on top.
 *
 * Track segments are drawn as separate paths rather than one, so a two-part
 * course doesn't grow a line between the end of one leg and the start of the
 * next. Returns nothing when the run has no course, which is the common case.
 *
 * @param {boolean} showWaypoints from the panel's toggle.
 */
export function courseLayers(course, showWaypoints = true) {
  if (!course) return [];

  const line = courseColor();
  const ring = surface();
  const getPath = seg => seg.map(p => [p.lon, p.lat]);

  const layers = [
    // The thing you actually point at. The drawn route is 3 px, which is a game
    // of skill with a mouse and hopeless with a thumb, so picking happens
    // against a transparent band many times wider: deck's picking pass renders
    // geometry regardless of fill alpha, so this catches the cursor while
    // showing nothing at all.
    new deck.PathLayer({
      id: 'course-hit',
      data: course.segments,
      getPath,
      pickable: true,
      widthUnits: 'pixels',
      getWidth: CONFIG.courseHoverPx,
      capRounded: true,
      jointRounded: true,
      getColor: [0, 0, 0, 0]
    }),

    new deck.PathLayer({
      id: 'course',
      data: course.segments,
      getPath,
      // Not pickable: `course-hit` above is, and two pickable layers over the
      // same geometry would just be two answers to one question.
      widthUnits: 'pixels',
      getWidth: 3,
      widthMinPixels: 2,
      capRounded: true,
      jointRounded: true,
      getColor: [...line, 180]
    })
  ];

  if (showWaypoints && course.waypoints.length) {
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

    layers.push(new deck.TextLayer({
      id: 'waypoint-labels',
      data: course.waypoints.filter(w => waypointName(w)),
      // Not pickable: the dot underneath owns the tooltip, and a label that
      // answers to a different hover than the mark it belongs to is a bug.
      getPosition: w => [w.lon, w.lat],
      getText: waypointName,
      getSize: 12,
      sizeUnits: 'pixels',
      getPixelOffset: [0, -13],
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'bottom',
      getColor: [...line, 255],
      // A halo in the page's own background colour, because the basemap
      // underneath is whatever it happens to be — town, forest, water.
      //
      // `outlineWidth` is a FRACTION OF THE FONT SIZE here, not pixels, and
      // only means anything with an SDF font.
      fontSettings: { sdf: true, radius: 12, cutoff: 0.25 },
      outlineWidth: 0.3,
      outlineColor: [...ring, 235]

      // No CollisionFilterExtension, though thinning out crowded labels is
      // exactly what it is for. In deck.gl 9.3.7 it culls EVERY label in this
      // stack — verified against the real course on both SwiftShader and the
      // hardware GPU, with and without `collisionTestProps`, and with the
      // per-frame layer rebuild frozen. The glyphs are laid out (33 instances,
      // sublayer visible) and simply never drawn. A label you can read beats a
      // label that tidily avoids its neighbours and isn't there.
    }));
  }

  return layers;
}

/** A waypoint's display name, or '' when it hasn't got one worth drawing. */
function waypointName(w) {
  return (w.name || w.sym || '').trim();
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
 * @param {boolean} showRaw from the panel's toggle. The SNAPPED dots are never
 *   optional — they are the reading; this only governs the audit trail behind
 *   them, which is worth having and not worth looking at all the time.
 */
export function pointLayers(points, pulse, showRaw = true) {
  const latest = latestOf(points);
  const latestData = latest ? [latest] : [];
  const ring = surface();
  const fill = pointColor();

  // Only the ones that actually moved. For an unsnapped ping the two positions
  // are the same, so there is nothing to draw faintly and nothing to join up.
  const moved = points.filter(p => p.snap);
  const audit = showRaw && moved.length ? [
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
    })
  ] : [];

  return [
    ...audit,

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
 * The other runs: one dot each, where that run was last seen, with its name.
 *
 * They are the answer to "what else is there?", which until now only the dropdown
 * could give — and a menu you have to open to discover is a menu nobody opens.
 *
 * Styled to be unmistakably NOT the run on screen. Every reading on this map is a
 * solid fill; these are outlined — the surface colour with a course-coloured ring
 * — which is the same argument the course itself makes by living off the blue
 * ramp: this is context, not data. They also carry the course's colour rather
 * than the accent, so nothing here can be mistaken for a ping.
 *
 * A run that is still going gets full-strength ink and a quiet one is faded, by
 * exactly the test the picker's `●` uses. It is the one thing worth knowing about
 * another race at a glance.
 *
 * @param {Array} beacons from `refreshBeacons`.
 */
export function beaconLayers(beacons) {
  if (!beacons.length) return [];

  const ink = courseColor();
  const paper = surface();
  const alpha = b => (isLive(b) ? 255 : 150);
  // `kind` is what the tooltip dispatches on — a beacon is not a fix, and
  // clicking one navigates rather than selecting.
  const data = beacons.map(b => ({ ...b, kind: 'beacon' }));
  // These move only when a run pings, but the array is rebuilt every frame, so
  // its identity says nothing. One string covering every dot's place and state.
  const trigger = data.map(b => `${b.run}:${b.sha}`).join();

  return [
    new deck.ScatterplotLayer({
      id: 'beacons',
      data,
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: b => [b.lon, b.lat],
      getRadius: 5,
      radiusMinPixels: 4,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      getLineColor: b => [...ink, alpha(b)],
      getFillColor: [...paper, 235],
      updateTriggers: { getPosition: trigger, getLineColor: trigger }
    }),

    new deck.TextLayer({
      id: 'beacon-labels',
      data,
      // Not pickable: the dot underneath owns the tooltip and the click.
      getPosition: b => [b.lon, b.lat],
      getText: b => b.run,
      getSize: 11,
      sizeUnits: 'pixels',
      getPixelOffset: [0, -10],
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'bottom',
      getColor: b => [...ink, alpha(b)],
      // Same halo as the waypoint labels, for the same reason: whatever basemap
      // happens to be under a name, the name has to survive it. See the note
      // there for why there is no CollisionFilterExtension.
      fontSettings: { sdf: true, radius: 12, cutoff: 0.25 },
      outlineWidth: 0.3,
      outlineColor: [...paper, 235],
      updateTriggers: { getPosition: trigger, getText: trigger, getColor: trigger }
    })
  ];
}

/**
 * Tooltip markup for another run's dot.
 *
 * Three lines and no coordinates: this is a signpost, not a reading. The last
 * line is there because a dot that turns out to be clickable only if you try it
 * is a feature nobody finds — and on a phone the tooltip never appears at all,
 * since a tap goes straight through to the switch.
 */
export function beaconTooltipHtml(beacon) {
  return [
    `<div class="t">${escapeHtml(beacon.run)}</div>`,
    `<div class="r">Last ping ${ago(beacon.latest)}</div>`,
    '<div class="r">Click to open this course</div>'
  ].join('');
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

/**
 * Where the runner probably is right now, on the map: the stretch of trace the
 * 80% range covers, and nothing else.
 *
 * The same mark the height strip carries, asking the same question of the same
 * model — this view has an axis for a place on the course just as the strip does,
 * so both can show it and they had better agree. Which is also why there is no
 * dot at the mean here: the model claims a stretch, not a spot, and a dot on it
 * invites the eye to read a precision that isn't there.
 *
 * The range is drawn as the route itself rather than as a band beside it, so
 * "probably somewhere along here" is said in the only units a map has for it. It
 * is wider than the 3 px route so it reads as a highlight of that route, and it
 * is not pickable: `course-hit` underneath owns the tooltip, and two answers to
 * one hover is a bug.
 *
 * @param {object|null} course
 * @param {{along, lo, hi}|null} marker from `positionAt`
 */
export function forecastLayers(course, marker) {
  if (!course || !marker) return [];

  const ink = accent();

  return [
    new deck.PathLayer({
      id: 'forecast-range',
      data: pathsBetween(course, marker.lo, marker.hi),
      getPath: p => p,
      widthUnits: 'pixels',
      getWidth: 6,
      widthMinPixels: 4,
      capRounded: true,
      jointRounded: true,
      getColor: [...ink, 255],
      // The band slides along the course as the clock runs, so its contents
      // change without the array identity saying anything about it.
      updateTriggers: { getPath: `${marker.lo},${marker.hi}` }
    })
  ];
}

/** Tooltip markup for one fix. Pure and DOM-free, so it's directly testable. */
export function tooltipHtml(point, isLatest) {
  // A finish beats "latest" — it is almost always both, and it says more. It is
  // also the one tag that stays true: this fix is still the finish tomorrow.
  const tag = point.is_finish ? ' &middot; finish' : isLatest ? ' &middot; latest' : '';
  const rows = [`<div class="t">${fmtTime.format(point.t)}${tag}</div>`];

  // The raw coordinates are the truth, and "snapped 12 m" belongs beside them
  // because that is what it qualifies: how far the drawn dot is from the fix.
  // A suspicious snap is then visible rather than silently believed.
  const coords = `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`;
  rows.push(`<div class="r">${coords}${point.snap
    ? ` &middot; snapped ${Math.round(point.snap.off)} m` : ''}</div>`);

  // Two "since" pairs, distance then time, each with the total first and the leg
  // since the previous ping after it. A long gap in either is usually a phone
  // that lost signal, which is worth seeing next to the fix that ended it.
  const stats = point.stats;
  if (stats && stats.distTotal !== undefined) {
    rows.push(`<div class="r">${sincePair(
      `${fmtDistance(stats.distTotal)} in`, fmtDistance(stats.dist))}</div>`);
  }
  if (stats) {
    rows.push(`<div class="r">${sincePair(
      `${fmtDuration(stats.sinceStart)} in`,
      stats.sincePrev === undefined ? null : fmtDuration(stats.sincePrev))}</div>`);
  }
  // Climb, when the course has elevation and this fix landed on it.
  if (stats && stats.upTotal !== undefined) {
    rows.push(`<div class="r">${climbHtml(stats.upTotal, stats.downTotal)}</div>`);
    rows.push(`<div class="r">${climbHtml(stats.up, stats.down)} since last</div>`);
  }

  // How the forecast did here, when this ping is late enough in the run to have
  // had one. Scored against a model that had never seen this ping or any after
  // it — see `deriveForecastErrors` — so it is a test of the prediction rather
  // than a look at its own residuals, and it is the only place on screen where
  // the model can be caught being wrong.
  if (stats?.forecast) rows.push(`<div class="r">${errorHtml(stats.forecast)}</div>`);

  if (point.btry !== undefined) rows.push(`<div class="r">Battery ${point.btry}%</div>`);
  if (point.msg) rows.push(`<div class="m">${escapeHtml(point.msg)}</div>`);
  if (point.img) rows.push(`<img src="${encodeURI(point.img)}" alt="">`);
  // Distance and time of day, which is what makes one ping's pin tellable from
  // the next one's once you're looking at it in Google Maps.
  rows.push(mapsLink(point.lat, point.lon, stats && stats.distTotal !== undefined
    ? `${fmtDistance(stats.distTotal)} · ${fmtClock.format(point.t)}`
    : fmtClock.format(point.t)));
  return rows.join('');
}

/** Tooltip markup for a course waypoint — a place, not a moment. */
export function waypointTooltipHtml(waypoint) {
  const rows = [`<div class="t">${escapeHtml(waypoint.name || waypoint.sym || 'Waypoint')}</div>`];
  if (waypoint.ele !== null && waypoint.ele !== undefined) {
    rows.push(`<div class="r">${Math.round(waypoint.ele)} m</div>`);
  }
  rows.push(`<div class="r">${waypoint.lat.toFixed(6)}, ${waypoint.lon.toFixed(6)}</div>`);
  rows.push(mapsLink(waypoint.lat, waypoint.lon, waypoint.name || waypoint.sym || 'Waypoint'));
  return rows.join('');
}

/**
 * Tooltip markup for a spot on the course that isn't a ping — what's under the
 * cursor when it's on the route itself.
 *
 * The height and the climb are facts about the course, so they're shown
 * wherever the cursor is. The time is a fact about the run, so past the last
 * ping it says so in words: this iteration deliberately does not extrapolate a
 * pace into ground nobody has covered yet.
 *
 * @param {object|null} at from [`interpolateAt`](stats.js).
 */
export function hoverTooltipHtml(at) {
  if (!at) return '';

  const rows = [`<div class="t">${fmtDistance(at.along)} in</div>`];
  if (at.ele !== null && at.ele !== undefined) {
    rows.push(`<div class="r">${Math.round(at.ele)} m</div>`);
  }
  if (at.state === 'between') {
    rows.push(`<div class="r">${fmtDuration(at.sinceStart)} in &middot; estimated</div>`);
  } else if (at.predicted) {
    // Two rows, because they answer two different questions. The first is when,
    // as a single number you can hold in your head; the second is how much that
    // number is worth. Splitting them keeps the window from reading as an
    // afterthought tacked onto a time that looks certain.
    rows.push(`<div class="r">${fmtHm.format(at.predicted.t)} &middot; ` +
      `${fmtDuration(at.predicted.sinceStart)} in</div>`);
    rows.push(`<div class="r">Likely ${fmtHm.format(at.predicted.lo)}` +
      `&thinsp;&ndash;&thinsp;${fmtHm.format(at.predicted.hi)}</div>`);
  } else {
    rows.push('<div class="r">Not reached yet</div>');
  }
  if (at.upTotal !== undefined) {
    rows.push(`<div class="r">${climbHtml(at.upTotal, at.downTotal)}</div>`);
  }
  rows.push(mapsLink(at.lat, at.lon, `${fmtDistance(at.along)} in`));
  return rows.join('');
}

/** "8.8 km in &middot; 1.2 km since last", or just the total when there's no previous. */
function sincePair(total, since) {
  return since === null || since === undefined
    ? total
    : `${total} &middot; ${since} since last`;
}

/**
 * The one thing in a tooltip you can click.
 *
 * Every tooltip names its pin, so the card that opens says which point you
 * followed rather than sitting blank — see `mapsUrl` for why that costs a URL
 * form Google no longer documents.
 *
 * All three tooltips have to opt out of `pointer-events: none` for this to be
 * reachable — deck.gl's default style sets it, and `#profile-tip` did too. See
 * `makeTooltip`, profile.js and pin.js.
 */
function mapsLink(lat, lon, label) {
  return `<a class="g" href="${mapsUrl(lat, lon, label)}" target="_blank" rel="noopener noreferrer">` +
    'Open in Google Maps</a>';
}

/**
 * "Predicted 12:36 &middot; 47s late" — how the forecast made before this ping
 * compared with the ping itself.
 *
 * "Late" and "early" describe the RUNNER against the prediction, not the
 * prediction against the runner: arriving after the predicted time is late. The
 * other convention would be a residual, which is a word for a different audience.
 *
 * Under a second, both words are silly and neither is informative, so it just
 * says the forecast was right.
 */
function errorHtml(forecast) {
  const off = Math.abs(forecast.error);
  const at = `Predicted ${fmtHm.format(forecast.t)}`;
  if (off < 1000) return `${at} &middot; spot on`;
  return `${at} &middot; ${fmtDuration(off)} ${forecast.error > 0 ? 'late' : 'early'}`;
}

/** "&uarr; 1,240 m &darr; 980 m" — arrows rather than +/-, which reads as arithmetic. */
function climbHtml(up, down) {
  const m = v => Math.round(v).toLocaleString();
  return `&uarr;&#8202;${m(up)} m &nbsp;&darr;&#8202;${m(down)} m`;
}

/** "850 m" / "12.4 km" — one wording for distance, wherever it is shown. */
export function fmtDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

/**
 * deck.gl's getTooltip callback, bound to live accessors for the current points
 * and course.
 *
 * `pointerEvents: 'auto'` overrides deck's default of `none`, which would leave
 * the Google Maps link visible but dead. It also keeps the tooltip up long
 * enough to reach: deck only listens for pointer events on its own canvas, so
 * once the cursor is over the tooltip div deck never learns it left the object.
 *
 * @param {() => boolean} isSuppressed whether there should be no hover tooltip at
 *   all right now. Two things say so, and map.js owns both: a point is pinned —
 *   a hover tooltip beside the pinned one is two answers to a question the user
 *   has already settled — or the pointer is a finger, which has no hover to
 *   speak of and whose tap is on its way to pinning something anyway.
 * @param {() => object|null} getForecast the run's pace model, so hovering ground
 *   the runner hasn't reached says when they probably will.
 */
export function makeTooltip(
  getPoints, getCourse = () => null, isSuppressed = () => false, getForecast = () => null
) {
  const tip = html => (html ? { html, className: 'tip', style: { pointerEvents: 'auto' } } : null);

  return ({ object, layer, coordinate }) => {
    if (isSuppressed()) return null;

    // The hit band is pickable so that hovering the route drives the profile
    // crosshair. What comes back as `object` is a segment — an array of
    // vertices, not a fix — so the coordinate is what's worth describing.
    if (layer?.id === 'course-hit') {
      const course = getCourse();
      if (!course || !coordinate) return null;
      const along = courseHoverAt(course, coordinate[0], coordinate[1]);
      if (along === null) return null;
      return tip(hoverTooltipHtml(interpolateAt(getPoints(), course, along, getForecast())));
    }

    if (!object) return null;
    if (object.kind === 'waypoint') return tip(waypointTooltipHtml(object));
    if (object.kind === 'beacon') return tip(beaconTooltipHtml(object));

    const latest = latestOf(getPoints());
    return tip(tooltipHtml(object, !!latest && latest.name === object.name));
  };
}
