// Photos and clips dropped into a run folder, placed on the map.
//
// A media file is named exactly like a ping — `2026-07-30T18_15_02+00_00.jpeg` —
// but unlike a ping it can also carry its OWN account of when and where it was
// taken: in EXIF if it is a photograph, and in QuickTime `moov` atoms if it is a
// clip. The two accounts disagree constantly: the files that prompted
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
// All of which assumes the photograph is EVIDENCE ABOUT THE RUNNER, and one kind
// of file isn't: a picture off a crew member's phone, marked by their name in
// capitals at the front of it. That file is held to a stricter rule — coordinates
// and a time or it is not drawn at all — and is placed where it says it was and
// nowhere else. See `crewOf`.
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

/**
 * Whose camera this came off, when it wasn't the runner's.
 *
 * A run's settings may name CREW — the people driving to the aid stations — and a
 * photograph of theirs is marked by putting their name, in capitals, in front of
 * whatever the file was already called: `MARIAM_IMG_4021.jpg`.
 *
 * That mark changes what the photograph MEANS, and it is worth being plain about
 * why. Every other rule in this file assumes a photograph is evidence about the
 * runner: one with coordinates is a fix and snaps like a ping, and one with only a
 * time is interpolated between the pings either side of it. A crew photograph is
 * evidence about somebody standing still three kilometres down the mountain
 * waiting for him. Interpolating it onto the course would draw the runner where he
 * demonstrably was not, and it would look exactly like the marks that are true.
 *
 * The capitals are the whole test, and they are load-bearing rather than
 * stylistic: `Mariam_and_me.jpg` is an ordinary filename that an ordinary person
 * types, and a case-insensitive match would quietly seize it. Shouting is
 * something you have to mean.
 *
 * @param {string} name the media filename.
 * @param {Array<string>} crew from [`parseSettings`](settings.js), in the casing a
 *   person wrote — which is what comes back, because it is what gets displayed.
 * @returns {string|null}
 */
export function crewOf(name, crew) {
  const prefix = String(name || '').split('_')[0];
  if (!prefix || !crew?.length) return null;
  return crew.find(member => prefix === member.toUpperCase()) || null;
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
 *
 * @param {string} name the media filename.
 * @param {string|null} [crew] the crew name in front of it, from `crewOf`. Taken
 *   off before the shape test, so the filename keeps its authority over the clock
 *   past somebody's name: `MARIAM_2026-08-05T12_41_01+02_00.jpg` is stamped, and
 *   `MARIAM_IMG_4021.jpg` is as unstamped as `IMG_4021.jpg` — which is exactly the
 *   guard above, still doing its work one prefix further in.
 */
export function mediaTime(name, crew = null) {
  let stamp = String(name || '').replace(MEDIA_RE, '');
  if (crew) stamp = stamp.slice(crew.length + 1);
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

// --- QuickTime --------------------------------------------------------------
//
// What a clip says about itself, which is the same two facts a photograph says
// and in a completely different container. A `.mov` off an iPhone carries
//
//   com.apple.quicktime.creationdate      2026-08-05T11:46:38+02:00
//   com.apple.quicktime.location.ISO6709  +46.6261-001.1173+000.000/
//
// and an Android `.mp4` carries the same coordinate in a `©xyz` atom instead.
// Both sit in `moov`, which — unlike a JPEG's APP1 — may be at the END of the
// file: on the clip this was built against `moov` starts at byte 3,446,584 of
// 3,452,585. So there is no head-of-file shortcut here, and `resolveMedia` reads
// the whole clip. It already had to: the atlas fetches the same URL for a first
// frame moments later, and both go through the same content-addressed cache.
//
// The layout is boxes all the way down — four bytes of size, four of type, then
// either children or payload — which makes the walk simple and the DEFENCE the
// interesting part. Every size in the file is a number some muxer wrote, and a
// walk that trusts one runs off the end of the buffer or loops forever. So a
// size that doesn't fit inside its parent ends the walk where it stands, exactly
// as `parseExif` drops an entry whose offset points off the end.

/** The clip containers built out of ISO base media boxes, as against WebM, which
 *  is Matroska and shares none of this. Kept apart from `VIDEO` because that set
 *  answers "what element plays this" and this one answers "is there anything in
 *  here worth opening the file for". */
const QUICKTIME = new Set(['mp4', 'm4v', 'mov']);

/** Whether the metadata below can be looked for at all. The one test that decides
 *  a clip is worth a download. */
export function isQuickTime(name) {
  return QUICKTIME.has(mediaKind(name));
}

/** Seconds between the QuickTime epoch (1904-01-01 UTC) and the Unix one. `mvhd`
 *  counts from the former and everything else here from the latter. */
const EPOCH_1904 = 2082844800;

/** The ilst keys worth reading, and the field each one answers. Apple's names are
 *  reverse-DNS and exact; anything else in the list is skipped unread. */
const QT_KEYS = new Map([
  ['com.apple.quicktime.creationdate',     'when'],
  ['com.apple.quicktime.location.ISO6709', 'where'],
  ['com.apple.quicktime.description',      'caption']
]);

/** The same three facts where a writer that has never heard of `keys`/`ilst` puts
 *  them. `©xyz` is the one an Android phone genuinely fills in. */
const QT_UDTA = new Map([
  ['©day', 'when'],
  ['©xyz', 'where'],
  ['©des', 'caption']
]);

/** One box's type as its four characters. The `©` beginning the older atom names
 *  is byte 0xA9, which `fromCharCode` gives back as exactly the character written
 *  in `QT_UDTA` above — the names compare equal without any decoding step. */
function fourcc(view, at) {
  return String.fromCharCode(
    view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3)
  );
}

/** A byte range as text. Used for keys, captions and the ASCII-shaped values
 *  alike — a QuickTime description is somebody's writing and can hold anything
 *  UTF-8 can, so it goes through a decoder for the same reason the EXIF caption
 *  does. Not fatal on bad bytes. */
function utf8(view, from, to) {
  if (to <= from) return null;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + from, to - from);
  // A trailing NUL is legal in some of these and is not part of the writing.
  const s = new TextDecoder().decode(bytes).replace(/\0.*$/s, '').trim();
  return s || null;
}

