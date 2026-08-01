// The pinned tooltip: the one that stays up after a click, until it's dismissed.
//
// Hover is a fine way to glance at a point and a poor way to READ one — the
// cursor has to be held still, and the Google Maps link inside can only be
// reached by a careful diagonal move before the tooltip evaporates. On a phone
// there is no hover at all. So a click pins the tooltip in place and suspends
// hovering in both views until it's put down again.
//
// One element, shared by the map and the height strip. Only the view that was
// clicked writes to it, which is what `Selection.view` is for: two owners of one
// element is how you get a tooltip that flickers between two positions.

/**
 * @typedef {object} Selection
 * @property {'map'|'profile'} view which view was clicked, and so which one
 *   positions the pin. The other still marks the place.
 * @property {string} html the tooltip's markup, built by the clicking view from
 *   the same functions the hover path uses.
 * @property {number} lat where the point is DRAWN — snapped, for a ping that
 * @property {number} lon   snapped. The tooltip has to point at the dot that
 *   was clicked; the raw fix is inside the tooltip, and its Maps link goes there.
 * @property {number|null} along metres along the course, or null for a ping
 *   that never snapped — it has a place on the map and none on the strip.
 * @property {string} [media] the filename, on a selection that is a photograph or
 *   a clip. It is what `same` compares such a selection by, and what lets the
 *   card's own buttons find the next one along.
 */

/**
 * Where to put a tooltip of this width so it's centred on the cursor and still
 * on screen.
 *
 * Pure, and shared by the pin and the strip's hover tooltip, so there is one
 * rule about falling off the edge of the window rather than two that drift
 * apart. A tip wider than the window pins to the left margin: at that point
 * something has to be clipped, and losing the end of a line is better than
 * losing the start of one.
 *
 * @param {number} clientX cursor position
 * @param {number} tipWidth
 * @param {number} windowWidth
 * @param {number} [margin] how close to the edge the tip may get
 */
export function clampLeft(clientX, tipWidth, windowWidth, margin = 8) {
  return Math.max(margin, Math.min(windowWidth - tipWidth - margin, clientX - tipWidth / 2));
}

/**
 * Where to put a tooltip of this height so it sits above the point it describes
 * — and, when a `ceiling` is given, entirely above that line as well.
 *
 * The ceiling is what the height strip needs. A pinned point on the strip is
 * somewhere inside a 112 px band, and "above the point" for one down in a valley
 * is still on top of the terrain: the tooltip covers the very chart it is
 * describing. Passing the top of the strip as the ceiling lifts it clear
 * regardless of how high the point itself sits.
 *
 * Pure, and the counterpart of `clampLeft` — the two together are the whole of
 * where a tooltip goes.
 *
 * @param {number} clientY the point being described
 * @param {number} tipHeight
 * @param {number} [ceiling] the lowest the tooltip's BOTTOM edge may reach
 * @param {number} [gap] clearance between the tooltip and the point
 * @param {number} [margin] how close to the top of the window it may get
 */
export function clampTop(clientY, tipHeight, ceiling = Infinity, gap = 14, margin = 8) {
  const above = Math.min(clientY - gap, ceiling) - tipHeight;
  return Math.max(margin, above);
}

/**
 * Whether two selections point at the same thing.
 *
 * This is what makes a click a toggle: clicking a point you have already pinned
 * puts it down. Compared by view as well as by place, so the same spot pinned
 * from the strip and then from the map is a MOVE rather than a dismissal — the
 * pin has to change views, which is not nothing happening.
 *
 * @param {Selection|null} a
 * @param {Selection|null} b
 */
export function same(a, b) {
  if (!a || !b) return false;
  // A photograph is identified by its filename rather than by where it landed.
  // Two shots from the same spot — a burst, or two frames either side of one
  // ping — have the very same coordinates, and compared by place the second
  // would read as the first being clicked again and put the pin DOWN. That is
  // exactly the step the `>` button makes, so it is not a corner case.
  if (a.media || b.media) return a.view === b.view && a.media === b.media;
  return a.view === b.view && a.lat === b.lat && a.lon === b.lon && a.along === b.along;
}

/**
 * Take ownership of the `#pin` element.
 *
 * @param {HTMLElement} [element]
 * @param {(act: string) => void} [onAction] what a `[data-act]` button inside the
 *   card was for. Delegated from the element itself rather than bound per button,
 *   because `show` replaces the whole subtree every time the pinned point changes
 *   — anything bound to a button would be thrown away with it, at a moment nobody
 *   here can see coming. The handler is registered once and outlives every card.
 *
 *   Whoever passes this decides what the strings mean; this file only knows that
 *   a click landed on something claiming to be one. `stopPropagation`, because the
 *   pin sits over the map and a press inside it is not a press on the place
 *   underneath — it must not put the very selection down that it is acting on.
 */
export function createPin(element = document.getElementById('pin'), onAction = null) {
  if (onAction) {
    element.addEventListener('click', event => {
      const act = event.target.closest?.('[data-act]');
      if (!act || !element.contains(act)) return;
      event.preventDefault();
      event.stopPropagation();
      onAction(act.dataset.act);
    });
  }

  return {
    /** Fill it in and show it. Positioning is a separate call — the content
     *  changes on a click, the position on every frame. */
    show(html) {
      if (element.innerHTML !== html) element.innerHTML = html;
      element.hidden = false;
    },

    /**
     * Put it above a point on the screen, in client coordinates.
     *
     * An anchor that has left the window takes the pin with it rather than
     * leaving it stuck to the edge: a tooltip pointing at nothing is worse than
     * no tooltip, and the map can be panned anywhere.
     *
     * @param {number} [ceiling] the lowest the pin's bottom edge may reach; the
     *   height strip passes its own top so the pin can't land on the chart.
     */
    place(clientX, clientY, ceiling) {
      if (clientX < 0 || clientY < 0 || clientX > innerWidth || clientY > innerHeight) {
        element.style.visibility = 'hidden';
        return;
      }
      element.style.visibility = '';
      element.style.left = `${clampLeft(clientX, element.offsetWidth, innerWidth)}px`;
      // Above the point, with room for the marker underneath it.
      element.style.top = `${clampTop(clientY, element.offsetHeight, ceiling)}px`;
    },

    hide() {
      element.hidden = true;
      element.innerHTML = '';
      element.style.visibility = '';
    },

    /** So a click on the Maps link inside isn't mistaken for a click elsewhere. */
    contains: node => element.contains(node)
  };
}
