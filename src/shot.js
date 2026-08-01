// One photograph, as big as the window will allow.
//
// The pinned card caps at 340 px because it is a label on a map — it has to leave
// the map visible around it, and it has to fit on a phone held in one hand. That
// is the right size for "what is this mark", and the wrong size for "look at
// this". So the ⤢ button lifts the same file out of the card and onto its own
// black field, and the map goes away for as long as you are looking.
//
// Deliberately NOT a second tooltip. There is no anchor, no clamping and no
// re-projection: it is not describing a place on the map, it is the picture
// itself, and the moment it has to stay attached to a coordinate it inherits
// every constraint the card has. The pin stays up underneath, so closing this
// puts you back exactly where you were rather than at nothing.
//
// The `src` is the same content-addressed URL the card and the thumbnail already
// went through, so opening this costs no network at all — the bytes are in the
// HTTP cache, and `sw.js` has them as immutable besides.

import { isVideo } from './media.js';
import { escapeHtml } from './util.js';

/**
 * Take ownership of the `#shot` element.
 *
 * @param {HTMLElement} [element]
 */
export function createShot(element = document.getElementById('shot')) {
  // Everything that dismisses it: the ✕, and the field around the picture. The
  // backdrop is a dismiss target rather than inert because the picture fills most
  // of the window and hunting for a 30 px button is not what anyone does — but the
  // picture ITSELF is not, or a click meant to hold a video still would close the
  // whole thing.
  element.addEventListener('click', event => {
    if (event.target === element || event.target.closest('[data-close]')) close();
  });

  function close() {
    if (element.hidden) return false;
    element.hidden = true;
    // Emptied, not just hidden. A `<video loop>` left in the DOM goes on decoding
    // frames behind a `display: none`, and a run with a clip in it would burn a
    // phone's battery for the rest of the session over a picture nobody is
    // looking at.
    element.innerHTML = '';
    return true;
  }

  return {
    /**
     * Show a photograph or clip full size.
     *
     * A clip gets `controls` here and not in the card. In a 340 px label a
     * scrubber is most of the picture and there is nothing to scrub to; at full
     * size the clip is the subject, and being unable to pause it or go back three
     * seconds is the difference between watching something and having it played
     * at you.
     *
     * @param {object} poi from [`placeMedia`](media.js).
     */
    show(poi) {
      const src = encodeURI(poi?.url || '');
      if (!src) return;

      const alt = escapeHtml(String(poi.name || ''));
      element.innerHTML =
        '<button type="button" class="shot-x" data-close title="Close" aria-label="Close">&times;</button>' +
        (isVideo(poi.name)
          ? `<video src="${src}" autoplay loop muted playsinline controls></video>`
          : `<img src="${src}" alt="${alt}">`);
      element.hidden = false;
    },

    /** Put it away. Returns whether there was anything to put away, so a caller
     *  handling Escape can tell whether the key has been spent — the pinned card
     *  underneath answers to the same key, and one press must not clear both. */
    close
  };
}
