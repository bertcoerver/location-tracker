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

Two numbers, both in the panel top left. **How long since the last ping**, on the top line, and
**how long the run has been going**, below the run name. Not how many pings there are, and not
what second the browser last checked GitHub — that second is the page's business, and the dot
already says whether polling is healthy. The run's name is set in the same type as the clock: they
are the two things worth reading at a glance, so neither is a caption for the other.

While a run is live the top line also says **when the next ping is due, and the battery deciding
that**:

```
● Last ping 1m ago · next ~16m · 25%
● Last ping 34m ago · overdue · 25%
```

The phone slows down as it drains — five minutes on a full charge, half an hour on a dying one — so
without this a long silence is indistinguishable from a broken tracker. With it, the same silence
reads as a system working exactly as designed, and says how long to wait. A finished run drops the
clause entirely; an expectation is a claim about a phone that is still out there.

Once the phone says it is done, the line says that instead:

```
● Finished 12m ago
```

The clock counts from the first ping and ticks each second while the run is live. It **stops** when
the run finishes — either because the phone said so, or because nothing has arrived for an hour —
and its label changes from "Elapsed" to "Total". A clock still counting hours after the finish would
be claiming the race is still on.

### Knowing a run is over

Without being told, the page can only guess from the clock: no ping for an hour means finished. That
guess cannot tell a finished race from a phone in a tunnel, and it is an hour late either way.

So the phone marks its last upload. It is an **ordinary ping** — coordinates, battery and all — with
one extra field, `"is_finish": true`. Three things change the moment it lands:

- the dot stops pulsing, the clock freezes to "Total", and the ticker reads `Finished 12m ago`;
- polling drops straight to one request every 15 minutes, skipping the whole overdue ladder;
- if the run has a course, the finish is pinned to the **end** of it — see "The course" below.

Only the newest ping counts. A finish with pings after it is a phone that was restarted, and the run
is plainly going again, so the page treats it as live once more. That rule is why the panel and the
poll schedule can never disagree: both read the same last point.

One limit worth knowing: a finished run that is *not* the one on screen keeps its `●` in the run
picker for the usual hour. The index comes from GitHub's tree API, which lists paths and never file
contents, so a run has to be opened before its finish is visible.

**One dot, two signals.** Its colour is the last poll's outcome — green for fine, red for failed,
with the reason spelled out underneath — and it pulses while the run is live, meaning it has pinged
within the last hour. There used to be a second dot for that; two of them side by side just read as
decoration.

That ticker is also the main control. **Click it to fly back to the newest fix**; panning the map
turns following off, and the ticker dims to say so. There is no separate Follow button because
"where is the runner" and "take me there" were never two questions.

Below it, when a run has a course, two checkboxes decide what else is drawn: its **points of
interest** (on the map and on the height strip both — one switch, or it would be lying about half
the screen) and the **raw points**, the audit trail showing where each fix really was before it
snapped, joined to it by a dashed line. The snapped dots themselves have no switch: they are the
reading, not a decoration. The choice is remembered across visits, and a checkbox for something the
current run hasn't got stays hidden.

### Click to keep a tooltip

Hovering is a fine way to glance at a point and a poor way to **read** one: the cursor has to be
held still, the link inside can only be reached by a careful diagonal move, and on a phone there is
no hover at all. So **clicking a point pins its tooltip** — a ping, a point of interest, or any spot
on the course, in either view. While one is pinned, hovering is suspended everywhere: no second
tooltip chases the cursor, and the crosshair stays on the point you asked about.

The tooltip appears in the view you clicked and stays attached to the place, riding along as the map
pans and zooms or the strip scrolls. It goes away when you click the same point again, click bare
basemap, or press Escape. The other view still marks the spot, which is what makes a click in one
view legible in the other.

**Every tooltip ends with a Google Maps link**, opening that exact spot in a new tab, with a label
on the pin — how far in and at what time for a ping, its own name for a point of interest. For a
ping the link points at the raw fix rather than the snapped one: the snap moves the dot onto the
course, it does not move the runner, and a link to the snapped position would be a place nobody has
been.

That label costs a URL form Google no longer documents. The supported `search/?api=1&query=` takes
**either** a coordinate or a place name — pass a name and the pin jumps to whatever Google matched,
which is worse than a blank card. The older `?q=lat,lon(Label)` is the only form that pins an exact
coordinate *and* names it. Links without a label stay on the documented one. See `mapsUrl` in
[`util.js`](src/util.js).

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

- **The route is drawn**, with its waypoints as named markers — the name is drawn beside the marker
  on the map and above its tick on the height strip, and hovering one gives its elevation too.
