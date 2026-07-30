// Colour comes from the CSS custom properties in index.html, so light/dark are
// defined in exactly one place and this file just reads whichever is active.
//
// There are four colours and each one means something: a ping, the course, the
// person looking at the page, and the surface they all sit on. Every ping is the
// accent, newest included — there used to be a separate blue for the older ones,
// which said "two kinds of thing" about one kind of thing. Age used to be a ramp
// on top of that, which needed a legend to decode; the status panel says how old
// the newest fix is in words instead, which is what people read the ramp for.

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Read lazily and once: the stylesheet must be applied before this resolves,
// and tests can import the pure helper above without touching the DOM.
let palette = null;

export function getPalette() {
  if (palette) return palette;

  const css = getComputedStyle(document.documentElement);
  const read = name => hexToRgb(css.getPropertyValue(name).trim());

  palette = {
    accent: read('--accent'),
    surface: read('--surface-1'),
    course: read('--course'),
    viewer: read('--viewer')
  };
  return palette;
}

/** Every ping, whenever it arrived, and the marks that answer to one: the
 *  forecast band, the profile's crosshair, the hover ring. */
export const accent  = () => getPalette().accent;

export const surface = () => getPalette().surface;

/** The race course. Off the accent on purpose: the route is context, not data. */
export const course  = () => getPalette().course;

/** The page's visitor. Blue, like every "you are here" dot ever made — the one
 *  mark on this map that isn't orange, because it is the one that isn't a race. */
export const viewer  = () => getPalette().viewer;

export const prefersDark = () =>
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
