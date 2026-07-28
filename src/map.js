// Owns the deck.gl instance, the camera, and the follow-latest behaviour.
// Data comes in through setPoints(); nothing here knows about GitHub.

import { CONFIG } from './config.js';
import { basemapLayer, makeTooltip, pointLayers } from './layers.js';
import { boundsOf, latestOf } from './points.js';

export function createMap(container, { onFollowChange = () => {} } = {}) {
  let points = [];
  let viewState = { longitude: 0, latitude: 20, zoom: 1.4, pitch: 0, bearing: 0 };
  let follow = true;
  let fitted = false;
  let flying = false;
  let pulse = 0;

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
    deckgl.setProps({ viewState, layers: [basemapLayer(), ...pointLayers(points, pulse)] });
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

  /** Fit every point, clamped — this tracker often sits still, and a degenerate
   *  bounding box would otherwise fit to infinite zoom. */
  function fitView(pts) {
    const bounds = boundsOf(pts);
    const base = { width: innerWidth, height: innerHeight, longitude: 0, latitude: 0, zoom: 1 };

    let fit = null;
    try {
      fit = new deck.WebMercatorViewport(base).fitBounds(bounds, { padding: 80 });
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

  return {
    /** Replace the drawn set. Fits on first data, then follows new arrivals. */
    setPoints(next) {
      const previousLatest = latestOf(points)?.name ?? null;
      points = next;
      if (!points.length) return;

      const latest = latestOf(points);
      if (!fitted) {
        fitted = true;
        setViewState(fitView(points), false);
      } else if (follow && latest.name !== previousLatest) {
        setViewState({ ...viewState, longitude: latest.lon, latitude: latest.lat }, true);
      } else {
        render();
      }
    },

    isFollowing: () => follow,

    /** Turn following back on and fly to the newest fix. */
    recenter() {
      setFollow(true);
      const latest = latestOf(points);
      if (!latest) return;
      setViewState({
        ...viewState,
        longitude: latest.lon,
        latitude: latest.lat,
        zoom: Math.max(viewState.zoom, 14)
      }, true);
    },

    stopFollowing: () => setFollow(false),

    /** Drive the halo animation. Called once per frame from main.js. */
    tick() {
      pulse = (Math.sin(Date.now() / 500) + 1) / 2;
      if (points.length) {
        deckgl.setProps({ layers: [basemapLayer(), ...pointLayers(points, pulse)] });
      }
    }
  };
}
