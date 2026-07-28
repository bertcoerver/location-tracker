# location-tracker

A phone drops one small JSON file per location ping into [`locations/`](locations/), and
[`index.html`](index.html) renders them all on a deck.gl map that updates itself as new pings land.

**Live map:** https://bertcoerver.github.io/location-tracker/

## Data format

One file per fix, named with the capture time as ISO 8601 with **every colon replaced by `_`**:

```
locations/2026-07-28T12_06_01+02_00.json
```

The timestamp lives *only* in the filename — there is no time field in the body:

```json
{"lat":46.57352593732256,"lon":-0.7721662634749413,"btry":49}
```

Only `lat` and `lon` are required. `btry` (battery %), `msg` and `img` are optional and the map
handles files that carry any, all, or none of them. Files are never edited once written.

## How the map stays fresh cheaply

Re-downloading every file on a timer would not scale, so the page only ever fetches what it does
not already have:

1. **One conditional request per poll** to the GitHub Contents API, sent with `If-None-Match`.
   When nothing has changed GitHub answers `304 Not Modified` — no body, and 304s do not count
   against the rate limit.
2. **Diff against `localStorage`**, which caches each point keyed by filename + blob SHA. Because
   files are immutable, a cached entry is never refetched.
3. **Fetch only the new files** from `raw.githubusercontent.com`, which is not subject to the
   API's 60 requests/hour limit.

Steady state is one cheap request every 120 s plus one ~70-byte fetch per new point. Reloading the
page costs a single `304` and zero data fetches. Polling pauses while the tab is hidden and
resumes immediately on focus.

### Known limit

A Contents API directory listing returns at most **1000 entries**, roughly 3.5 days of pings at the
current 5-minute cadence. When that's reached, add a GitHub Action that appends each ping into a
compact `data/index.json`; only `listRemoteFiles()` in `index.html` needs to change, and it's
marked in the source.

## Project structure

```
index.html          markup + all CSS (the colour tokens live here)
src/
  main.js           entry point: wires everything together, owns the poll loop
  config.js         repo coordinates, poll interval — the only file to edit
  github.js         data layer: listing, fetching, the incremental cache
  points.js         cache -> sorted array, time position, bounding box
  map.js            deck.gl instance, camera, follow-latest behaviour
  layers.js         layer construction + tooltip markup
  colors.js         reads the CSS colour tokens, samples the ramp
  util.js           time parsing, formatting, concurrency pool, storage guard
test/
  *.test.js         run with `npm test`
package.json        scripts only — no dependencies, nothing to install
```

These are **native ES modules** (`import`/`export`), which browsers run directly —
there is no bundler and no build step, so what's in `src/` is exactly what ships.
`index.html` loads one file, `<script type="module" src="src/main.js">`, and the
imports pull in the rest.

The one consequence: modules are subject to CORS, so **opening `index.html` as a
`file://` path won't work** — you need a local server (below). Over `http://` it's fine.

If you later want to `npm install` a third-party package, that's the point at which
you'd add a bundler (Vite is the usual choice) — it isn't worth it before then.

### Where to add things

- New data field from the phone → `github.js` (`fetchPoint`) and `layers.js` (`tooltipHtml`).
- New visual layer → `layers.js`, then include it in `pointLayers`.
- New panel or control → `index.html` for markup/CSS, `ui.js` for behaviour.
- Different repo or poll rate → `config.js` only.

## Running it

No install step. Serve the repo root and open it:

```sh
npm run dev          # or: python3 -m http.server 8000
```

Then open http://localhost:8000/.

## Tests

```sh
npm test
```

Uses Node's built-in test runner — no dependencies, no `npm install`. The suite
runs offline against a fake GitHub and covers the caching contract that the whole
design rests on: a cold start downloads everything once, an unchanged poll
downloads nothing, and one new point upstream downloads exactly one file.

## Publishing

One-time setup: **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**. The empty
`.nojekyll` file stops Pages running the repo through Jekyll.