/**
 * The boxes directly inside a range, in order.
 *
 * Yields `{type, index, body, end}` — `index` being the type read as a number
 * instead, which is what an `ilst` child is: a 1-based pointer into the `keys`
 * table rather than a name.
 *
 * The walk STOPS rather than skipping on anything it can't make sense of. A box
 * claiming to reach past its parent is a file that has been truncated or is not
 * what it says it is, and the boxes after it cannot be found by a reader that has
 * lost its place.
 */
function* boxes(view, from, to) {
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    let head = 8;

    if (size === 1) {
      // The 64-bit escape, for a box larger than 4 GiB. `mdat` in a long clip.
      if (at + 16 > to) return;
      size = Number(view.getBigUint64(at + 8));
      head = 16;
    } else if (size === 0) {
      // "To the end of the file", legal only for the last box.
      size = to - at;
    }

    if (!Number.isFinite(size) || size < head || at + size > to) return;
    yield { type: fourcc(view, at + 4), index: view.getUint32(at + 4), body: at + head, end: at + size };
    at += size;
  }
}

/** The first box of a type inside a range, or null. */
function box(view, from, to, type) {
  for (const it of boxes(view, from, to)) if (it.type === type) return it;
  return null;
}

/**
 * Where a `meta` box's children start, which is the one place the two dialects of
 * this format genuinely disagree.
 *
 * QuickTime's `meta` is a plain container. ISO-BMFF's is a FullBox, with four
 * bytes of version and flags in front of its children — so the same descent that
 * works on a `.mov` lands four bytes short on a `.mp4` and finds nothing. Nothing
 * in the box says which it is, and the file extension is no guide either: an
 * iPhone writes the QuickTime shape into a `.mov` and the ISO shape into the
 * `.mp4` it exports.
 *
 * So the SHAPE decides. If the four bytes at the front begin a box that fits, they
 * are one; version-and-flags is `00 00 00 00` in every writer, which reads as a
 * size of zero and fits nothing.
 */
function metaBody(view, meta) {
  if (meta.body + 8 > meta.end) return meta.body;
  const size = view.getUint32(meta.body);
  return size >= 8 && meta.body + size <= meta.end ? meta.body : meta.body + 4;
}

/** The `keys` table: reverse-DNS names, indexed from ONE by `ilst`. Index 0 is a
 *  hole that nothing ever asks for. */
