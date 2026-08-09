// deck.gl layer construction. `deck` is a global from the UMD bundle loaded by
// index.html, not an import.

import { CONFIG } from './config.js';
import {
  accent, course as courseColor, crew as crewColor, surface, viewer as viewerColor,
  prefersDark
} from './colors.js';
import { courseHoverAt, pathsBetween } from './course.js';
import { glyphAtlas, inkOf, inlineGlyph } from './glyphs.js';
import { isLive } from './github.js';
import { stillRunning } from './predict.js';
import { interpolateAt, originOf } from './stats.js';
import { isDaylight, moonPhase } from './sun.js';
import {
  ago, dayTag, escapeHtml, fmtClock, fmtDuration, fmtHm, fmtPace, mapsUrl
} from './util.js';
import { finishOf, fixesOf, latestOf, posOf, tracePath } from './points.js';
import { isVideo, THUMB_PX } from './media.js';

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

/**
 * The line through the run's own readings, drawn only when it has no course.
 *
 * Every ping, and every photograph that recorded where and when it was taken —
 * the marks this map draws in the accent. See below for why that is `points` and
 * not `fixesOf(points)`.
 *
 * Same colour and weight as a course, because it occupies the same place in the
 * picture: it is the shape of the run, under the readings. Dashed, because it is
 * the one thing a course isn't — nobody surveyed this. A course is a line
 * somebody drew and the phone was measured against; this is joined-up dots, and
 * between any two of them the runner went wherever they went. The dash is the
 * same admission the snap leashes make with the same extension.
 *
 * Not pickable, and there is no hit band under it either. `course-hit` earns its
 * width by having something to say — a distance along, a height, a prediction —
 * all of which come from the GPX. Here there is nothing behind the line that the
 * two pings at its ends don't already say better, and a 34 px band that answers a
 * hover with nothing would be a target that swallows the dots' own hovers.
 *
 * @param {Array} points sorted oldest-first, as from `buildPoints`.
 * @param {object|null} course the run's route. Present means this doesn't draw.
 */
export function traceLayers(points, course = null) {
  if (course) return [];

  // Every point, and NOT `fixesOf` — the one place in this file where a
  // photograph belongs in with the pings rather than held out of them.
  //
  // `fixesOf` exists to keep media out of four things it would break, and each of
  // those is about a photograph being the wrong KIND of answer: the latest fix,
  // the finish, the camera fit, a second dot under a thumbnail. None of that is
  // this. What is in the points array at all is a photograph that recorded its own
  // coordinates and its own moment — `point: true` in `placeMedia` — which is a
  // measurement of where the runner was, drawn in the accent every other
  // measurement gets. The run went through it, so the line goes through it. A
  // photograph placed BY interpolation never reaches this array, and must not: its
  // position was derived from the pings either side, so making it a knot would
  // drag the curve back onto the straight line it was read off.
  //
  // Neither does a CREW member's photograph, which has coordinates and a moment
  // and is `point: false` regardless — it is a measurement of where somebody who
  // isn't running was standing, and it is what would otherwise send this line on a
  // detour to an aid station.
  const data = tracedPath(points);
  if (!data.length) return [];

  return [new deck.PathLayer({
    id: 'trace',
    // One path, in a wrapper the memo owns: a fresh `[path]` every frame would
    // put a new `data` in front of deck sixty times a second and undo the point
    // of caching the path at all.
    data,
    getPath: p => p,
    widthUnits: 'pixels',
    getWidth: 3,
    widthMinPixels: 2,
    capRounded: true,
    jointRounded: true,
    // Firmer ink than the course's 180, which is the compensation a dash needs: a
    // course is a solid stroke and this one is off for more of its length than it
    // is on, so at matching alpha it read as the fainter line of the two. The dash
    // is already carrying the whole "this is inferred" argument on its own.
    getColor: [...courseColor(), 215],

    // `highPrecisionDash`, and NOT `dashJustified`. Both matter, and this is the
    // one place on the page where a smoothed path and a dash pattern meet.
    //
    // A dash is measured along a segment, and this line's segments are a twelfth
    // of a ping-to-ping span each — metres. Justified mode divides a segment into
    // a whole number of dashes, `unitLength / round(pathLength / unitLength)`, so
    // the moment a segment is shorter than one dash the divisor rounds to zero and
    // every fragment comes out solid. That is exactly what zooming out does: it is
    // the segment's length in LINE WIDTHS that the shader tests, so the dashes
    // survive up close and merge into a plain line as soon as the run fits on
    // screen — which is most of the time anyone is looking at it.
    //
    // Unjustified, each segment instead takes its phase from where it starts along
    // the whole path. That distance only exists as an attribute when
    // `highPrecisionDash` is on; without it the phase is zero for every segment,
    // so all twelve restart the pattern and the result is solid again by a
    // different route.
    extensions: [new deck.PathStyleExtension({ dash: true, highPrecisionDash: true })],

    // In multiples of the line width, not pixels — so on a 3 px line this is 12 px
    // of ink and 18 px of gap. More gap than ink, deliberately: an even dash at
    // this weight reads as a solid line with a texture on it, and the whole job of
    // the dash is to be seen NOT to be a course.
    getDashArray: [4, 6]
  })];
}

