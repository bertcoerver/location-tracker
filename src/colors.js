// Colour comes from the CSS custom properties in index.html, so light/dark are
// defined in exactly one place and this file just reads whichever is active.
//
// The ramp is a single blue hue, oldest -> newest, and it INVERTS between modes:
// light mode runs light->dark, dark mode dark->light, so the newest fix always
// carries the most contrast against the basemap. Both directions were checked
// for monotone lightness, adjacent-step separation, and contrast against their
// surface.

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Sample a list of RGB stops at t in [0, 1]. Pure, so it's testable without a DOM.
 */
export function interpolate(stops, t) {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f)
  ];
}

// Read lazily and once: the stylesheet must be applied before this resolves,
// and tests can import the pure helpers above without touching the DOM.
let palette = null;

export function getPalette() {
  if (palette) return palette;

  const css = getComputedStyle(document.documentElement);
  const read = name => hexToRgb(css.getPropertyValue(name).trim());

  palette = {
    ramp: ['--ramp-0', '--ramp-1', '--ramp-2', '--ramp-3', '--ramp-4'].map(read),
    accent: read('--accent'),
    surface: read('--surface-1')
  };
  return palette;
}

/** The sequential ramp sampled at t in [0, 1] — 0 = oldest fix, 1 = newest. */
export function rampAt(t) {
  return interpolate(getPalette().ramp, t);
}

export const accent  = () => getPalette().accent;
export const surface = () => getPalette().surface;

export const prefersDark = () =>
  globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
