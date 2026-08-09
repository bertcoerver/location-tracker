import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseGpx } from '../src/gpx.js';

// The parser is hand-rolled, so the case that matters most is a file nobody
// wrote for it: a real export, from a real app, with namespaces and extensions.
//
// It lives here rather than under `locations/`, where it started. Anything in
// there is a RUN — the tree listing turns a folder with a GPX in it into an entry
// in the picker — so a fixture kept there is a fake race on the map, and clearing
// those out took this file with it and broke this suite for a fortnight. A test's
// fixture belongs to the test.
const REAL = readFileSync(
  fileURLToPath(new URL('./fixtures/test.gpx', import.meta.url)), 'utf8');

test('reads a real MapOut export', () => {
  const gpx = parseGpx(REAL);

  assert.equal(gpx.segments.length, 1);
  assert.equal(gpx.segments[0].length, 285);
  assert.equal(gpx.waypoints.length, 3);
  assert.equal(gpx.hasElevation, true);
  assert.equal(gpx.name, 'Drawn 28 Jul 2026 at 14:03');
});

test('coordinates survive at full precision', () => {
  // Truncating these would move the course by metres, which is the same order
  // as the snapping it feeds.
  const first = parseGpx(REAL).segments[0][0];
  assert.equal(first.lat, 46.57342348293472);
  assert.equal(first.lon, -0.772143183814973377);
  assert.equal(first.ele, 62);
});

test('waypoint names come through, including one that is not just "Waypoint"', () => {
  const names = parseGpx(REAL).waypoints.map(w => w.name);
  assert.deepEqual(names, ['Waypoint', 'Waypoint', 'Route de Foussais']);
  assert.equal(parseGpx(REAL).waypoints[2].ele, 83);
});

test('a waypoint <type> is read, for the exporters that use it instead of <sym>', () => {
  const gpx = parseGpx(
    '<gpx><wpt lat="46.5" lon="8.1"><name>Col</name><type>SUMMIT</type></wpt>' +
    '<trk><trkseg><trkpt lat="46.5" lon="8.1"/><trkpt lat="46.6" lon="8.2"/>' +
    '</trkseg></trk></gpx>');

  assert.equal(gpx.waypoints[0].type, 'SUMMIT');
  assert.equal(gpx.waypoints[0].sym, null);
});

test('<extensions> inside a waypoint does not leak into it', () => {
  // The real file wraps a <mapout:color> in <extensions>; a sloppier reader
  // would pick that up as the waypoint's own data.
  for (const w of parseGpx(REAL).waypoints) {
    assert.equal(w.sym, 'Waypoint');
    assert.ok(!('color' in w));
  }
});

// --- shapes other exporters produce -----------------------------------------

const wrap = inner => `<?xml version="1.0"?><gpx version="1.1">${inner}</gpx>`;

test('each <trkseg> stays its own segment', () => {
  // Merging them would draw a line across the gap between two legs of a course.
  const gpx = parseGpx(wrap(`<trk>
    <trkseg><trkpt lat="1" lon="1"/><trkpt lat="1" lon="2"/></trkseg>
    <trkseg><trkpt lat="5" lon="5"/><trkpt lat="5" lon="6"/></trkseg>
  </trk>`));

  assert.equal(gpx.segments.length, 2);
  assert.deepEqual(gpx.segments.map(s => s.length), [2, 2]);
});

test('a route-only file is read as a course', () => {
  // Plenty of published race courses are <rte>, not <trk>.
  const gpx = parseGpx(wrap(`<rte>
    <rtept lat="1" lon="1"><ele>10</ele></rtept>
    <rtept lat="1" lon="2"><ele>20</ele></rtept>
  </rte>`));

  assert.equal(gpx.segments.length, 1);
  assert.equal(gpx.segments[0].length, 2);
  assert.equal(gpx.hasElevation, true);
});

test('a track wins over a route in a file carrying both', () => {
  const gpx = parseGpx(wrap(`
    <rte><rtept lat="9" lon="9"/><rtept lat="9" lon="8"/></rte>
    <trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="1" lon="2"/></trkseg></trk>`));

  assert.equal(gpx.segments.length, 1);
  assert.equal(gpx.segments[0][0].lat, 1);
});

test('partial elevation counts as no elevation', () => {
  // A profile with holes in it is worse than no profile, and there is no honest
  // way to invent the missing heights.
  const gpx = parseGpx(wrap(`<trk><trkseg>
    <trkpt lat="1" lon="1"><ele>10</ele></trkpt>
    <trkpt lat="1" lon="2"/>
  </trkseg></trk>`));

  assert.equal(gpx.hasElevation, false);
  assert.equal(gpx.segments[0][1].ele, null);
});

test('single-quoted attributes and namespace prefixes are tolerated', () => {
  const gpx = parseGpx(`<?xml version='1.0'?><gpx:gpx xmlns:gpx="x">
    <gpx:trk><gpx:trkseg>
      <trkpt lon='2' lat='1'><ele>5</ele></trkpt>
      <trkpt lon='3' lat='1'><ele>6</ele></trkpt>
    </gpx:trkseg></gpx:trk></gpx:gpx>`);

  assert.equal(gpx.segments[0].length, 2);
  assert.equal(gpx.segments[0][0].lat, 1);
});

test('escaped characters in a waypoint name are decoded', () => {
  const gpx = parseGpx(wrap(`
    <wpt lat="1" lon="1"><name>Caf&amp; &lt;Bar&gt;</name></wpt>
    <trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="1" lon="2"/></trkseg></trk>`));

  assert.equal(gpx.waypoints[0].name, 'Caf& <Bar>');
});

test('self-closing points with no children are fine', () => {
  const gpx = parseGpx(wrap('<trk><trkseg><trkpt lat="1" lon="1"/><trkpt lat="2" lon="2"/></trkseg></trk>'));
  assert.equal(gpx.segments[0].length, 2);
  assert.equal(gpx.hasElevation, false);
});

// --- refusing rather than guessing ------------------------------------------

test('anything that is not usable GPX returns null', () => {
  for (const bad of [
    '',
    'not xml at all',
    '<html><body>404</body></html>',
    wrap(''),                                                    // no geometry
    wrap('<trk><trkseg><trkpt lat="1" lon="1"/></trkseg></trk>'), // one point is not a course
    wrap('<trk><trkseg><trkpt lat="x" lon="y"/></trkseg></trk>'), // unparseable coordinates
    null,
    undefined
  ]) {
    const gpx = parseGpx(bad);
    // A single-point track parses but can't be a course; buildCourse rejects it.
    assert.ok(gpx === null || gpx.segments.flat().length < 2, JSON.stringify(bad));
  }
});
