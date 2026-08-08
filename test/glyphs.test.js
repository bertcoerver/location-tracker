// The drawn marks are files on disk, so what there is to check here is about the
// files: that every name the app asks for has one, that the worker will have
// cached it, and that the two a night puts on a course are not the same picture.
//
// The rasteriser itself is a canvas and an `<img>` and belongs in a browser, so
// none of it runs here. Importing the module is safe — nothing in it touches
// `document` until something asks for a mark.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { GLYPHS, INLINE_GLYPHS } from '../src/glyphs.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = name => readFileSync(`${root}icons/${name}.svg`, 'utf8');
const all = [...GLYPHS, ...INLINE_GLYPHS];

test('every mark the app names has a file, and the file is an SVG', () => {
  // The failure this exists for: renaming an icon and leaving the name behind in
  // `GLYPHS`, which in a browser is silent — both loaders swallow the 404 and the
  // mark simply never appears.
  for (const name of all) {
    const svg = read(name);
    assert.match(svg, /<svg[\s>]/, `icons/${name}.svg is not an SVG`);
    assert.match(svg, /viewBox="0 0 24 24"/,
      `icons/${name}.svg is not on the 24x24 grid the others are`);
  }
});

test('the drawn marks fix their own colour and the inlined ones inherit it', () => {
  // The one rule that differs between the two families, and the one that fails
  // silently in opposite directions: a drawn mark without `color` is at the mercy
  // of what an `<img>` context resolves `currentColor` to, and an inlined mark WITH
  // one is frozen black inside a button that is white on a dark scheme.
  for (const name of GLYPHS) {
    assert.match(read(name), /\scolor="/, `icons/${name}.svg states no color`);
  }
  for (const name of INLINE_GLYPHS) {
    assert.doesNotMatch(read(name), /\scolor="/,
      `icons/${name}.svg states a color, so it cannot inherit the button's ink`);
  }
});

test('an inlined mark is one self-contained element', () => {
  // It is dropped straight into a button, so anything before or after the root
  // element lands in the DOM with it — and `fetchSource` strips only comments.
  for (const name of INLINE_GLYPHS) {
    const svg = read(name).replace(/<!--[\s\S]*?-->/g, '').trim();
    assert.ok(svg.startsWith('<svg'), `icons/${name}.svg has markup before its root`);
    assert.ok(svg.endsWith('</svg>'), `icons/${name}.svg has markup after its root`);
  }
});

test('sunrise and sunset are not the same picture', () => {
  // Two marks a night that look alike are two marks that say nothing. The pair is
  // meant to differ in what is RISING — a sun with rays, a crescent moon — rather
  // than in the horizon and the arrow they share, so this is a floor and not a
  // proof: it catches the copy-paste, which is the way they would actually end up
  // identical.
  assert.notEqual(strip(read('sunrise')), strip(read('sunset')));
});

test('every mark is precached by the worker', () => {
  // Same guard as `every module in src/ is precached`, and the same failure: a
  // course opened offline would draw its sunrises as bare dots.
  const source = readFileSync(`${root}sw.js`, 'utf8');
  const body = source.match(/const SHELL_URLS = \[([\s\S]*?)\];/);
  assert.ok(body, 'SHELL_URLS is not where this test expects it');
  const cached = new Set([...body[1].matchAll(/'([^']+)'/g)].map(m => m[1]));

  for (const name of all) {
    assert.ok(cached.has(`./icons/${name}.svg`), `icons/${name}.svg is not in SHELL_URLS`);
  }
});

/** The drawing alone: comments off, whitespace flattened. Two files that differ
 *  only in what they say ABOUT themselves are the same picture. */
function strip(svg) {
  return svg.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim();
}
