// The drawn marks: sunrise, sunset, and a photograph.
//
// The drawings themselves live in `icons/*.svg` rather than in here, so that
// changing what a mark LOOKS like is editing one small file — with a drawing
// program if you like — and touching no code at all. This module is only the
// plumbing between those files and the two surfaces that draw them: deck.gl's
// `IconLayer`, which wants a texture atlas, and the height strip's 2D canvas,
// which wants an image to blit.
//
// Every mark is MONO. Whatever colour an SVG states is discarded: the raster is
// used as a stencil and refilled with one of the page's own five colours, so a
// mark follows the palette in either colour scheme and a replacement icon cannot
// arrive carrying a sixth colour. Opacity survives — it is the stencil's alpha —
// so a half-strength shape stays half-strength and a hole stays a hole, which is
// the only way a solid mark like the camera can have a lens.
//
// This replaced a pair of colour emoji. They were unusable for a reason worth
// recording: with `sdf: true` and with `sdf: false` alike, deck.gl 9.3.7 renders
// 🌅 as a solid filled square, because its font atlas keeps a glyph's coverage and
// throws away its colour — right for lettering, fatal for an emoji whose entire
// content is colour. Rasterising in our own canvas sidesteps that, and once the
// mark is ours rather than the platform's it also stops looking like a different
// picture on every operating system.

// There are two families here and the difference between them is not cosmetic.
//
// The DRAWN marks go onto a canvas — deck's atlas or the height strip — so they
// are rasterised through an `<img>` and refilled with one of the page's colours.
// A colour stated in one of those files is discarded, and `currentColor` in one
// resolves to whatever the file itself says, which is why they set `color`.
//
// The INLINED marks go into markup, inside a button, and are never rasterised at
// all. There `currentColor` is the whole point — it inherits the button's own ink
// and follows the light and dark schemes — so those files must NOT state a
// `color`, and their colours are their own. `icons/prev.svg` says so at the top.

/** The marks drawn onto a canvas, and so the filenames under `icons/`. */
export const GLYPHS = ['sunrise', 'sunset', 'photo'];

/** The marks inlined into markup. */
export const INLINE_GLYPHS = ['prev', 'next', 'expand'];

/**
 * The cell each mark is rasterised into, a side. Well past the 22 and 44 px they
 * are drawn at, so they stay crisp on a display with three times the density.
 */
export const CELL_PX = 96;

/**
 * How much of that cell is margin rather than drawing.
 *
 * The halo blurs OUTWARDS from the ink, and a drawing that ran to the edge of its
 * cell would have that blur cut off square — which reads as a box around the
 * mark, the one artefact worse than no halo at all. Every display size is quoted
 * in whole cells, so this margin is the difference between the size asked for and
 * the size seen; the callers' numbers already allow for it.
 */
export const INSET_PX = 8;

/** The halo's spread, in cell pixels. */
const HALO_PX = 5;

/** The load, once. Held so that a second caller waits on the first rather than
 *  fetching the same four files again. */
let loading = null;

/** name -> the raw rasterised drawing, in whatever ink the file happened to
 *  state. Only ever used as a stencil. */
const stencils = new Map();

/** `${name}|${ink}|${halo}` -> the finished, coloured mark. Built on demand and
 *  kept: the palette is read once per page, so there are only ever a handful. */
const marks = new Map();

/** name -> the SVG source of an inlined mark, ready to drop into markup. */
const sources = new Map();

/**
 * Fetch every mark: rasterise the drawn ones, hold the source of the inlined ones.
 *
 * Idempotent, and it never rejects: a mark whose file will not load simply isn't
 * there, and `glyph` answers null for it forever after. That is the right failure
 * — the dot under a sunrise still draws, and a map missing one icon is a great
 * deal better than a map missing everything because one file 404'd.
 *
 * Callers redraw when it settles. Nothing waits for it: the first paint happens
 * without the marks and they land on it a moment later, exactly as the photo
 * thumbnails do. The inlined ones have longer still — they are on a card that
 * only exists once somebody has clicked a photograph.
 *
 * @returns {Promise<void>}
 */
export function loadGlyphs() {
  loading ??= Promise
    .all([...GLYPHS.map(rasterise), ...INLINE_GLYPHS.map(fetchSource)])
    .then(() => undefined);
  return loading;
}

/**
 * One inlined mark, as markup, or '' before its file has arrived.
 *
 * Empty rather than a built-in fallback drawing, deliberately: a fallback would
 * be a second copy of the picture living in the code, which is the thing moving
 * these into files was for. The button around it carries its own `aria-label` and
 * `title`, so even the empty case is operable and named — and by the time one of
 * these is on screen a fetch begun at page load is long done.
 *
 * Returns markup, so it is HTML-unsafe by construction. Only ever our own files,
 * from our own origin, listed above.
 */
export function inlineGlyph(name) {
  return sources.get(name) ?? '';
}

/**
 * One mark, coloured, or null while its file is still on its way.
 *
 * @param {string} name one of `GLYPHS`.
 * @param {string} ink a CSS colour — the whole drawing is refilled with it.
 * @param {string|null} [halo] a CSS colour to spread behind the drawing. Worth it
 *   on the map, where whatever is underneath is whatever the basemap happens to
 *   be; pointless on the height strip, which owns its own background.
 * @returns {HTMLCanvasElement|null}
 */
