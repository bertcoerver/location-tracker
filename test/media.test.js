// The two halves of media.js that can be tested without a browser: reading EXIF
// out of a JPEG, and deciding where a file belongs on the map.
//
// The EXIF half is tested against a REAL photograph as well as against synthetic
// ones. A hand-built fixture only ever proves the parser agrees with the same
// author's reading of the spec; the iPhone file proves it agrees with a camera.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isAnimated, isVideo, MEDIA_RE, mediaKind, mediaTime, parseExif, placeMedia
} from '../src/media.js';

const MINUTE = 60000;

/** A file's bytes as a standalone ArrayBuffer — `readFileSync` hands back a view
 *  into a shared pool, and passing its whole `.buffer` reads the wrong bytes. */
function fixture(name) {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// --- naming -------------------------------------------------------------------

test('MEDIA_RE admits the formats a phone actually produces, and nothing else', () => {
  for (const name of ['a.jpg', 'a.jpeg', 'a.png', 'a.gif', 'a.webm', 'a.mp4', 'a.m4v', 'a.mov',
                      'A.JPG', 'A.JPEG', 'A.PNG', 'A.GIF', 'A.WEBM', 'A.MP4', 'A.M4V', 'A.MOV']) {
    assert.ok(MEDIA_RE.test(name), `${name} should be media`);
  }
  // `.heic` is the one worth naming: it is what an iPhone shoots by default, and
  // browsers largely cannot decode it. Excluded rather than half-supported —
  // unlike `.mov`, which is the same phone's video and which browsers largely
  // CAN, so it is admitted and left to degrade where they can't.
  for (const name of ['a.json', 'a.gpx', 'course_settings.json', 'a.heic', 'a.webp', 'a.avi', 'a']) {
    assert.ok(!MEDIA_RE.test(name), `${name} should not be media`);
  }
});

test('the two jpeg spellings collapse to one kind', () => {
  assert.equal(mediaKind('a.jpg'), 'jpeg');
  assert.equal(mediaKind('a.JPEG'), 'jpeg');
  assert.equal(mediaKind('a.webm'), 'webm');
  assert.equal(mediaKind('a.MOV'), 'mov');
  assert.equal(mediaKind('a.json'), null);
});

test('a clip is a clip whatever container it came in', () => {
  for (const name of ['a.webm', 'a.mp4', 'a.m4v', 'a.MOV']) {
    assert.equal(isVideo(name), true, `${name} should want a <video>`);
  }
  // A GIF moves and still is not video: it animates as an image, and a player
  // would give it controls it has no use for.
  for (const name of ['a.gif', 'a.jpg', 'a.png', 'a.json']) {
    assert.equal(isVideo(name), false, `${name} should want an <img>`);
  }
});

test('only the formats that can move get a play badge', () => {
  assert.equal(isAnimated('a.gif'), true);
  assert.equal(isAnimated('a.webm'), true);
  assert.equal(isAnimated('a.mp4'), true);
  assert.equal(isAnimated('a.mov'), true);
  assert.equal(isAnimated('a.jpg'), false);
  assert.equal(isAnimated('a.png'), false);
});

test('a media filename carries a time the same way a ping filename does', () => {
  assert.equal(mediaTime('2026-07-30T18_15_02+00_00.jpeg'), Date.UTC(2026, 6, 30, 18, 15, 2));
  assert.equal(mediaTime('2026-07-30T20_15_02+02_00.png'), Date.UTC(2026, 6, 30, 18, 15, 2));
  // No stamp is the ordinary case, not an error: such a file is placeable only if
  // it carries its own coordinates.
  assert.ok(Number.isNaN(mediaTime('sunset.jpg')));
  assert.ok(Number.isNaN(mediaTime('IMG_4021.jpeg')));
});

// --- EXIF, against a real camera ----------------------------------------------

test('a real iPhone photo gives up its time, its place and its height', () => {
  const exif = parseExif(fixture('exif-gps.jpg'));

  // 2024:09:27 09:28:15 with OffsetTimeOriginal +02:00 — so the zone is recorded
  // and nothing has to be assumed about it.
  assert.equal(exif.t, Date.UTC(2024, 8, 27, 7, 28, 15));
  assert.equal(exif.assumedUtc, false);

  assert.ok(Math.abs(exif.lat - 43.034022) < 1e-5, `lat was ${exif.lat}`);
  assert.ok(Math.abs(exif.lon - -0.447694) < 1e-5, `lon was ${exif.lon}`);
  assert.ok(Math.abs(exif.ele - 1169.3) < 0.1, `ele was ${exif.ele}`);
});

test('a photo from the same camera with no GPS gives a time and no place', () => {
  const exif = parseExif(fixture('exif-plain.jpg'));
  assert.equal(exif.t, Date.UTC(2024, 8, 27, 7, 28, 15));
  assert.equal(exif.lat, null);
  assert.equal(exif.lon, null);
  assert.equal(exif.ele, null);
});

test('both fixtures are truncated files, and the walk stops rather than throwing', () => {
  // 8 KB of a 346 KB photo: the EXIF block ends around byte 3000, so everything
  // worth reading is here and the scan marker never is. A parser that assumed it
  // would reach the end of the image would run off this.
  assert.equal(fixture('exif-gps.jpg').byteLength, 8192);
  assert.ok(parseExif(fixture('exif-gps.jpg')));
});

// --- EXIF, against files no camera on disk produces ---------------------------

/**
 * A minimal JPEG carrying one EXIF block, for the branches the real photos don't
 * reach. `tags` is a list of `[ifd, tag, type, values]`, where `ifd` is `0`,
 * `'exif'` or `'gps'`.
 *
 * Deliberately writes a JFIF APP0 first, like a phone does, so every case here
 * also exercises the marker walk rather than an APP1 that happens to be first.
 */
function buildJpeg({ little = false, tags = [], stopAt = null } = {}) {
  const bytes = [];
  const u8 = v => bytes.push(v & 0xff);
  const u16 = v => { bytes.push((v >> 8) & 0xff, v & 0xff); };

  const tiff = [];
  const t8 = v => tiff.push(v & 0xff);
  const t16 = v => little ? tiff.push(v & 0xff, (v >> 8) & 0xff) : tiff.push((v >> 8) & 0xff, v & 0xff);
  const t32 = v => little
    ? tiff.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
    : tiff.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);

  const group = which => tags.filter(t => t[0] === which);
  const zero = group(0);
  const exif = group('exif');
  const gps = group('gps');

  // header: order, magic, offset of IFD0
  little ? tiff.push(0x49, 0x49) : tiff.push(0x4d, 0x4d);
  t16(0x2a);
  t32(8);

  // Every IFD is laid out one after another, with all three IFDs' overflow values
  // behind the last of them. Every offset written is relative to the start of
  // `tiff` rather than to the start of the file, which is the whole point of the
  // exercise.
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 10: 8 };
  const encode = (type, values) => {
    const out = [];
    const push8 = v => out.push(v & 0xff);
    const push16 = v => little ? out.push(v & 0xff, (v >> 8) & 0xff) : out.push((v >> 8) & 0xff, v & 0xff);
    const push32 = v => little
      ? out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff)
      : out.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    for (const v of values) {
      if (type === 1) push8(v);
      else if (type === 2) push8(v);
      else if (type === 3) push16(v);
      else if (type === 4) push32(v);
      else { push32(v[0]); push32(v[1]); }
    }
    return out;
  };

  // Where each IFD starts, worked out before anything is written. IFD0 holds two
  // entries nobody passed in — the pointers to the other two — so its size has to
  // be counted from what will actually be written rather than from `zero`.
  const sizeOf = n => 2 + n * 12 + 4;
  const exifAt = 8 + sizeOf(zero.length + 2);
  const gpsAt = exifAt + sizeOf(exif.length);
  const overflowAt = gpsAt + sizeOf(gps.length);

  const overflow = [];
  const writeIfd = (list, extras) => {
    t16(list.length + extras.length);
    for (const [, tag, type, values] of [...list, ...extras]) {
      const count = values.length;
      const bytesNeeded = SIZE[type] * count;
      t16(tag);
      t16(type);
      t32(count);
      const encoded = encode(type, values);
      if (bytesNeeded <= 4) {
        // Inline, left-aligned in the four-byte field.
        for (let i = 0; i < 4; i++) t8(encoded[i] ?? 0);
      } else {
        t32(overflowAt + overflow.length);
        overflow.push(...encoded);
      }
    }
    t32(0);
  };

  // IFD0 gains the pointers to the two sub-IFDs.
  writeIfd(zero, [
    [0, 0x8769, 4, [exifAt]],
    [0, 0x8825, 4, [gpsAt]]
  ]);
  writeIfd(exif, []);
  writeIfd(gps, []);
  tiff.push(...overflow);

  u16(0xffd8);
  // APP0/JFIF, so APP1 is never the first segment.
  u16(0xffe0); u16(16);
  for (const c of 'JFIF\0') u8(c.charCodeAt(0));
  for (let i = 0; i < 9; i++) u8(0);

  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  u16(0xffe1);
  u16(payload.length + 2);
  bytes.push(...payload);
  u16(0xffda);          // start of scan, and nothing after it

  const all = Uint8Array.from(stopAt === null ? bytes : bytes.slice(0, stopAt));
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const ascii = s => [...s].map(c => c.charCodeAt(0)).concat(0);

