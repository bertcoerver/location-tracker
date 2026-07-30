// The pure half of geo.js. The watch itself is a browser API and a permission
// prompt, which is a browser concern — but the two things that can silently go
// wrong are the shape of what comes back and what we say when nothing does.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { geoMessage, isDenied, supported, viewerFrom } from '../src/geo.js';

/** A `GeolocationPosition` is a plain read to us, so a literal stands in for one. */
const fix = (coords, timestamp = Date.parse('2026-07-30T09:00:00Z')) => ({ coords, timestamp });

test('a fix becomes a drawable position, accuracy in metres', () => {
  const at = viewerFrom(fix({ latitude: 46.5, longitude: 8.1, accuracy: 25 }));

  assert.deepEqual(at, {
    lat: 46.5,
    lon: 8.1,
    accuracy: 25,
    t: Date.parse('2026-07-30T09:00:00Z')
  });
});

test('nothing at all is not a position', () => {
  assert.equal(viewerFrom(null), null);
  assert.equal(viewerFrom(undefined), null);
  assert.equal(viewerFrom({}), null);
});

test('a coordinate that is not a number is refused rather than drawn', () => {
  // It reaches a layer as a dot at an undefined place, which is worse than no
  // dot: the mark is there, it means nothing, and nothing on screen says so.
  for (const coords of [
    { latitude: NaN, longitude: 8.1, accuracy: 25 },
    { latitude: 46.5, longitude: NaN, accuracy: 25 },
    { latitude: 46.5, accuracy: 25 },
    { latitude: '46.5', longitude: '8.1', accuracy: 25 }
  ]) {
    assert.equal(viewerFrom(fix(coords)), null, JSON.stringify(coords));
  }
});

test('an accuracy worth nothing becomes null, so no circle is drawn from it', () => {
  // The circle is a claim about precision. Made out of a missing or impossible
  // radius it would be a claim about nothing, which is the one thing this marker
  // exists not to do — `viewerLayers` skips the layer entirely on a null.
  for (const accuracy of [undefined, null, 0, -5, NaN, Infinity, 'lots']) {
    const at = viewerFrom(fix({ latitude: 46.5, longitude: 8.1, accuracy }));
    assert.equal(at.accuracy, null, String(accuracy));
    // And the position itself still stands: a fix with no stated accuracy is
    // still a fix, and the dot is the part that matters.
    assert.equal(at.lat, 46.5);
  }
});

test('a position with no timestamp is now, not 1970', () => {
  const before = Date.now();
  const at = viewerFrom({ coords: { latitude: 46.5, longitude: 8.1, accuracy: 10 } });
  assert.ok(at.t >= before && at.t <= Date.now(), String(at.t));
});

test('each failure gets its own words, chosen by code and not by the browser', () => {
  // The messages browsers supply differ by browser and by locale, and one of
  // them is "User denied Geolocation", which is not a thing to show anyone.
  assert.equal(geoMessage({ code: 1, message: 'User denied Geolocation' }), 'blocked');
  assert.equal(geoMessage({ code: 2 }), 'unavailable');
  assert.equal(geoMessage({ code: 3 }), 'no signal');
});

test('an unrecognised failure still says something', () => {
  assert.equal(geoMessage({ code: 99 }), 'unavailable');
  assert.equal(geoMessage(null), 'unavailable');
});

test('only a refusal is permanent', () => {
  // It is the one error we stop retrying on and the one that unticks the box:
  // a timeout is worth another go, a revoked permission is not.
  assert.equal(isDenied({ code: 1 }), true);
  assert.equal(isDenied({ code: 2 }), false);
  assert.equal(isDenied({ code: 3 }), false);
  assert.equal(isDenied(null), false);
});

test('under node there is nothing to ask, so the control is never offered', () => {
  // Which is the same answer the browser gives over plain http from a LAN
  // address: the API may be there, the secure context is not.
  assert.equal(supported(), false);
});
