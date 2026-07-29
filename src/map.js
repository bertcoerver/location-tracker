// Owns the deck.gl instance, the camera, and the follow-latest behaviour.
// Data comes in through setPoints(); nothing here knows about GitHub.

import { CONFIG } from './config.js';
import { courseBounds, courseHoverAt, pointAt } from './course.js';
import {
  basemapLayer, courseLayers, hoverLayers, hoverTooltipHtml, makeTooltip, pointLayers,
  tooltipHtml, waypointTooltipHtml
} from './layers.js';
import { createPin } from './pin.js';
import { boundsOf, latestOf, posOf, unionBounds } from './points.js';
import { interpolateAt } from './stats.js';

export function createMap(container, {
  onFollowChange = () => {},
  onCourseHover = () => {},
  onSelect = () => {}
} = {}) {
  let points = [];
  let course = null;
  let hover = null;      // [lon, lat] on the course, from the profile strip
  // The pinned point, from a click in either view. While one is held the map's
  // hover tooltip is suspended and the crosshair stops chasing the cursor.
  let selection = null;
  const pin = createPin();
  let layerFlags = { waypoints: true, raw: true };
  let viewState = { longitude: 0, latitude: 20, zoom: 1.4, pitch: 0, bearing: 0 };
  let follow = true;
  let fitted = false;
  let flying = false;
  let pulse = 0;

  /** The whole stack, in draw order. One place, so nothing can disagree. */
  function allLayers() {
    return [
      basemapLayer(),
      ...courseLayers(course, layerFlags.waypoints),
      ...pointLayers(points, pulse, layerFlags.raw),
      ...hoverLayers(hover)
    ];
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

    // A ping. `t` is what a fix has and nothing else here does.
    if (object?.t !== undefined) {
      const latest = latestOf(points);
      // The DRAWN position, snapped where it snapped: the tooltip has to point
      // at the dot that was clicked. The raw fix is inside the tooltip, and its
      // Maps link goes there.
      const [lon, lat] = posOf(object);
      return {
        view: 'map',
        html: tooltipHtml(object, !!latest && latest.name === object.name),
        lat,
        lon,
        along: object.snap ? object.snap.along : null
      };
    }

    // The course itself, via its transparent hit band.
    if (layer?.id === 'course-hit' && course && coordinate) {
      const along = courseHoverAt(course, coordinate[0], coordinate[1]);
      if (along === null) return null;
      const at = interpolateAt(points, course, along);
      return { view: 'map', html: hoverTooltipHtml(at), lat: at.lat, lon: at.lon, along };
    }

    return null;
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
    const rect = container.getBoundingClientRect();
    const viewport = new deck.WebMercatorViewport({
      ...viewState,
      width: rect.width || 1,
      height: rect.height || 1
    });
    const [x, y] = viewport.project([selection.lon, selection.lat]);
    pin.place(rect.left + x, rect.top + y);
  }

  const deckgl = new deck.DeckGL({
    container,
    viewState,
    controller: true,
    layers: [basemapLayer()],
    getTooltip: makeTooltip(() => points, () => course, () => Boolean(selection)),

    /**
     * Pin what was clicked, so its tooltip stays up and can be read — and its
     * Google Maps link reached — without holding the cursor still. A click on
     * bare basemap selects nothing, which is how you put a selection down
     * without having to find it again.
     */
    onClick: info => {
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
      // keep looking at, so the crosshair stays on it.
      if (selection) return;
      // A ping already knows where it sits on the course; no need to re-solve
      // geometry that snap.js worked out with the benefit of history.
      if (info.object?.snap) return onCourseHover(info.object.snap.along);
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

      // Mid-flight, deck owns the camera — just record where it is. Echoing the
      // interpolated state back as a new controlled value would cancel the flight.
      if (flying && !touched) {
        viewState = { ...viewState, ...next };
        return;
      }

      flying = false;
      viewState = next;
      deckgl.setProps({ viewState });
    }
  });

  function render() {
    deckgl.setProps({ viewState, layers: allLayers() });
  }

  /** Drop the transition props once a flight ends, so a later render() doesn't
   *  re-trigger an animation to where we already are. */
  function settle() {
    flying = false;
    const { transitionDuration, transitionInterpolator,
            onTransitionEnd, onTransitionInterrupt, ...rest } = viewState;
    viewState = rest;
  }

  function setViewState(next, animate) {
    if (animate) {
      flying = true;
      viewState = {
        ...next,
        transitionDuration: 900,
        transitionInterpolator: new deck.FlyToInterpolator({ speed: 1.6 }),
        onTransitionEnd: settle,
        onTransitionInterrupt: settle
      };
    } else {
      flying = false;
      viewState = next;
    }
    render();
  }

  /** Fit every point AND the course, clamped — this tracker often sits still,
   *  and a degenerate bounding box would otherwise fit to infinite zoom. */
  function fitView(pts) {
    // The course is the thing worth seeing whole; the pings so far are usually a
    // small part of it, and fitting only those would open on a stretch of road
    // with no context.
    const bounds = unionBounds(
      pts.length ? boundsOf(pts) : null,
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

  /** How much of the bottom of the window the profile strip is covering, if any. */
  function bottomInset() {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--profile-h');
    return parseFloat(value) || 0;
  }

  return {
    /** Replace the drawn set. Fits on first data, then follows new arrivals. */
    setPoints(next) {
      const previous = latestOf(points);
      const previousAt = previous ? String(posOf(previous)) : null;
      points = next;
      if (!points.length) return render();

      const latest = latestOf(points);
      const [lon, lat] = posOf(latest);

      if (!fitted) {
        const fit = fitView(points);
        fitted = true;
        if (fit) return setViewState(fit, false);
        render();
      // Keyed on the drawn position, not just the filename: when a course lands
      // and the newest ping jumps onto it, the camera should go with it.
      } else if (follow && String([lon, lat]) !== previousAt) {
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
      // A distance along the old course means nothing on the new one.
      if (changed) hover = null;

      if (changed && next && follow) {
        const fit = fitView(points);
        if (fit) {
          fitted = true;
          return setViewState(fit, true);
        }
      }
      render();
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
     * Which optional layers are on, from the panel's toggles: the waypoints,
     * and the raw-fix cloud with its snap links. The snapped dots are not on
     * this list — they are the reading itself.
     */
    setLayers(next) {
      layerFlags = { ...layerFlags, ...next };
      render();
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

      if (!selection) {
        pin.hide();
        hover = null;
        return render();
      }

      // The ring goes on the selection and stays there, in either view's case:
      // clicking a point on the strip should mark it on the map.
      hover = [selection.lon, selection.lat];
      if (selection.view === 'map') pin.show(selection.html);
      render();
      placePin();
    },

    /** Fit the next setPoints() again — a different run is a different place. */
    refit() { fitted = false; },

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
      if (points.length) deckgl.setProps({ layers: allLayers() });
      // Here rather than in render(): a fly-to moves the camera for a second
      // without anything calling render, and a pinned tooltip left behind at
      // the old screen position would be pointing at nothing.
      placePin();
    }
  };
}
