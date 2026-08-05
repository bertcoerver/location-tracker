// Photos and clips dropped into a run folder, placed on the map.
//
// A media file is named exactly like a ping — `2026-07-30T18_15_02+00_00.jpeg` —
// but unlike a ping it can also carry its OWN account of when and where it was
// taken, in EXIF. The two accounts disagree constantly: the files that prompted
// this were shot in 2024 and renamed into a 2026 run, so the camera's date is
// nearly two years off the name's.
//
// Which is why the precedence is fixed here, once, rather than decided per
// caller:
//
//   the FILENAME is the authority on WHEN — it is what somebody typed on purpose,
//     and the camera's clock is whatever it happened to be set to;
//   the FILE is the authority on WHERE — a coordinate the camera recorded beats a
//     coordinate this code guessed, however far off the course it lands.
//
// Everything else follows from those two lines. A file with a time and no place
// is interpolated between the pings either side of it, and a time OUTSIDE the
// pings is not placed at all: interpolation is a reading between two
// measurements, and extrapolation is [predict.js](predict.js)'s job. A file with
// a place and no time is a place — a POI in the idiom of a GPX waypoint, with no
// moment to put in a title.
//
// The file splits in half. Everything above `resolveMedia` is pure and is what
// the tests exercise; everything below needs a DOM, a network, or both, and is
// never reached from node. That is the same discipline `sunAtlas` follows in
// layers.js, applied to a whole module.

import { CONFIG } from './config.js';
import { surface } from './colors.js';
import { traceAt } from './stats.js';
import { parseTime } from './util.js';

/** What counts as media in a run folder. Read by `buildIndex`, which is the one
 *  place a filename decides what a file IS.
 *
 *  The video half of this list is longer than a web page would normally want.
 *  WebM is the format a browser is guaranteed to play and the one format a phone
 *  will not give you: iOS records `.mov` (QuickTime, H.264/HEVC) and Android
 *  records `.mp4`, and nothing in either camera app offers a choice. Insisting on
 *  WebM means transcoding every clip before it can be dropped in a folder, which
 *  is not a workflow anybody keeps up during a race.
 *
 *  So the containers people actually have are admitted, and the risk is accepted:
 *  `.mov` in particular is a container a browser MAY refuse — Safari plays them,
 *  Chrome and Firefox play the H.264 ones and not the HEVC ones. A clip that
 *  cannot be decoded degrades rather than breaks — see `firstFrame`, whose
 *  timeout exists for exactly this, and which leaves such a file with an anchor
 *  dot and no thumbnail rather than hanging the atlas. */
export const MEDIA_RE = /\.(jpe?g|png|gif|webm|mp4|m4v|mov)$/i;

/** The containers `<video>` handles, as against the pictures `<img>` does. GIF is
 *  deliberately NOT here: it animates perfectly well as an image, and a player
 *  would give it controls it has no use for. */
const VIDEO = new Set(['webm', 'mp4', 'm4v', 'mov']);

/** Side of a thumbnail marker, in screen pixels. Shared with `mediaLayers`, so
 *  the atlas cells and the icons drawn from them can't disagree about size. */
export const THUMB_PX = 44;

/**
 * Which of the four shapes a file is, or null if it isn't media at all.
 *
 * `.jpg` and `.jpeg` collapse to one kind because nothing downstream cares which
 * spelling was used, and because `kind === 'jpeg'` is the test for "worth reading
 * EXIF out of".
 */
export function mediaKind(name) {
  const ext = /\.([a-z0-9]+)$/i.exec(name || '')?.[1]?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'png' || ext === 'gif' || VIDEO.has(ext)) return ext;
  return null;
}

/** Whether this wants a `<video>` around it rather than an `<img>`. The one test
 *  every caller that has to choose an element goes through, so a format added to
 *  `VIDEO` is playable everywhere at once rather than in the three places
 *  somebody remembered. */
export function isVideo(name) {
  return VIDEO.has(mediaKind(name));
}

/** Whether the marker needs a ▶ badge: a still frame is all a WebGL texture can
 *  hold, so the badge is how a marker admits there is more to it than the map
 *  can show. */