test('a little-endian TIFF reads the same as a big-endian one', () => {
  const tags = [[ 'exif', 0x9003, 2, ascii('2026:07:30 18:15:02') ]];
  const be = parseExif(buildJpeg({ little: false, tags }));
  const le = parseExif(buildJpeg({ little: true, tags }));
  assert.equal(be.t, Date.UTC(2026, 6, 30, 18, 15, 2));
  assert.equal(le.t, be.t);
});

test('with no recorded offset the clock is read as UTC, and says so', () => {
  const exif = parseExif(buildJpeg({
    tags: [['exif', 0x9003, 2, ascii('2026:07:30 18:15:02')]]
  }));
  assert.equal(exif.t, Date.UTC(2026, 6, 30, 18, 15, 2));
  assert.equal(exif.assumedUtc, true);
});

test('a recorded offset is honoured and the caveat drops away', () => {
  const exif = parseExif(buildJpeg({
    tags: [
      ['exif', 0x9003, 2, ascii('2026:07:30 20:15:02')],
      ['exif', 0x9011, 2, ascii('+02:00')]
    ]
  }));
  assert.equal(exif.t, Date.UTC(2026, 6, 30, 18, 15, 2));
  assert.equal(exif.assumedUtc, false);
});

test('south and west are negative', () => {
  const exif = parseExif(buildJpeg({
    tags: [
      ['gps', 0x0001, 2, ascii('S')],
      ['gps', 0x0002, 5, [[21, 1], [6, 1], [54, 1]]],
      ['gps', 0x0003, 2, ascii('W')],
      ['gps', 0x0004, 5, [[55, 1], [32, 1], [9, 1]]]
    ]
  }));
  assert.ok(Math.abs(exif.lat - -21.115) < 1e-6, `lat was ${exif.lat}`);
  assert.ok(Math.abs(exif.lon - -55.5358333) < 1e-6, `lon was ${exif.lon}`);
});

