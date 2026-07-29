# location-tracker

A phone drops one small JSON file per location ping into [`locations/`](locations/), and
[`index.html`](index.html) renders them all on a deck.gl map that updates itself as new pings land.

**Live map:** https://bertcoerver.github.io/location-tracker/

## Runs

Every ping belongs to a run — one subfolder of [`locations/`](locations/) per race:

```
locations/
  test/                 an existing run — /?run=test
  vendee-10k/           add a folder, get a map
```

| URL | Shows |
|---|---|
| `/` | whichever run pinged most recently, and it **keeps following** — a new race takes over the plain link as soon as it starts |
| `/?run=test` | `locations/test/`, pinned; never overridden |
| `/?run=locations/test` | the same thing, so you can paste a path straight from GitHub |

**Adding a run is just making a folder** — no config, no code. The picker lists
whatever subfolders exist, newest first, and hides itself when there's only one.
A run that has pinged within the last hour is marked live, with a `●` in the picker
and a pulsing dot beside the title.

A file sitting loose in `locations/` belongs to no run and is never shown. An unknown
or malformed `run` falls back to the newest run rather than erroring.

Each run keeps its own point cache, and **switching runs costs no API requests at all**
— see below.

## On screen

Two numbers. **How long since the last ping**, beside the run name, and **how long the run has been
going**, in the top right. Not how many pings there are, and not what second the browser last
checked GitHub — that second is the page's business, and the dot already says whether polling is
healthy.

The clock counts from the first ping and ticks each second while the run is live. Once the run goes
quiet — nothing for an hour — it **stops**, and its label changes from "Elapsed" to "Total". A clock
still counting hours after the finish would be claiming the race is still on.

**One dot, two signals.** Its colour is the last poll's outcome — green for fine, red for failed,
with the reason spelled out underneath — and it pulses while the run is live, meaning it has pinged
within the last hour. There used to be a second dot for that; two of them side by side just read as
decoration.

That ticker is also the only control. **Click it to fly back to the newest fix**; panning the map
turns following off, and the ticker dims to say so. There is no separate Follow button because
"where is the runner" and "take me there" were never two questions.

Every ping is one colour, with the newest in the accent colour and a pulsing halo. There used to
be a time ramp and a legend to decode it, but the only thing anyone read off it was how fresh the
newest fix was, and the ticker now says that in words. All the colours are CSS custom properties in
[`index.html`](index.html) — `--point`, `--accent`, `--course`, `--surface-*` — and
[`colors.js`](src/colors.js) reads whichever of light or dark is active.

## The course

Drop a `.gpx` file into a run's folder and it becomes that run's course:

```
locations/test/
  test.gpx                          the course
  2026-07-28T12_06_01+02_00.json    the pings
```

No config, no naming convention — any `.gpx` directly inside the folder is found. It is never
treated as a ping, so adding one can't make a finished race look live, and a folder holding only a
course isn't a run until the first ping lands. Track segments (`<trk>`) are preferred; a file with
only a route (`<rte>`) works too. If a run somehow has several `.gpx` files the first alphabetically
wins — arbitrary, but stable, which is what matters for the cache.

With a course present, three things change:

- **The route is drawn**, with its waypoints as markers you can hover for a name and elevation.
- **Pings snap to it.** A fix within 500 m of the course is drawn where it belongs on the route, and
  its real position stays visible underneath at low opacity, joined to it by a dashed line — so you
  can always see how far the snap moved things, and which fix moved where. A fix further away than
  that is left exactly where it is.
- **A height profile appears** along the bottom, if the GPX carries elevation for every point. It
  plots the whole course with each snapped ping on it; hovering a ping gives the same tooltip the
  map does, and hovering anywhere else reads out distance and height. On a narrow screen it keeps
  its width and scrolls sideways rather than compressing a 20 km race into 375 pixels.

  The terrain line is drawn from one elevation sample per pixel column, then blurred by
  `profileSmoothPx` columns — about 100 m of ground, which settles GPS noise without flattening
  anything real. The underlying summary keeps every peak; only the drawing is smoothed.