export function glyph(name, ink, halo = null) {
  const stencil = stencils.get(name);
  if (!stencil) return null;

  const key = `${name}|${ink}|${halo ?? ''}`;
  let mark = marks.get(key);
  if (!mark) {
    mark = halo ? withHalo(tint(stencil, ink), halo) : tint(stencil, ink);
    marks.set(key, mark);
  }
  return mark;
}

/**
 * Several marks side by side as one texture, with the mapping deck.gl needs to
 * cut them back out of it.
 *
 * `mask: false` throughout: the colour is already in the texture, and it is the
 * page's own — letting deck tint it from a layer prop would be a second place
 * that decides what colour a sunrise is.
 *
 * Null unless EVERY mark asked for is ready, so a caller never draws an atlas
 * with a hole in it. It is cheap to ask again on the next paint, and the redraw
 * that `loadGlyphs` triggers is what makes that paint happen.
 *
 * @param {string[]} names
 * @returns {{atlas: HTMLCanvasElement, mapping: Object}|null}
 */
export function glyphAtlas(names, ink, halo = null) {
  const cells = names.map(name => glyph(name, ink, halo));
  if (cells.some(cell => !cell)) return null;

  const canvas = document.createElement('canvas');
  canvas.width = CELL_PX * names.length;
  canvas.height = CELL_PX;

  const c = canvas.getContext('2d');
  const mapping = {};
  names.forEach((name, i) => {
    c.drawImage(cells[i], i * CELL_PX, 0);
    mapping[name] = { x: i * CELL_PX, y: 0, width: CELL_PX, height: CELL_PX, mask: false };
  });

  return { atlas: canvas, mapping };
}

/** An `[r, g, b]` from [colors.js](colors.js) as something a canvas will take. */
export const inkOf = rgb => `rgb(${rgb.join(',')})`;

/**
 * Draw one SVG file into a cell.
 *
 * Loaded through an `<img>` rather than fetched and inlined, which is what makes
 * a replacement icon a drop-in: the browser parses it with its own SVG engine, so
 * whatever an editor writes out — groups, transforms, gradients, a `<style>`
 * block — renders exactly as it does anywhere else. `currentColor` resolves to
 * the file's own `color`, and none of it survives `tint` in any case.
 *
 * Resolved against this module's own URL so the app works from a sub-path, which
 * is how it is served on Pages.
 */
function rasterise(name) {
  return new Promise(resolve => {
    const img = new Image();
    const art = CELL_PX - 2 * INSET_PX;

    img.addEventListener('load', () => {
      const canvas = document.createElement('canvas');
      canvas.width = CELL_PX;
      canvas.height = CELL_PX;
      canvas.getContext('2d').drawImage(img, INSET_PX, INSET_PX, art, art);
      stencils.set(name, canvas);
      resolve();
    });
    // A missing or unparseable file leaves this name out of `stencils`, and every
    // later `glyph` for it answers null. Deliberately quiet: one icon short is a
    // cosmetic fault, and the console is where real ones are reported.
    img.addEventListener('error', () => resolve());

    img.src = new URL(`../icons/${name}.svg`, import.meta.url).href;
  });
}

/**
 * Read one SVG file as text, for inlining.
 *
 * The comment header every one of these files carries is stripped: it is a note
 * to whoever edits the file and has no business being copied into the DOM three
 * times per photo card.
 *
 * Quiet on failure, like `rasterise`, and for the same reason.
 */
async function fetchSource(name) {
  try {
    const url = new URL(`../icons/${name}.svg`, import.meta.url);
    const response = await fetch(url);
    if (!response.ok) return;
    sources.set(name, (await response.text()).replace(/<!--[\s\S]*?-->/g, '').trim());
  } catch {
    // Offline and not precached. The button is still there and still labelled.
  }
}

/**
 * The drawing, refilled with one colour.
 *
 * `source-in` keeps the destination's alpha and takes the source's colour, so
 * anti-aliased edges and any deliberate transparency — the camera's punched-out
 * lens — come through untouched while every hue in the file is thrown away. That
 * is what "mono" means here, and it is enforced rather than assumed: an icon
 * downloaded from anywhere at all arrives on this page in this page's colours.
 */
function tint(stencil, ink) {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_PX;
  canvas.height = CELL_PX;

  const c = canvas.getContext('2d');
  c.drawImage(stencil, 0, 0);
  c.globalCompositeOperation = 'source-in';
  c.fillStyle = ink;
  c.fillRect(0, 0, CELL_PX, CELL_PX);
  return canvas;
}

/**
 * The same drawing with the page's background spread behind it.
 *
 * The marks sit on a basemap this app does not control, and a one-colour drawing
 * on satellite imagery or on a dark street map can vanish outright — the colour
 * emoji these replaced carried their own contrast and never had to think about
 * it. This is the same bargain the waypoint labels already make with
 * `outlineColor`, drawn rather than typeset.
 *
 * Drawn three times because one shadow pass is faint: they accumulate to
 * something that actually separates the mark from what is under it, and the clean
 * copy on top keeps the drawing's own edges sharp.
 */
function withHalo(mark, halo) {
  const canvas = document.createElement('canvas');
  canvas.width = CELL_PX;
  canvas.height = CELL_PX;

  const c = canvas.getContext('2d');
  c.shadowColor = halo;
  c.shadowBlur = HALO_PX;
  for (let i = 0; i < 3; i++) c.drawImage(mark, 0, 0);

  c.shadowColor = 'transparent';
  c.shadowBlur = 0;
  c.drawImage(mark, 0, 0);
  return canvas;
}
