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
  applyMediaSnaps, crewOf, isAnimated, isQuickTime, isVideo, MEDIA_RE, mediaKind, mediaTime,
  parseExif, parseIso6709, parseQuickTime, placeMedia
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

test('a crew name in front of a filename is read, and only when it is shouted', () => {
  const crew = ['Mariam', 'Jo'];
  assert.equal(crewOf('MARIAM_IMG_4021.jpg', crew), 'Mariam');
  // The casing that comes back is the casing the settings file wrote, because that
  // is what ends up on the card.
  assert.equal(crewOf('JO_IMG_4021.jpg', crew), 'Jo');

  // Capitals are the whole mark. `Mariam_and_me.jpg` is a filename an ordinary
  // person types about an ordinary photograph, and claiming it would move somebody
  // else's picture off the course.
  assert.equal(crewOf('Mariam_and_me.jpg', crew), null);
  assert.equal(crewOf('mariam_IMG_4021.jpg', crew), null);
  // Only the FIRST part, and only the whole of it.
  assert.equal(crewOf('IMG_MARIAM_4021.jpg', crew), null);
  assert.equal(crewOf('MARIAMS_IMG_4021.jpg', crew), null);
  assert.equal(crewOf('MARIAM.jpg', crew), null);

  // Nobody named, nothing to match — which is every run in this repo but one.
  assert.equal(crewOf('MARIAM_IMG_4021.jpg', []), null);
  assert.equal(crewOf('MARIAM_IMG_4021.jpg', undefined), null);
  assert.equal(crewOf('', crew), null);
});