/** The last path built, as deck's one-element `data`, and what it came from. */
let traceMemo = { from: null, data: [] };

/**
 * `tracePath`, computed once per set of pings rather than once per frame.
 *
 * This stack is rebuilt at animation rate to drive the newest ping's pulse, and
 * the trace is the only thing in it doing real arithmetic — a spline over every
 * fix of the run, sixty times a second, for an answer that changes when the phone
 * pings. Keyed on the array's IDENTITY, which map.js replaces exactly when new
 * points arrive, so a stale path is not a thing that can happen.
 *
 * Holding the result also holds `data` steady between frames, which is what lets
 * deck skip re-uploading the geometry it just drew.
 */
function tracedPath(points) {
  if (points !== traceMemo.from) {
    const path = tracePath(points);
    // Empty rather than `[[]]` when there is nothing to join: `traceLayers` reads
    // the length of this to decide whether to draw at all.
    traceMemo = { from: points, data: path.length ? [path] : [] };
  }
  return traceMemo.data;
}

/** A waypoint's display name, or '' when it hasn't got one worth drawing. */
function waypointName(w) {
  return (w.name || w.sym || '').trim();
}

/**
 * Sunrise and sunset, marked where the run was when they happened.
 *
 * Two layers per mark. The dot is what a cursor picks and what carries the
 * tooltip; the icon is a picture of the moment, and is not pickable — like the
 * waypoint labels, a mark whose label answers a different hover is a bug.
 *
 * There used to be a third layer with the time typeset beside the icon, and it is
 * gone. Two marks a night, each with digits hanging off it, is a lot of furniture
 * on a route for a fact nobody reads off the map anyway — the tooltip says the
 * time to the minute, and says the date and the race clock with it. What the mark
 * has to say from across the screen is only "here is where the light changed",
 * and the drawing says that on its own.
 *
 * Drawn in the course's colour rather than the accent: these are annotations on
 * the route, in the same idiom as its waypoints, and the accent on this page
 * belongs to the runner.
 *
 * @param {Array} pois from [`sunPois`](sun.js).
 */
export function sunLayers(pois) {
  if (!pois.length) return [];

  const line = courseColor();
  const ring = surface();
  const marks = sunAtlas();

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

    // Nothing to draw until the drawings have loaded, which is a frame or two
    // after the first paint. The dot above is already there and already carries
    // the tooltip, so what a visitor sees in the meantime is a mark with no
    // picture on it yet rather than a missing mark.
    ...(marks ? [new deck.IconLayer({
      id: 'sun-glyph',
      // Not pickable, like the waypoint labels: the dot underneath owns the
      // tooltip, and a mark whose label answers a different hover is a bug.
      data: pois,
      iconAtlas: marks.atlas,
      iconMapping: marks.mapping,
      getIcon: p => p.event,
      getPosition: p => [p.lon, p.lat],
      getSize: SUN_PX,
      sizeUnits: 'pixels',
      // Centred over the dot — where a waypoint puts its name — rather than
      // shouldered to one side of it, which is what it had to be back when a
      // time was typeset alongside.
      getPixelOffset: [0, -SUN_PX / 2 - 5],
      // The atlas is null until the SVGs load and then never changes again, so
      // this is one rebuild in the life of the page.
      updateTriggers: { getIcon: marks }
    })] : [])
  ];
}

/** How big a sun mark is drawn, in whole cells — see `CELL_PX` for why the
 *  drawing inside one comes out a sixth smaller than this. */
const SUN_PX = 30;

