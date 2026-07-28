# location-tracker

A phone drops one small JSON file per location ping into [`locations/`](locations/), and
[`index.html`](index.html) renders them all on a deck.gl map that updates itself as new pings land.

**Live map:** https://bertcoerver.github.io/location-tracker/

## Runs

Pings are grouped into one subfolder of [`locations/`](locations/) per run:

```
locations/
  test/                 an existing run — /?run=test
  vendee-10k/           add a folder, get a map
  2026-07-28T…json      loose files land here — /
```

Pick one with the `run` query parameter, and the map shows only that folder:

| URL | Shows |
|---|---|
| `/` | loose files sitting directly in `locations/` — the unsorted feed |
| `/?run=test` | `locations/test/` |
| `/?run=locations/test` | the same thing, so you can paste a path straight from GitHub |

**Adding a run is just making a folder** — no config, no code. A picker in the corner
lists whatever subfolders exist, and each run keeps its own independent cache, so
switching between them never refetches points you already have.

An unknown or malformed `run` falls back to the unsorted feed rather than erroring.

## Data format

One file per fix, named with the capture time as ISO 8601 with **every colon replaced by `_`**:

```
locations/test/2026-07-28T12_06_01+02_00.json
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
   When nothing has changed GitHub answers `304 Not Modified`, so no body is transferred.
   (A 304 still *counts* against the rate limit — measured, despite what the docs say. See
   "Rate limit" below.)
2. **Diff against `localStorage`**, which caches each point keyed by filename + blob SHA. Because
   files are immutable, a cached entry is never refetched.
3. **Fetch only the new files** from `raw.githubusercontent.com`, which is not subject to the
   API's 60 requests/hour limit.

Steady state is one cheap request every 240 s plus one ~70-byte fetch per new point. Reloading the
page costs a single `304` and zero data fetches. Polling pauses while the tab is hidden and
resumes on focus, subject to the 30 s floor described under "Rate limit".

### Rate limit

Unauthenticated GitHub API access is **60 requests/hour per IP address** — per viewer's IP, not
per repo, so audience size on its own is not the problem. File bodies don't count (they come from
the CDN), and a hidden tab doesn't poll.

A 304 counts the same as a 200, so the poll interval *is* the request rate. At `pollMs` of 240 s
that's **15 requests/hour per open tab**, a quarter of the budget:

| Viewers behind one IP | Requests/hour | Result |
|---|---|---|
| 1–4 | 15–60 | fine |
| 5+ | 75+ | throttled until the hour rolls |

Distinct connections are unaffected, so a hundred people on their own phones is fine while five in
one office is not. Four safeguards keep a tab from spending faster than that:

- **`minRefreshMs` (30 s) floors the gap between refreshes**, however they were triggered. `focus`
  and `visibilitychange` both fire when a tab comes forward, so without this a viewer flipping
  between tabs could burn the whole hour in a couple of minutes. Overlapping triggers coalesce into
  the one in-flight request rather than stacking.
- **That interval is persisted**, so it survives a page reload — otherwise mashing the browser
  refresh button reset it every time, which was the cheapest way to get rate limited. It's keyed
  per run, so opening a run you haven't viewed still loads immediately.
- **The run list is cached for `runsTtlMs` (1 hour)** and refreshed for free whenever the root feed
  is polled. Subfolders appear when you create a race, not every four minutes.
- **Hidden tabs don't poll at all.**

Measured cost of one page load, warm cache:

| | API requests |
|---|---|
| Reload within 30 s | **0** — repainted from cache |
| Reload after 30 s | **1** |
| Cold load of a run never viewed | 2 |

Trading latency for headroom is a one-line change to `pollMs` in [`src/config.js`](src/config.js).
Going further means removing the API from the read path entirely — a GitHub Action that aggregates
each run into one static file, which lifts the viewer ceiling completely but adds several minutes
of delay before a new ping is visible.

### Known limit

A Contents API directory listing returns at most **1000 entries**, roughly 3.5 days of pings at the
current 5-minute cadence — though that's now per run, so a race would have to last three days to
hit it. When it is reached, add a GitHub Action that appends each ping into a compact
`<run>/index.json`; only `listDir()` in [`src/github.js`](src/github.js) needs to change, and it's
marked in the source.

## Project structure

```
index.html          markup + all CSS (the colour tokens live here)
src/
  main.js           entry point: wires everything together, owns the poll loop
  config.js         repo coordinates, poll interval — the only file to edit
  route.js          which run the URL asks for, and where its files live
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
- New URL parameter → `route.js`.
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
downloads nothing, one new point upstream downloads exactly one file, and
switching between runs doesn't invalidate either one's cache.

## Publishing

One-time setup: **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**. The empty
`.nojekyll` file stops Pages running the repo through Jekyll.
