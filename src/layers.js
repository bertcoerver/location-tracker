// deck.gl layer construction. `deck` is a global from the UMD bundle loaded by
// index.html, not an import.

import { CONFIG } from './config.js';
import {
  accent, course as courseColor, surface, viewer as viewerColor, prefersDark
} from './colors.js';
import { courseHoverAt, pathsBetween } from './course.js';
import { isLive } from './github.js';
import { interpolateAt, originOf } from './stats.js';
import { isDaylight, moonPhase } from './sun.js';
import {
  ago, dayTag, escapeHtml, fmtClock, fmtDuration, fmtHm, fmtPace, mapsUrl
} from './util.js';
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
 * The waypoints are not optional. They were behind a toggle, and a toggle is a
 * question — this one had the same answer every time, which makes it furniture
 * rather than a choice. A course with waypoints shows them.
 */
export function courseLayers(course) {
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
 * Sunrise and sunset, marked where the run was when they happened.
 *
 * Three layers per mark, and the split between them is forced rather than chosen —
 * see `sunAtlas` for the measurement behind it. The dot is what a cursor picks and
 * what carries the tooltip, the glyph is an `IconLayer` because deck's text
 * pipeline destroys a colour emoji, and the time is a `TextLayer` because deck's
 * text pipeline is very good at digits.
 *
 * Drawn in the course's colour rather than the accent: these are annotations on
 * the route, in the same idiom as its waypoints, and the accent on this page
 * belongs to the runner. The glyph supplies the only colour they need anyway.
 *
 * @param {Array} pois from [`sunPois`](sun.js).
 */
export function sunLayers(pois) {
  if (!pois.length) return [];

  const line = courseColor();
  const ring = surface();
  const { atlas, mapping } = sunAtlas();

  return [
    new deck.ScatterplotLayer({
      id: 'sun',
      // `kind` is already on the data, and it is what the tooltips dispatch on. A
      // sun POI also carries a `t`, so anything testing for one BEFORE testing
      // `kind` will describe it as a fix — see `makeTooltip` and map.js.
      data: pois,
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: p => [p.lon, p.lat],
      getRadius: 5,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      getLineColor: [...ring, 255],
      getFillColor: [...line, 255]
    }),

    new deck.IconLayer({
      id: 'sun-glyph',
      // Not pickable, like the waypoint labels: the dot underneath owns the
      // tooltip, and a mark whose label answers a different hover is a bug.
      data: pois,
      iconAtlas: atlas,
      iconMapping: mapping,
      getIcon: p => p.event,
      getPosition: p => [p.lon, p.lat],
      getSize: 19,
      sizeUnits: 'pixels',
      // Up and to the left of the dot, so the glyph and the time together sit
      // centred above it — the place a waypoint puts its name.
      getPixelOffset: [-19, -19]
    }),

    new deck.TextLayer({
      id: 'sun-time',
      data: pois,
      getPosition: p => [p.lon, p.lat],
      getText: p => fmtHm(p.t),
      getSize: 12,
      sizeUnits: 'pixels',
      getPixelOffset: [-6, -19],
      getTextAnchor: 'start',
      getAlignmentBaseline: 'center',
      getColor: [...line, 255],
      // The same halo as the waypoint labels and for the same reason — the
      // basemap under it is whatever it happens to be. This is the half of the
      // label deck CAN typeset properly, so it gets the treatment.
      fontSettings: { sdf: true, radius: 12, cutoff: 0.25 },
      outlineWidth: 0.3,
      outlineColor: [...ring, 235]
    })
  ];
}

/** Rasterised at this many pixels a side, which is headroom over the 19 px it is
 *  drawn at on a display with twice the density. */
const GLYPH_PX = 96;

/** Built once and kept, because it never changes: the glyphs are fixed and the
 *  atlas has no colour of its own to follow the page's scheme with. */
let glyphAtlas = null;

/**
 * The two glyphs, drawn into a canvas for an `IconLayer` to sample.
 *
 * This exists because deck.gl 9.3.7 cannot draw a colour emoji as TEXT. Measured
 * rather than assumed: with `sdf: true` — what the waypoint labels use — and with
 * `sdf: false` alike, a `TextLayer` renders 🌅 as a solid filled square, while the
 * digits beside it come out perfectly. Its font atlas keeps each glyph's coverage
 * and discards its colour, which is exactly right for lettering and fatal for an
 * emoji, whose entire content is colour.
 *
 * A 2D canvas has no such trouble — the same call that fails inside deck succeeds
 * here — so the rasterising happens in our own canvas and arrives as an icon,
 * where `mask: false` tells deck to sample the texture as it is rather than tinting
 * it. Which is also why the time is a separate `TextLayer`: each half of the label
 * goes through the pipeline that can render it.
 *
 * Lazy, and never called from node: the tooltip half of this file is unit-tested
 * without a DOM, and `document` does not exist there.
 */
function sunAtlas() {
  if (glyphAtlas) return glyphAtlas;

  const canvas = document.createElement('canvas');
  canvas.width = GLYPH_PX * 2;
  canvas.height = GLYPH_PX;

  const c = canvas.getContext('2d');
  // Named emoji fonts first and a plain sans-serif last, so a platform with
  // neither draws its own missing-glyph box rather than nothing at all.
  c.font = `${Math.round(GLYPH_PX * 0.8)}px "Apple Color Emoji", "Segoe UI Emoji", ` +
    '"Noto Color Emoji", ui-sans-serif, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(ICON.sunrise, GLYPH_PX / 2, GLYPH_PX / 2);
  c.fillText(ICON.sunset, GLYPH_PX * 1.5, GLYPH_PX / 2);

  const cell = x => ({ x, y: 0, width: GLYPH_PX, height: GLYPH_PX, mask: false });
  glyphAtlas = { atlas: canvas, mapping: { sunrise: cell(0), sunset: cell(GLYPH_PX) } };
  return glyphAtlas;
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
 * The audit trail used to be behind a toggle, off by default, which meant almost
 * nobody ever saw what the snapper had done. It is always drawn now and instead
 * pushed further down the stack by alpha alone: faint enough to read as a smudge
 * behind the reading, there the moment you look for it.
 *
 * @param {Array} points sorted oldest-first, each maybe carrying `snap`
 * @param {number} pulse 0..1, drives the halo on the newest fix
 */
export function pointLayers(points, pulse) {
  const latest = latestOf(points);
  const latestData = latest ? [latest] : [];
  const ring = surface();
  const fill = accent();

  // Only the ones that actually moved. For an unsnapped ping the two positions
  // are the same, so there is nothing to draw faintly and nothing to join up.
  const moved = points.filter(p => p.snap);
  const audit = moved.length ? [
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
      getColor: [...fill, 55],
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
      getFillColor: [...fill, 45]
    })
  ] : [];

  return [
    ...audit,

    // What you actually point at. Invisible, wider than any dot, and above the
    // course's own hit band so that a tap near a fix gets the fix — see
    // `pointHitPx`. Picking renders geometry regardless of fill alpha, which is
    // what lets this be a target and nothing else.
    new deck.ScatterplotLayer({
      id: 'points-hit',
      data: points,
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: posOf,
      getRadius: CONFIG.pointHitPx,
      getFillColor: [0, 0, 0, 0]
    }),

    new deck.ScatterplotLayer({
      id: 'trail',
      data: points,
      // Not pickable: `points-hit` above is, over the same objects, and two
      // pickable layers over one mark are two answers to one question.
      radiusUnits: 'meters',
      getPosition: posOf,
      getRadius: CONFIG.trailDotM,
      radiusMinPixels: CONFIG.trailDotMinPx,
      radiusMaxPixels: CONFIG.trailDotMaxPx,
      // No ring. It was there to keep overlapping fixes readable as separate
      // marks, and on a course pinged every few minutes it instead turned a
      // stretch of trail into a chain of little targets. A plain dot reads as a
      // trace, which is what a line of pings is.
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
 * Where the person looking at the page is: a blue dot, its pulse, and the circle
 * the browser's own uncertainty describes.
 *
 * The one mark on this map that isn't about the race. It answers the other half of
 * a spectator's question — the pings say where the runner is, and until now
 * nothing said where *you* are, so anyone planning to intercept a runner had to
 * hold one of those two facts in their head or go and look at a different map.
 *
 * Blue because a blue dot has meant "you" on every map anyone has used — and it
 * is now the only thing on this map that isn't orange, the pings having given up
 * their blue. The ring and the halo are what finish the job: a ping carries no
 * ring at all, and the only other pulsing mark on screen is the newest fix, which
 * pulses orange.
 *
 * The accuracy circle is drawn in METRES, at whatever radius the browser admits
 * to. A wifi-derived fix can be a kilometre wide and a GPS one ten metres, and
 * those two must not look alike: this map already refuses to over-claim in the
 * raw-versus-snapped trail and in the forecast's band, and a bare dot on a
 * 1 km fix would be the same lie in a new place.
 *
 * Nothing here is pickable. It carries no reading a tooltip could add to, and a
 * hit area the size of the accuracy circle would sit over the route swallowing
 * hovers meant for the race.
 *
 * @param {{lat, lon, accuracy}|null} viewer from `viewerFrom`, or null when the
 *   visitor hasn't asked to be located — which is the default and the common case.
 * @param {number} pulse 0..1, the same value the newest ping's halo rides.
 */
export function viewerLayers(viewer, pulse) {
  if (!viewer) return [];

  const ink = viewerColor();
  const data = [[viewer.lon, viewer.lat]];
  // The dot moves as the visitor does, and the array is rebuilt every frame, so
  // its identity says nothing about whether the position changed.
  const at = String(data[0]);

  return [
    // How sure the browser is, to scale. `radiusUnits: 'meters'` is the point of
    // this layer: it has to shrink as you zoom out, because it is an area of
    // ground and not a mark on a screen.
    ...(viewer.accuracy ? [new deck.ScatterplotLayer({
      id: 'viewer-accuracy',
      data,
      radiusUnits: 'meters',
      getPosition: p => p,
      getRadius: viewer.accuracy,
      // So a very good fix doesn't vanish under its own dot — at which point the
      // circle has stopped being a claim about metres and is just a soft edge.
      radiusMinPixels: 12,
      getFillColor: [...ink, 38],
      updateTriggers: { getPosition: at, getRadius: viewer.accuracy }
    })] : []),

    new deck.ScatterplotLayer({
      id: 'viewer-halo',
      data,
      radiusUnits: 'pixels',
      getPosition: p => p,
      getRadius: 11 + pulse * 9,
      getFillColor: [...ink, Math.round(70 - pulse * 45)],
      updateTriggers: { getPosition: at, getRadius: pulse, getFillColor: pulse }
    }),

    new deck.ScatterplotLayer({
      id: 'viewer',
      data,
      radiusUnits: 'pixels',
      getPosition: p => p,
      getRadius: 7,
      stroked: true,
      lineWidthUnits: 'pixels',
      // A ring at all, where a ping has none. On a phone-map dot this is most of
      // what makes it read as "you" rather than as another measurement.
      getLineWidth: 3,
      getLineColor: [...surface(), 255],
      getFillColor: [...ink, 255],
      updateTriggers: { getPosition: at }
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

/**
 * Tooltip markup for one fix. Pure and DOM-free, so it's directly testable.
 *
 * Four bands, in this order: when this was and how the phone was doing, then the
 * weather it was in, then what the run has done, then anything a person wrote. The
 * top line is modelled on a phone's status bar — the time on the left, the battery
 * and the signal on the right — because that is exactly what those three readings
 * are, and a reader who has held a phone already knows how to read it.
 *
 * @param {number|null} [origin] the moment the run's clock counts from, from
 *   `originOf`. Only used to say which DAY this fix landed on — see `dayTag`.
 *   Defaulted, so a caller with no points array to derive one from gets a plain
 *   time rather than a crash.
 */
export function tooltipHtml(point, isLatest, origin = null) {
  // A finish beats "latest" — it is almost always both, and it says more. It is
  // also the one tag that stays true: this fix is still the finish tomorrow.
  const tag = point.is_finish ? ' &middot; finish' : isLatest ? ' &middot; latest' : '';
  const day = dayTag(point.t, origin);
  const rows = [titleHtml(
    `${fmtClock(point.t)}${day ? `<span class="d">${day}</span>` : ''}${tag}`,
    statusHtml(point)
  )];

  const stats = point.stats;

  // --- the weather it happened in ------------------------------------------
  // Above the run's own figures rather than below them, because it is the setting
  // and they are the story: 4°C and rain is the first thing that explains a pace.
  rows.push(weatherHtml(point));

  // --- what the run has done so far ----------------------------------------
  // Each of these is a total with the leg that got there beside it, quietly. The
  // totals are the readings; the legs are context for them. They used to be typeset
  // identically, which made six equal numbers out of three answers.
  //
  // Time and distance lead, at full weight. They are the two figures somebody
  // opened this tooltip for — everything under them qualifies one of the two.
  //
  // `sinceStart` and not merely `stats`: a ping from before the scheduled start has
  // no elapsed time — it happened before the race did — and formatting the absence
  // would put "NaN in" on the tooltip. The gap since the previous ping goes with it
  // rather than standing alone, since the pair is one row and one thought.
  if (stats?.sinceStart !== undefined) {
    rows.push(reading(ICON.time, fmtDuration(stats.sinceStart),
      stats.sincePrev === undefined ? null : `+${fmtDuration(stats.sincePrev)}`, true));
  }
  if (stats && stats.distTotal !== undefined) {
    rows.push(reading(ICON.dist, fmtDistance(stats.distTotal),
      leg(stats.dist, fmtDistance), true));
  }
  // How the last stretch went, said twice. Neither row has a total to lead on: a
  // pace is only ever about a stretch, and the stretch that matters is the one just
  // finished. See `deriveStats` for when there isn't one.
  //
  // Two units for one number, because the two audiences for it don't convert. A
  // runner thinks in minutes per kilometre and will not divide 3600 by anything;
  // anyone following by car, bike or map thinks in km/h. Deriving the second from
  // the first costs one division and settles the argument.
  //
  // One row, in the shape every other row already has: the reading, then the same
  // reading said differently, quietly, in the column the legs live in. Two rows
  // claimed two measurements, and there is only one.
  if (stats?.pace !== undefined) {
    rows.push(reading(ICON.pace, `${fmtPace(stats.pace)}&thinsp;min/km`,
      `${fmtSpeed(stats.pace)}&thinsp;km/h`));
  }
  // Climb, when the course has elevation and this fix landed on it. Two rows rather
  // than the single four-figure line this replaces: up and down are two different
  // readings, and a row holding two totals and two legs cannot put focus on either.
  if (stats && stats.upTotal !== undefined) {
    rows.push(reading(ICON.up, metres(stats.upTotal), leg(stats.up, metres)));
    rows.push(reading(ICON.down, metres(stats.downTotal), leg(stats.down, metres)));
  }
  // Last of the readings, and in with them rather than off on a line of its own:
  // a heart rate is a fact about the run in exactly the way a pace is — the one
  // number here that says what the last kilometre COST — and it belongs beside the
  // figures it explains. Battery and signal are facts about a handset, and they
  // are up in the status bar where handset facts go.
  if (point.bpm !== undefined) rows.push(reading(ICON.bpm, `${point.bpm} bpm`));

  if (point.msg) rows.push(`<div class="m">${escapeHtml(point.msg)}</div>`);
  if (point.img) rows.push(`<img src="${encodeURI(point.img)}" alt="">`);
  // Distance and time of day, which is what makes one ping's pin tellable from
  // the next one's once you're looking at it in Google Maps. Also the last place
  // the raw coordinates matter at all, now that the tooltip has stopped printing
  // them: they are diagnostics, and they were the first thing under the title.
  rows.push(mapsLink(point.lat, point.lon, stats && stats.distTotal !== undefined
    ? `${fmtDistance(stats.distTotal)} · ${fmtClock(point.t)}`
    : fmtClock(point.t)));
  return rows.filter(Boolean).join('');
}

/** Tooltip markup for a course waypoint — a place, not a moment. */
export function waypointTooltipHtml(waypoint) {
  const rows = [titleHtml(escapeHtml(waypoint.name || waypoint.sym || 'Waypoint'))];
  if (waypoint.ele !== null && waypoint.ele !== undefined) {
    rows.push(reading(ICON.ele, metres(waypoint.ele)));
  }
  // No coordinate row, for the reason the ping tooltip no longer has one. A named
  // place with no height is then a name and a link, which is all a waypoint is.
  rows.push(mapsLink(waypoint.lat, waypoint.lon, waypoint.name || waypoint.sym || 'Waypoint'));
  return rows.join('');
}

/**
 * Tooltip markup for a sunrise or a sunset — a moment AND a place, unlike either
 * of its neighbours here.
 *
 * So it is built like a ping tooltip rather than like a waypoint: the wall clock
 * goes in the title, because that is where every tooltip on this page puts a wall
 * clock, and the 🕒 row keeps the meaning it has everywhere else — time on the race
 * clock, not time of day. The two would collide if the title were the event's name
 * alone, which is how the event's name ends up beside the time instead of above it.
 *
 * @param {object} poi from [`sunPois`](sun.js).
 * @param {number|null} [origin] the moment the run's clock counts from, for the
 *   elapsed row and the day tag. Defaulted, like `tooltipHtml`'s.
 */
export function sunTooltipHtml(poi, origin = null) {
  const day = dayTag(poi.t, origin);
  const rows = [titleHtml(
    `${fmtClock(poi.t)}${day ? `<span class="d">${day}</span>` : ''}` +
    ` &middot; ${poi.event === 'sunrise' ? 'sunrise' : 'sunset'}`
  )];

  // Where the race clock stood. Absent rather than negative on a mark that fell
  // before the gun, for the reason `deriveStats` gives: a sunrise an hour before
  // the start has no elapsed time, and "-1:00:00" is not what a race clock says.
  if (origin !== null && poi.t >= origin) {
    rows.push(reading(ICON.time, fmtDuration(poi.t - origin), null, true));
  }

  // How far in, and — when the phone had been quiet a while — how much of that
  // figure is interpolation. A position pulled out of a two-hour blackout is an
  // estimate, and this is the page's one place for saying so.
  if (poi.along !== null && poi.along !== undefined) {
    rows.push(reading(ICON.dist, fmtDistance(poi.along),
      poi.gap > CONFIG.maxPingMs ? `interpolated across ${fmtDuration(poi.gap)}` : null, true));
  }
  if (poi.ele !== null && poi.ele !== undefined) rows.push(reading(ICON.ele, metres(poi.ele)));

  rows.push(mapsLink(poi.lat, poi.lon, `${poi.event} · ${fmtClock(poi.t)}`));
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
 * The prediction leads, where there is one. It is the answer to the question that
 * made somebody point at ground nobody has reached — "when will he be here" — and
 * the distance and the climb are how far away "here" is. On a ping tooltip the
 * measured readings lead for the same reason reversed: there, nothing is a guess.
 *
 * @param {object|null} at from [`interpolateAt`](stats.js).
 */
export function hoverTooltipHtml(at) {
  if (!at) return '';

  const rows = [];
  if (at.predicted) {
    rows.push(predictionHtml({ ...at.predicted, origin: at.origin }));
  }
  // The distance carries the same ruler the ping tooltips label theirs with, and
  // nothing else: "23.9 km in" needed the word because a bare number could have been
  // anything, and the glyph says the same thing in less space and in one voice.
  rows.push(reading(ICON.dist, fmtDistance(at.along), null, true));
  if (at.ele !== null && at.ele !== undefined) rows.push(reading(ICON.ele, metres(at.ele)));
  // Nothing for the `'between'` case. Interpolating a time between two fixes is
  // arithmetic on a straight line through ground that was climbed at whatever pace it
  // was climbed at, and labelling it "estimated" did not make it worth a row — the
  // fixes either side both carry times somebody actually recorded.
  if (at.state !== 'between' && !at.predicted) {
    rows.push(reading(ICON.time, 'Not reached yet'));
  }
  if (at.upTotal !== undefined) {
    rows.push(reading(ICON.up, metres(at.upTotal)));
    rows.push(reading(ICON.down, metres(at.downTotal)));
  }
  rows.push(mapsLink(at.lat, at.lon, `${fmtDistance(at.along)} in`));
  return rows.join('');
}

/**
 * The weather a ping carries, as its two halves: `["28°C", "Sunny"]`.
 *
 * The phone sends one string with the temperature and the sky glued together by
 * an " and " it composed itself. Those are two readings and not one — a number
 * you compare with the last ping's, and a word you don't — so they are pulled
 * apart here and shown as two, in the same `·` idiom as everything else in a
 * tooltip.
 *
 * Split on the FIRST " and " only, so a label that contains one of its own
 * ("Rain and thunder") survives intact. A string that has none is passed through
 * whole rather than sliced on a guess, which also covers a phone that one day
 * sends the label alone.
 *
 * Escaped here rather than by the caller, because this is what hands back the
 * pieces — a temperature is a plausible enough number that nothing else in this
 * file would think to.
 *
 * @param {string|undefined} wthr
 * @returns {string[]|null} one or two escaped parts, or null when there's nothing.
 */
export function splitWeather(wthr) {
  const text = String(wthr ?? '').trim();
  if (!text) return null;

  const halves = /^(.*?)\s+and\s+(.+)$/i.exec(text);
  return (halves ? [halves[1], halves[2]] : [text]).map(escapeHtml);
}

/**
 * The glyphs a tooltip labels its readings with.
 *
 * Emoji rather than drawn icons, which is a trade taken with open eyes: they render
 * in the platform's own colour and metrics, which no stylesheet here can reach. What
 * buys that back is the weather, where a hand-drawn set would need fifteen glyphs
 * for a vocabulary everyone can already read at a glance. Having accepted them
 * there, using them for the other six is the only way the tooltip has one voice.
 *
 * `️` on the ones that need it: several of these have a legacy text
 * presentation that some platforms still default to, and a monochrome outline
 * beside four colour glyphs looks like a font that failed to load.
 */
const ICON = {
  time: '\u{1F552}',   // 🕒
  // A ruler, not a map pin. The reading is a LENGTH along the course; a pin says
  // "a place", which is the one thing this row is not about.
  dist: '\u{1F4CF}',   // 📏
  // A runner rather than the stopwatch this obviously wanted, because a stopwatch at
  // 11 px is a small circle with hands on it and so is the clock two rows above —
  // two readings that are already easy to confuse arriving under the same glyph.
  pace: '\u{1F3C3}',   // 🏃
  // Trend charts, not arrows. Ascent and descent over a course ARE a line going up
  // and a line coming down — it is the shape the height strip at the bottom of the
  // page draws these very numbers as — so the glyph and the graph agree. They also
  // sidestep what made ⬆️/⬇️ unusable here: those render as filled blue tiles that
  // outweighed every number on the card and fought the page's one accent colour.
  up:   '\u{1F4C8}',   // 📈
  down: '\u{1F4C9}',   // 📉
  ele:  '⛰️', // ⛰️
  // The weather's own glyph does duty for the temperature, so there is no
  // thermometer: the sky and the air are one reading taken by one sensor, and a
  // thermometer beside a sun was two icons for it. `temp` survives as what
  // `weatherIcon` falls back to when a label arrives that nobody anticipated —
  // that case is genuinely "some temperature, no idea what sky".
  temp: '\u{1F321}️', // 🌡️
  bpm:  '❤️', // ❤️
  // The one pair here picked for being unlike EACH OTHER rather than for being
  // like what it depicts. 🌅 and 🌇 are the obvious choice and are the same
  // picture — a sun on a horizon — at the 19 px these are drawn at on the map, so
  // the two marks a night puts on a course would be indistinguishable. A starry
  // skyline is unmistakable beside a sunrise, and it says the thing the runner
  // cares about: the head torch goes on.
  sunrise: '\u{1F305}', // 🌅
  sunset:  '\u{1F303}'  // 🌃
};

/**
 * The glyph for a sun event.
 *
 * Exported so the height strip draws the same two characters this file does — it
 * renders them with canvas `fillText`, which has no trouble with a colour emoji
 * whatsoever, and a second copy of the pair is a second chance to change one.
 */
export function sunGlyph(event) {
  return event === 'sunrise' ? ICON.sunrise : ICON.sunset;
}

/**
 * A tooltip's top line: what this is, and — on a ping — how the phone was doing.
 *
 * @param {string} label already escaped or built from formatted numbers.
 * @param {string} [aside] pushed to the right edge by the stylesheet.
 */
function titleHtml(label, aside = '') {
  return `<div class="t"><span class="tt">${label}</span>${aside}</div>`;
}

/**
 * The right-hand end of the top line: battery and signal, as a phone draws them.
 *
 * Drawn rather than lettered, and this is the one place in the tooltip where SVG
 * beats the emoji everything else uses — because these two icons carry their
 * READINGS in their shape. 🔋 is the same glyph at 4% as at 100%, so it needed a
 * number beside it to say anything; a battery drawn one fifth full has already
 * said it, and 📶 is four bars whatever the signal is. Twelve lines of SVG buys a
 * status bar that means what a status bar means.
 *
 * The percentage stays as text next to the drawn cell. On a tracker it is not
 * decoration — a phone at 6% is a run that is about to stop reporting, and "about
 * a fifth" is not the same warning as "6%".
 *
 * Returns '' when the ping carries neither, which every file written before those
 * fields existed does.
 */
function statusHtml(point) {
  const cells = [
    point.btry === undefined ? '' : `<span class="c">${batteryIcon(point.btry)}${point.btry}%</span>`,
    point.ntwrk === undefined ? '' : signalIcon(point.ntwrk)
  ].filter(Boolean);
  return cells.length ? `<span class="st">${cells.join('')}</span>` : '';
}

/**
 * A battery, filled to `pct`.
 *
 * `currentColor` throughout, so it inherits the line's ink and needs no rule of its
 * own in either colour scheme. Deliberately NOT red when low: this page spends its
 * one accent colour on the run itself, and a second signal colour would be competing
 * with the pings for the same meaning.
 *
 * The fill is clamped to a floor of one rounded pixel of width so that 1% is a
 * sliver rather than nothing at all — an empty shell reads as "no reading", which
 * is a different thing from "nearly flat".
 */
function batteryIcon(pct) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const w = p === 0 ? 0 : Math.max(1.5, (p / 100) * 18);
  return svg('25 13', `Battery ${Math.round(p)}%`,
    '<rect x=".6" y=".6" width="20.8" height="11.8" rx="3.4" fill="none" ' +
      'stroke="currentColor" stroke-opacity=".4" stroke-width="1.2"/>' +
    '<path d="M23.1 4.6v3.8a2.4 2.4 0 0 0 0-3.8z" fill="currentColor" fill-opacity=".4"/>' +
    `<rect x="2" y="2" width="${w.toFixed(1)}" height="9" rx="2.2" fill="currentColor"/>`);
}

/** Signal strength, as the four rising bars a phone draws. `n` of them are lit. */
function signalIcon(n) {
  const lit = Math.max(0, Math.min(4, Math.round(Number(n) || 0)));
  const bars = [0, 1, 2, 3].map(i => {
    const h = 3.5 + i * 2.1;
    return `<rect x="${i * 4}" y="${(10.3 - h).toFixed(1)}" width="2.9" ` +
      `height="${h.toFixed(1)}" rx="1" fill="currentColor" ` +
      `fill-opacity="${i < lit ? '1' : '.28'}"/>`;
  });
  return svg('14.9 10.3', `Signal ${lit}/4`, bars.join(''));
}

/**
 * One drawn icon.
 *
 * `role="img"` with a label rather than `aria-hidden`, unlike every emoji in this
 * file: these two are not labels for a value stated beside them, they ARE the value,
 * and the signal has no text at all. The label doubles as what a pointer resting on
 * one reveals, which is how "3/4" is still reachable exactly.
 */
function svg(viewBox, label, body) {
  return `<svg class="ic" viewBox="0 0 ${viewBox}" role="img" aria-label="${label}" ` +
    `><title>${label}</title>${body}</svg>`;
}

/**
 * The weather, as its own line between the status bar and the run.
 *
 * One glyph, the temperature, and the phone's own wording for the sky. The glyph
 * stands in for the thermometer that used to sit beside the number: the sky and the
 * air temperature are one reading from one sensor, and giving each an icon made two
 * readings out of it.
 *
 * The label is kept next to the glyph rather than replaced by it. A glyph is a
 * category — "Rain and thunder" and "Isolated Thunderstorms" draw the same cloud —
 * and the label is the only place that distinction survives.
 */
function weatherHtml(point) {
  const weather = splitWeather(point.wthr);
  if (!weather) return '';

  // Two halves means a temperature and a sky; one means a sky alone, which is what a
  // phone that stopped gluing them together would send.
  const temp = weather.length === 2 ? weather[0] : null;
  const sky = weather[weather.length - 1];

  // The ping's own place, its own moment, and — where it snapped — the course's
  // height there: the same three arguments the 🌅 and 🌃 marks were placed from, so
  // the glyph on this line and the marks on the course cannot disagree about
  // whether a given minute was dark. A ping that missed the course passes no
  // height and gets the sea-level horizon, which is the honest answer when we do
  // not know how high it was standing.
  const [lon, lat] = posOf(point);
  const night = isDaylight(point.t, lat, lon, point.snap?.ele ?? null)
    ? null
    : moonPhase(point.t, lat);

  return `<div class="wx"><span class="i" aria-hidden="true">${weatherIcon(sky, night)}</span>` +
    `${temp === null ? '' : `<span class="wt">${temp}</span>`}` +
    `<span class="wl">${sky}</span></div>`;
}

/**
 * One reading: a glyph, the answer, and quietly beside it the context.
 *
 * The two values are not typeset alike, which is the whole complaint about the rows
 * this replaces — a total and the leg that got there were the same size and the same
 * ink, so three answers read as six equal numbers.
 *
 * The glyph is `aria-hidden`. It is a label, the value beside it is the reading, and
 * a screen reader announcing "three o'clock 1h 23m" per row is worse than no label
 * at all. The row's own text is left to carry the meaning, which is why the units
 * stay in it: "1,240 m" says what it is without the arrow.
 */
/**
 * The leg beside a total — "+124 m" — or nothing when it rounds away.
 *
 * The guard is not cosmetic. `stats.down` comes back as fractions of a metre left
 * over from the elevation threshold, and `stats.dist` does the same when a snap
 * barely moved, so a run through a flat kilometre produced a column of "+0 m". Beside
 * a total, "+0 m" reads as a measured zero — "this leg was flat" — rather than as a
 * number too small to have a digit, which is a different claim.
 */
function leg(v, fmt) {
  return Math.round(v) > 0 ? `+${fmt(v)}` : null;
}

function reading(icon, primary, secondary = null, strong = false) {
  return `<div class="row${strong ? ' big' : ''}">` +
    `<span class="i" aria-hidden="true">${icon}</span>` +
    `<span class="p">${primary}</span>` +
    `<span class="s">${secondary === null || secondary === undefined ? '' : secondary}</span>` +
    '</div>';
}

/**
 * A weather label as one glyph.
 *
 * Matched on KEYWORDS in worst-first order rather than looked up in a table of
 * Apple's condition names, for two reasons.
 *
 * The phone composes its own wording. Every ping in this repo says "Sunny", which is
 * not any WeatherKit case description, so a table would be a table of guesses about
 * someone else's string formatting — and a label that misses it would draw nothing,
 * which is the one outcome worse than drawing something approximate.
 *
 * And the order is itself information. "Rain and thunder" is a thunderstorm and not
 * rain; "Partly Cloudy" is the cloud answer while "Mostly Clear" is the clear one.
 * Whichever pattern is tested first decides, so the ladder runs from the weather you
 * would most want to know about down to the weather you wouldn't.
 *
 * Night used to be deliberately not distinguished, on the grounds that a moon for
 * "Clear" at 02:00 needs a sunrise table to be right and would otherwise be wrong
 * for half the year anywhere far enough north — which is where these races tend to
 * be. [`sun.js`](sun.js) is now exactly that table, so the objection is spent: the
 * ladder still decides WHAT the weather was, and `night` decides how to draw it
 * once the sun is down.
 *
 * @param {string} label the phone's own wording.
 * @param {string|null} [night] the glyph to stand in for a sun after dark — the
 *   moon phase, from `weatherHtml`. A glyph rather than a boolean, so this stays a
 *   lookup and the astronomy stays in the module that owns it.
 */
function weatherIcon(label, night = null) {
  const s = String(label).toLowerCase();
  const hit = WEATHER.find(([pattern]) => pattern.test(s));
  const glyph = hit ? hit[1] : ICON.temp;

  if (night === null || !AFTER_DARK.has(glyph)) return glyph;
  return AFTER_DARK.get(glyph) ?? night;
}

// The three glyphs both tables below name, as constants rather than as the same
// literal typed twice. Two of them carry a variation selector and one does not, so
// a map keyed on a hand-copied glyph is a map that misses silently — and it has to
// be declared before `AFTER_DARK`, which reads it as the module loads.
const SUN = '☀️';
const PART = '⛅';
const CLOUD = '☁️';

/**
 * What the two glyphs that draw a SUN become once it has set.
 *
 * Only those two. Rain, fog, wind, snow and a thunderstorm look the same at
 * midnight as at noon, and drawing them differently would be inventing a
 * distinction the label does not make.
 *
 * `null` means "the moon" — whichever phase the caller worked out. ⛅ gets a plain
 * cloud instead, because Unicode has no moon behind a cloud: it has the sun behind
 * three different amounts of one and nothing lunar at all. So for the hours it
 * cannot be drawn, the three-way distinction between "Mostly Cloudy", "Partly
 * Cloudy" and "Mostly Clear" moves to the label sitting beside the glyph, which
 * still spells out which of them it was.
 */
const AFTER_DARK = new Map([
  [SUN, null],
  [PART, CLOUD]
]);

const WEATHER = [
  [/tornado/,                          '\u{1F32A}️'], // 🌪️
  [/hurricane|tropical|cyclone/,       '\u{1F300}'],       // 🌀
  // Before rain, so "Rain and thunder" is never merely rain.
  [/thunder|storm/,                    '⛈️'],    // ⛈️
  [/hail|sleet|wintry|freezing/,       '\u{1F9CA}'],       // 🧊
  [/blizzard|snow|flurr/,              '❄️'],    // ❄️
  [/drizzle|rain|shower/,              '\u{1F327}️'], // 🌧️
  [/fog|haze|hazy|smok|dust|mist/,     '\u{1F32B}️'], // 🌫️
  [/wind|breez|blustery/,              '\u{1F4A8}'],       // 💨
  // The three-way that the two rules below cannot make on their own. "Mostly Cloudy"
  // is the cloudy answer, while "Partly Cloudy" and "Mostly Clear" are both the
  // in-between one — so the qualifier has to be read together with what it qualifies,
  // and reading it first is what stops "Mostly Clear" arriving at a bare sun.
  [/mostly cloud/,                     CLOUD],   // ☁️
  [/partly|mostly|intermittent/,       PART],    // ⛅
  [/cloud|overcast|dreary/,            CLOUD],   // ☁️
  [/clear|sun|fair/,                   SUN],     // ☀️
  [/hot|frigid|cold/,                  ICON.temp]
];

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
 * A prediction, fenced off from everything that was measured.
 *
 * Built as a little diagram rather than as three sentences, because a forecast has a
 * shape: a moment in the middle, a window either side of it, and a width. So the
 * predicted time is centred, the bar under it grows outwards from that same centre,
 * the two edges of the window sit at the two ends of the bar, and the width of the
 * window is underneath. Everything lines up with the thing it describes, and the
 * reader never has to hold two times in their head to work out how far apart they are
 * — which is what "Likely 14:40 – 15:05" asked of them.
 *
 * The width sits between the two edges on their own line, which is where it is a
 * reading of the distance between them rather than a third figure under a pair. It
 * says only the duration: the bar directly above it already says the word "wide".
 *
 * Under all of it, the race clock at that moment — as an ordinary reading row, left
 * aligned and at full weight, which is exactly how a ping tooltip states the elapsed
 * time it measured. The two are the same reading, one measured and one predicted, and
 * typesetting them alike is what says so; the diagram above is the part that is a
 * diagram.
 *
 * @param {number}      t     the predicted moment
 * @param {number}      lo    near edge of the window
 * @param {number}      hi    far edge
 * @param {number}      [sinceStart] elapsed race time at that moment, when known
 * @param {number|null} [origin] for the day tag — a 30-hour race predicted to finish
 *   at "09:12" needs to say which morning.
 */
function predictionHtml({ t, lo, hi, sinceStart, origin = null }) {
  const stamp = ms => `${fmtHm(ms)}${dayTag(ms, origin) &&
    `<span class="d">${dayTag(ms, origin)}</span>`}`;

  return '<div class="pred">' +
    '<div class="k">Predicted</div>' +
    `<div class="pv">${stamp(t)}</div>` +
    uncertaintyBar(hi - lo) +
    `<div class="edges"><span>${stamp(lo)}</span>` +
    `<span class="wide">${fmtDuration(hi - lo)}</span>` +
    `<span>${stamp(hi)}</span></div>` +
    (sinceStart === undefined ? ''
      : reading(ICON.time, fmtDuration(sinceStart), null, true)) +
    '</div>';
}

/**
 * How wide a forecast window is, drawn as a length.
 *
 * The bar is the only thing in a tooltip that can be read without reading: two
 * predictions half an hour apart are worth comparing, and comparing "14:40 – 15:05"
 * with "16:02 – 16:11" means arithmetic. Its scale is `uncertaintyRefMs`, fixed, so
 * the same fill always means the same span — see config.js for why it cannot be
 * scaled to the window itself.
 *
 * The fill is centred in its track by the stylesheet, growing outwards from the middle
 * rather than rightwards from the left edge, because that is where the predicted time
 * sits and the window is symmetric about it. Growing from one end would have drawn the
 * near edge as fixed and the far edge as the only uncertain one.
 *
 * The width is an inline style because it is a datum rather than a styling choice:
 * there is no rule a stylesheet could hold that would know this number.
 */
function uncertaintyBar(ms) {
  const filled = Math.min(1, Math.max(0, ms / CONFIG.uncertaintyRefMs));
  return `<div class="bar"><i style="width:${(filled * 100).toFixed(1)}%"></i></div>`;
}

/**
 * "1,240 m" — a height or a climb, grouped, because four digits of metres is common
 * on the courses this is for.
 *
 * Pinned to `en-US` rather than left to the visitor's locale, which is what it used
 * to be. Every word in a tooltip is English — "Likely", "since last", "Open in
 * Google Maps" — so a number formatted to some other convention beside them is a
 * page that can't decide, and the same reasoning that took `Intl` out of the clock
 * applies: one wording, chosen here, testable anywhere.
 */
export function metres(v) {
  return `${Math.round(v).toLocaleString('en-US')} m`;
}

/**
 * The same pace as a speed: "11.4".
 *
 * Derived from ms per kilometre rather than measured separately, so the two rows can
 * never disagree — they are one measurement in two units, and computing them from
 * different numerators is how a tooltip ends up claiming 6:00/km and 9.7 km/h.
 *
 * One decimal, which is as much as the input is worth: the pace behind it came from
 * a snapped distance over a few minutes.
 */
function fmtSpeed(msPerKm) {
  return (3600000 / msPerKm).toFixed(1);
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
    // Before the fall-through below, which tests nothing at all: a sun POI carries
    // a `t` and would be described as a fix, complete with a battery it never had.
    if (object.kind === 'sun') return tip(sunTooltipHtml(object, originOf(getPoints())));

    const points = getPoints();
    const latest = latestOf(points);
    return tip(tooltipHtml(object, !!latest && latest.name === object.name, originOf(points)));
  };
}