- **Each ping carries its climb**, in the tooltip: metres up and down since the run started, and
  over the stretch since the previous ping.

### Hovering works both ways

The map and the profile are two views of one run, so pointing at a place in either marks it in the
other. Hovering the strip puts a ring on the route; hovering the route — or a ping — moves the
strip's crosshair to it. Whichever view the pointer is actually over owns the crosshair, so the two
can't fight over it.

### Counting the climb

Ascent is **integrated along the course**, not taken as the difference between two snapped
elevations. Pings arrive minutes apart, and a hill climbed and descended in between would otherwise
count as nothing at all.

Raw GPX elevations wobble by a metre or two whatever the ground is doing, and adding that wobble up
is how a flat road comes out as a mountain range — reported gains from naive summing are routinely
double the truth. So a rise or fall only counts once it has moved `eleThresholdM` (3 m) clear of the
last committed height, and then it counts in full. On the 8.8 km test loop that is the difference
between 95 m of "climb" and 61 m of real one.

The totals are accumulated once per course, when the GPX is parsed, so a ping's figures are two
array lookups and a subtraction.

### Circular courses

Where a course starts and finishes in the same place, a fix at that junction is metres from two
points on the route that are a whole lap apart. Geometry cannot choose between them — both are
equally close. So snapping runs in time order and scores each ping against how far the *previous*
one got: moving backwards along the course is heavily penalised, jumping forwards mildly. Starting
from zero, the first ping therefore lands at the start line and a late one at the finish, from
identical coordinates.

The tuning lives in [`src/config.js`](src/config.js) (`snapMeters`, `snapBackPenalty`,
`snapForwardBias`, `loopMeters`). Two consequences worth knowing:

- `along` is a position **on the course**, not a race odometer. On a second lap a ping snaps back to
  where it was the first time round, because that is genuinely where it is. Laps aren't modelled.
- An out-and-back course works, because the return leg is part of the route and distance keeps
  increasing along it.

### Cost

A course is discovered in the tree listing the page already fetches, and downloaded from the CDN, so
**it costs zero API requests**. Snapping is done once per ping, ever: results are keyed by filename
in `localStorage`, so a reload paints the snapped positions before the GPX has even arrived. The
whole cache is recomputed only if the course file changes, the threshold changes, or a ping appears
that is older than one already snapped — a backfill, which was never scored against the pings before
it. The parsed course itself is deliberately *not* cached; a long route would dwarf everything else
in storage, and the browser's HTTP cache makes refetching it free.

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

1. **One conditional request per poll**, to the Git Trees API:
   `GET /repos/…/git/trees/main:locations?recursive=1`, sent with `If-None-Match`. When nothing has
   changed GitHub answers `304 Not Modified`, so no body is transferred. (A 304 still *counts*
   against the rate limit — measured, despite what the docs say. See "Rate limit" below.)
2. **Build the index** from that one response. Because a ping's capture time is in its *filename*,
   the listing alone says which runs exist, when each last moved, and what's in the one on screen.
   That is why the request count doesn't grow with the number of runs.
3. **Diff against `localStorage`**, which caches each point keyed by filename + blob SHA. Because
   files are immutable, a cached entry is never refetched.
4. **Fetch only the new files** from `raw.githubusercontent.com`, which is not subject to the
   API's 60 requests/hour limit.

Steady state is one cheap request every 240 s plus one ~70-byte fetch per new point. Reloading the
page costs a single `304` and zero data fetches. Polling pauses while the tab is hidden and
resumes on focus, subject to the 30 s floor described under "Rate limit".

Steps 1–2 are the only rate-limited work, and they're independent of which run you're looking at.
So **opening a run costs zero API requests**: the cached index already lists its files, and their
bodies come from the CDN. Switching runs can never rate-limit you.

The trade is response size. A tree listing covers every ping in the repo, not one folder, so a
changed poll transfers roughly 200 bytes per ping ever recorded. At race-day volumes that is tens
of kilobytes; see "Known limit" for where it stops being reasonable.

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
- **Hidden tabs don't poll at all.**