test('an altitude below sea level is negative', () => {
  const exif = parseExif(buildJpeg({
    tags: [
      ['gps', 0x0001, 2, ascii('N')],
      ['gps', 0x0002, 5, [[31, 1], [30, 1], [0, 1]]],
      ['gps', 0x0003, 2, ascii('E')],
      ['gps', 0x0004, 5, [[35, 1], [30, 1], [0, 1]]],
      ['gps', 0x0005, 1, [1]],
      ['gps', 0x0006, 5, [[4300, 10]]]
    ]
  }));
  assert.ok(Math.abs(exif.ele - -430) < 0.01, `ele was ${exif.ele}`);
});

test('a fix at exactly 0,0 is a camera that never got one', () => {
  const exif = parseExif(buildJpeg({
    tags: [
      ['exif', 0x9003, 2, ascii('2026:07:30 18:15:02')],
      ['gps', 0x0001, 2, ascii('N')],
      ['gps', 0x0002, 5, [[0, 1], [0, 1], [0, 1]]],
      ['gps', 0x0003, 2, ascii('E')],
      ['gps', 0x0004, 5, [[0, 1], [0, 1], [0, 1]]]
    ]
  }));
  assert.equal(exif.lat, null);
  assert.equal(exif.lon, null);
  // The time survives it: null island is a bad coordinate, not a bad file.
  assert.equal(exif.t, Date.UTC(2026, 6, 30, 18, 15, 2));
});