- **Pings snap to it.** A fix within 500 m of the course is drawn where it belongs on the route, and
  its real position stays visible underneath at low opacity, joined to it by a dashed line — so you
  can always see how far the snap moved things, and which fix moved where. A fix further away than
  that is left exactly where it is.
- **A height profile appears** along the bottom, if the GPX carries elevation for every point. It
  plots the whole course with each snapped ping on it, under a minimal distance axis ticked at
  round numbers — 500 m, 2 km, whatever is coarse enough to leave the labels legible. On a narrow
  screen it keeps its width and scrolls sideways rather than compressing a 20 km race into 375
  pixels; there is no scrollbar, because on the platforms that lay one out it eats into a 112 px
  strip and on the ones that overlay it it sits on top of the distance labels. Instead the strip
  **fades at whichever end has more course**, which says both that there is more and which way.

  It is translucent, so the course carries on underneath the chart of it — a solid band across the
  bottom of the map hides the very thing you are reading about. `--surface-3`, deliberately not the
  same value as a tooltip's: a tooltip is small and transient and wants legibility above all else.

  The terrain line is drawn from one elevation sample per pixel column, then blurred by
  `profileSmoothPx` columns — about 100 m of ground, which settles GPS noise without flattening
  anything real. The underlying summary keeps every peak; only the drawing is smoothed. It is inset
  a little from both ends, because the start and the finish are the two most interesting points on
  a course and edge-to-edge put half of each off the canvas.

- **Each ping carries its climb**, in the tooltip: metres up and down since the run started, and
  over the stretch since the previous ping. Alongside them, distance and elapsed time in the same
  shape — how far and how long since the start, and since the ping before.

- **Anywhere on the course can be asked about.** Hovering the route on the map, or the terrain on
  the strip, gives a tooltip for that spot: how far in, how high, and what the climb is to there.
  The time is **interpolated between the pings either side** and labelled as an estimate, since a
  constant pace across a five-minute gap is a guess — the only one the data supports. Past the
  furthest ping the run has reached, it says "Not reached yet" rather than extrapolating a pace into
  ground nobody has covered.

### Hovering works both ways

The map and the profile are two views of one run, so pointing at a place in either marks it in the
other. Hovering the strip puts a ring on the route; hovering the route — or a ping — moves the
strip's crosshair to it. Whichever view the pointer is actually over owns the crosshair, so the two
can't fight over it, and a **pinned** point outranks both.

The drawn route is 3 px wide, which is a game of skill to hit with a mouse and hopeless with a
thumb, so what you actually point at is a **transparent band `courseHoverPx` wide** laid over it.
deck.gl's picking pass renders geometry whatever its fill alpha, so the band catches the cursor
while showing nothing. It is the only pickable one of the two; the visible line is not, because two
pickable layers over the same geometry would be two answers to one question.

The band can be generous — it is 34 px — because deck picks the **topmost** layer under the cursor
and the ping dots are drawn after it, so widening it never starts swallowing hovers meant for a fix.
Measured: the crosshair still tracks 24 px off the drawn line, and a ping under the cursor still
answers as a ping.

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

A ping marked `is_finish` skips all of that and is pinned to the **last vertex of the course**, so
the run's total distance reads the full course length. This is where the flag earns the most: the
last ping of a lap is exactly the case the cost function has the least margin on, and an explicit
finish settles it outright rather than arguing about it.

The 500 m threshold does **not** apply to a finish. For an ordinary ping, being that far off is
evidence the phone is not on the course, and leaving the fix where it is says so honestly; a finish
is not evidence but an assertion by the device, so it is pinned whatever the geometry says. The
"snapped 640 m" figure in its tooltip, and the dashed line back to the raw fix, are then what tell
you how far away it actually was.

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

Only `lat` and `lon` are required. `btry` (battery %), `msg`, `img` and `is_finish` are optional and
the map handles files that carry any, all, or none of them. Files are never edited once written.

`is_finish: true` marks the phone's **last upload of a run**. It is deliberately a normal ping rather
than a separate marker file with no coordinates: every consumer of a point assumes a fix, so a
coordinate-less record would have to be kept out of the array by hand at half a dozen call sites. A
flag on a real ping is read in the four places that care and ignored everywhere else. See
"Knowing a run is over".

`btry` does double duty: as well as appearing in the tooltip it is what tells the page **when to
expect the next ping**, since the phone picks its interval from its own battery — see
"Polling when a ping is due". A file without it still draws fine; the page just falls back to a
fixed poll rate.

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

Steady state is one cheap request per ping the phone actually sends, plus one ~70-byte fetch for
the point itself. Reloading the page costs a single `304` and zero data fetches. Polling pauses
while the tab is hidden and resumes on focus, subject to the 30 s floor described under
"Rate limit".

### Polling when a ping is due