/** Built once and kept: the palette is read once per page too, so there is no
 *  colour in here that can change under it. Not memoised until it EXISTS, so the
 *  paints before the drawings land don't cache their own absence. */
let sunAtlasMemo = null;

/** The two marks as one texture. Null until `loadGlyphs` has settled. */
function sunAtlas() {
  return sunAtlasMemo ??=
    glyphAtlas(['sunrise', 'sunset'], inkOf(courseColor()), inkOf(surface()));
}

/**
 * Photographs and clips, as thumbnails on the map.
 *
 * Two layers, in the sun's idiom with the pickability the other way round. There
 * the dot is what you point at and the glyph beside it is a label; here the
 * picture IS the mark, so it owns the tooltip and the dot under it is the
 * annotation — a 44 px marker has to float clear of the route to be legible, and
 * a mark that has moved off its own coordinate needs something left behind saying
 * where that was.
 *
 * The upward offset is also what keeps the pings reachable, and this is the same
 * measurement `allLayers` records for the sun marks reversed. deck picks the
 * topmost pickable layer; a 44 px box sitting ON the coordinate would swallow the
 * 16 px hit disc of every fix underneath it, and on a course pinged every five
 * minutes that is several. Lifted, the box sits mostly in empty ground above the
 * route and the ping below stays pointable.
 *
 * The dot is coloured by where its position CAME FROM, which is the only thing
 * about a photograph the map can be wrong about. A file carrying its own GPS was
 * somewhere, and is the accent every other measured fix on this page is. A file
 * carrying only a filename was placed between the two pings either side, and is
 * the course purple — the same colour, for the same reason, as a sunrise mark:
 * both are computed ONTO the route rather than read off a device, and neither
 * tells you anything new about the runner. Reserving the accent for real readings
 * is what stops an interpolation from looking like evidence.
 *
 * The third colour answers a different question from the other two. Those say how
 * well the map knows where a photograph was taken; magenta says the photograph is
 * not about the runner at all — it came off a CREW member's phone, and the person
 * in front of that camera was standing somewhere the runner wasn't. It is the one
 * mark on the media layer whose position is exactly as measured as an accent dot
 * and still tells you nothing about the race, which is why it cannot share a
 * colour with either of them. See `crewOf` in [media.js](media.js).
 *
 * @param {Array} pois from [`placeMedia`](media.js).
 * @param {{atlas, mapping}|null} atlas from `buildMediaAtlas`, once its images
 *   have decoded. Null until then, and only until then: every POI gets a cell,
 *   and a file that would not decode gets a dark one with the ▶ badge on it. So
 *   the dots-alone state is a loading state and nothing else.
 */
