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
  return a.view === b.view && a.lat === b.lat && a.lon === b.lon && a.along === b.along;
}

/**
 * Take ownership of the `#pin` element.
 *
 * @param {HTMLElement} [element]
 */
export function createPin(element = document.getElementById('pin')) {
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
     */
    place(clientX, clientY) {
      if (clientX < 0 || clientY < 0 || clientX > innerWidth || clientY > innerHeight) {
        element.style.visibility = 'hidden';
        return;
      }
      element.style.visibility = '';
      element.style.left = `${clampLeft(clientX, element.offsetWidth, innerWidth)}px`;
      // Above the point, with room for the marker underneath it.
      element.style.top = `${Math.max(8, clientY - element.offsetHeight - 14)}px`;
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