test('one bad file never throws, whatever is wrong with it', () => {
  const cases = {
    'not a jpeg at all': Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
    'empty': new ArrayBuffer(0),
    'two bytes': Uint8Array.from([0xff, 0xd8]).buffer,
    'cut off mid-IFD': buildJpeg({
      tags: [['exif', 0x9003, 2, ascii('2026:07:30 18:15:02')]], stopAt: 30
    }),
    'cut off mid-header': buildJpeg({
      tags: [['exif', 0x9003, 2, ascii('2026:07:30 18:15:02')]], stopAt: 24
    })
  };
  for (const [what, buffer] of Object.entries(cases)) {
    assert.doesNotThrow(() => parseExif(buffer), what);
  }
});

test('a jpeg with no EXIF at all reads as no EXIF, not as an error', () => {
  // SOI then straight to the scan.
  assert.equal(parseExif(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 2]).buffer), null);
});

test('an EXIF block that said nothing useful is the same as none', () => {
  assert.equal(parseExif(buildJpeg({ tags: [] })), null);
});

// --- placing ------------------------------------------------------------------

const T0 = Date.UTC(2026, 6, 30, 12, 0, 0);

/** A dozen fixes five minutes apart, running due east. */
const PINGS = Array.from({ length: 12 }, (_, i) => ({
  name: `p${i}.json`, t: T0 + i * 5 * MINUTE, lat: 45.8, lon: 6.1 + i * 0.01
}));

const record = over => ({
  name: 'x.jpg', sha: 'sha1', url: 'https://example/x.jpg',
  t: null, assumedUtc: false, lat: null, lon: null, ele: null, ...over
});

const only = (...records) => placeMedia(records, PINGS, null);

test('the filename beats the metadata about when', () => {
  // The case the whole precedence exists for: a photo shot in 2024 and renamed
  // into a 2026 run. Trusting the camera would put it outside the span entirely
  // and it would vanish.
  const [poi] = only(record({
    name: '2026-07-30T12_12_30+00_00.jpg',
    t: Date.UTC(2024, 8, 27, 7, 28, 15)
  }));
  assert.equal(poi.t, Date.UTC(2026, 6, 30, 12, 12, 30));
  assert.equal(poi.source, 'trace');
  // Halfway between the third and fourth fix, so halfway between their longitudes.
  assert.ok(Math.abs(poi.lon - 6.125) < 1e-9, `lon was ${poi.lon}`);
  // A filename stamp carries its own offset, so the camera's zone question never
  // arises — even when the metadata it beat had no offset of its own.
  assert.equal(poi.assumedUtc, false);
});

test('the metadata beats the filename about where', () => {
  const [poi] = only(record({
    name: '2026-07-30T12_12_30+00_00.jpg', lat: 43.034, lon: -0.4477, ele: 1169.3
  }));
  assert.equal(poi.source, 'exif');
  assert.equal(poi.lat, 43.034);
  assert.equal(poi.lon, -0.4477);
  assert.equal(poi.ele, 1169.3);
  // Its own coordinates and a moment make it a fix, and a fix belongs in the
  // points array.
  assert.equal(poi.point, true);
  // Nothing was interpolated, so there is no distance along the course to show.
  assert.equal(poi.along, null);
});

