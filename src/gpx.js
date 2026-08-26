// A GPX reader, hand-rolled.
//
// `DOMParser` would be the obvious tool, and it doesn't exist in Node — where
// the tests run. Pulling in an XML library would mean a build step, which this
// project doesn't have. GPX is regular enough that reading it by hand is a
// smaller commitment than either, and it stays a pure function of a string.
//
// What it deliberately does NOT do: namespaces, validation, `<extensions>`, or
// anything schema-aware. It reads the four element shapes a course file uses and
// ignores the rest.

// `NS` swallows an optional namespace prefix. The default GPX namespace is
// almost never prefixed in practice, but "almost never" isn't never, and a
// prefixed file silently reading as empty would be the worst kind of failure.
const NS = '(?:[\\w.-]+:)?';

const POINT = new RegExp(
  `<${NS}(trkpt|rtept|wpt)\\b([^>]*?)(\\/>|>([\\s\\S]*?)<\\/${NS}\\1\\s*>)`, 'gi');
const SEG = new RegExp(`<${NS}trkseg\\b[^>]*>([\\s\\S]*?)<\\/${NS}trkseg\\s*>`, 'gi');
const RTE = new RegExp(`<${NS}rte\\b[^>]*>([\\s\\S]*?)<\\/${NS}rte\\s*>`, 'gi');

/** Reads one attribute out of a start tag's attribute text, quote style agnostic. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? (m[2] ?? m[3]) : null;
}

/** First child element of `body` with this local name, text content only. */
function child(body, name) {
  const m = body.match(
    new RegExp(`<${NS}${name}\\s*>([\\s\\S]*?)</${NS}${name}\\s*>`, 'i'));
  return m ? unwrap(m[1].trim()) : null;
}

function decode(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#39);/g, (_, e) =>
    ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", '#39': "'" })[e]);
}

// A `<![CDATA[...]]>` section is verbatim text, not markup — MapOut wraps a
// `<name>` in one whenever it contains an apostrophe, so a course full of
// "L'Alpe" and "Plan de l'Au" is a course full of CDATA. Left to `decode`
// alone, that text comes through as the literal markers and all —
// "<![CDATA[Plan de l'Au]]>" — which is worse than the name it replaces.
// Only the text OUTSIDE the CDATA sections gets entity-decoded; text inside
// one is exactly what's between the brackets, by definition.
const CDATA = /<!\[CDATA\[([\s\S]*?)\]\]>/g;

function unwrap(raw) {
  if (!raw.includes('<![CDATA[')) return decode(raw);
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(CDATA)) {
    out += decode(raw.slice(last, m.index)) + m[1];
    last = m.index + m[0].length;
  }
  return out + decode(raw.slice(last));
}

/** One `<trkpt>` / `<rtept>` / `<wpt>` match -> a point, or null if unusable. */
function toPoint(tag, body) {
  const lat = Number(attr(tag, 'lat'));
  const lon = Number(attr(tag, 'lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const raw = body ? child(body, 'ele') : null;
  const ele = raw === null ? null : Number(raw);
  return { lat, lon, ele: Number.isFinite(ele) ? ele : null };
}

/** Every point element of the given kinds inside `xml`, in document order. */
function points(xml, kinds) {
  const out = [];
  for (const [, kind, tag, , body] of xml.matchAll(POINT)) {
    if (!kinds.includes(kind.toLowerCase())) continue;
    const point = toPoint(tag, body || '');
    if (point) out.push({ ...point, body: body || '' });
  }
  return out;
}

/**
 * Parses a GPX document into the shape [course.js](course.js) consumes.
 *
 * Track segments stay separate so a multi-part course draws as several paths
 * rather than one line teleporting between them. A file with no `<trk>` falls
 * back to its `<rte>` elements — plenty of course exports are routes, not tracks.
 *
 * @returns {{name: string|null, segments: Array<Array<{lat,lon,ele}>>,
 *            waypoints: Array<{lat,lon,ele,name,sym}>, hasElevation: boolean} | null}
 *   null when the text isn't GPX or carries no usable geometry.
 */
export function parseGpx(text) {
  if (typeof text !== 'string' || !/<gpx\b/i.test(text)) return null;

  const segments = [];
  for (const [, body] of text.matchAll(SEG)) {
    const seg = points(body, ['trkpt']).map(({ body: _, ...p }) => p);
    if (seg.length) segments.push(seg);
  }
  // Only if there were no track segments at all — a file with both is a track
  // file that happens to carry a route, and the track is the authoritative one.
  if (!segments.length) {
    for (const [, body] of text.matchAll(RTE)) {
      const seg = points(body, ['rtept']).map(({ body: _, ...p }) => p);
      if (seg.length) segments.push(seg);
    }
  }
  if (!segments.length) return null;

  // Waypoints are top-level, so anything already inside a <trkseg> or <rte> is
  // excluded by construction — <wpt> can't legally appear there.
  // `type` as well as `sym` because the two are the same claim made by different
  // exporters — what KIND of place this is — and a file picks one. The UTMB
  // course writes `<type>AID STATION</type>` and no `<sym>` at all; MapOut does
  // the reverse.
  const waypoints = points(text, ['wpt']).map(({ body, ...p }) => ({
    ...p,
    name: child(body, 'name'),
    sym: child(body, 'sym'),
    type: child(body, 'type')
  }));

  // Partial elevation is treated as none: a profile with holes in it would be
  // worse than no profile, and there's no honest way to fill them.
  const hasElevation = segments.every(seg => seg.every(p => p.ele !== null));

  return { name: metadataName(text), segments, waypoints, hasElevation };
}

/** `<metadata><name>` — the course's own title, when it has one. */
function metadataName(text) {
  const m = text.match(new RegExp(`<${NS}metadata\\b[^>]*>([\\s\\S]*?)<\\/${NS}metadata\\s*>`, 'i'));
  return m ? child(m[1], 'name') : null;
}
