// Owns the deck.gl instance, the camera, and the follow-latest behaviour.
// Data comes in through setPoints(); nothing here knows about GitHub.

import { CONFIG } from './config.js';
import { courseBounds, courseHoverAt, pointAt } from './course.js';
import { loadGlyphs } from './glyphs.js';
import {
  basemapLayer, beaconLayers, courseLayers, forecastLayers, hoverLayers, hoverTooltipHtml,
  makeTooltip, mediaLayers, mediaTooltipHtml, pointLayers, sunLayers, sunTooltipHtml,
  tooltipHtml, traceLayers, viewerLayers, waypointTooltipHtml
} from './layers.js';
import { createPin } from './pin.js';
import { boundsOf, fixesOf, latestOf, posOf, unionBounds } from './points.js';
import { positionAt } from './predict.js';
import { interpolateAt, originOf } from './stats.js';

/**
 * A view state with any in-flight transition props stripped off.
 *
 * They have to come off before the state is reused as a plain camera position:
 * deck reads them on every controlled value it is handed, so a state left
 * carrying them re-animates a move that was meant to be instant.
 */
const withoutTransition = ({
  transitionDuration, transitionInterpolator, onTransitionEnd, onTransitionInterrupt, ...rest
}) => rest;

export function createMap(container, {
  onFollowChange = () => {},
  onCourseHover = () => {},
  onSelect = () => {},
  onScrub = () => {},
  onBeaconPick = () => {},
  onExpand = () => {}
} = {}) {
  let points = [];
  let course = null;
  // The other runs, each as one dot where it was last seen. Not part of this
  // view's subject — they are the way OUT of it, to another run.
  let beacons = [];
  // Where the person LOOKING at the page is, once they have asked to be shown —
  // `{ lat, lon, accuracy }`, or null, which is the default. Not part of the run
  // and not part of the camera: acquiring it never moves the view. See
  // `viewerLayers`.
  let viewer = null;
  // The run's pace model, or null, and where it says the runner is AT THIS
  // MOMENT — `{ along, lo, hi }` in metres, from `positionAt`. A prediction of a
  // TIME has no place on a view whose axes are both space, but a prediction of a
  // place on the course does, and it is the same mark the height strip carries.
  let forecast = null;
  let marker = null;
  // Sunrise and sunset, placed where the run was when they happened. Derived from
  // the points and pushed in from main.js rather than computed here, so the map and
  // the height strip are marking one set of moments rather than two.
  let sun = [];
  // Photographs and clips, placed. Derived in main.js from the same pings this
  // view draws, and pushed in beside the sun for the same reason — one set of
  // marks, not two. `mediaAtlas` is the texture their thumbnails are cut from,
  // and it arrives a moment later than they do: the pictures have to decode.
  let media = [];
  let mediaAtlas = null;
  let hover = null;      // [lon, lat] on the course, from the profile strip
  // The pinned point, from a click in either view. While one is held the map's
  // hover tooltip is suspended and the crosshair stops chasing the cursor.
  let selection = null;
  const pin = createPin(undefined, act => pinAction(act));
  let viewState = { longitude: 0, latitude: 20, zoom: 1.4, pitch: 0, bearing: 0 };
  let follow = true;
  let fitted = false;
  // Whether the next fit should be flown or jumped. A first load has nowhere to
  // fly FROM, so it jumps; a run switch has, and flying it is what makes the two
  // races read as two places on one map rather than as two page loads.
  let flyOnFit = false;
  let flying = false;
  // Which camera move is the current one. Only its own callbacks may act — see
  // `settle`.
  let flight = 0;
  let pulse = 0;
  // Mid-drag: the pinned point is being slid along the course. While this is
  // true the camera controller is switched off entirely — see `pointerdown`.
  let dragging = false;
  // The last place on the course the drag reached. Dragging the pointer off the
  // route must leave the marker ON the route rather than dropping it, so when
  // `courseHoverAt` comes back empty this is what stands.
  let dragAlong = null;
  // Whether this drag has actually moved the point yet. A press that goes
  // nowhere is not a drag — it is the click that puts the point down.
  let dragMoved = false;
  // Whether the last press came from a finger rather than a cursor.
  //
  // This is what stops a tap producing TWO tooltips. deck shows its hover
  // tooltip from the same press that then pins the point, and on a touch screen
  // nothing moves afterwards to take it away again — so the hover tooltip sat
  // beside the pinned one until the map was next panned. A finger has no hover
  // to report in the first place: its tap is a click on its way to happening.
  let touchInput = false;

  /** The whole stack, in draw order. One place, so nothing can disagree. */
  function allLayers() {
    return [
      basemapLayer(),
      // Under the course and the pings, deliberately: another race is context for
      // this one, and nothing about it may sit on top of the reading.
      ...beaconLayers(beacons),
      // Under the course as well, and for a sharper reason than the beacons: the
      // accuracy circle can be a kilometre across, and drawn over the route it
      // would wash the race out. The cost is that a visitor standing on the
      // course can be partly covered by a ping — but the halo still reads around
      // the edge of one, and the race is what the page is for.
      ...viewerLayers(viewer, pulse),
      ...courseLayers(course),
      // The stand-in for a run that has no GPX: a dashed line through its own
      // pings, in the course's place in the stack because it is playing the
      // course's part. Draws nothing when there IS a course — the two would be
      // saying the same thing twice, and disagreeing wherever a snap had moved a
      // fix.
      ...traceLayers(points, course),
      // Above the course and under the pings, which is the same order the height
      // strip draws these two in. The band is a guess about the course; a ping is
      // a measurement. Drawn last it covered the pulsing dot whenever the phone
      // went quiet for a while and the band slid over the newest fix — hiding the
      // one mark on the map that is actually known, behind the one that isn't.
      ...forecastLayers(course, marker),
      // The forecast goes in for one reason: it decides whether the newest fix
      // still pulses. A mountain with no network is an hour of silence on a run
      // that is plainly still happening, and the panel's clock already knows not
      // to call that finished — see `latestState`.
      ...pointLayers(points, pulse, course, forecast),
      // Above the pings, which took a measurement to get right: deck picks the
      // TOPMOST pickable layer, `points-hit` is a 16 px disc around every fix, and
      // a sun mark is interpolated between two pings five minutes apart — so
      // underneath, its dot sat inside a ping's hit disc at every usable zoom and
      // hovering a sunrise returned the neighbouring ping's tooltip. Verified in a
      // browser, not reasoned about.
      //
      // The cost is the reverse of that: where a mark lands on a fix, the mark's
      // 5 px wins the middle of that fix's 16 px. Which is the same trade
      // `points-hit` itself makes against the course band under it — the smaller,
      // more specific target owns the pixels it covers, and the ping is still
      // there six pixels away.
      // Above the pings for the reason just given, and BELOW the sun for its
      // mirror image: a thumbnail is 44 px and a sun mark is 5, so with the order
      // reversed a photograph that happened to land on a sunset would take the
      // whole of it. The smaller, more specific target keeps the pixels it covers.
      ...mediaLayers(media, mediaAtlas),
      ...sunLayers(sun),
      ...hoverLayers(hover)
    ];
  }

  /**
   * Recompute where the runner probably is. The strip's `refreshMarker` gates a
   * redraw on it; here there is nothing to gate — `tick()` rebuilds the stack
   * every frame regardless.
   *
   * `positionAt` gives null once the prediction has run off the end of the
   * course, which is what takes the marker away when a run goes quiet: a phone
   * that stopped reporting three days ago is not "probably at the finish line".
   */
  function refreshMarker() {
    marker = course && forecast ? positionAt(forecast, Date.now()) : null;
  }

  /**
   * What a click landed on, as a selection — or null for bare basemap.
   *
   * The same three cases `onHover` dispatches on, and the markup comes from the
   * same functions the hover tooltip uses, so a pinned point reads exactly like
   * a hovered one.
   *
   * @param {object} info deck.gl's picking info.
   * @returns {import('./pin.js').Selection|null}
   */
  function describe(info) {
    const { object, layer, coordinate } = info;

    if (object?.kind === 'waypoint') {
      return {
        view: 'map',
        html: waypointTooltipHtml(object),
        lat: object.lat,
        lon: object.lon,
        along: object.along ?? null
      };
    }

    // A sun mark. Above the ping branch below, not beside it: this object has a
    // `t` too, so the order of these two decides which one describes it.
    //
    // `along: null` even though the mark has one. That leaves it pinnable and not
    // draggable, which is right — a sunrise is a fixed fact about a moment, and
    // sliding it down the course would be sliding the sun.
    if (object?.kind === 'sun') {
      return {
        view: 'map',
        html: sunTooltipHtml(object, originOf(points)),
        lat: object.lat,
        lon: object.lon,
        along: null
      };
    }

    // A photograph. Above the ping branch for the sun's reason and then some: one
    // that recorded its own coordinates is genuinely in the points array, so it
    // has every field the branch below tests for and would be described as an
    // ordinary fix — losing the picture, which is the whole of what it is.
    //
    // Pinnable, not draggable: sliding a photograph down the course would be
    // sliding a photograph. That is `fixed` and not, as it once was, an `along` of
    // null — the two are different claims, and using the second to say the first
    // cost this mark its place on the strip. A photograph's distance is a real
    // measurement — `applyMediaSnaps` takes it from the snapper, `traceAt` from
    // the trace — and the crosshair is how a click on the map says WHERE on the
    // climb this was taken. It stays null only for a crew photograph, which has no
    // distance along the runner's course to report.
    //
    // The sun's branch above still says null and still means it: a sun mark is
    // drawn on the strip whether or not anything is selected, so it needs no
    // crosshair to be found there.
    if (object?.kind === 'media') {
      // Where it sits in the run's own order — which is `placeMedia`'s: oldest
      // first, the timeless ones at the end. That is the sequence the `‹` and `›`
      // buttons walk, and it is also why they are given to `mediaTooltipHtml`
      // from here rather than worked out there: this is the only place that can
      // see the other photographs.
      const at = media.findIndex(poi => poi.name === object.name);
      return {
        view: 'map',
        html: mediaTooltipHtml(object, originOf(points), {
          prev: at > 0,
          next: at >= 0 && at < media.length - 1
        }),
        media: object.name,
        lat: object.lat,
        lon: object.lon,
        along: object.along ?? null,
        fixed: true
      };
    }

    // A ping. `t` is what a fix has and nothing else here does.
    if (object?.t !== undefined) {
      const latest = latestOf(points);
      // The DRAWN position, snapped where it snapped: the tooltip has to point
      // at the dot that was clicked. The raw fix is inside the tooltip, and its
      // Maps link goes there.
      const [lon, lat] = posOf(object);
      return {
        view: 'map',
        html: tooltipHtml(object, !!latest && latest.name === object.name, originOf(points)),
        lat,
        lon,
        along: object.snap ? object.snap.along : null
      };
    }

    // The course itself, via its transparent hit band.
    if (layer?.id === 'course-hit' && course && coordinate) {
      const along = courseHoverAt(course, coordinate[0], coordinate[1]);
      return along === null ? null : atAlong(along);
    }

    return null;
  }

  /**
   * A place on the course, as a selection.
   *
   * Shared by the click path and the drag path deliberately: if they built these
   * differently, picking a point up would rewrite the very tooltip you grabbed.
   *
   * @param {number} along metres from the start of the course.
   */
  function atAlong(along) {
    const at = interpolateAt(points, course, along, forecast);
    return { view: 'map', html: hoverTooltipHtml(at), lat: at.lat, lon: at.lon, along };
  }

  /**
   * A button inside the pinned card was pressed.
   *
   * Only a photograph's card has any, so all three cases are about the currently
   * pinned photograph — found by NAME rather than held in a variable, because
   * `media` is replaced wholesale on every paint and a captured object would go
   * stale the moment the atlas or the course landed.
   *
   * @param {string} act the button's `data-act`, from layers.js.
   */
  function pinAction(act) {
    const poi = media.find(m => m.name === selection?.media);
    if (!poi) return;
    if (act === 'expand') return onExpand(poi);
    if (act === 'prev' || act === 'next') stepMedia(act === 'next' ? 1 : -1);
  }

  /**
   * Move the pin to the photograph before or after this one, and go and look at
   * it.
   *
   * The step goes out through `onSelect` rather than straight into
   * `setSelection`, so main.js stays the one place that knows what is pinned and
   * the height strip is told about the move too — the same door a click uses,
   * which is what keeps a stepped-to photograph indistinguishable from a clicked
   * one.
   *
   * Then `reveal`, which a map click never needs: what you clicked was on screen
   * by definition, and the next photograph along may be a valley away. Guarded on
   * the selection having actually landed, because `select` treats a repeat as a
   * dismissal and it is not this function's place to assume it didn't.
   */
  function stepMedia(delta) {
    const at = media.findIndex(poi => poi.name === selection?.media);
    const next = at < 0 ? null : media[at + delta];
    if (!next) return;

    onSelect(describe({ object: next }));
    if (selection?.media === next.name) reveal(selection, true);
  }

  /**
   * The current camera as a viewport, for going between coordinates and pixels.
   *
   * Asked of deck rather than rebuilt from `viewState`, so there is one camera in
   * this file rather than a copy of it reconstructed at every call site — and so
   * that what a pixel is measured against is the same projection that drew the
   * frame, including mid-flight.
   *
   * `viewport` is null until deck has laid out once. Every caller has to cope:
   * there is genuinely no answer yet.
   */
  function viewport() {
    return {
      rect: container.getBoundingClientRect(),
      viewport: deckgl.getViewports?.()[0] ?? null
    };
  }

  /**
   * Keep the pinned tooltip over its point as the map moves under it.
   *
   * The anchor is a coordinate, not a screen position, so it has to be
   * re-projected — every frame, since a fly-to animates the camera without
   * anything else telling us it moved. One point through one viewport is
   * nothing next to the layer stack being rebuilt beside it.
   */
  function placePin() {
    if (selection?.view !== 'map') return;
    const { rect, viewport: view } = viewport();
    if (!view) return;
    const [x, y] = view.project([selection.lon, selection.lat]);
    pin.place(rect.left + x, rect.top + y);
  }

  /**
   * How far, in pixels, the pointer is from the pinned point — or null when
   * there is nothing to be near.
   *
   * Two selections are not draggable. One with no `along` has no line to slide
   * down: it is a ping the snapper left alone, so it has a place on the map and
   * none on the course. One that is `fixed` has a place on both and is still not
   * ours to move — a photograph was taken where it was taken, and the drag would
   * be editing the measurement rather than reading it.
   *
   * @param {number} x pointer position relative to the container, which deck's
   * @param {number} y picking info reports directly and a raw event does not.
   */
  function grabDistance(x, y) {
    if (!course || selection?.along == null || selection.fixed) return null;
    const { viewport: view } = viewport();
    if (!view) return null;
    const [px, py] = view.project([selection.lon, selection.lat]);
    return Math.hypot(x - px, y - py);
  }

  const deckgl = new deck.DeckGL({
    container,
    viewState,
    controller: true,
    layers: [basemapLayer()],
    getTooltip: makeTooltip(
      () => points, () => course, () => Boolean(selection) || touchInput, () => forecast),

    /**
     * Deck rewrites the cursor on every hover, so a scrub has to be declared
     * here rather than assigned — assigning it would survive about one frame.
     *
     * Only the drag itself needs saying. There is no separate "you may pick this
     * up" cursor because the map's resting state is already `grab`: the pinned
     * point sits on a surface that has advertised itself as draggable all along,
     * and the gesture simply turns out to move the point instead of the camera.
     */
    getCursor: ({ isDragging, isHovering }) => {
      if (dragging) return 'grabbing';
      return isDragging ? 'grabbing' : isHovering ? 'pointer' : 'grab';
    },

    /**
     * Pin what was clicked, so its tooltip stays up and can be read — and its
     * Google Maps link reached — without holding the cursor still. A click on
     * bare basemap selects nothing, which is how you put a selection down
     * without having to find it again.
     */
    onClick: info => {
      // Another run's dot is a door, not a thing to look at: it goes to that run
      // rather than pinning a tooltip about it. Checked before `describe`, which
      // has no case for it and would read it as bare basemap — putting the
      // current selection down on the way out.
      if (info.object?.kind === 'beacon') return onBeaconPick(info.object.run);
      onSelect(describe(info));
    },

    /**
     * Report what the cursor is pointing at on the course, so the height profile
     * can mark the same place. Fires for every layer, including misses, which is
     * how the crosshair learns to go away again.
     */
    onHover: info => {
      if (!course) return;
      // A pinned point outranks the cursor: it is the place the user asked to
      // keep looking at, so the crosshair stays on it. It is also the only thing
      // on this map that can be picked up, so say so on approach — nothing else
      // would hint that the gesture exists.
      if (selection) return;
      // A ping already knows where it sits on the course; no need to re-solve
      // geometry that snap.js worked out with the benefit of history.
      if (info.object?.snap) return onCourseHover(info.object.snap.along);
      // And a photograph knows it the same way, off the snapper or off the trace.
      // A crew photograph's is null and falls through to the clear below, which is
      // right: it has no distance along this course to point at.
      if (info.object?.kind === 'media' && info.object.along != null) {
        return onCourseHover(info.object.along);
      }
      // `course-hit` rather than `course`: the drawn route is 3 px and all but
      // unhittable, so what's pickable is a wide transparent band over it.
      if (info.layer?.id === 'course-hit' && info.coordinate) {
        return onCourseHover(courseHoverAt(course, info.coordinate[0], info.coordinate[1]));
      }
      onCourseHover(null);
    },

    onViewStateChange: ({ viewState: next, interactionState }) => {
      const touched = interactionState &&
        (interactionState.isDragging || interactionState.isPanning || interactionState.isZooming);

      // Hands on the map means the user wants to look somewhere specific.
      if (touched) setFollow(false);

      // Mid-flight deck owns the camera, but a CONTROLLED view state is not one
      // deck applies to itself — see `Deck._onViewStateChange`, which skips its
      // own viewManager update whenever `props.viewState` is set. It interpolates
      // the arc and reports every frame of it; DRAWING those frames is ours to do,
      // and without this line the flight runs invisibly for a second and the map
      // cuts to the destination when it ends. That cut was the whole symptom.
      //
      // Handing it straight back is safe only because it is VERBATIM and
      // synchronous: deck's `_isUpdateDueToCurrentTransition` compares what comes
      // back against the frame it has just reported and ignores a match, which is
      // exactly how a controlled camera is meant to be flown. A camera even one
      // frame stale fails that comparison and RETARGETS the flight to it — the
      // halfway freeze `render()` exists to prevent.
      if (flying && !touched) {
        viewState = { ...viewState, ...next };
        deckgl.setProps({ viewState });
        return;
      }

      flying = false;
      // Stripped, because `next` is derived from the props deck was handed and can
      // still be carrying the flight this pan just interrupted. Left on, the very
      // next render() would re-fire it.
      viewState = withoutTransition(next);
      deckgl.setProps({ viewState });
    }
  });

  /**
   * Dragging a pinned point along the course.
   *
   * Listened for on the container rather than through deck, and in the CAPTURE
   * phase, because the thing being fought for is the gesture itself: deck's
   * controller reads a press-and-move as a pan, and there is no way to ask it
   * politely for one drag back. So the press is stopped before mjolnir sees it
   * and the controller is switched off outright for the duration — belt and
   * braces, because intercepting events alone has proved fragile against that
   * recogniser before.
   *
   * The marker follows the COURSE, not the cursor: the pointer is turned into a
   * coordinate, and `courseHoverAt` turns that into a distance along the route.
   * Past `snapMeters` it returns nothing, and then the last good distance stands
   * — dragging away from the route should leave the point on the route rather
   * than flinging it into a field.
   *
   * Note what stopping the press costs: deck never recognises a tap either, so
   * no `onClick` is coming for this gesture at all — not at the end of a drag,
   * and not for a press that never moved. Both outcomes have to be produced
   * here, in `endDrag`.
   */
  // What is pointing at the map, tracked whatever the gesture turns out to be:
  // deck asks for a tooltip during the very gesture that answers this, and it
  // gets a different answer for a finger. Capture phase on the container, so it
  // is known before deck's own listeners on the canvas inside it have run — and
  // on both events, so a mouse plugged into a tablet takes hovering back.
  for (const type of ['pointerdown', 'pointermove']) {
    container.addEventListener(type, event => { touchInput = event.pointerType !== 'mouse'; }, true);
  }

  container.addEventListener('pointerdown', event => {
    const rect = container.getBoundingClientRect();
    const near = grabDistance(event.clientX - rect.left, event.clientY - rect.top);
    if (near === null || near > CONFIG.dragGrabPx) return;

    dragging = true;
    dragMoved = false;
    dragAlong = selection.along;
    deckgl.setProps({ controller: false });
    container.setPointerCapture(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  }, true);

  container.addEventListener('pointermove', event => {
    if (!dragging) return;
    dragMoved = true;
    const { rect, viewport: view } = viewport();
    if (!view) return;
    const [lon, lat] = view.unproject([
      event.clientX - rect.left, event.clientY - rect.top
    ]);

    const along = courseHoverAt(course, lon, lat);
    if (along !== null) dragAlong = along;
    onScrub(atAlong(dragAlong));
    event.stopPropagation();
  }, true);

  function endDrag(event) {
    if (!dragging) return;
    dragging = false;
    deckgl.setProps({ controller: true });
    if (container.hasPointerCapture(event.pointerId)) {
      container.releasePointerCapture(event.pointerId);
    }

    // A press that went nowhere is the click that puts the point down, and no
    // click is coming to do it. Handing the CURRENT selection back to
    // `onSelect` is how: `same()` matches it against itself and main.js reads
    // that as a dismissal, so there is still exactly one rule in the codebase
    // about what putting a point down means.
    if (!dragMoved) onSelect(selection);
  }

  container.addEventListener('pointerup', endDrag, true);
  container.addEventListener('pointercancel', endDrag, true);

  /** Hand deck both the camera and the layers. The one place a view state is
   *  pushed, and the only caller that may do it mid-flight. */
  function paint() {
    deckgl.setProps({ viewState, layers: allLayers() });
  }

  /**
   * Redraw because the DATA changed.
   *
   * Mid-flight the camera belongs to deck, and this is not the place that knows
   * where it currently is. `onViewStateChange` is — it echoes each interpolated
   * frame back as deck reports it, and deck recognises its own frame and flies
   * on. A view state from anywhere ELSE is a frame or more stale by the time it
   * lands, and deck reads a stale camera not as a redraw but as a NEW destination:
   * the flight retargets to a point on its own arc and stops there.
   *
   * That is a subtle bug with a very visible symptom: a run switch flies out, and
   * then the next `render()` along (the new points, the forecast, the other runs'
   * dots — three of them arrive within a few milliseconds) freezes it halfway, so
   * the camera lands roughly over the new course and never zooms in.
   *
   * `tick()` has always updated layers alone for the same reason.
   */
  function render() {
    if (flying) return deckgl.setProps({ layers: allLayers() });
    paint();
  }

  // The sun marks and the finish flag are SVG files, so they arrive a moment
  // after the first paint. One redraw when they land is all it takes — the atlas
  // is built on the next `allLayers()` and never changes again. Nothing waits for
  // this: a map that held its first paint back for an icon would be a map that
  // holds its first paint back.
  loadGlyphs().then(render);

  /**
   * Drop the transition props once a flight ends, so a later render() doesn't
   * re-trigger an animation to where we already are.
   *
   * Ignored when a LATER flight has already been set up, and that guard is
   * load-bearing rather than defensive. Replacing one flight with another — which
   * is how a switch retargets itself as the pings and then the course arrive — has
   * deck report the interruption *while* it is being handed the replacement, from
   * inside `paint()`. Settling on that would strip the props off the flight that
   * is only just starting and clear `flying`, and the next render() would then end
   * it on the spot: the camera would stall wherever the arc had got to.
   */
  function settle(id) {
    if (id !== flight) return;
    flying = false;
    viewState = withoutTransition(viewState);
  }

  /**
   * Move the camera.
   *
   * @param {object} next the view state to end up at.
   * @param {boolean|'far'} animate how to get there.
   *
   *   `false` jumps. `true` flies for a fixed 900 ms, which is right for a nudge —
   *   following the runner to the next ping, centring a point that was clicked on
   *   the height strip. Both are already on screen; the flight is there to show
   *   that the view moved rather than cut.
   *
   *   `'far'` hands the length of the flight to deck, which sizes it from the
   *   distance. That is what a switch between two races needs: they can be on
   *   different continents, and 900 ms across 1,000 km is a teleport with extra
   *   steps. It also gives the arc room to read as one — `FlyToInterpolator`
   *   pulls the camera UP over a long move and back down at the far end, which is
   *   what makes a switch legible as a journey between two places rather than as
   *   a cut to somewhere unrelated.
   */
  function setViewState(next, animate) {
    // Every camera move retires the one before it, so a callback arriving from an
    // older flight can be recognised and ignored. See `settle`.
    const id = ++flight;

    if (animate) {
      flying = true;
      viewState = {
        ...next,
        transitionDuration: animate === 'far' ? 'auto' : 900,
        // `curve` is how high the arc goes; a little above deck's √2 default, so
        // the zoom out and back in is unmistakable rather than merely present.
        transitionInterpolator: new deck.FlyToInterpolator({ speed: 1.6, curve: 1.5 }),
        onTransitionEnd: () => settle(id),
        onTransitionInterrupt: () => settle(id)
      };
    } else {
      flying = false;
      // `next` is usually the current state with a coordinate changed, so it can
      // arrive with a flight that hasn't finished still attached to it.
      viewState = withoutTransition(next);
    }
    // `paint`, not `render`: this call is the one that owns the camera, and going
    // through the mid-flight guard would mean the flight it just set up never
    // reached deck at all.
    paint();
  }

  /**
   * Bring a point picked on the height strip into the middle of the map.
   *
   * The mirror of the strip scrolling a map-picked point into view: a click on
   * the profile can land anywhere on the course, including well off the edge of
   * the camera, and a tooltip you can't see the place of says very little.
   *
   * Following goes off, for the same reason panning turns it off — the camera has
   * been pointed at a place on purpose, and the next ping arriving must not yank
   * it back to the runner. The ticker brings it back.
   *
   * @param {import('./pin.js').Selection} at
   * @param {boolean} animate flown for a fresh pick, jumped while one is being
   *   dragged along the course.
   */
  function reveal({ lon, lat }, animate) {
    setFollow(false);
    setViewState({ ...viewState, longitude: lon, latitude: lat }, animate);
  }

  /** Fit every point AND the course, clamped — this tracker often sits still,
   *  and a degenerate bounding box would otherwise fit to infinite zoom. */
  function fitView(pts) {
    // Pings only, and this is the one consumer where that matters enough to say
    // out loud. Everything else downstream of the snapper reads `p.snap`, which a
    // photo more than 500 m off the course never gets — so distance, pace and
    // climb are safe from a mis-filed picture by the ordinary rule. `boundsOf`
    // reads `posOf`, which falls back to the RAW fix by design, so it is the one
    // place a photograph taken in the Pyrenees can drag a race in the Alps into a
    // camera fit 350 km wide. See `fixesOf`.
    const fixes = fixesOf(pts);
    // The course is the thing worth seeing whole; the pings so far are usually a
    // small part of it, and fitting only those would open on a stretch of road
    // with no context.
    const bounds = unionBounds(
      fixes.length ? boundsOf(fixes) : null,
      course ? courseBounds(course) : null
    );
    if (!bounds) return null;

    const base = { width: innerWidth, height: innerHeight, longitude: 0, latitude: 0, zoom: 1 };

    let fit = null;
    try {
      // The profile strip covers the bottom of the window, so the fit has to
      // clear it or the start of the course hides behind it.
      fit = new deck.WebMercatorViewport(base).fitBounds(bounds, {
        padding: { top: 80, left: 80, right: 80, bottom: 80 + bottomInset() }
      });
    } catch { /* degenerate bounds */ }

    const usable = fit && Number.isFinite(fit.zoom);
    return {
      longitude: usable ? fit.longitude : bounds[0][0],
      latitude:  usable ? fit.latitude  : bounds[0][1],
      zoom: Math.min(usable ? fit.zoom : CONFIG.maxZoom, CONFIG.maxZoom),
      pitch: 0,
      bearing: 0
    };
  }

  function setFollow(on) {
    if (follow === on) return;
    follow = on;
    onFollowChange(on);
  }

  /**
   * How much of the bottom of the window the overlays are covering, if any: the
   * height strip, plus the news bar stacked on top of it.
   *
   * Summed HERE rather than read from one combined custom property, and that is a
   * platform constraint rather than a preference. An unregistered custom property
   * holding a `calc()` comes back from `getComputedStyle` as the unresolved token
   * string "calc(112px + 30px)", which `parseFloat` reads as NaN — the substitution
   * only happens where the value is actually used in a declaration. Two reads and an
   * addition is the version that works.
   */
  function bottomInset() {
    const style = getComputedStyle(document.documentElement);
    const px = name => parseFloat(style.getPropertyValue(name)) || 0;
    return px('--profile-h') + px('--news-h');
  }

  return {
    /** Replace the drawn set. Fits on first data, then follows new arrivals. */
    setPoints(next) {
      const previous = latestOf(fixesOf(points));
      const previousAt = previous ? String(posOf(previous)) : null;
      points = next;
      if (!points.length) return render();

      // Following follows the RUNNER. A photograph timestamped after the last
      // ping is not the runner having moved there, and letting one drag the
      // camera is how uploading a picture from the car park ends the race early.
      const latest = latestOf(fixesOf(points));
      if (!latest) return render();
      const [lon, lat] = posOf(latest);

      if (!fitted) {
        const fit = fitView(points);
        fitted = true;
        // `'far'` for a switch: the two runs can be anywhere, so the flight has to
        // be sized from the distance rather than crammed into 900 ms.
        const fly = flyOnFit;
        // Spent, not saved up: it belongs to the switch that asked for it, and
        // left standing it would make some later first-fit fly for no reason.
        flyOnFit = false;
        if (fit) return setViewState(fit, fly && 'far');
        render();
      // Keyed on the drawn position, not just the filename: when a course lands
      // and the newest ping jumps onto it, the camera should go with it.
      //
      // Not while a flight is running, though. During a switch the pings arrive
      // mid-arc, and a fixed 900 ms hop to the newest one would cut across the
      // journey to land on a single dot — when the flight already in progress is
      // heading for this run's whole course, which is the better destination.
      } else if (follow && !flying && String([lon, lat]) !== previousAt) {
        setViewState({ ...viewState, longitude: lon, latitude: lat }, true);
      } else {
        render();
      }
    },

    /**
     * The run's course, or null. Drawn even before any ping has arrived.
     *
     * A course almost always arrives after the cached points have painted and
     * the camera has already fitted to them, so a new one re-fits — otherwise
     * you'd be looking at three dots with the race off-screen. Only while
     * following, so it can't yank the view out from under someone panning.
     */
    setCourse(next) {
      const changed = (course?.sha ?? null) !== (next?.sha ?? null);
      course = next;
      // A distance along the old course means nothing on the new one — and a
      // pace model fitted against it means even less. `show()` supplies a fresh
      // one straight after, so this only closes the gap.
      if (changed) { hover = null; forecast = null; marker = null; }

      if (changed && next && follow) {
        const fit = fitView(points);
        if (fit) {
          fitted = true;
          // `'far'` while a flight is already running, because that flight is a run
          // switch in progress and this is the same journey: the course lands a
          // moment after the pings did, and it is the better destination — the
          // whole race rather than the handful of pings that have arrived. Sizing
          // it from the distance again lets deck simply retarget the arc, where a
          // fixed 900 ms would cut across it. Landing on this run's own course
          // afterwards is an ordinary short move.
          return setViewState(fit, flying ? 'far' : true);
        }
      }
      render();
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
      render();
    },

    /**
     * The run's sun events, from `sunPois`. Empty for a run that stayed in
     * daylight, which is most of them.
     */
    setSun(next) {
      sun = next;
      render();
    },

    /**
     * The run's photographs and clips, from `placeMedia`.
     *
     * WHERE they are, and nothing else. The texture goes in through
     * `setMediaAtlas` below, and the separation is load-bearing: decoding a
     * photograph takes far longer than fetching a course, so the atlas resolves
     * several paints after the list it was started from. Passing both together
     * meant that late texture carried its stale positions in with it, and a photo
     * that had already been re-placed onto the course jumped back off it — until
     * the next poll happened to paint again. See `refreshAtlas` in main.js.
     */
    setMedia(next) {
      media = next;
      render();
    },

    /**
     * The texture those thumbnails are cut out of, or null.
     *
     * Null until the images have decoded, and null for a run whose files could
     * none of them be read — `mediaLayers` then draws the anchor dots alone.
     * main.js keys the atlas on the run's shas and is the only thing that knows
     * whether the one in flight still belongs to the markers on screen.
     */
    setMediaAtlas(next) {
      mediaAtlas = next;
      render();
    },

    /**
     * Slide the marker along as the clock runs. Called once a second from
     * main.js, beside the strip's, because it is the same mark on the same beat.
     * No render — `tick()` paints it on the next frame.
     */
    tickForecast() {
      refreshMarker();
    },

    /**
     * Mark a distance along the course, or clear it with null. This is the
     * height strip pointing at the map.
     *
     * @param {number|null} along metres along the course.
     */
    setHover(along) {
      // A selection outranks a hover from either view — it is the point the
      // user asked to keep looking at.
      if (selection) return;
      let next = null;
      if (course && along !== null && along !== undefined) {
        const at = pointAt(course, along);
        next = [at.lon, at.lat];
      }

      // Renders run at 60 fps from tick() anyway, but a pointermove that hasn't
      // changed the ring shouldn't rebuild the layer stack on its own account.
      if (String(next) === String(hover)) return;
      hover = next;
      render();
    },

    /**
     * The pinned point, or null. Told to BOTH views whichever one was clicked:
     * the one that owns it draws the tooltip, and the other still marks the
     * place, which is what makes a click in one view legible in the other.
     *
     * @param {import('./pin.js').Selection|null} next
     * @param {boolean} animate whether a camera move this causes should be flown
     *   or jumped. False while the point is being dragged: a 900 ms flight
     *   restarted on every pointermove never arrives anywhere.
     */
    setSelection(next, animate = true) {
      selection = next;

      if (!selection) {
        pin.hide();
        hover = null;
        return render();
      }

      // The ring goes on the selection and stays there, in either view's case:
      // clicking a point on the strip should mark it on the map.
      hover = [selection.lon, selection.lat];
      if (selection.view === 'map') pin.show(selection.html);
      // Only for the strip's own picks: a point clicked on the MAP is already on
      // screen by definition, and flying the camera to centre it would move the
      // ground out from under the click that asked for it.
      else reveal(selection, animate);
      render();
      placePin();
    },

    /**
     * Fit the next setPoints() again — a different run is a different place.
     *
     * @param {boolean} animate whether to FLY there. A first load jumps: there is
     *   nowhere to fly from, and animating out of the default world view would
     *   make every visit start with a swoop. A run switch flies, because that is
     *   the difference between changing the subject and reloading the page.
     *
     *   Following comes back on with it, and that is not a side effect — asking
     *   for another race means asking to be shown it, and a `follow: false` left
     *   over from panning the previous one would strand the camera there.
     *
     * @param {string|null} run where we are heading, so the flight can LEAVE NOW
     *   rather than when the data lands. The dot already drawn for that run is a
     *   position we have had all along — see `beaconLayers` — and waiting for a
     *   fetch to start moving makes a switch feel like the page load it replaced.
     *   The real fit follows whenever it is ready and retargets this mid-arc.
     */
    refit(animate = false, run = null) {
      fitted = false;
      flyOnFit = animate;
      if (!animate) return;
      setFollow(true);

      const at = beacons.find(b => b.run === run);
      if (!at) return;
      setViewState({
        ...viewState,
        longitude: at.lon,
        latitude: at.lat,
        // A single dot says where the race is and nothing about how big it is, so
        // this is a guess at "close enough to be looking at one" — and a floor
        // rather than a setting, so a switch made while already zoomed in doesn't
        // pull the camera back out. The fit that follows knows the real answer.
        zoom: Math.max(viewState.zoom, 12)
      }, 'far');
    },

    /**
     * The other runs, as dots. Cheap enough to redraw on every poll — see
     * `refreshBeacons`, which mostly answers out of localStorage.
     *
     * @param {Array} next from `refreshBeacons`, the run on screen already left out.
     */
    setBeacons(next) {
      beacons = next;
      render();
    },

    /**
     * Where the page's visitor is, or null to stop showing them.
     *
     * Deliberately does nothing to the camera. Someone watching a race in another
     * country and ticking the box gets a dot they cannot see, and that is the
     * honest outcome — moving the view would take the race off screen to show
     * them a fact about themselves they already knew.
     *
     * @param {{lat, lon, accuracy}|null} next from `viewerFrom`.
     */
    setViewer(next) {
      viewer = next;
      render();
    },

    isFollowing: () => follow,

    /** Turn following back on and fly to the newest fix. */
    recenter() {
      setFollow(true);
      const latest = latestOf(points);
      if (!latest) return;
      const [longitude, latitude] = posOf(latest);
      setViewState({
        ...viewState,
        longitude,
        latitude,
        zoom: Math.max(viewState.zoom, 14)
      }, true);
    },

    stopFollowing: () => setFollow(false),

    /** Drive the halo animation. Called once per frame from main.js. */
    tick() {
      pulse = (Math.sin(Date.now() / 500) + 1) / 2;
      // Two things pulse, and either one is reason enough to repaint. The viewer's
      // dot is the case with no pings behind it: a run that hasn't started yet is
      // exactly when someone checks where they are relative to it, and without
      // this the halo would sit frozen.
      if (points.length || viewer) deckgl.setProps({ layers: allLayers() });
      // Here rather than in render(): a fly-to moves the camera for a second
      // without anything calling render, and a pinned tooltip left behind at
      // the old screen position would be pointing at nothing.
      placePin();
    }
  };
}