test('a filename stamp alone is interpolated between the pings either side', () => {
  const [poi] = only(record({ name: '2026-07-30T12_07_30+00_00.jpg' }));
  assert.equal(poi.source, 'trace');
  assert.equal(poi.point, false);
  assert.ok(Math.abs(poi.lon - 6.115) < 1e-9, `lon was ${poi.lon}`);
  assert.equal(poi.gap, 5 * MINUTE);
});

test('metadata time is used when the filename has none', () => {
  const [poi] = only(record({ name: 'IMG_4021.jpg', t: T0 + 7 * MINUTE, assumedUtc: true }));
  assert.equal(poi.t, T0 + 7 * MINUTE);
  assert.equal(poi.source, 'trace');
  // The caveat survives all the way to the tooltip, because nothing has replaced
  // the guess it describes.
  assert.equal(poi.assumedUtc, true);
});

test('a moment outside the pings is dropped, never extrapolated', () => {
  const before = only(record({ name: '2026-07-30T11_00_00+00_00.jpg' }));
  const after = only(record({ name: '2026-07-30T23_00_00+00_00.jpg' }));
  assert.deepEqual(before, []);
  assert.deepEqual(after, []);
});

test('a photo outside the pings is still placed if it knows where it was', () => {
  // Its own coordinates are a measurement; the span only bounds what can be
  // GUESSED.
  const [poi] = only(record({
    name: '2026-07-30T23_00_00+00_00.jpg', lat: 45.9, lon: 6.3
  }));
  assert.equal(poi.lat, 45.9);
  assert.equal(poi.point, true);
});

test('coordinates and no time at all is a place, not a moment', () => {
  const [poi] = only(record({ name: 'summit.jpg', lat: 45.9, lon: 6.3 }));
  assert.equal(poi.t, null);
  assert.equal(poi.source, 'exif');
  // Emphatically not a point: everything downstream of `buildPoints` sorts on a
  // `t` and would be sorting on null.
  assert.equal(poi.point, false);
});

test('neither a time nor a place is nothing to draw', () => {
  assert.deepEqual(only(record({ name: 'summit.jpg' })), []);
});

test('an animated file is marked as one, whatever else is true of it', () => {
  const [clip] = only(record({ name: '2026-07-30T12_07_30+00_00.webm' }));
  const [still] = only(record({ name: '2026-07-30T12_07_30+00_00.jpg' }));
  assert.equal(clip.animated, true);
  assert.equal(still.animated, false);
});

test('the run with no media at all comes back empty rather than undefined', () => {
  assert.deepEqual(placeMedia([], PINGS, null), []);
  assert.deepEqual(placeMedia(undefined, PINGS, null), []);
  assert.deepEqual(placeMedia([null], PINGS, null), []);
});

test('placed media is oldest first, with the timeless ones at the end', () => {
  const pois = placeMedia([
    record({ name: 'summit.jpg', sha: 'a', lat: 45.9, lon: 6.3 }),
    record({ name: '2026-07-30T12_40_00+00_00.jpg', sha: 'b' }),
    record({ name: '2026-07-30T12_10_00+00_00.jpg', sha: 'c' })
  ], PINGS, null);
  assert.deepEqual(pois.map(p => p.sha), ['c', 'b', 'a']);
});

test('one photo is never interpolated off another', () => {
  // Both are placed against the same pings, so adding the first cannot move the
  // second — which is what makes the result independent of listing order.
  const forward = placeMedia([
    record({ name: '2026-07-30T12_02_30+00_00.jpg', sha: 'a' }),
    record({ name: '2026-07-30T12_07_30+00_00.jpg', sha: 'b' })
  ], PINGS, null);
  const reversed = placeMedia([
    record({ name: '2026-07-30T12_07_30+00_00.jpg', sha: 'b' }),
    record({ name: '2026-07-30T12_02_30+00_00.jpg', sha: 'a' })
  ], PINGS, null);
  assert.deepEqual(forward.map(p => [p.sha, p.lon]), reversed.map(p => [p.sha, p.lon]));
});