function keyTable(view, keys) {
  const out = [null];
  let at = keys.body + 4;                            // version and flags
  if (at + 4 > keys.end) return out;

  const n = view.getUint32(at);
  at += 4;
  for (let i = 0; i < n; i++) {
    if (at + 8 > keys.end) break;
    const size = view.getUint32(at);
    if (size < 8 || at + size > keys.end) break;
    // The four bytes at `at + 4` are the namespace — `mdta` on everything Apple
    // writes. The name is whatever follows, and is not NUL-terminated.
    out.push(utf8(view, at + 8, at + size));
    at += size;
  }
  return out;
}

/** The text inside an ilst item's `data` box, or null when it holds something
 *  else. Type 1 is UTF-8; the numeric types exist and none of the three values
 *  read here is ever written as one. */
function itemText(view, item) {
  const data = box(view, item.body, item.end, 'data');
  if (!data || data.body + 8 > data.end) return null;
  if ((view.getUint32(data.body) & 0xffffff) !== 1) return null;
  return utf8(view, data.body + 8, data.end);       // past the type and the locale
}

/** The text inside a `udta` box of the older kind: two bytes of length, two of
 *  language, then the string. */
function udtaText(view, atom) {
  if (atom.body + 4 > atom.end) return null;
  const n = view.getUint16(atom.body);
  const from = atom.body + 4;
  return n > 0 && from + n <= atom.end ? utf8(view, from, from + n) : null;
}

/**
 * One half of an ISO 6709 coordinate, in degrees.
 *
 * The standard allows three spellings — `±DD.DDDD`, `±DDMM.MM` and `±DDMMSS.SS`,
 * each one digit wider for a longitude — and NOTHING in the string says which was
 * used. The count of digits before the point is the only tell, and it is
 * unambiguous: a latitude with four of them is degrees and minutes, and one with
 * two is degrees. Phones write the first spelling and the other two are handled
 * because reading `+4637.66` as 4637 degrees would put a clip in the sea rather
 * than fail.
 *
 * @param {string} field including its sign, which ISO 6709 always writes.
 * @param {number} width digits of degrees: 2 for a latitude, 3 for a longitude.
 */
function degrees(field, width) {
  const sign = field[0] === '-' ? -1 : 1;
  const body = field.slice(1);
  const whole = body.split('.')[0].length;

  if (whole === width) return sign * Number(body);
  if (whole === width + 2) {
    return sign * (Number(body.slice(0, width)) + Number(body.slice(width)) / 60);
  }
  if (whole === width + 4) {
    return sign * (Number(body.slice(0, width))
      + Number(body.slice(width, width + 2)) / 60
      + Number(body.slice(width + 2)) / 3600);
  }
  return null;
}

const ISO6709_RE = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/;

/**
 * An ISO 6709 string — `"+46.6261-001.1173+000.000/"` — as a place.
 *
 * The trailing `/` and anything after it are ignored: Android appends a CRS name
 * (`CRSWGS_84`) that says the coordinate is in the datum this app already assumes
 * everything is in.
 *
 * An altitude of exactly zero is read as ABSENT rather than as sea level. It is
 * what an iPhone writes when it has a fix with no height to go with it, and a
 * clip filmed beside three photographs that say 43 m should not be the one mark
 * claiming 0. The cost of being wrong is a missing figure in a tooltip; the cost
 * the other way is a wrong one.
 */