export function isAnimated(name) {
  return mediaKind(name) === 'gif' || isVideo(name);
}

/** The whole of a media basename, when the whole of it is a timestamp. */
const STAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}[_:]\d{2}[_:]\d{2}(Z|[+-]\d{2}[_:]?\d{2})?$/;

/**
 * The moment in a media filename, or NaN.
 *
 * [`parseTime`](util.js) does the reading, with the media extension taken off
 * first — it strips `.json` and swaps `_` back to `:`, and the second half is the
 * part that matters here. But it is guarded by a shape test first, which
 * `parseTime` alone is not, and the guard is not decoration:
 * `Date.parse('IMG:4021')` — which is what a camera's own filename becomes once
 * the underscore is swapped — is not NaN. It is a date in the year 4021. A photo
 * straight off a memory card would be given a timestamp two thousand years out
 * and then silently dropped for falling outside the run, when the truth about it
 * is that it never carried a time at all.
 *
 * Ping filenames never had this problem because a phone writes them. A media
 * filename is whatever a camera, a chat app or a person called it.
 *
 * No stamp is the ORDINARY case, not an error: such a file is still placeable if
 * it carries its own coordinates, and the rules below are written around the NaN.
 */
export function mediaTime(name) {
  const stamp = String(name || '').replace(MEDIA_RE, '');
  return STAMPED.test(stamp) ? parseTime(stamp) : NaN;
}

// --- EXIF -------------------------------------------------------------------

/** How much of a file has to be read to be sure of its EXIF. The APP1 block sits
 *  within the first few KB of everything a phone writes — 3 KB in the files this
 *  was built against — and 64 KB is headroom over that, not a guess at it. */
export const EXIF_BYTES = 65536;

const TAG = {
  imageDescription:   0x010e,
  dateTime:           0x0132,
  exifIfd:            0x8769,
  gpsIfd:             0x8825,
  dateTimeOriginal:   0x9003,
  offsetTimeOriginal: 0x9011,
  gpsLatRef:          0x0001,
  gpsLat:             0x0002,
  gpsLonRef:          0x0003,
  gpsLon:             0x0004,
  gpsAltRef:          0x0005,
  gpsAlt:             0x0006
};

/** Bytes per element, by TIFF type code. An unlisted type is one this doesn't
 *  read, and its entry is skipped rather than guessed at. */
const TYPE_BYTES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

/** How much of a caption is kept. A line or two is a note about a photograph;
 *  anything longer is something else pasted into the field, and it would push the
 *  picture off a card that is mostly picture by design. */
const CAPTION_CHARS = 280;

/**
 * What a JPEG says about itself: when it was taken and, if the camera had a fix,
 * where.
 *
 * Hand-rolled rather than a library because this app has no bundler and no
 * dependencies, and because the useful part of EXIF is eight tags. It is written
 * to be UNSHAKEABLE rather than complete: every failure — a truncated buffer, a
 * length field pointing off the end, a type code nobody has heard of, a file that
 * isn't a JPEG at all — returns null or drops one field, and never throws. One
 * bad photo in a folder must not take the run down with it.
 *
 * @param {ArrayBuffer} buffer the head of the file. `EXIF_BYTES` is enough; the
 *   whole file works too, and a buffer cut off mid-image is expected — the walk
 *   stops when it runs out of bytes.
 * @returns {{t: number|null, caption: string|null, assumedUtc: boolean,
 *            lat: number|null, lon: number|null, ele: number|null}|null} null
 *   when there is no readable EXIF at all.
 */
export function parseExif(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

    // Walk the marker chain rather than assuming APP1 comes first. On the files
    // this was built against it does not: an iPhone writes APP0/JFIF, then
    // APP1/Exif, then a second APP1 holding XMP, then two APP2s.
    let at = 2;
    while (at + 4 <= view.byteLength) {
      if (view.getUint8(at) !== 0xff) return null;     // out of step with the chain
      const marker = view.getUint8(at + 1);

      // Standalone markers carry no length. Reading two bytes of image data as
      // one is how a walk ends up in the middle of a scan.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { at += 2; continue; }
      // Start of scan: the metadata is all behind us, and there was none.
      if (marker === 0xda) return null;

      const length = view.getUint16(at + 2);
      if (length < 2) return null;

      const payload = at + 4;
      if (marker === 0xe1 && payload + 6 <= view.byteLength && isExif(view, payload)) {
        return readTiff(view, payload + 6);
      }
      at += 2 + length;
    }
    return null;
  } catch {
    return null;
  }
}