test('a crew photo keeps the filename authority over the clock, past the name', () => {
  assert.equal(
    mediaTime('MARIAM_2026-07-30T18_15_02+00_00.jpeg', 'Mariam'),
    Date.UTC(2026, 6, 30, 18, 15, 2)
  );
  // And the shape guard still does its work one prefix further in: `IMG_4021` must
  // not become the year 4021 just because somebody's name is in front of it.
  assert.ok(Number.isNaN(mediaTime('MARIAM_IMG_4021.jpeg', 'Mariam')));
  // Without the prefix stripped, a stamped crew file reads as no stamp at all —
  // which is exactly what would happen if `place` forgot to pass the name.
  assert.ok(Number.isNaN(mediaTime('MARIAM_2026-07-30T18_15_02+00_00.jpeg')));
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

test('a caption written on a phone comes back with its emoji intact', () => {
  // The head of a real iPhone photo out of `locations/Lac`, captioned through the
  // iOS share sheet. TIFF calls this field ASCII and the phone wrote UTF-8 into it
  // anyway — four bytes of emoji at the end — which is exactly the case a
  // charCode-per-byte reader turns into eight characters of mojibake.
  const exif = parseExif(fixture('exif-caption.jpg'));
  assert.equal(exif.caption, 'A road with tree 😍🌳');
  assert.equal(exif.t, Date.UTC(2026, 7, 5, 9, 37, 38));
});

test('a photo nobody captioned says so, rather than saying nothing much', () => {
  assert.equal(parseExif(fixture('exif-gps.jpg')).caption, null);
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

/** A string as the UTF-8 bytes a camera would actually write, NUL-terminated. */
const utf8 = s => [...new TextEncoder().encode(s)].concat(0);

test('a caption is enough on its own to keep a file worth reading', () => {
  // No time and no place in the block at all — but the file may still be placed by
  // its NAME, and returning null here would throw the words away with the nothing.
  const exif = parseExif(buildJpeg({ tags: [[0, 0x010e, 2, utf8('Halfway up')]] }));
  assert.equal(exif.caption, 'Halfway up');
  assert.equal(exif.t, null);
  assert.equal(exif.lat, null);
});

test('a caption field with nothing in it is no caption', () => {
  for (const written of ['', '   ', '\n']) {
    const exif = parseExif(buildJpeg({
      tags: [
        ['exif', 0x9003, 2, ascii('2026:07:30 18:15:02')],
        [0, 0x010e, 2, utf8(written)]
      ]
    }));
    assert.equal(exif.caption, null, `"${written}" should read as no caption`);
  }
});

test('a caption longer than a caption is cut rather than allowed to eat the card', () => {
  const exif = parseExif(buildJpeg({ tags: [[0, 0x010e, 2, utf8('x'.repeat(500))]] }));
  assert.equal(exif.caption.length, 280);
});

// --- QuickTime, against a real phone ------------------------------------------
//
// `quicktime-iphone.mov` is the `ftyp` and `moov` of a clip filmed at Lac on the
// morning of 5 August 2026, with the `mdat` — 3.4 MB of HEVC — cut out. What is
// left is every byte this parser reads and none of the bytes it skips, which is
// what makes a 6 KB fixture a fair test of a file that was three megabytes.

test('a real iPhone clip gives up its time and its place', () => {
  const meta = parseQuickTime(fixture('quicktime-iphone.mov'));

  // `com.apple.quicktime.creationdate`, which carries its own +02:00 — so there is
  // no zone to guess at and no caveat to pass on.
  assert.equal(meta.t, Date.UTC(2026, 7, 5, 9, 46, 38));
  assert.equal(meta.assumedUtc, false);

  // `com.apple.quicktime.location.ISO6709`: +46.6261-001.1173+000.000/
  assert.ok(Math.abs(meta.lat - 46.6261) < 1e-9, `lat was ${meta.lat}`);
  assert.ok(Math.abs(meta.lon - -1.1173) < 1e-9, `lon was ${meta.lon}`);
  // The altitude the phone wrote is exactly zero, which is what it writes when it
  // has a fix and no height. Read as absent rather than as sea level.
  assert.equal(meta.ele, null);

  assert.equal(meta.caption, null);
});

test('the clip lands where the photographs beside it in the folder do', () => {
  // The point of the whole exercise, and the one assertion that would have caught
  // the bug: this clip was filmed between two JPEGs whose own EXIF puts them at
  // 46.632–46.637 N, 1.135–1.138 W. A parser that read the coordinate backwards,
  // or as degrees-and-minutes, would still produce a number.
  const meta = parseQuickTime(fixture('quicktime-iphone.mov'));
  assert.ok(meta.lat > 46.6 && meta.lat < 46.7, `lat was ${meta.lat}`);
  assert.ok(meta.lon > -1.2 && meta.lon < -1.0, `lon was ${meta.lon}`);
});

test('only the containers built out of atoms are worth opening', () => {
  for (const name of ['a.mov', 'a.MP4', 'a.m4v']) {
    assert.equal(isQuickTime(name), true, `${name} should be opened`);
  }
  // WebM is Matroska and shares none of this, and the stills have their own
  // parser or no metadata worth a download.
  for (const name of ['a.webm', 'a.jpg', 'a.png', 'a.gif', 'a.json']) {
    assert.equal(isQuickTime(name), false, `${name} should not be opened`);
  }
});

// --- QuickTime, against files this repo builds --------------------------------

/** Four bytes, big-endian, as an array. */
const b32 = v => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const b16 = v => [(v >> 8) & 0xff, v & 0xff];
/** A box type or a key name, one byte per character. Not a UTF-8 encoder, and the
 *  difference matters at exactly one place: `©xyz` is a FOUR-byte atom type
 *  beginning with byte 0xA9, and encoding it as UTF-8 would make it five. */
const chars = s => [...s].map(c => c.charCodeAt(0));

/** A value somebody wrote, which can hold anything UTF-8 can. */
const words = s => [...new TextEncoder().encode(s)];

/** One box. `type` is four characters, or a NUMBER — which is what an `ilst` item's
 *  type is: an index into the `keys` table wearing a box header's clothes. */
function atom(type, ...parts) {
  const body = parts.flat();
  const head = typeof type === 'number' ? b32(type) : chars(type);
  return [...b32(body.length + 8), ...head, ...body];
}

/** A `data` box holding UTF-8 — type indicator 1, then a locale nothing reads. */
const data = value => atom('data', b32(1), b32(0), words(value));

/**
 * A clip carrying whatever metadata a test wants to put in it.
 *
 * @param {object} opts
 * @param {Array<[string,string]>} opts.keys reverse-DNS name and value, for the
 *   modern `keys`/`ilst` pair.
 * @param {boolean} opts.full write `meta` as a FullBox — four bytes of version and
 *   flags in front of its children — which is the ISO-BMFF spelling an exported
 *   `.mp4` uses and the QuickTime one does not.
 * @param {Array<[string,string]>} opts.udta the older `©`-prefixed atoms.
 * @param {number|null} opts.created `mvhd` creation time, in seconds from 1904.
 */
function buildMov({ keys = [], full = false, udta = [], created = null, version = 0 } = {}) {
  const inner = [];

  if (keys.length) {
    // A `keys` entry is size + namespace + name, which is exactly a box whose type
    // is the namespace — so the generic builder writes one without knowing that.
    const table = atom('keys', b32(0), b32(keys.length),
      keys.map(([name]) => atom('mdta', chars(name))).flat());
    // And an `ilst` item is a box whose type is the 1-based index of the key that
    // names it.
    const list = atom('ilst', keys.map(([, value], i) => atom(i + 1, data(value))).flat());
    inner.push(...atom('meta', full ? b32(0) : [], table, list));
  }

  if (udta.length) {
    inner.push(...atom('udta', udta.map(([type, value]) => {
      const written = words(value);
      return atom(type, b16(written.length), b16(0), written);
    }).flat()));
  }

  if (created !== null) {
    const stamp = version === 1
      ? [...b32(Math.floor(created / 2 ** 32)), ...b32(created >>> 0)]
      : b32(created);
    inner.push(...atom('mvhd', [version, 0, 0, 0], stamp));
  }

  const bytes = [...atom('ftyp', chars('qt  '), b32(0)), ...atom('moov', inner)];
  return new Uint8Array(bytes).buffer;
}

test('the fixture builder agrees with the phone', () => {
  // Everything below rests on this builder writing what an iPhone writes, so it is
  // held against the real file once rather than trusted.
  const built = parseQuickTime(buildMov({
    keys: [
      ['com.apple.quicktime.creationdate', '2026-08-05T11:46:38+0200'],
      ['com.apple.quicktime.location.ISO6709', '+46.6261-001.1173+000.000/']
    ]
  }));
  const real = parseQuickTime(fixture('quicktime-iphone.mov'));
  assert.equal(built.t, real.t);
  assert.equal(built.lat, real.lat);
  assert.equal(built.lon, real.lon);
});

test('an mp4 hides its metadata four bytes further in, and is followed there', () => {
  // The one place the two dialects genuinely disagree. A reader that descends into
  // `meta` the QuickTime way finds nothing at all in an exported `.mp4`, which is
  // a silently unplaced clip rather than an error.
  const keys = [['com.apple.quicktime.location.ISO6709', '+46.6261-001.1173/']];
  const quicktime = parseQuickTime(buildMov({ keys }));
  const iso = parseQuickTime(buildMov({ keys, full: true }));
  assert.equal(iso.lat, quicktime.lat);
  assert.equal(iso.lon, quicktime.lon);
});

test('an Android clip keeps its coordinate in the older atom, and it is read', () => {
  // `©xyz`, with the datum name Android appends and this app already assumes.
  const meta = parseQuickTime(buildMov({
    udta: [['©xyz', '+46.6261-001.1173/CRSWGS_84']]
  }));
  assert.ok(Math.abs(meta.lat - 46.6261) < 1e-9);
  assert.ok(Math.abs(meta.lon - -1.1173) < 1e-9);
});

test('the modern atoms win over the older ones, because they know their zone', () => {
  const meta = parseQuickTime(buildMov({
    keys: [['com.apple.quicktime.creationdate', '2026-08-05T11:46:38+02:00']],
    udta: [['©day', '2026-08-05T09:00:00Z']]
  }));
  assert.equal(meta.t, Date.UTC(2026, 7, 5, 9, 46, 38));
  assert.equal(meta.assumedUtc, false);
});

test('a stamp with no zone on it is read as UTC, and says so', () => {
  // The same rule EXIF's zoneless `DateTimeOriginal` gets, and for the same reason:
  // local time is the one reading that changes with who is watching.
  const meta = parseQuickTime(buildMov({
    udta: [['©day', '2026-08-05 09:46:38']]
  }));
  assert.equal(meta.t, Date.UTC(2026, 7, 5, 9, 46, 38));
  assert.equal(meta.assumedUtc, true);
});

test('a clip with nothing but a movie header still gives up a time', () => {
  // 1904 to 2026-08-05T09:46:38Z. Every file has an `mvhd`; nominally UTC, and
  // written as local time by enough muxers to be worth the caveat.
  const secs = 2082844800 + Date.UTC(2026, 7, 5, 9, 46, 38) / 1000;
  const meta = parseQuickTime(buildMov({ created: secs }));
  assert.equal(meta.t, Date.UTC(2026, 7, 5, 9, 46, 38));
  assert.equal(meta.assumedUtc, true);
  assert.equal(meta.lat, null);
});

test('the 64-bit movie header reads the same as the 32-bit one', () => {
  const secs = 2082844800 + Date.UTC(2026, 7, 5, 9, 46, 38) / 1000;
  assert.equal(
    parseQuickTime(buildMov({ created: secs, version: 1 })).t,
    parseQuickTime(buildMov({ created: secs })).t
  );
});

test('a movie header with no clock behind it is no time at all', () => {
  // Zero is what a muxer writes when it never had one, and 1904 is not a reading.
  assert.equal(parseQuickTime(buildMov({ created: 0 })), null);
});

test('a clip carrying a description brings it to the card', () => {
  const meta = parseQuickTime(buildMov({
    keys: [['com.apple.quicktime.description', 'The col at last 😍']]
  }));
  assert.equal(meta.caption, 'The col at last 😍');
  // A caption is enough on its own to be worth keeping, exactly as it is for a
  // photograph with no fix.
  assert.equal(meta.t, null);
  assert.equal(meta.lat, null);
});

test('a clip description is cut to the same length a photograph caption is', () => {
  const meta = parseQuickTime(buildMov({
    keys: [['com.apple.quicktime.description', 'x'.repeat(500)]]
  }));
  assert.equal(meta.caption.length, 280);
});

test('keys nobody asked for are skipped rather than misread', () => {
  const meta = parseQuickTime(buildMov({
    keys: [
      ['com.apple.quicktime.make', 'Apple'],
      ['com.apple.quicktime.model', 'iPhone 15 Pro'],
      ['com.apple.quicktime.creationdate', '2026-08-05T11:46:38+02:00'],
      ['com.apple.quicktime.software', '26.0']
    ]
  }));
  assert.equal(meta.t, Date.UTC(2026, 7, 5, 9, 46, 38));
  assert.equal(meta.caption, null);
});

// --- ISO 6709 -----------------------------------------------------------------

test('a coordinate is read in whichever of the three spellings it was written', () => {
  // Degrees; degrees and minutes; degrees, minutes and seconds. Nothing in the
  // string says which — only the count of digits before the point.
  const decimal = parseIso6709('+46.6261-001.1173/');
  assert.ok(Math.abs(decimal.lat - 46.6261) < 1e-9);
  assert.ok(Math.abs(decimal.lon - -1.1173) < 1e-9);

  const minutes = parseIso6709('+4637.566-00107.038/');
  assert.ok(Math.abs(minutes.lat - 46.6261) < 1e-4, `lat was ${minutes.lat}`);
  assert.ok(Math.abs(minutes.lon - -1.1173) < 1e-4, `lon was ${minutes.lon}`);

  const seconds = parseIso6709('+463733.9-0010702.2/');
  assert.ok(Math.abs(seconds.lat - 46.6261) < 1e-4, `lat was ${seconds.lat}`);
  assert.ok(Math.abs(seconds.lon - -1.1173) < 1e-4, `lon was ${seconds.lon}`);
});

test('an altitude is kept, and an altitude of exactly zero is not', () => {
  assert.equal(parseIso6709('+46.6261-001.1173+1169.300/').ele, 1169.3);
  // Below sea level is a real reading and survives.
  assert.equal(parseIso6709('+46.6261-001.1173-004.500/').ele, -4.5);
  // Exactly zero is what a phone writes when it has a fix and no height.
  assert.equal(parseIso6709('+46.6261-001.1173+000.000/').ele, null);
  assert.equal(parseIso6709('+46.6261-001.1173/').ele, null);
});

test('south and west are negative here too', () => {
  const at = parseIso6709('-33.8688+151.2093/');
  assert.ok(Math.abs(at.lat - -33.8688) < 1e-9);
  assert.ok(Math.abs(at.lon - 151.2093) < 1e-9);
});

test('a coordinate off the planet is refused rather than drawn', () => {
  for (const written of ['+99.0000-001.1173/', '+46.6261-200.0000/', '+46.6261/', 'CRSWGS_84', '']) {
    assert.equal(parseIso6709(written), null, `"${written}" should not be a place`);
  }
});

test('one bad clip never throws, whatever is wrong with it', () => {
  const good = buildMov({ keys: [['com.apple.quicktime.creationdate', '2026-08-05T11:46:38Z']] });
  const bytes = new Uint8Array(good);

  // Every truncation of a real file, which is the shape a half-downloaded clip
  // has. None may throw, and none may hang: a box size that reaches past the end
  // stops the walk where it stands.
  for (let n = 0; n <= bytes.length; n++) {
    assert.doesNotThrow(() => parseQuickTime(bytes.slice(0, n).buffer), `truncated to ${n}`);
  }

  // And the files that are not clips at all.
  assert.equal(parseQuickTime(new ArrayBuffer(0)), null);
  assert.equal(parseQuickTime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer), null);
  assert.equal(parseQuickTime(fixture('exif-gps.jpg')), null);
});

test('a box claiming more room than it has ends the walk rather than the process', () => {
  const bytes = new Uint8Array(buildMov({
    keys: [['com.apple.quicktime.location.ISO6709', '+46.6261-001.1173/']]
  }));
  // The `moov` header sits behind `ftyp`; overstate its size and everything in it
  // becomes unreachable. The answer is nothing, not a crash and not a guess.
  const moov = 8 + 8;                        // ftyp is eight bytes of body
  bytes[moov] = 0x7f;
  assert.equal(parseQuickTime(bytes.buffer), null);
});

test('a clip with no metadata worth the name reads as none', () => {
  assert.equal(parseQuickTime(buildMov({})), null);
  assert.equal(parseQuickTime(buildMov({ keys: [['com.apple.quicktime.make', 'Apple']] })), null);
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

// --- crew ---------------------------------------------------------------------
//
// The rule these all circle: a crew member's photograph is a measurement of where
// the CREW MEMBER was, and every other rule in this module is about the runner. The
// failure being guarded against is not a crash — it is a map that draws somebody
// waiting at an aid station as the runner passing through it.

const CREW = ['Mariam'];
const withCrew = (...records) => placeMedia(records, PINGS, null, { crew: CREW });

test('a crew photo is placed where it says it was, and is not a point', () => {
  const [poi] = withCrew(record({
    name: 'MARIAM_IMG_4021.jpg', t: T0 + 7 * MINUTE, lat: 45.9, lon: 6.3, ele: 1200
  }));
  assert.equal(poi.crew, 'Mariam');
  assert.equal(poi.by, 'Mariam');
  assert.equal(poi.source, 'crew');
  assert.equal(poi.lat, 45.9);
  assert.equal(poi.lon, 6.3);
  assert.equal(poi.ele, 1200);
  // The load-bearing assertion in this file. `point: false` is what keeps this out
  // of the points array, and so out of the snapper, the distance and the climb.
  assert.equal(poi.point, false);
  // No distance along the runner's course, because a crew member has none.
  assert.equal(poi.along, null);
});

test('a crew photo with only a moment is not drawn at all', () => {
  // The case the feature exists for. Interpolating this would put the crew member
  // on the course at 12:07 — a claim about the runner, made out of a photograph of
  // somebody else.
  assert.deepEqual(withCrew(record({ name: 'MARIAM_IMG_4021.jpg', t: T0 + 7 * MINUTE })), []);
  // Including when the moment came from the filename, which everywhere else in this
  // module is the strongest thing a file can carry.
  assert.deepEqual(withCrew(record({ name: 'MARIAM_2026-07-30T12_07_30+00_00.jpg' })), []);
});

test('a crew photo with only a place is not drawn either', () => {
  // A run photograph with coordinates and no time is a waypoint, and worth keeping.
  // The same file off a crew member's phone is a road somewhere, with nothing tying
  // it to the run.
  assert.deepEqual(withCrew(record({ name: 'MARIAM_IMG_4021.jpg', lat: 45.9, lon: 6.3 })), []);
});

test('a crew photo is placed outside the pings as readily as inside them', () => {
  // Its coordinates are a measurement, and the ping span only ever bounded what
  // could be GUESSED. A crew member photographing the empty finish line an hour
  // before anyone arrives is a true picture of a real place.
  const [poi] = withCrew(record({
    name: 'MARIAM_IMG_4021.jpg', t: T0 - 60 * MINUTE, lat: 45.9, lon: 6.3
  }));
  assert.equal(poi.source, 'crew');
  assert.equal(poi.lon, 6.3);
});

test('a run that names no crew treats the same file as the runner\'s own', () => {
  // Which is the pre-existing behaviour, unchanged: the prefix means nothing until
  // a settings file says it does.
  const [poi] = only(record({
    name: 'MARIAM_IMG_4021.jpg', t: T0 + 7 * MINUTE, lat: 45.9, lon: 6.3
  }));
  assert.equal(poi.crew, null);
  assert.equal(poi.source, 'exif');
  assert.equal(poi.point, true);
});

test('a crew photo never reaches the snapper, and is never moved by one', () => {
  const pois = withCrew(record({
    name: 'MARIAM_IMG_4021.jpg', t: T0 + 7 * MINUTE, lat: 45.9, lon: 6.3
  }));
  // `point` is what main.js filters the points array on, so nothing here can be
  // snapped, counted, or mistaken for the latest fix.
  assert.deepEqual(pois.filter(p => p.point), []);

  // And if a snap for that name somehow existed, `applyMediaSnaps` still declines to
  // apply it — the same `point` gate, one module further on.
  applyMediaSnaps(pois, [
    { kind: 'media', name: 'MARIAM_IMG_4021.jpg', snap: { lat: 45.8, lon: 6.15, along: 4000 } }
  ]);
  assert.equal(pois[0].lat, 45.9);
  assert.equal(pois[0].lon, 6.3);
  assert.equal(pois[0].along, null);
});

// --- the byline ---------------------------------------------------------------

test('a run that names its runner credits his photographs to him', () => {
  const [poi] = placeMedia(
    [record({ name: '2026-07-30T12_07_30+00_00.jpg' })], PINGS, null, { runner: 'Bert' }
  );
  assert.equal(poi.by, 'Bert');
  // `crew` and `by` answer different questions, and only the first of them decides
  // anything about where this photograph may be drawn.
  assert.equal(poi.crew, null);
  assert.equal(poi.source, 'trace');
});

test('a crew photo is credited to the crew member, not to the runner', () => {
  const [poi] = placeMedia([record({
    name: 'MARIAM_IMG_4021.jpg', t: T0 + 7 * MINUTE, lat: 45.9, lon: 6.3
  })], PINGS, null, { crew: CREW, runner: 'Bert' });
  assert.equal(poi.by, 'Mariam');
  assert.equal(poi.crew, 'Mariam');
});

test('a run that names nobody credits nobody', () => {
  // The whole of the opt-in. A byline on every picture is what makes one mean
  // "whose"; with no second name to have said instead, it says nothing at all.
  const [poi] = only(record({ name: '2026-07-30T12_07_30+00_00.jpg' }));
  assert.equal(poi.by, null);
  assert.equal(poi.crew, null);
});

test('the runner is credited on his timeless photographs too', () => {
  // A waypoint — coordinates, no clock. It is still his picture.
  const [poi] = placeMedia(
    [record({ name: 'summit.jpg', lat: 45.9, lon: 6.3 })], PINGS, null, { runner: 'Bert' }
  );
  assert.equal(poi.t, null);
  assert.equal(poi.by, 'Bert');
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

// --- snapping -----------------------------------------------------------------

/** The points array as `main.js` hands it over: pings, plus the media that are fixes. */
const snapped = snap => [
  ...PINGS,
  { name: 'x.jpg', kind: 'media', t: T0 + 2 * MINUTE, lat: 45.81, lon: 6.11, ...(snap ? { snap } : {}) }
];

const SNAP = { along: 4200, lat: 45.8, lon: 6.104, ele: 1180, off: 31 };

test('a photograph that carried its own GPS is moved onto the course like a ping', () => {
  // Named like the real thing off a phone — no stamp in the filename, so the time
  // comes off the camera, exactly as `IMG_0559.jpeg` does.
  const pois = only(record({ t: T0 + 2 * MINUTE, lat: 45.81, lon: 6.11, ele: 1204 }));
  applyMediaSnaps(pois, snapped(SNAP));

  assert.equal(pois[0].lat, 45.8);
  assert.equal(pois[0].lon, 6.104);
  assert.equal(pois[0].along, 4200);
  // The course's height, not the camera's: the reading has to describe where the
  // picture is now drawn.
  assert.equal(pois[0].ele, 1180);
  // Still a measured position, whatever the snapper did to it — that is what the
  // dot's colour says, and snapping doesn't make it an inference.
  assert.equal(pois[0].source, 'exif');
});

test('a photograph the snapper turned down stays where the camera put it', () => {
  const pois = only(record({ t: T0 + 2 * MINUTE, lat: 45.81, lon: 6.11, ele: 1204 }));
  applyMediaSnaps(pois, snapped(null));

  assert.equal(pois[0].lat, 45.81);
  assert.equal(pois[0].lon, 6.11);
  assert.equal(pois[0].along, null);
  assert.equal(pois[0].ele, 1204);
});

test('an interpolated photograph is left alone — it was already on the course', () => {
  // No `point`, so no copy of it in the points array and nothing to copy back.
  const pois = only(record({ name: '2026-07-30T12_02_30+00_00.jpg' }));
  const before = { ...pois[0] };
  applyMediaSnaps(pois, snapped(SNAP));
  assert.deepEqual(pois[0], before);
});

test('snapping media survives a run with no media in its points at all', () => {
  assert.deepEqual(applyMediaSnaps([], PINGS), []);
  assert.deepEqual(applyMediaSnaps(undefined, PINGS), undefined);
  const pois = only(record({ t: T0 + 2 * MINUTE, lat: 45.81, lon: 6.11 }));
  assert.equal(applyMediaSnaps(pois, PINGS)[0].lat, 45.81);
});
