// Owns the deck.gl instance, the camera, and the follow-latest behaviour.
// Data comes in through setPoints(); nothing here knows about GitHub.

import { CONFIG } from './config.js';
import { courseBounds } from './course.js';
import { basemapLayer, courseLayers, makeTooltip, pointLayers } from './layers.js';
import { boundsOf, latestOf, posOf, unionBounds } from './points.js';

export function createMap(container, { onFollowChange = () => {} } = {}) {
  let points = [];
  let course = null;
  let viewState = { longitude: 0, latitude: 20, zoom: 1.4, pitch: 0, bearing: 0 };
  let follow = true;
  let fitted = false;
  let flying = false;
  let pulse = 0;

  /** The whole stack, in draw order. One place, so nothing can disagree. */
  function allLayers() {
    return [basemapLayer(), ...courseLayers(course), ...pointLayers(points, pulse)];
  }

  const deckgl = new deck.DeckGL({
    container,
    viewState,
    controller: true,
    layers: [basemapLayer()],
    getTooltip: makeTooltip(() => points),
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

      if (changed && next && follow) {
        const fit = fitView(points);
        if (fit) {
          fitted = true;
          return setViewState(fit, true);
        }
      }
      render();
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
    }
  };
}