export function mediaLayers(pois, atlas) {
  if (!pois?.length) return [];

  const ring = surface();
  const measured = accent();
  const inferred = courseColor();
  const theirs = crewColor();

  const fill = poi =>
    poi.source === 'exif' ? measured :
    poi.source === 'crew' ? theirs : inferred;

  return [
    new deck.ScatterplotLayer({
      id: 'media-dot',
      // Not pickable: the thumbnail above it owns the tooltip, and two pickable
      // layers over one mark are two answers to one question.
      data: pois,
      radiusUnits: 'pixels',
      getPosition: p => [p.lon, p.lat],
      getRadius: 4,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      getLineColor: [...ring, 255],
      getFillColor: p => [...fill(p), 255]
    }),

    // Until the atlas lands there is nothing above the dots, so for those few
    // seconds they are the whole of the mark and answer for themselves. Invisible,
    // generous, and pickable, in the idiom of `course-hit`. It goes away the moment
    // the thumbnails arrive, which is what keeps the rule below true: one mark, one
    // tooltip, and the picture owns it wherever there is one.
    ...(atlas ? [] : [new deck.ScatterplotLayer({
      id: 'media-hit',
      data: pois,
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: p => [p.lon, p.lat],
      // Wider than the 4 px dot it stands over, because a dot drawn that small is
      // aimed at rather than hit.
      getRadius: 10,
      getFillColor: [0, 0, 0, 0]
    })]),

    ...(atlas ? [new deck.IconLayer({
      id: 'media',
      data: pois,
      pickable: true,
      iconAtlas: atlas.atlas,
      iconMapping: atlas.mapping,
      // Every POI has a cell, decoded or not — see `buildMediaAtlas`. A clip whose
      // frame would not come gets a dark one with the ▶ on it, which is a marker
      // you can read and point at rather than a hole in the layer.
      getIcon: p => p.name,
      getPosition: p => [p.lon, p.lat],
      getSize: THUMB_PX,
      sizeUnits: 'pixels',
      getPixelOffset: [0, -(THUMB_PX / 2 + 8)],
      updateTriggers: { getIcon: atlas }
    })] : [])
  ];
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
 * A ping the snapper TURNED DOWN is drawn the same way as a raw position, because
 * that is exactly what it is: a fix with no place on the course. It used to be
 * indistinguishable from a snapped one — same size, same solid orange — which
 * made the map assert something the snapper had explicitly declined to say, and
 * put the eye on the least trustworthy marks on the page. Faint, they read as
 * what they are: the phone was here, and the route was somewhere else.
 *
 * That only means anything when there is a course to be off. Without one nothing
 * is snapped and every ping is simply a ping, drawn solid.
 *
 * A photograph that carried its own GPS gets the audit trail and nothing else from
 * this function — its faint raw dot and its dashed leash, with the thumbnail from
 * `mediaLayers` standing in for the solid dot at the far end. It earns the trail on
 * the same terms a ping does: it is a reading the snapper moved, and how far it
 * moved is not a thing the map should keep to itself.
 *
 * @param {Array} points sorted oldest-first, each maybe carrying `snap`
 * @param {number} pulse 0..1, drives the halo on the newest fix
 * @param {object|null} course the run's route, when it has one
 */
/**
 * What the newest fix is: a runner still out there, a phone that has gone quiet,
 * or a race the phone itself called done.
 *
 * Pure, and separated out because it decides the two most visible things on the
 * map — whether the orange dot pulses, and whether a still ring stands around it
 * instead — and neither of those can be unit-tested through a deck.gl layer.
 *
 * `finished` is the phone's own assertion and outranks everything: `is_finish` on
 * the last fix means the runner crossed the line, and that stays true tomorrow, in
 * a week, and next year. It is the one state on this map that never goes stale.
 *
 * `live` is not a second opinion — it is [`stillRunning`](predict.js), the very
 * rule the status panel's clock and dot are drawn from, so the halo and the panel
 * cannot end up saying different things about one run. The record it wants is
 * built from the newest PING rather than taken from the index, which is the same
 * fact one poll sooner: the points are what this layer already has in its hand.
 *
 * Only a live run pulses. A pulse is a claim that something is happening NOW, and
 * the two cases where nothing is are exactly these — the race is over, or the
 * runner could no longer plausibly still be out on the course. Left pulsing, a fix
 * from three weeks ago reads as a runner standing on a mountain, which is the one
 * thing this map must never say.
 *
 * @param {Array} points fixes only, oldest-first — see `fixesOf`.
 * @param {object|null} [forecast] from `buildForecast`; without it a quiet phone
 *   is simply quiet, which is the honest answer on a run with no course.
 * @param {number} [now]
 */
export function latestState(points, forecast = null, now = Date.now()) {
  const latest = latestOf(points);
  const finish = finishOf(points);
  const live = stillRunning({ finish, record: { latest: latest?.t }, forecast, now });
  return { latest, finished: !!finish, live };
}

/**
 * @param {object|null} [forecast] for the liveness the halo rides on — see
 *   `latestState`.
 */
export function pointLayers(all, pulse, course = null, forecast = null) {
  // Media that carried its own coordinates rides in the points array so that it
  // snaps and counts, but it gets no dot, no hit disc and no halo here: it has a
  // thumbnail of its own, and a dot under that thumbnail is one mark claimed by
  // two layers — with two tooltips to match. See `mediaLayers`.
  const points = fixesOf(all);
  const { latest, finished, live } = latestState(points, forecast);
  const latestData = latest ? [latest] : [];
  const ring = surface();
  const fill = accent();

  // Only the ones that actually moved. For an unsnapped ping the two positions
  // are the same, so there is nothing to draw faintly and nothing to join up.
  //
  // Media IS included, and this is the one place it is. What the audit trail shows
  // is how far the snapper moved a reading, and that question is asked of a
  // photograph for exactly the reasons it is asked of a ping — more so, since a
  // thumbnail sits 30 px above its anchor and the eye has further to travel to
  // check it. Excluding media here would have made the map quieter about the marks
  // it had corrected most recently.
  const moved = all.filter(p => p.snap);

  // Fixes the snapper declined to place, and the ones it placed. Both pings only:
  // a turned-down photograph already draws its own anchor at the raw position, and
  // a snapped one draws it on the course. Split only when there is a course —
  // `rejected` has to be empty on a run without one, or every ping on it would be
  // drawn as a refusal.
  const rejected = course ? points.filter(p => !p.snap) : [];
  const placed = course ? points.filter(p => p.snap) : points;
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
      // Not pickable: whatever sits at the far end of the leash owns the tooltip —
      // the snapped dot for a ping, the thumbnail for a photograph.
      radiusUnits: 'pixels',
      getPosition: p => [p.lon, p.lat],
      getRadius: 3,
      getFillColor: [...fill, 45]
    })
  ] : [];

  return [
    ...audit,

    // The turned-down fixes, drawn exactly as `raw` above draws a snapped ping's
    // real position — same size, same alpha — because they are the same kind of
    // mark. Deliberately NOT inside `audit`: that stack is gated on something
    // having snapped, and a run where nothing has yet is precisely when these are
    // the only pings there are.
    //
    // Still picked by `points-hit` below, so a faint dot keeps its full tooltip.
    // Quiet is not the same as unavailable, and "why is this one off the course?"
    // is a question the map should keep answering.
    new deck.ScatterplotLayer({
      id: 'rejected',
      data: rejected,
      radiusUnits: 'pixels',
      getPosition: p => [p.lon, p.lat],
      getRadius: 3,
      getFillColor: [...fill, 45]
    }),

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
      // The placed fixes only. A rejected one is drawn faintly above instead, and
      // drawing it here as well would put a solid dot back on top of it.
      data: placed,
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

    // Pulsing halo, so a newly arrived fix is visible without hunting for it —
    // and ONLY while there is something arriving. See `latestState`: a finished
    // race and a phone that has gone quiet both get the bare dot, because a pulse
    // means "now" and neither of them is happening now.
    //
    // A finished run gets a still ring in its place, at the halo's mid-size. The
    // mark is the last thing on the course anybody looks at, and without it the
    // newest fix would shrink to the size of every other ping the moment the
    // runner crossed the line.
    ...(live ? [
      new deck.ScatterplotLayer({
        id: 'latest-halo',
        data: latestData,
        radiusUnits: 'pixels',
        getPosition: posOf,
        getRadius: 11 + pulse * 9,
        getFillColor: [...accent(), Math.round(70 - pulse * 45)],
        updateTriggers: { getRadius: pulse, getFillColor: pulse }
      })
    ] : finished ? [
      new deck.ScatterplotLayer({
        id: 'latest-halo',
        data: latestData,
        radiusUnits: 'pixels',
        getPosition: posOf,
        getRadius: 15,
        getFillColor: [...accent(), 48]
      })
    ] : []),

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
  //
  // And when the runner stood still, the row says so instead of disappearing. A
  // tooltip that is silent about pace is indistinguishable from one whose pace
  // could not be worked out, and on a trail run the stops are half the story.
  if (stats?.pace !== undefined) {
    rows.push(reading(ICON.pace, `${fmtPace(stats.pace)}&thinsp;min/km`,
      `${fmtSpeed(stats.pace)}&thinsp;km/h`));
  } else if (stats?.paused) {
    rows.push(reading(ICON.pace, '&ndash;&thinsp;paused'));
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

/**
 * What KIND of place a waypoint is — "Aid station", "Summit" — or '' when the
 * file doesn't say.
 *
 * Not to be confused with the `kind` the layer stamps on its data, which is what
 * the tooltip dispatches on. This is the waypoint's own `<type>`, or its `<sym>`
 * for the exporters that use that instead.
 *
 * Two values are treated as silence rather than as answers: "GENERIC" is the
 * UTMB export's way of saying it has no category for this one, and MapOut writes
 * "Waypoint" into every `<sym>` it produces. Both would put a label on the card
 * that says nothing the card doesn't already say.
 *
 * Shouty enum values are sentence-cased — "AID STATION" is a database column, not
 * a thing to read — but anything already mixed-case is left alone, because there
 * the exporter chose the capitals and may have had a proper noun in mind.
 */
function waypointKind(waypoint) {
  const raw = (waypoint.type || waypoint.sym || '').trim();
  if (!raw || /^(generic|waypoint)$/i.test(raw)) return '';
  return raw === raw.toUpperCase() ? raw[0] + raw.slice(1).toLowerCase() : raw;
}

/** Tooltip markup for a course waypoint — a place, not a moment. */
export function waypointTooltipHtml(waypoint) {
  const kind = waypointKind(waypoint);
  // The kind stands in as the title for a waypoint with no name of its own — an
  // unnamed summit is better called "Summit" than "Waypoint" — and in that case
  // it has been spent, so it doesn't also appear as the aside beside itself.
  const name = waypoint.name || kind || 'Waypoint';
  const aside = kind && kind !== name ? `<span class="k">${escapeHtml(kind)}</span>` : '';

  const rows = [titleHtml(escapeHtml(name), aside)];
  if (waypoint.ele !== null && waypoint.ele !== undefined) {
    rows.push(reading(ICON.ele, metres(waypoint.ele)));
  }
  // No coordinate row, for the reason the ping tooltip no longer has one. A named
  // place with no height is then a name and a link, which is all a waypoint is.
  rows.push(mapsLink(waypoint.lat, waypoint.lon, name));
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
 * One figure in the caption bar: a glyph and a number, side by side.
 *
 * Deliberately not `reading()`. That is a three-column grid built so a COLUMN of
 * readings lines its answers up, and there is no column here — the caption is one
 * line laid over a picture, and the thing that has to fit is the picture.
 */
function capStat(icon, value) {
  return `<span class="cv"><span class="i" aria-hidden="true">${icon}</span>${value}</span>`;
}

/**
 * One of the controls laid over a pinned photograph.
 *
 * `data-act` is the whole interface between this file and the click handler:
 * layers.js knows what the buttons ARE and map.js knows what they DO, and neither
 * has to import the other. pin.js delegates one listener on the element rather
 * than binding three per selection, which matters because the card's markup is
 * replaced wholesale every time the pin moves.
 *
 * `disabled` rather than absent at the ends of the run. A button that vanishes
 * takes its neighbours' positions with it, so the one you meant to press next is
 * no longer where you were about to press — and there is no way to tell "there is
 * nothing further this way" from "this viewer has no such control".
 *
 * The mark is a drawing rather than a character, and its file is `icons/<act>.svg`
 * — the button's action names its own icon, which is why there is no table here
 * mapping one to the other. `‹`, `›` and `⤢` were the obvious thing and are wrong
 * in both of the ways a character is wrong inside a small disc; prev.svg records
 * why at length.
 *
 * Inlined rather than loaded through an `<img>`, which is what keeps
 * `currentColor` working: the mark has to be the button's ink, in both colour
 * schemes and while disabled, and an image cannot inherit that.
 */
function mediaButton(act, label, enabled = true) {
  return `<button type="button" class="mb ${act}" data-act="${act}" ` +
    `title="${label}" aria-label="${label}"${enabled ? '' : ' disabled'}>` +
    `${inlineGlyph(act)}</button>`;
}

/**
 * Tooltip markup for a photograph or a clip.
 *
 * The one tooltip on this page that is not a card with a picture in it. It is the
 * picture, edge to edge — the stylesheet drops the card's padding for it — with
 * the readings laid over the foot of the image the way a phone's photo viewer
 * lays them over a frame. Everything here follows from that: whoever clicked a
 * thumbnail wants to see the photograph, and a 44 px marker is not seeing it.
 *
 * So the caption carries only what a caption can carry without becoming a list —
 * the clock, then the elapsed, the distance and the height. No Maps link: the
 * marker is already ON the map, at the place in question, which is the one context
 * where "open this somewhere else" answers nothing. No provenance line either;
 * that fact now lives in the colour of the dot the picture floats above — accent
 * for a photo that recorded its own coordinates, course purple for one placed
 * between the pings either side. See `mediaLayers`.
 *
 * With ONE exception, and it is an exception because it is not provenance: the
 * byline, over the top-left corner where a photograph's credit goes. That the
 * runner is not in a crew member's photograph and was not standing where it was
 * taken is the only thing on this card a reader could get badly wrong, and "badly
 * wrong" is the test for what earns words rather than a colour — words read before
 * the picture rather than after the clock.
 *
 * Which is also why the RUNNER's own name goes there when a run gives one, and why
 * it is optional. A byline on every picture is what makes a byline mean "whose",
 * rather than "this one is odd"; but a run that names nobody has no comparison to
 * draw, and a credit on every photograph in a folder where they are all the same
 * person's is a label saying nothing four hundred times.
 *
 * Two admissions survive, because dropping them would be dropping facts rather
 * than dropping furniture, and both fit in the space an annotation takes:
 *   - a distance interpolated across a long blackout is prefixed `~`, where the
 *     old row said `interpolated across 2h 5m` underneath itself;
 *   - a time read off a camera clock that named no zone gets `zone?` beside it,
 *     in the same raised, quietened style as the day tag. Rare by construction —
 *     `placeMedia` only trusts an EXIF clock when the filename had no timestamp.
 *
 * A file whose name carries no time has no moment to put in the caption, so its
 * filename goes there instead and the elapsed drops away — the waypoint
 * treatment, for a thing that has become a place. Unless it carries a caption of
 * its own, in which case that is plainly the better label and the filename goes.
 *
 * A caption — `ImageDescription`, what the phone's share sheet calls a caption —
 * is the one line here that a person wrote rather than a sensor recorded, and it
 * sits above the readings for that reason.
 *
 * @param {object} poi from [`placeMedia`](media.js).
 * @param {number|null} [origin] the moment the run's clock counts from.
 * @param {{prev: boolean, next: boolean}|null} [controls] whether to lay the
 *   expand and step buttons over the picture, and which of the two steps lead
 *   anywhere. Only the PINNED card passes this, and that is not a style choice:
 *   the hover tooltip ignores the pointer outright — see `makeTooltip` — so a
 *   button drawn on it could be seen and never pressed, which is worse than no
 *   button at all. A click is what makes the card reachable, and a click is
 *   already how you pin one.
 */
export function mediaTooltipHtml(poi, origin = null, controls = null) {
  // A `<video>` rather than an `<img>` only where one is needed. A GIF animates
  // perfectly well as an image, and wrapping it in a player would give it
  // controls it has no use for.
  const src = encodeURI(poi.url || '');
  const frame = isVideo(poi.name)
    ? `<video class="media" src="${src}" autoplay loop muted playsinline></video>`
    : `<img class="media" src="${src}" alt="">`;

  // Over the picture rather than under it, for the reason the readings are: the
  // card has no room that isn't photograph, and a strip of chrome below the image
  // would be the one edge the picture didn't reach.
  const buttons = !controls ? '' :
    mediaButton('expand', 'See it full size') +
    mediaButton('prev', 'Previous photo', controls.prev) +
    mediaButton('next', 'Next photo', controls.next);

  // What somebody typed about the picture, if they typed anything — and the only
  // line on this card that isn't a measurement. It goes ABOVE the readings rather
  // than after them: the words are what the photograph is about, and the clock and
  // the distance are the annotation on it, which is the order every other tooltip
  // on this page puts a fact and its caveats in.
  const said = poi.caption ? `<span class="cq">${escapeHtml(poi.caption)}</span>` : '';

  // Whose camera — a byline over the top-left corner of the picture, where a
  // photograph's credit goes.
  //
  // Set for a crew member's photograph always, and for the runner's own when the
  // run named him. `place` decides which; both arrive here as `by`, because a
  // credit is a credit and a card that signed one person's pictures and left the
  // other's bare would read as though only one of them had been vouched for.
  //
  // Deliberately NOT down in the caption with the day tag and the `zone?` caveat,
  // which is where this started. Those are annotations on a reading: small print
  // qualifying a number somebody has already read. This is not a qualification of
  // anything on the card, it is a correction to the assumption somebody brings TO
  // the card — that a photograph on this map is a photograph of the run. It has to
  // be read before the picture, not after the clock, so it sits where a credit sits
  // and says "by" rather than standing as a bare name that could be the subject.
  //
  // Solid and light rather than the caption's scrim, and that is the same argument
  // `.mb` makes in reverse: over an unknown photograph, contrast has to be supplied
  // rather than hoped for. A dark badge would have matched the chrome; a light one
  // is the only thing on this card that reads as a label ON the photograph instead
  // of part of its furniture.
  const by = poi.by ? `<span class="by">by ${escapeHtml(poi.by)}</span>` : '';

  const day = poi.t === null ? '' : dayTag(poi.t, origin);

  // A filename is what goes in the title when nothing better is known. A caption is
  // something better, so `IMG_4021` is dropped rather than set beside it — two
  // labels for one picture, one of them meaningless.
  const title = poi.t === null
    ? (poi.caption ? '' : escapeHtml(String(poi.name).replace(/\.[a-z0-9]+$/i, '')))
    : `${fmtClock(poi.t)}${day ? `<span class="d">${day}</span>` : ''}` +
      `${poi.assumedUtc ? '<span class="d">zone?</span>' : ''}`;

  const stats = [];
  if (origin !== null && poi.t !== null && poi.t >= origin) {
    stats.push(capStat(ICON.time, fmtDuration(poi.t - origin)));
  }
  if (poi.along !== null && poi.along !== undefined) {
    const about = poi.gap > CONFIG.maxPingMs ? '~' : '';
    stats.push(capStat(ICON.dist, `${about}${fmtDistance(poi.along)}`));
  }
  if (poi.ele !== null && poi.ele !== undefined) stats.push(capStat(ICON.ele, metres(poi.ele)));

  return `<figure class="ph">${frame}${by}${buttons}<figcaption class="cap">` + said +
    (title ? `<span class="ct">${title}</span>` : '') +
    (stats.length ? `<span class="cs">${stats.join('')}</span>` : '') +
    '</figcaption></figure>';
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
  bpm:  '❤️' // ❤️
  // The sunrise and sunset pair used to live here as 🌅 and 🌃. They are drawings
  // now, in `icons/`, for the reason `glyphs.js` records: an emoji is a different
  // picture on every platform, and the pair had to be chosen for being unlike EACH
  // OTHER rather than for being like what they depict. Two icons we draw ourselves
  // can be both.
};

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
 * The two icons below are the only ones left in code rather than in `icons/`, and
 * that is not an oversight. Every other mark on this page is a picture of a fixed
 * thing — a sunrise is a sunrise — but these two carry their READING in their
 * geometry: the fill rectangle's width IS the charge, and which bars are lit IS
 * the signal. There is nothing to move to a file that would not have to be
 * regenerated from a number the moment it was drawn.
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
 * That override is also a trap, and `tip` below is built around the two halves of
 * it. deck positions the tooltip with `transform: translate(x, y)` at the raw
 * pointer coordinate — the card's top-left CORNER lands on the cursor, with no
 * offset — so a card that accepts pointer events is a card sitting under the
 * pointer that is keeping it open. For the tooltips with a link in them that is
 * the bargain: the corner is 9 px of padding, the cursor is already moving away
 * from it, and being able to click the link is worth it. For a photograph it is
 * not a bargain at all — there is nothing to click, and the corner is 340 px of
 * opaque picture laid over the very thumbnail deck is picking. The canvas stops
 * seeing the pointer, the pick comes back empty, the tooltip hides, the canvas
 * sees the pointer again, and the whole thing runs at pointer-event rate.
 *
 * The second half is `same`. deck calls this on EVERY pointer move and
 * `setTooltip` assigns `innerHTML` unconditionally, so a stationary tooltip has
 * its whole subtree destroyed and rebuilt dozens of times a second. Mostly that
 * is invisible waste; with media in it, it is not. A fresh `<img>` element
 * repaints, and a fresh `<video autoplay>` seeks back to zero — a clip could
 * never play more than one pointer-move's worth of itself. Omitting the `html`
 * key entirely is what stops it: deck's own `e.html && (...innerHTML = e.html)`
 * leaves the DOM alone and moves the card it already has. #pin guards its own
 * writes the same way, for the same reason.
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
  // What the tooltip element is currently showing, so an unchanged card can be
  // moved rather than rebuilt. Not reset when the tooltip hides: deck keeps one
  // element and hiding it is `display: none`, so its subtree is still there and
  // still correct when the same thing is hovered again.
  let shown = null;

  const tip = (html, pointerEvents = 'auto') => {
    if (!html) return null;
    const same = html === shown;
    shown = html;
    return { ...(same ? {} : { html }), className: 'tip', style: { pointerEvents } };
  };

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
    // And a photograph carries one too — plus, when it recorded its own
    // coordinates, everything else a fix has, because it IS one. It still wants
    // its own tooltip: what makes it worth pointing at is the picture.
    //
    // The one tooltip deck's default `pointer-events: none` is right for. There
    // is nothing in it to click — the Maps link went when the picture took the
    // whole card — so nothing is lost, and what is gained is that the card cannot
    // cover the thumbnail holding it open. See the note above `makeTooltip`.
    if (object.kind === 'media') {
      return tip(mediaTooltipHtml(object, originOf(getPoints())), 'none');
    }

    const points = getPoints();
    const latest = latestOf(points);
    return tip(tooltipHtml(object, !!latest && latest.name === object.name, originOf(points)));
  };
}