Measured cost of one page load, warm cache:

| | API requests |
|---|---|
| Reload within 30 s | **0** — repainted from cache |
| Reload after 30 s | **1** |
| Cold load, empty cache | **1** |
| Switching to a run you've never opened | **0** |

Trading latency for headroom is a one-line change to `pollMs` in [`src/config.js`](src/config.js).
Going further means removing the API from the read path entirely — a GitHub Action that aggregates
each run into one static file, which lifts the viewer ceiling completely but adds several minutes
of delay before a new ping is visible.

### Known limit

A tree response is capped at **100,000 entries / 7 MB**, after which GitHub sets `truncated` and
silently drops the rest — roughly a year of pings at the current 5-minute cadence, and the page
says so in the status panel rather than quietly showing a partial map. Response size will get
uncomfortable well before that.

When it does, add a GitHub Action that appends each ping into a compact `<run>/index.json`; only
`fetchTree()` in [`src/github.js`](src/github.js) needs to change, and it's marked in the source.

## Project structure

```
index.html          markup + all CSS (the colour tokens live here)
src/
  main.js           entry point: wires everything together, owns the poll loop
  config.js         repo coordinates, poll interval — the only file to edit
  route.js          which run the URL pins, if any
  github.js         data layer: the tree request, the run index, the point cache
  points.js         cache -> sorted array, time position, bounding box
  gpx.js            reads a .gpx into segments and waypoints (no dependencies)
  course.js         projects it to metres: distance along, climb, loop detection, grid index
  snap.js           puts each ping on the course, once, and remembers where
  stats.js          per-ping elapsed time and climb, derived on each paint
  profile.js        the height profile strip (canvas 2D)
  map.js            deck.gl instance, camera, follow-latest behaviour
  layers.js         layer construction + tooltip markup
  colors.js         reads the CSS colour tokens
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
- New colour → a token in `index.html`, then read it in `colors.js`. Never a literal in a layer.
- New URL parameter → `route.js`.
- Different repo, poll rate, or snap threshold → `config.js` only.
- Something else read out of the GPX → `gpx.js`, then `course.js` if it needs measuring.
- Changing how a ping picks its place on the course → the cost function in `snap.js`.
- Another figure derived per ping → `stats.js`, then a row in `tooltipHtml`.
- Linking the two views further → `map.js` and `profile.js` each expose `setHover`; `main.js`
  is where they are joined up.

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
design rests on: a cold start costs one API request and downloads every file once,
an unchanged poll downloads nothing, one new point upstream downloads exactly one
file, opening a run for the first time costs no API request at all, and loose files
never surface as a run.

The course work is covered the same way. The GPX parser is tested against the real
[`locations/test/test.gpx`](locations/test/test.gpx) rather than a fixture written to
suit it; the grid index is checked against brute force over a few hundred probes,
since it is an optimisation and must never change an answer; and the snapper is
pinned down on the two things that are easy to get quietly wrong — that on a closed
loop the same coordinate resolves to the start when it arrives first and the finish
when it arrives last, and that growing a run one ping at a time gives byte-identical
results to snapping it all at once, at one projection per ping.

The profile's arithmetic is tested without a canvas anywhere near it: that smoothing
settles column-to-column noise without moving a summit or sagging the ends of the
course towards sea level, and that hovering picks the dot you are actually pointing at
rather than its neighbour — a mistake that looks fine in a screenshot.

The climb figures get the same treatment, and the tests are written around the ways
the arithmetic could quietly lie: that a flat course dressed in a metre of noise
accumulates **nothing**, that a slow steady climb is not thrown away by the same
threshold that discards the noise, that a leg spanning a ping which missed the course
still counts the ground underneath it, and that a ping landing *behind* its predecessor
reports positive metres with ascent and descent swapped rather than negative ones.

## Publishing

One-time setup: **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**. The empty
`.nojekyll` file stops Pages running the repo through Jekyll.
