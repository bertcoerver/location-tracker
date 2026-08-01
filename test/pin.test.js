// The pure half of pin.js. `createPin` needs a DOM, which is a browser concern.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clampLeft, clampTop, same } from '../src/pin.js';

// --- staying on screen --------------------------------------------------------

test('clampLeft centres the tooltip on the cursor when there is room', () => {
  assert.equal(clampLeft(500, 200, 1400), 400);
});

test('clampLeft pushes back inside at both edges', () => {
  // At the far end of a scrolled strip the point being described is near the
  // window edge, and a centred tooltip would hang half off it.
  assert.equal(clampLeft(10, 200, 1400), 8);
  assert.equal(clampLeft(1390, 200, 1400), 1400 - 200 - 8);
});

test('clampLeft pins a tooltip wider than the window to the left margin', () => {
  // Something has to be clipped at that point, and losing the end of a line is
  // better than losing the start of one.
  assert.equal(clampLeft(200, 500, 390), 8);
});

test('clampLeft takes the margin as an argument rather than baking it in', () => {
  assert.equal(clampLeft(0, 100, 1000, 20), 20);
});

// --- and staying above the thing it describes ----------------------------------

test('clampTop puts the tooltip above the point, with room for the marker', () => {
  assert.equal(clampTop(500, 80), 500 - 80 - 14);
});

test('clampTop keeps the tooltip out of the top of the window', () => {
  assert.equal(clampTop(20, 80), 8);
});

test('clampTop lifts the tooltip clear of a ceiling', () => {
  // The height strip's case: a point down in a valley sits low in the band, and
  // "above the point" for that one is still on top of the terrain. Given the top
  // of the strip, the tooltip's BOTTOM edge lands there instead.
  const ceiling = 900;
  assert.equal(clampTop(980, 80), 980 - 80 - 14, 'no ceiling, no change');
  assert.equal(clampTop(980, 80, ceiling), ceiling - 80);
});

test('clampTop leaves a point already above the ceiling where it was', () => {
  // A point up by the skyline clears the strip on its own; the ceiling must not
  // push it back DOWN towards it.
  assert.equal(clampTop(860, 80, 900), 860 - 80 - 14);
});

// --- what counts as the same point --------------------------------------------

const at = (view, lat, lon, along) => ({ view, lat, lon, along, html: '' });

test('same() recognises a re-click on the point already pinned', () => {
  // This is what makes a click a toggle: clicking a pinned point puts it down.
  assert.ok(same(at('map', 46.5, 8.1, 100), at('map', 46.5, 8.1, 100)));
  // Different markup, same place — the tooltip is rebuilt on every click, so
  // comparing html would make every click a new selection.
  assert.ok(same(
    at('map', 46.5, 8.1, 100),
    { ...at('map', 46.5, 8.1, 100), html: '<div>rebuilt</div>' }
  ));
});

test('same() tells two different points apart', () => {
  assert.ok(!same(at('map', 46.5, 8.1, 100), at('map', 46.5, 8.2, 100)));
  assert.ok(!same(at('map', 46.5, 8.1, 100), at('map', 46.6, 8.1, 100)));
  // Two spots on a lap course can share a coordinate and not a distance.
  assert.ok(!same(at('map', 46.5, 8.1, 100), at('map', 46.5, 8.1, 4100)));
});

test('same() treats a switch of view as a move, not a dismissal', () => {
  // Clicking a point on the strip that is already pinned from the map has to
  // move the tooltip across, which is not nothing happening.
  assert.ok(!same(at('map', 46.5, 8.1, 100), at('profile', 46.5, 8.1, 100)));
});

test('same() tells two photographs apart by name, not by place', () => {
  const shot = name => ({ view: 'map', lat: 46.5, lon: 8.1, along: null, media: name, html: '' });
  // A burst, or two frames either side of one ping: identical coordinates, two
  // different pictures. Compared by place the second would read as the first being
  // clicked again and put the pin DOWN — and that is exactly the step the `>`
  // button makes, so it is not a corner case.
  assert.ok(!same(shot('a.jpg'), shot('b.jpg')));
  // And the toggle still has to work: clicking the photograph already pinned is
  // how you put it down.
  assert.ok(same(shot('a.jpg'), shot('a.jpg')));
  // A photograph and the bare place it sits on are not the same selection either.
  assert.ok(!same(shot('a.jpg'), at('map', 46.5, 8.1, null)));
});

test('same() is false when either side is nothing', () => {
  // The first click of all, and the click on bare basemap that dismisses.
  assert.ok(!same(null, at('map', 46.5, 8.1, 100)));
  assert.ok(!same(at('map', 46.5, 8.1, 100), null));
  assert.ok(!same(null, null), 'two dismissals in a row must not toggle back on');
});