The page does not poll on a fixed timer, because the phone does not *ping* on one. It picks its
interval from a logistic curve on its own battery — often five minutes, half an hour when it is
nearly flat:

```
interval = 5min + (30min - 5min) / (1 + e^(0.3 × (battery - 25)))
```

| battery | 100–40% | 35% | 30% | 25% | 20% | 15% | ≤10% |
|---|---|---|---|---|---|---|---|
| interval | 5 min | 6 | 9 | 17 | 25 | 28 | 29 min |

Whole minutes, **floored**, because that is what the phone's scheduler does — rounding would put
every prediction up to half a minute after the ping it is predicting. Note the last column: the
curve approaches 30 minutes without reaching it, so a flat battery pings every 29.

Every ping already carries the battery it was sent on (`btry`), so
[`src/schedule.js`](src/schedule.js) can work out when the next one is due and sleep until then
instead of guessing. **Freshness and request rate stop being the same dial**: a phone on 5-minute
cadence is read within ~30 s of committing rather than an average of two minutes later, *and* a
phone at 12% is asked about four times an hour instead of fifteen.

> ⚠️ The four constants in [`src/config.js`](src/config.js) — `minPingMs`, `maxPingMs`, `batteryK`,
> `batteryMid` — **mirror the phone's script, which is the authority.** They are duplicated here
> only because `btry` is what the ping carries. A mismatch is *silent*: the map keeps working and
> just polls at the wrong times. Retune the phone, retune these.

Two things stop this being fragile:

- **`nextPollMs` is pure** — a function of the newest point and the clock, with no counter of
  missed pings. So it cannot drift out of step with the refresh throttle, with a poll that got
  dropped, or with a tab that was asleep for an hour, and it is safe to recompute after *every*
  refresh however that refresh was triggered.
- **A missed ping is not a failure.** Tunnels, battery saver and dead zones mean expectations get
  missed routinely. A ping that is only seconds late is treated as jitter — the interval predicts
  when the phone *wakes*, and it still has to take a fix, upload it and have the commit reach the
  API — so it gets a cheap look 30 s later rather than a five-minute wait.

  Past that, the page waits **a whole interval**, because of how the phone handles a failed upload:
  it does not retry on its own, it retries *on its next poll*. So once a ping has properly missed
  its slot, nothing can appear in the repo until the phone wakes again, and every request in
  between is guaranteed to come back empty. (The estimate is a lower bound — an offline phone is
  also draining, and a flatter battery means a longer interval — which is the safe direction:
  being early costs one 304, being late costs staleness.)

  For a longer silence `overdue / 2` takes over, so a run that ended yesterday backs off instead of
  asking every five minutes forever. That carries no state either — "how overdue are we" already
  encodes how many slots have gone by — and caps at `maxPollMs` (15 min), which doubles as a floor
  poll so a *new* run starting is never invisible for longer than that.

  End to end, a phone that goes quiet costs about nine requests to establish the silence and four
  an hour after that, against fifteen an hour forever.

- **A finished run skips the ladder entirely.** If the newest ping carries `is_finish`, nothing more
  is coming and there is nothing to establish — the very next poll is already at the 15-minute cap.
  That is the nine requests above reduced to none. It stays at the cap rather than stopping, because
  a *new* run starting is the one thing left worth noticing.

A ping written before `btry` existed leaves nothing to predict from, and the page falls back to the
old fixed `pollMs`.

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

A 304 counts the same as a 200, so the poll interval *is* the request rate — which is why the page
schedules its polls off the phone's battery rather than a fixed timer. What one open tab costs:

| Situation | Fixed 240 s timer | Scheduled | Staleness |
|---|---|---|---|
| battery >45%, 5 min cadence | 15/hr | ~12/hr | 2 min → ~30 s |
| battery 25%, 17 min cadence | 15/hr | ~6.7/hr | 2 min → ~30 s |
| battery <15%, 30 min cadence | 15/hr | ~3.9/hr | 2 min → ~30 s |
| run over, tab left open | 15/hr | ~4/hr | — |

(The 15-minute cap costs one extra request per long interval; that is already in these numbers.)
So the budget stretches to roughly five simultaneous viewers behind one IP on a fresh phone and
fifteen on a dying one — which is when a long day out tends to have the most people watching.

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

Trading latency for headroom is a one-line change to `maxPollMs` in
[`src/config.js`](src/config.js), which sets both the backoff cap and how long the page will go
without looking. Going further means removing the API from the read path entirely — a GitHub Action that aggregates
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
  schedule.js       when the next ping is due, from the battery the last one reported
  stats.js          per-ping time, distance and climb, and interpolating a hovered spot
  profile.js        the height profile strip and its distance axis (canvas 2D)
  map.js            deck.gl instance, camera, follow-latest behaviour
  layers.js         layer construction + tooltip markup
  pin.js            the tooltip a click pins in place, shared by both views
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
- The phone changed how often it pings → the four battery constants in `config.js`, which mirror
  its script. If the *shape* of its rule changed, `pingIntervalMs` in `schedule.js` too.