/** The six bytes `Exif\0\0` that tell one APP1 from the XMP one beside it. */
function isExif(view, at) {
  return view.getUint32(at) === 0x45786966 && view.getUint16(at + 4) === 0x0000;
}

/**
 * The TIFF block inside an EXIF APP1.
 *
 * @param {number} tiff offset of the TIFF header — `MM` or `II`. EVERY offset
 *   inside the block is relative to THIS, not to the start of the file, which is
 *   the one thing a hand-rolled EXIF reader always gets wrong.
 */
function readTiff(view, tiff) {
  const order = view.getUint16(tiff);
  if (order !== 0x4d4d && order !== 0x4949) return null;
  const le = order === 0x4949;
  if (view.getUint16(tiff + 2, le) !== 0x002a) return null;

  const u16 = a => view.getUint16(a, le);
  const u32 = a => view.getUint32(a, le);
  const i32 = a => view.getInt32(a, le);

  /** One IFD as tag -> field. Entries that don't fit in the buffer are dropped,
   *  which is what makes a truncated file readable as far as it goes. */
  const ifd = offset => {
    const out = new Map();
    const base = tiff + offset;
    if (offset <= 0 || base + 2 > view.byteLength) return out;

    const n = u16(base);
    for (let i = 0; i < n; i++) {
      const e = base + 2 + i * 12;
      if (e + 12 > view.byteLength) break;

      const type = u16(e + 2);
      const width = TYPE_BYTES[type];
      if (!width) continue;

      const count = u32(e + 4);
      const bytes = width * count;
      // Four bytes or fewer live INLINE in the entry; anything longer is an
      // offset from the TIFF header.
      const at = bytes <= 4 ? e + 8 : tiff + u32(e + 8);
      if (at < 0 || at + bytes > view.byteLength) continue;

      out.set(u16(e), { type, count, at });
    }
    return out;
  };

  const ascii = f => {
    if (!f || f.type !== 2) return null;
    let s = '';
    for (let i = 0; i < f.count; i++) {
      const c = view.getUint8(f.at + i);
      if (!c) break;                                   // NUL terminates, as ASCII does here
      s += String.fromCharCode(c);
    }
    return s;
  };

  /**
   * The same field, read as writing rather than as a machine token.
   *
   * TIFF calls type 2 "ASCII" and every phone ignores that: the caption this was
   * built for is `A road with tree 😍🌳`, four bytes of which are one emoji. So
   * these bytes go through a UTF-8 decoder rather than one `String.fromCharCode`
   * at a time, which would have turned each of those four into its own mojibake
   * character. `ascii` above stays as it is on purpose — it reads timestamps and
   * `N`/`S`/`E`/`W` refs, where a byte really is a character and a decoder would
   * be ceremony.
   *
   * Not fatal on bad bytes: a caption a camera mangled should come back with a
   * replacement character in it, not take the whole photograph off the map.
   */
  const text = f => {
    if (!f || f.type !== 2) return null;
    let n = 0;
    while (n < f.count && view.getUint8(f.at + n)) n++;
    if (!n) return null;
    const bytes = new Uint8Array(view.buffer, view.byteOffset + f.at, n);
    const s = new TextDecoder().decode(bytes).trim().slice(0, CAPTION_CHARS);
    return s || null;
  };

  const ratio = (f, i) => {
    const a = f.at + i * 8;
    const den = f.type === 10 ? i32(a + 4) : u32(a + 4);
    return den ? (f.type === 10 ? i32(a) : u32(a)) / den : 0;
  };

  const scalar = f => {
    if (!f) return null;
    if (f.type === 1 || f.type === 6 || f.type === 7) return view.getUint8(f.at);
    if (f.type === 3) return u16(f.at);
    if (f.type === 4) return u32(f.at);
    if (f.type === 5 || f.type === 10) return ratio(f, 0);
    return null;
  };

  /** Degrees, minutes and seconds as one number. */
  const dms = f => {
    if (!f || (f.type !== 5 && f.type !== 10) || f.count < 3) return null;
    return ratio(f, 0) + ratio(f, 1) / 60 + ratio(f, 2) / 3600;
  };

  const zero = ifd(u32(tiff + 4));
  const exif = ifd(scalar(zero.get(TAG.exifIfd)) ?? 0);
  const gps  = ifd(scalar(zero.get(TAG.gpsIfd)) ?? 0);

  // DateTimeOriginal is when the shutter fired; DateTime is when the file was
  // last written, which for anything that has been through an editor is a
  // different and less interesting fact. Hence the order.
  const stamp = ascii(exif.get(TAG.dateTimeOriginal)) ?? ascii(zero.get(TAG.dateTime));
  const offset = ascii(exif.get(TAG.offsetTimeOriginal));
  const when = stampToMs(stamp, offset);

  let lat = dms(gps.get(TAG.gpsLat));
  let lon = dms(gps.get(TAG.gpsLon));
  if (lat !== null && /^S/i.test(ascii(gps.get(TAG.gpsLatRef)) || '')) lat = -lat;
  if (lon !== null && /^W/i.test(ascii(gps.get(TAG.gpsLonRef)) || '')) lon = -lon;

  // Range-checked in the idiom `fetchPoint` uses on a ping body, plus one extra
  // rule: a fix at exactly 0,0 is a camera that wrote the tags and never got a
  // lock, and null island is a thousand kilometres from any race.
  const placed = Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat === 0 && lon === 0);

  let ele = scalar(gps.get(TAG.gpsAlt));
  if (ele !== null && scalar(gps.get(TAG.gpsAltRef)) === 1) ele = -ele;   // below sea level
  const height = Number.isFinite(ele) && Math.abs(ele) <= 10000 ? ele : null;

  // What somebody typed about the picture. `ImageDescription` in IFD0 is where
  // Photos, Lightroom and the iOS share sheet all put a caption, and it is the
  // one this reader can have for free — it is a tag in an IFD already walked.
  //
  // The same words are usually written a second time into an IPTC block inside a
  // Photoshop APP13 segment, and that is deliberately not read: it is a third
  // container with a third set of rules, for a string already in hand.
  const caption = text(zero.get(TAG.imageDescription));

  // A TIFF block that said nothing useful. A caption counts as useful even with
  // no time and no place attached — the file may still be placed by its NAME, and
  // dropping the record here would throw away the words along with the nothing.
  if (when === null && !placed && caption === null) return null;

  return {
    t: when,
    caption,
    // True when the time is a reading of a clock whose zone nobody recorded. See
    // `stampToMs`.
    assumedUtc: when !== null && !hasZone(offset),
    lat: placed ? lat : null,
    lon: placed ? lon : null,
    ele: placed ? height : null
  };
}