export function parseIso6709(text) {
  const m = ISO6709_RE.exec(String(text || '').trim());
  if (!m) return null;

  const lat = degrees(m[1], 2);
  const lon = degrees(m[2], 3);
  if (lat === null || lon === null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const height = m[3] !== undefined ? Number(m[3]) : NaN;
  return { lat, lon, ele: Number.isFinite(height) && height !== 0 ? height : null };
}

/**
 * What a clip says about itself: when it was filmed and, if the phone had a fix,
 * where.
 *
 * Written to the same standard as `parseExif` and for the same reason — one bad
 * file in a folder must not take the run down with it. Every failure returns null
 * or drops one field, and it never throws.
 *
 * Three places are read for a time, in falling order of how much they can be
 * trusted:
 *
 *   `creationdate` in `ilst` — an ISO 8601 stamp WITH an offset, which is the
 *     only one of the three that knows its own zone;
 *   `©day` in `udta` — usually the same shape, occasionally a bare date;
 *   `mvhd` — the movie header, which every file has. Nominally UTC, and written
 *     as local time by enough muxers that it comes back flagged `assumedUtc`,
 *     the same caveat an EXIF stamp with no `OffsetTimeOriginal` gets.
 *
 * The flag is not decoration: it survives to the tooltip, and an hour of doubt
 * about a clip is worth showing rather than hiding.
 *
 * @param {ArrayBuffer} buffer the WHOLE file. Unlike EXIF, a head is not enough —
 *   `moov` is commonly the last box in the file.
 * @returns {{t: number|null, caption: string|null, assumedUtc: boolean,
 *            lat: number|null, lon: number|null, ele: number|null}|null} null when
 *   there is nothing readable in there at all.
 */
export function parseQuickTime(buffer) {
  try {
    const view = new DataView(buffer);
    const moov = box(view, 0, view.byteLength, 'moov');
    if (!moov) return null;

    const found = { when: null, where: null, caption: null };

    // `keys` and `ilst` are parallel: the Nth name in one describes the item that
    // points at N in the other. Both or neither.
    const meta = box(view, moov.body, moov.end, 'meta');
    if (meta) {
      const from = metaBody(view, meta);
      const keys = box(view, from, meta.end, 'keys');
      const ilst = box(view, from, meta.end, 'ilst');
      if (keys && ilst) {
        const names = keyTable(view, keys);
        for (const item of boxes(view, ilst.body, ilst.end)) {
          const field = QT_KEYS.get(names[item.index]);
          if (field && found[field] === null) found[field] = itemText(view, item);
        }
      }
    }

    // The older spelling, read only where the modern one said nothing — a file
    // may carry both, and `ilst` is the one with the offset in its timestamp.
    const udta = box(view, moov.body, moov.end, 'udta');
    if (udta) {
      for (const atom of boxes(view, udta.body, udta.end)) {
        const field = QT_UDTA.get(atom.type);
        if (field && found[field] === null) found[field] = udtaText(view, atom);
      }
    }

    let t = found.when ? Date.parse(found.when) : NaN;
    // A stamp with no zone on it is a wall clock, and reading it as the viewer's
    // local time would put the same clip in two places for two people watching.
    // `Date.parse` of a bare `YYYY-MM-DD` is already UTC; of a bare date and time
    // it is local, so the Z is added rather than assumed.
    let assumedUtc = false;
    if (found.when && Number.isFinite(t) && !/(Z|[+-]\d{2}:?\d{2})$/.test(found.when.trim())) {
      t = Date.parse(`${found.when.trim().replace(' ', 'T')}Z`);
      assumedUtc = true;
    }

    if (!Number.isFinite(t)) {
      const mvhd = box(view, moov.body, moov.end, 'mvhd');
      const secs = mvhd && mvhdSeconds(view, mvhd);
      // Zero is what a muxer writes when it has no clock, and 1904 is not a
      // reading. Anything else is left to stand or fall on whether it lands
      // inside the run's pings, which is where a wrong hour gets caught anyway.
      t = secs ? (secs - EPOCH_1904) * 1000 : NaN;
      assumedUtc = Number.isFinite(t);
    }

    const at = found.where ? parseIso6709(found.where) : null;

    if (!Number.isFinite(t) && !at && !found.caption) return null;
    return {
      t: Number.isFinite(t) ? t : null,
      caption: found.caption ? found.caption.slice(0, CAPTION_CHARS) : null,
      assumedUtc: Number.isFinite(t) ? assumedUtc : false,
      lat: at ? at.lat : null,
      lon: at ? at.lon : null,
      ele: at ? at.ele : null
    };
  } catch {
    return null;
  }
}

/** `mvhd`'s creation time, in seconds from 1904. Version 1 widened it to 64 bits
 *  in 2003 and phones still write version 0. */
function mvhdSeconds(view, mvhd) {
  const version = view.getUint8(mvhd.body);
  const at = mvhd.body + 4;                          // past version and flags
  if (version === 1) {
    return at + 8 <= mvhd.end ? Number(view.getBigUint64(at)) : 0;
  }
  return at + 4 <= mvhd.end ? view.getUint32(at) : 0;
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
 * @param {{crew?: Array<string>, runner?: string|null}} [people] who this run says
 *   is out there, from [`parseSettings`](settings.js) — the crew, and the runner's
 *   own name if it gave one. Both default to nobody, which is every run that has
 *   never named anybody; one object rather than two positional arguments, in the
 *   idiom `snapAll` already uses for `{start, maxSpeed}`.
 * @returns {Array} oldest-first, timeless ones last. Each is
 *   `{kind: 'media', name, sha, url, animated, caption, crew, by, t, lat, lon,
 *     along, ele, gap, source, point}` — the sun POI's shape plus what it takes to
 *   draw a picture. `kind` is `'media'`, which is what the tooltips dispatch on;
 *   `point` marks the ones that are fixes in their own right and belong in the
 *   points array.
 */
export function placeMedia(records, points, course = null, people = {}) {
  const out = [];
  for (const record of records || []) {
    const poi = record && place(record, points, course, people);
    if (poi) out.push(poi);
  }
  // Timeless POIs have nothing to sort BY, so they go to the end in the order
  // they arrived rather than being interleaved on a null.
  return out.sort((a, b) => (a.t ?? Infinity) - (b.t ?? Infinity));
}

function place(record, points, course, { crew = [], runner = null } = {}) {
  const who = crewOf(record.name, crew);
  const named = mediaTime(record.name, who);
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
    // Null on the overwhelming majority of photographs, and present on all of them
    // so that everything downstream can ask the question without knowing whether
    // this run has a crew at all.
    crew: who,
    // Who to credit, which is a DIFFERENT question from the one above and the
    // reason both fields exist. `crew` decides how this photograph may be placed
    // and what colour its dot is — it is a fact about the evidence. `by` is a line
    // on a card, and a run that named its runner credits his pictures to him just
    // as it credits Mariam's to her.
    //
    // Null when the run named nobody, and that is the whole of the opt-in: a folder
    // with no `runners_name` and no crew draws no bylines, exactly as before. The
    // credit is only worth putting on every picture in a run once there is a second
    // name it could have been.
    by: who ?? runner ?? null,
    t
  };

  // A crew photograph, and the one branch here that REFUSES more than it places.
  //
  // Both halves have to be present. Coordinates, because the alternative is
  // `traceAt`, and putting a crew member on the runner's course is precisely the
  // false claim this whole branch exists to prevent — a photograph of somebody
  // waiting at an aid station would be drawn as the runner passing through it. And
  // a moment, because a picture with no time is a picture nobody can place in the
  // story of the run; for the runner's own photographs that is tolerable, since a
  // waypoint with a coordinate is still a fact about the route, but a crew member's
  // undated position on a road somewhere is not a fact about the run at all.
  //
  // `point: false` is the load-bearing field. It is what keeps this out of the
  // points array in main.js, and therefore out of the snapper, out of `deriveStats`,
  // out of the distance and the climb, out of `applyMediaSnaps`, and out of the
  // reckoning of which fix is the latest. A crew photograph is drawn on the map and
  // counts towards NOTHING, which is the correct weight for a picture of somebody
  // who isn't running.
  //
  // `along` is null for the same reason: a crew member has no distance along the
  // runner's course, and a number there would be read as one.
  if (who) {
    if (t === null) return null;
    if (!Number.isFinite(record.lat) || !Number.isFinite(record.lon)) return null;
    return {
      ...base,
      lat: record.lat,
      lon: record.lon,
      along: null,
      ele: Number.isFinite(record.ele) ? record.ele : null,
      gap: null,
      source: 'crew',
      point: false
    };
  }

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
      // Named for where these coordinates first came from, and now equally a
      // clip's ISO 6709 — what the value means to [mediaLayers](layers.js) is "the
      // file measured this", as against a position worked out for it, and a
      // camera and a camcorder are the same kind of witness.
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
 * JPEG and the QuickTime family are opened; PNG, GIF and WebM are not. The line
 * is drawn at what a PHONE fills in. A `.png` off a screenshot and a `.webm` off
 * a transcode have somewhere in their spec to put a coordinate and nothing that
 * puts one there, so they cost no request and rest on their filename.
 *
 * The two that are opened are read differently, and the difference is where the
 * metadata sits. A JPEG's APP1 is within the first few KB, so a JPEG is sliced.
 * A clip's `moov` is commonly the LAST box in the file — 3,446,584 bytes into the
 * 3,452,585-byte clip this was written against — so a clip is read whole. That
 * costs nothing extra in practice: the atlas fetches the very same
 * content-addressed URL for the clip's first frame moments later, and `sw.js` and
 * `force-cache` between them mean the second read never reaches the network. The
 * one file that genuinely pays is a clip with no metadata in it, which is
 * downloaded here to discover exactly that.
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
  const clip = isQuickTime(name);
  if (kind !== 'jpeg' && !clip) return record;

  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);

  const blob = await res.blob();
  const meta = clip
    ? parseQuickTime(await blob.arrayBuffer())
    : parseExif(await blob.slice(0, EXIF_BYTES).arrayBuffer());
  return meta ? { ...record, ...meta } : record;
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
