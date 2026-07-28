// deck.gl layer construction. `deck` is a global from the UMD bundle loaded by
// index.html, not an import.

import { accent, rampAt, surface, prefersDark } from './colors.js';
import { escapeHtml, fmtTime } from './util.js';
import { latestOf } from './points.js';

/** Keyless CARTO raster basemap, light or dark to match the page. */
export function basemapLayer() {
  const style = prefersDark() ? 'dark_all' : 'light_all';

  return new deck.TileLayer({
    id: 'basemap',
    data: ['a', 'b', 'c'].map(sub =>
      `https://${sub}.basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}@2x.png`),
    minZoom: 0,
    maxZoom: 19,
    tileSize: 256,
    renderSubLayers: props => {
      const { boundingBox } = props.tile;
      return new deck.BitmapLayer(props, {
        data: null,
        image: props.data,
        bounds: [boundingBox[0][0], boundingBox[0][1], boundingBox[1][0], boundingBox[1][1]]
      });
    }
  });
}

/**
 * The point layers.
 * @param {Array} points sorted oldest-first, each carrying `k`
 * @param {number} pulse 0..1, drives the halo on the newest fix
 */
export function pointLayers(points, pulse) {
  const latest = latestOf(points);
  const latestData = latest ? [latest] : [];
  const ring = surface();

  return [
    new deck.ScatterplotLayer({
      id: 'trail',
      data: points,
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: p => [p.lon, p.lat],
      getRadius: 5,
      radiusMinPixels: 5,
      // A surface-coloured ring keeps overlapping fixes readable as separate marks.
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      getLineColor: [...ring, 235],
      getFillColor: p => [...rampAt(p.k), 232],
      updateTriggers: { getFillColor: points.length }
    }),

    // Pulsing halo, so a newly arrived fix is visible without hunting for it.
    new deck.ScatterplotLayer({
      id: 'latest-halo',
      data: latestData,
      radiusUnits: 'pixels',
      getPosition: p => [p.lon, p.lat],
      getRadius: 11 + pulse * 9,
      getFillColor: [...accent(), Math.round(70 - pulse * 45)],
      updateTriggers: { getRadius: pulse, getFillColor: pulse }
    }),

    new deck.ScatterplotLayer({
      id: 'latest',
      data: latestData,
      pickable: true,
      radiusUnits: 'pixels',
      getPosition: p => [p.lon, p.lat],
      getRadius: 7,
      stroked: true,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      getLineColor: [...ring, 255],
      getFillColor: [...accent(), 255]
    })
  ];
}

/** Tooltip markup for one fix. Pure and DOM-free, so it's directly testable. */
export function tooltipHtml(point, isLatest) {
  const rows = [
    `<div class="t">${fmtTime.format(point.t)}${isLatest ? ' &middot; latest' : ''}</div>`,
    `<div class="r">${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}</div>`
  ];
  if (point.btry !== undefined) rows.push(`<div class="r">Battery ${point.btry}%</div>`);
  if (point.msg) rows.push(`<div class="m">${escapeHtml(point.msg)}</div>`);
  if (point.img) rows.push(`<img src="${encodeURI(point.img)}" alt="">`);
  return rows.join('');
}

/** deck.gl's getTooltip callback, bound to a live accessor for the current points. */
export function makeTooltip(getPoints) {
  return ({ object }) => {
    if (!object) return null;
    const latest = latestOf(getPoints());
    return {
      html: tooltipHtml(object, !!latest && latest.name === object.name),
      className: 'tip'
    };
  };
}