const ZONE_RE = /^[+-]\d{2}:?\d{2}$/;
const hasZone = offset => ZONE_RE.test(String(offset || '').trim());

/**
 * An EXIF timestamp — `"2024:09:27 07:28:15"` — as epoch milliseconds.
 *
 * The zone is the whole difficulty. `DateTimeOriginal` is a wall clock with no
 * zone attached; `OffsetTimeOriginal` supplies one, when the camera bothered to
 * write it, and plenty don't. With no offset this reads the clock as UTC and says
 * so, rather than as the viewer's local time: the same file must land in the same
 * place for somebody watching from Sydney and somebody watching from the finish
 * line, and local time is the one reading that changes with who is looking.
 *
 * It matters less than it sounds. A filename stamp beats this outright, so the
 * ambiguity only reaches a file nobody renamed — and a guess wrong by an hour
 * either lands a few hundred metres along the course or falls outside the pings
 * entirely, where it is dropped rather than placed.
 */
function stampToMs(stamp, offset) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(stamp || '').trim());
  if (!m) return null;

  const zone = hasZone(offset)
    ? offset.trim().replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')
    : 'Z';
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${zone}`);
  return Number.isFinite(ms) ? ms : null;
}

// --- placing ----------------------------------------------------------------

/**
 * Every media file this run can show, placed.
 *
 * @param {Array} records resolved metadata, from `hydrateMedia` — one per file.
 * @param {Array} points the run's PINGS, sorted oldest-first, and only the pings.
 *   Passing an array that already has media in it would let one photo's position
 *   be interpolated off another photo's, which makes the answer depend on the
 *   order the folder happened to list, and chains a guess off a guess.
 * @param {object|null} course when the run has one — with it, an interpolated
 *   photo sits ON the route rather than on a chord across it.
 * @returns {Array} oldest-first, timeless ones last. Each is
 *   `{kind: 'media', name, sha, url, animated, caption, t, lat, lon, along, ele, gap,
 *     source, point}` — the sun POI's shape plus what it takes to draw a picture.
 *   `kind` is `'media'`, which is what the tooltips dispatch on; `point` marks the
 *   ones that are fixes in their own right and belong in the points array.
 */
export function placeMedia(records, points, course = null) {
  const out = [];
  for (const record of records || []) {
    const poi = record && place(record, points, course);
    if (poi) out.push(poi);
  }
  // Timeless POIs have nothing to sort BY, so they go to the end in the order
  // they arrived rather than being interleaved on a null.
  return out.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
}

function place(record, points, course) {
  const named = mediaTime(record.name);
  const timed = Number.isFinite(named);

  // The filename wins outright, and takes its certainty with it: a stamp somebody
  // typed carries its own offset, so the camera's zone question never arises.
  const t = timed ? named : (Number.isFinite(record.t) ? record.t : null);

  const base = {
    kind: 'media',
    name: record.name,
    sha: record.sha,
    url: record.url,
    animated: isAnimated(record.name),
    assumedUtc: timed ? false : !!record.assumedUtc,
    // The only thing on a POI that came from a person rather than from a sensor
    // or an arithmetic. It rides along untouched: nothing about where a photo
    // ends up can change what somebody wrote on it.
    caption: record.caption || null,
    t
  };

  // Its own coordinates beat anything this could work out, however far off the
  // course they land. A photo that knows where it was taken is a measurement, and
  // one with a moment beside it is a fix like any other — it snaps, or doesn't,
  // by the same 500 m rule every ping is held to.
  if (Number.isFinite(record.lat) && Number.isFinite(record.lon)) {
    return {
      ...base,
      lat: record.lat,
      lon: record.lon,
      along: null,
      ele: Number.isFinite(record.ele) ? record.ele : null,
      gap: null,
      source: 'exif',
      point: t !== null
    };
  }

  // No place and no moment is nothing to place.
  if (t === null) return null;

  // Interpolation only. `traceAt` gives null outside the ping span, and that null
  // is the whole of the no-extrapolation rule: a photo from before the run
  // started, or after the phone stopped, has no position this page can honestly
  // claim, so it isn't drawn.
  const at = traceAt(points, course, t);
  if (!at) return null;

  return { ...base, ...at, source: 'trace', point: false };
}

/**
 * Move the photographs that carried their own GPS onto the course, once the
 * snapper has said where on it they belong.
 *
 * `placeMedia` cannot do this itself, and the reason is an ordering one. A photo
 * with EXIF coordinates is a fix, so it rides in the points array and is snapped
 * by exactly the same 500 m rule as a ping — but that happens AFTER the array is
 * built, which is after the POIs the map draws were made. Without this step the
 * two copies disagree for the rest of the paint: the point counts its distance
 * from a place on the route, while the thumbnail floats over the raw reading a
 * few dozen metres off it, and every other mark on the page has been quietly
 * corrected except the picture.
 *
 * Interpolated files need none of this — `traceAt` already put them on the
 * course — which is why only the `point` ones are touched.
 *
 * A photo the snapper turned down keeps its raw position, and that is the same
 * answer a rejected ping gets: too far from the route to claim a place on it.
 *
 * @param {Array} pois from `placeMedia`.
 * @param {Array} points the run's points AFTER `applySnaps`, media included.
 * @returns {Array} the same array, moved in place.
 */
export function applyMediaSnaps(pois, points) {
  const byName = new Map();
  for (const point of points || []) {
    if (point?.kind === 'media') byName.set(point.name, point);
  }
  if (!byName.size) return pois;

  for (const poi of pois || []) {
    const snap = poi.point ? byName.get(poi.name)?.snap : null;
    if (!snap) continue;
    poi.lat = snap.lat;
    poi.lon = snap.lon;
    poi.along = snap.along;
    // The course's height rather than the camera's. The reading has to describe
    // the place the picture is now drawn at, and a GPS altitude off a phone is
    // the weaker of the two measurements anyway.
    poi.ele = snap.ele ?? poi.ele;
  }
  return pois;
}

// --- everything below here needs a browser ----------------------------------

/**
 * One media file's metadata, ready to persist.
 *
 * The URL is content-addressed and `force-cache`d like every other body in this
 * app, so the whole file is downloaded at most once per browser ever — and the
 * download is not waste, because it is the same URL the tooltip's `<img>` and the
 * thumbnail decode both go on to use, and both then hit the HTTP cache.
 *
 * A `Range` request for just the EXIF was the obvious alternative and is worse in
 * three ways: `sw.js` puts every sha-suffixed raw URL into the Cache API, and a
 * 206 cannot be `put`; `force-cache` and `Range` together are inconsistent across
 * engines and fail SILENTLY, as a photo with no GPS rather than as an error; and
 * the full bytes are wanted moments later regardless, so it buys a second request
 * rather than a smaller one.
 *
 * Only JPEG is opened at all. PNG, GIF and every video container have somewhere
 * in their spec to put a timestamp and a coordinate — QuickTime's `©xyz` atom is
 * the one a phone genuinely does fill in — but reading them means a second and
 * third parser with no test data behind either, and a `.mov`'s metadata sits in a
 * `moov` atom that may be at the END of the file. So they cost NO request here
 * and rest on their filename, which is the authority on time regardless and is
 * what everything in this folder is named by anyway.
 *
 * @param {string} url from `rawUrl` — sha-suffixed.
 * @returns {Promise<object|null>} null when the name isn't media at all.
 */
export async function resolveMedia(url, name, sha) {
  const kind = mediaKind(name);
  if (!kind) return null;

  const record = {
    name, sha, url, kind,
    t: null, caption: null, assumedUtc: false, lat: null, lon: null, ele: null
  };
  if (kind !== 'jpeg') return record;

  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);

  const blob = await res.blob();
  const exif = parseExif(await blob.slice(0, EXIF_BYTES).arrayBuffer());
  return exif ? { ...record, ...exif } : record;
}

/**
 * The first frame of a clip, as something a texture can be built from.
 *
 * Every step of this is event-driven and codec-dependent, and a container the
 * browser cannot decode fires NO event at all — not `error`, not `loadeddata` —
 * so the timeout is the load-bearing part rather than a precaution. Without it a
 * single unplayable clip leaves the atlas build pending forever and the map never
 * gets its thumbnails. That case stopped being hypothetical when `.mov` was
 * admitted: an iPhone shooting HEVC writes a file Chrome will not open.
 */
function firstFrame(blob) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    let done = false;

    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), CONFIG.mediaFrameMs);

    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('error', () => finish(null));
    video.addEventListener('loadeddata', async () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        if (!canvas.width || !canvas.height) return finish(null);
        canvas.getContext('2d').drawImage(video, 0, 0);
        finish(await createImageBitmap(canvas));
      } catch {
        finish(null);
      }
    });
    video.src = url;
  });
}

/** One POI's thumbnail source, or null if it can't be decoded. Both branches read
 *  the same content-addressed URL the metadata pass already warmed, so this is a
 *  local operation however many photos a run has. */
async function thumbnail(poi) {
  try {
    const res = await fetch(poi.url, { cache: 'force-cache' });
    if (!res.ok) return null;
    const blob = await res.blob();
    // A GIF needs none of the video dance — `createImageBitmap` hands back frame
    // one, which is exactly what a still marker wants.
    return isVideo(poi.name) ? await firstFrame(blob) : await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** Rasterised at this many pixels a side: `THUMB_PX` on a display with three
 *  times the density, which is the headroom `sunAtlas` reasons about for glyphs. */
const CELL_PX = THUMB_PX * 3;

/**
 * Every thumbnail packed into one texture, with the mapping deck needs to cut
 * them back out.
 *
 * One `IconLayer` over an atlas rather than a `BitmapLayer` per photo, and the
 * reason is not speed. A `BitmapLayer`'s bounds are LON/LAT, so a marker meant to
 * be 44 px would have to have its extent in degrees recomputed at every zoom, and
 * would still be wrong halfway through a camera flight. An `IconLayer` with
 * `sizeUnits: 'pixels'` is screen-constant for nothing, and picks and offsets like
 * every other mark on the map.
 *
 * The frame and the play badge are drawn INTO the cells rather than added as
 * further layers: baked, they cannot drift out of alignment with the picture they
 * belong to, and they cost no draw calls. That the frame's colour is therefore
 * fixed at build time is the same bargain `getPalette` already makes — it is read
 * once per page and never re-read when the scheme changes.
 *
 * @param {Array} pois from `placeMedia`.
 * @returns {Promise<{atlas: HTMLCanvasElement, mapping: Object}|null>} null when
 *   nothing could be decoded, which is what keeps `mediaLayers` from drawing
 *   empty frames.
 */
export async function buildMediaAtlas(pois) {
  if (!pois?.length) return null;

  const bitmaps = await Promise.all(pois.map(thumbnail));
  const usable = pois.map((poi, i) => [poi, bitmaps[i]]).filter(([, bitmap]) => bitmap);
  if (!usable.length) return null;

  const cols = Math.ceil(Math.sqrt(usable.length));
  const rows = Math.ceil(usable.length / cols);

  const canvas = document.createElement('canvas');
  canvas.width = cols * CELL_PX;
  canvas.height = rows * CELL_PX;
  const c = canvas.getContext('2d');

  const [r, g, b] = surface();
  const mapping = {};

  usable.forEach(([poi, bitmap], i) => {
    const x = (i % cols) * CELL_PX;
    const y = Math.floor(i / cols) * CELL_PX;
    // Inset by the frame's own width, so the stroke sits inside the cell rather
    // than half of it bleeding into the neighbour.
    const pad = CELL_PX * 0.05;
    const side = CELL_PX - pad * 2;
    const radius = side * 0.16;

    const box = () => {
      c.beginPath();
      c.roundRect(x + pad, y + pad, side, side, radius);
    };

    // Centre-cropped, so a 4:3 photo fills a square without being squashed into
    // one. The alternative — letterboxing — spends a third of a 44 px marker on
    // background.
    const crop = Math.min(bitmap.width, bitmap.height);
    c.save();
    box();
    c.clip();
    c.drawImage(bitmap,
      (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop,
      x + pad, y + pad, side, side);
    c.restore();

    c.strokeStyle = `rgb(${r},${g},${b})`;
    c.lineWidth = CELL_PX * 0.05;
    box();
    c.stroke();

    // A still frame is all a texture can hold. The badge is how the marker admits
    // that, so nobody has to open a tooltip to find out something moves.
    if (poi.animated) {
      const cx = x + CELL_PX - pad - side * 0.19;
      const cy = y + CELL_PX - pad - side * 0.19;
      const r0 = side * 0.15;
      c.fillStyle = 'rgba(0,0,0,0.55)';
      c.beginPath();
      c.arc(cx, cy, r0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#fff';
      c.beginPath();
      c.moveTo(cx - r0 * 0.32, cy - r0 * 0.46);
      c.lineTo(cx + r0 * 0.52, cy);
      c.lineTo(cx - r0 * 0.32, cy + r0 * 0.46);
      c.closePath();
      c.fill();
    }

    // Keyed by filename, which is unique within a run and is what `getIcon`
    // reads. A POI whose thumbnail failed to decode has no entry, and deck draws
    // nothing for it rather than drawing the wrong picture.
    mapping[poi.name] = { x, y, width: CELL_PX, height: CELL_PX, mask: false };
  });

  return { atlas: canvas, mapping };
}
