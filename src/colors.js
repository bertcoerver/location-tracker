// Colour comes from the CSS custom properties in index.html, so light/dark are
// defined in exactly one place and this file just reads whichever is active.
//
// There are four colours and each one means something: a ping, the newest ping,
// the course, and the surface they sit on. Age used to be encoded in a ramp,
// which needed a legend to decode; the status panel says how old the newest fix
// is in words instead, which is what people were reading the ramp for anyway.

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
    point: read('--point'),
    accent: read('--accent'),
    surface: read('--surface-1'),
    course: read('--course')
  };
  return palette;
}

/** Every ping, whenever it arrived. The newest one is `accent()` instead. */
export const point   = () => getPalette().point;

export const accent  = () => getPalette().accent;
export const surface = () => getPalette().surface;

/** The race course. Off the blue ramp on purpose: the route is context, not data. */
export const course  = () => getPalette().course;

export const prefersDark = () =>
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