- A different rule for when to poll → `nextPollMs` in `schedule.js`. Keep it pure: `main.js`
  recomputes it after every refresh, and that is only safe while it holds no state.
- Something else read out of the GPX → `gpx.js`, then `course.js` if it needs measuring.
- Changing how a ping picks its place on the course → the cost function in `snap.js`.
- Another figure derived per ping → `stats.js`, then a row in `tooltipHtml`.
- Something new to say about a spot on the course → `interpolateAt` in `stats.js`, then
  `hoverTooltipHtml` in `layers.js`. Both views render from those two, so neither can drift.
- Linking the two views further → `map.js` and `profile.js` each expose `setHover` and
  `setSelection`; `main.js` is where they are joined up and where the pinned point lives.
- Something else clickable → `describe()` in `map.js` (the map's side) or `readAt()` in
  `profile.js` (the strip's). Both return the same small `Selection`, so neither view needs to
  know how the other one found it.
- Another optional layer → a checkbox in `index.html`, a flag through `ui.js`'s `onLayers`, and
  `setLayers` on `map.js` and/or `profile.js`. Nothing that carries a reading should get one.

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

Interpolating a hovered spot is pinned on the distinction it exists to make: that height
and climb come back **everywhere on the course**, because they are facts about the ground,
while the time comes back only where the run has actually been. Halfway between two pings
gives half the leg's minutes; on a lap covered twice the *latest* visit wins; and past the
furthest ping the answer is a state, not a number.

The axis ladder is tested at course lengths from 500 m to 250 km — that the ticks never
pack closer than the minimum spacing, always land on 1, 2 or 5 × 10ⁿ rather than
`length / 8`, and that a zero-length course returns a single tick instead of looping
forever.

Pinning is tested through its two pure pieces. `same()` decides whether a click is a
re-click — the rule that makes clicking a pinned point put it down — and it is checked
that a rebuilt tooltip for the same place still counts as the same point, that two spots
on a lap sharing a coordinate do not, and that the same place clicked from the *other*
view is a move rather than a dismissal. `clampLeft` keeps a tooltip on screen at either
edge and when it is wider than the window at all.

The Maps link is tested for the thing that would silently break it: a label containing a
parenthesis, which is the delimiter of the URL form that carries it.

The poll schedule is entirely pure, so all of it is tested. `pingIntervalMs` is checked
against the phone's own numbers at ten points on the curve — figures derived from the
formula by hand, not from this implementation, so a drift from the phone's script shows up
as a failure rather than as quietly wrong polling. Its *shape* is asserted too, since that
shape is the reason the interval can't simply be inferred from the gaps between recent
pings: flat at both ends and more than fifty times steeper through the knee, where each
gap is minutes longer than the one before it. Then `nextPollMs` for waiting until a ping
is due, for backing off geometrically once one is late, for both clamps, for falling back
to the fixed rate when a ping predates `btry` — and for being **pure**, which is what makes
it safe for `main.js` to recompute after every refresh. One test walks the whole backoff
ladder and asserts a long silence costs fewer than fifteen requests in total rather than
fifteen every hour.

The finish is tested at each place it is read. That it survives the round trip through
`localStorage` as a real boolean, since it goes through JSON on every reload; that
`finishOf` ignores a finish with pings after it, which is what keeps the panel and the poll
schedule from ever disagreeing; that a finished run polls at the cap whatever its age or
battery, and predicts no next ping; and that its tooltip says "finish" in place of "latest".
The snapping tests state the two claims worth stating out loud — that a finish is pinned to
the course end even from **beyond** the 500 m threshold, where the identical fix without the
flag snaps nowhere at all, and that on a closed loop it resolves to the end rather than the
start, which is the ambiguity the whole cost function exists to fight.

## A note on waypoint labels

The map draws every waypoint's name. deck.gl's `CollisionFilterExtension` is the right tool
for thinning them out when a course carries thirty of them and they overlap at low zoom, and
it is deliberately **not** used: in deck.gl 9.3.7 it culls *every* label in this layer stack.
Verified against the real course on both SwiftShader and the hardware GPU, with and without
`collisionTestProps`, and with the per-frame layer rebuild frozen — the glyphs are laid out
(33 instances, sublayer visible) and simply never drawn. A label you can read beats a label
that tidily avoids its neighbours and isn't there. The height strip does its own overlap
rule in six lines, dropping any label that would run into the previous one.

## Publishing

One-time setup: **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**. The empty
`.nojekyll` file stops Pages running the repo through Jekyll.
