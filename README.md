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

Every *other* run is also marked on the map, as an outlined dot with its name on it, sitting
where that run was last seen. Clicking one opens it, which is the second way in besides the
picker. Switching happens **in place** — the URL is pushed rather than navigated to, the camera
flies from one course to the other, and nothing is torn down and rebuilt. The back button walks
back through the runs you looked at.

## On screen

Two numbers, both in the panel top left. **How long since the last ping**, on the top line, and
**how long the run has been going**, below the run name. Not how many pings there are, and not
what second the browser last checked GitHub — that second is the page's business, and the dot
already says whether polling is healthy. The run's name is set in the same type as the clock: they
are the two things worth reading at a glance, so neither is a caption for the other. Each sits under
a small caption of its own — `COURSE` and `ELAPSED` — in the same 11 px uppercase.

**The run name is also the run picker.** There used to be a name and, stacked underneath it, a
dropdown listing that same name; now there is one control. At rest it is typeset exactly as the
heading was, and it grows a border and a chevron only when pointed at, so it stops looking like a
widget until you go looking for one. With a single run it is inert and visually identical — hiding
it, as the old separate picker did, would now take the run's name off the screen with it. Inside
the open list a `●` marks the runs that are still live; the one already on screen never gets one,
because its own liveness is the pulsing dot one line above.

The heading is sized by an invisible span rather than by the control itself. A `<select>` is laid
out from the browser's own metrics, not from the width of its option text, so at 20 px it comes out
a few pixels too narrow and quietly clips the end of a longer name; the span carries the same string
at the same type and the control is stretched over it. The two box models have to match exactly,
borders included, or the ruler is short by precisely the border. The one cap on how wide a name may
make the panel lives on that span, in viewport units — a percentage there would resolve against the
width it is itself deciding, and clip by the heading's own negative margin.

While a run is live the top line also says **when the next ping is due**:

```
● Last ping 1m ago · next ~16m
● Last ping 34m ago · overdue
```

The phone slows down as it drains — five minutes on a full charge, half an hour on a dying one — so
without this a long silence is indistinguishable from a broken tracker. With it, the same silence
reads as a system working exactly as designed, and says how long to wait. A finished run drops the
clause entirely; an expectation is a claim about a phone that is still out there.

The battery itself is not shown here. It is what *decides* that number rather than something to act
on, and "next ~16m" is already the useful half of the answer; the figure is still in each ping's own
tooltip for anyone who wants it.

Once the phone says it is done, the line says that instead:

```
● Finished 12m ago
```

The clock counts from the first ping and ticks each second while the run is live. It **stops** when
the run finishes — either because the phone said so, or because nothing has arrived for an hour —
and its label changes from "Elapsed" to "Total". A clock still counting hours after the finish would
be claiming the race is still on.

Under it, once the run has enough legs to fit one, sits the **predicted finish** and its range:

```
FINISH
~13:24
13:16 – 13:33
```

The same question as the clock, asked forwards. It is set a size down and in the secondary ink
because the two sit one above the other and only one of them is a measurement — the hierarchy has to
say which — and the range underneath is not decoration, it is the part that stops a single number
being read as a promise. It shows only while the run is live, and never at all for a run that has
finished: a forecast is a claim about a phone that is still out there. See "Predicting the rest".

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
reading, not a decoration.

The two defaults are deliberately opposite ways round. Waypoints are part of the course and belong
on it, so they are **on** unless switched off. The raw fixes are an audit of the *snapping* — the
thing to look at when a dot seems wrong, and clutter the rest of the time — so they are **off**
unless asked for. Either choice is remembered across visits.

A checkbox for something the current run hasn't got stays hidden, and the whole block disappears
when neither applies. The points-of-interest switch appears only when the GPX actually carries
`<wpt>` elements, which costs nothing to know: the waypoints are already parsed out of the course
file, so it is a length check on an array that is in hand either way.

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

### Drag a pinned point along the course

A pinned point can be **picked up and slid along the route**, in either view — grab it on the map
or on the height strip and the reading updates continuously: distance in, elevation, time — estimated
behind the runner and forecast ahead of them — and climb so far. Both views stay in step throughout, so dragging on the strip walks the marker around
the map and vice versa.

The marker follows the **course**, not the cursor. The pointer is turned into a coordinate and the
course answers with a distance along itself; drag away from the route and the last good distance
stands, so the point stays on the route rather than being flung into a field. Only a point that has
a place on the course can be dragged — a ping the snapper left alone has a position on the map and
none on a chart of distance, so there is no line to slide it down.

On the map this means taking the gesture away from the camera. deck's controller reads press-and-move
as a pan and cannot be asked politely for one drag back, so the press is stopped in the capture phase
and the controller is switched off outright for the duration. That has a consequence worth knowing:
deck never recognises a tap either, so **no click is coming** — not at the end of a drag, and not for
a press that never moved. Both outcomes are produced when the drag ends, and a press that went
nowhere is handed back to the ordinary selection rule so that it still puts the point down.

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
  round numbers — 500 m, 2 km, whatever is coarse enough to leave the labels legible.

  **A kilometre is never drawn narrower than `profilePxPerKm` (24 px).** The x-axis used to be
  simply the window, which quietly made distance mean something different for every course: 150 km
  and 2 km got the same pixels, so on the long one a climb worth twenty minutes of somebody's day
  arrived as three pixels of noise. Now the scale is fixed and the strip scrolls when it runs past
  the window — a 150 km run is 3600 px wide on any screen. `profileMinWidth` (640 px) is still the
  floor for anything short, since a 3 km course drawn 72 px wide would be obeying the rule and
  showing nothing. There is no scrollbar, because on the platforms that lay one out it eats into a
  112 px strip and on the ones that overlay it it sits on top of the distance labels. Instead the
  strip **fades at whichever end has more course**, which says both that there is more and which way.

  It is frosted rather than solid, so the course carries on underneath the chart of it — a solid
  band across the bottom of the map hides the very thing you are reading about. It shares
  `--surface-2` and the panel blur with the status box: they are two windows onto the same map, and
  reading as two different materials made the page look assembled rather than designed.

  The terrain line is drawn from one elevation sample per pixel column, then blurred by
  `profileSmoothPx` columns — about 100 m of ground, which settles GPS noise without flattening
  anything real. The underlying summary keeps every peak; only the drawing is smoothed. It is inset
  a little from both ends, because the start and the finish are the two most interesting points on
  a course and edge-to-edge put half of each off the canvas.

  Ground already covered is filled solidly and ground still to come faintly, so the strip says at a
  glance how much race is left. The split is at the newest ping, which is also where the forecast is
  anchored, so the faint half is exactly the half the ETAs are talking about.

  Sitting just above the axis in that faint half is one more mark: **where the runner probably is
  right now**, as a dot with a bar for the 80% range around it. It is the forecast read the way
  round a distance axis can answer — the tooltips ask "when will he be *here*", and this asks "where
  is he *now*" — and it creeps forward with the clock rather than waiting for a ping. It is down by
  the axis, away from the ping dots and the waypoint labels, because everything else on the strip
  happened and this has not. Once the prediction runs off the end of the course it disappears: a
  phone that stopped reporting three days ago is not "probably at the finish line".

- **Each ping carries its climb**, in the tooltip: metres up and down since the run started, and
  over the stretch since the previous ping. Alongside them, distance and elapsed time in the same
  shape — how far and how long since the start, and since the ping before. Later pings also carry
  **how the forecast did** — `Predicted 12:36 · 47s late` — scored against a model that had never
  seen that ping or any after it. See "Predicting the rest".

- **Anywhere on the course can be asked about.** Hovering the route on the map, or the terrain on
  the strip, gives a tooltip for that spot: how far in, how high, and what the climb is to there.
  Behind the runner the time is **interpolated between the pings either side** and labelled as an
  estimate, since a constant pace across a five-minute gap is a guess — the only one the data
  supports. Ahead of them it is **forecast**, with a window:

  ```
  15.0 km in
  81 m
  12:55 · 1h 18m in
  Likely 12:51 – 13:00
  ```

  Two rows, because they answer two different questions: when, as a single number you can hold in
  your head, and how much that number is worth. A run too young to fit a model still says "Not
  reached yet" rather than drawing a pace through two dots.

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

## Predicting the rest

Past the last ping the map used to say "Not reached yet" and stop. It now forecasts: hover any part
of the course still ahead of the runner and the tooltip gives a time and a window for it.

The model lives in [`src/predict.js`](src/predict.js) and is fitted from **one run's own pings and
nothing else**. Nothing is shared between runs, cached across them, or seeded from them — a course is
run differently by different people on different days, and borrowing yesterday's pace is how a
forecast becomes confident and wrong.

### The model

Each pair of consecutive snapped pings is a **leg**, and leg duration is regressed on distance,
ascent and descent, with no intercept:

```
dt  =  flat · distance  +  up · ascent  +  down · descent          seconds, metres
```

Three coefficients, each in seconds per metre and each directly readable: `flat` is flat pace, `up`
is what a metre of climbing costs on top of it, `down` what a metre of descent does. It is the
classic Naismith shape, and the smallest model that can tell a climb from a drop — which is the
point of fitting anything at all rather than dividing distance by time. Ascent and descent come from
the same threshold-filtered `gainAt` the tooltips already show, so a leg's climb means the same thing
here as it does two rows further down the same tooltip.

Regressing **time** rather than pace is what makes it robust. With no intercept, a leg where the
runner did not move — an aid station, a phone on a table, a ping that snapped backwards — is an
all-zero row in the design matrix. It contributes exactly nothing to the coefficients and exactly its
own residual to the scatter, so a stop widens the uncertainty and cannot drag the pace anywhere.
There is no "ignore short legs" threshold because none is needed.

**Recency** is measured in *metres of course covered*, not minutes elapsed: `predictHalfLifeM`
(15 km) is a half-life on distance. What makes the last hour of a race unlike the first is fatigue
and terrain, and both track distance; a phone that drops to half-hourly pings as its battery fades
would otherwise silently halve how much history the model looks at, exactly when it can least afford
to. On a 20 km run this is nearly an even weighting — there isn't enough of it for recency to mean
much — while on a 160 km ultra the last ~45 km carry most of the fit.

**Shrinkage** pulls the fit towards the run's own overall pace, worth `predictPriorLegs` (4)
pseudo-legs, so the prior argues about as loudly as four observed legs and fades to nothing as a long
run accumulates data. It is what stops one slow patch running away with the forecast, and it is much
stronger than `4/(4+n)` along whatever direction the data happens not to pin down — on a course with
no descent, the descent coefficient is pinned by nothing and comes back as its prior, which is the
honest answer rather than a singular matrix.

### The window

The band is the **80% central interval** (`predictBandZ`), and it comes from two genuinely different
sources, added:

- **parameter uncertainty** — "I don't know your true pace". Taken from the weighted fit's own
  covariance, and it grows with the *square* of the distance ahead, because a pace error compounds
  all the way.
- **leg noise** — "even knowing your pace, you'll wobble". One leg's worth of residual scatter per
  remaining leg, so it grows linearly and its contribution to the width grows as the square root.

The residual scatter is floored twice over (`predictMinSigmaMs`, `predictSigmaFloorFrac`): three
legs can be fitted almost perfectly by three coefficients, and a band claiming ten seconds of
certainty an hour out would be the most misleading thing on the screen.

### Judging it

Every ping late enough in the run carries a **`Predicted 12:36 · 47s late`** row. That figure comes
from a walk-forward backtest, and strictly so: the forecast for ping *i* is fitted on pings `0..i-1`
and anchored at ping `i-1`, so nothing from ping *i* or after it reaches the fit. It is a test of the
prediction rather than a look at its own residuals, and it is the regime the model was actually in
when that ping landed. One leg ahead is a modest test, and that is the point — it is the only
forecast the data supported at the time.

Measured on the sample runs, where `test_3` is a 13-ping prefix of `test_2` and so has ground truth
for everything it cannot see: mean absolute error **1.6 min** over the nine unseen pings, all nine
inside the 80% band, and a finish predicted at 13:24 (13:16–13:33) against an actual 13:22.

### Known limitation

`flat` is **moving** pace. Time spent standing still widens the band, because it is real scatter, but
it does not push the estimate later — so on a race with long aid-station stops the forecast will run
optimistic. The per-ping scores are where that shows up: consistently "late" errors are this, and the
fix would be a stoppage term rather than a tweak to any constant in `config.js`.

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
3. **Diff against `localStorage`**, which caches each point keyed by filename + blob SHA. A file
   whose SHA hasn't moved is never refetched.
4. **Fetch only the new files** from `raw.githubusercontent.com`, which is not subject to the
   API's 60 requests/hour limit. **The SHA goes on the URL as a query string**, which the CDN
   ignores — that makes each URL content-addressed, so `cache: 'force-cache'` is both safe and free:
   one SHA is one immutable body, valid forever, never revalidated.

   That last part is not decoration. Pings are append-only, so for most of this project's life no
   file ever changed after it was written, and a path and its contents were the same thing. Adding
   `is_finish` to the last ping of an already-finished run is the first edit there has been, and it
   broke that assumption: the SHA moved but the address didn't, `force-cache` returned the pre-edit
   bytes, and the record was then stored with the *new* SHA against the *old* body — so it looked
   current and would never correct itself. The run you had open most recently was the one that
   stayed wrong, because it was the one still in the browser's HTTP cache. Content-addressing the
   URL fixes it; the `v7` cache bump discards the records the old scheme had already poisoned.

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

### Marking the other runs

The dots showing where every other run was last seen are the same trick applied again, and they add
**no API requests whatsoever**. The tree response already names each run's newest ping and carries
its blob SHA, so the only thing missing is two numbers out of a ~200-byte body — and that body is
content-addressed and `force-cache`d like any other, so one SHA is fetched at most once per browser
ever. The positions are persisted in one small `lt.beacons.*` entry, which means:

- a reload draws every dot before making a single network call, and fetches nothing;
- a poll that found no new ping for a run costs nothing for that run;
- a run that has **finished** keeps the same newest SHA forever, so it is free on every poll after
  the first sighting;
- a run you have already *opened* is free even on the first sighting, because its newest point is
  already in that run's own point cache.

Steady state is therefore one ~200-byte fetch per *live* other run per ping it sends — usually zero
or one. A cold first load fetches one per run, pooled at `CONFIG.concurrency` and capped at
`CONFIG.beaconLimit` (40, newest first) so a repo that grows to hundreds of runs doesn't fan out to
all of them. That cap is about the cold fan-out, not the budget; there is no budget to spend here.

Only the raw fix is used, deliberately: snapping a ping to its course would mean downloading that
course, and the whole point is to mark a run without opening it. At the zoom these are read at, the
few metres a snap would move a dot are invisible.

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
  predict.js        the run's own pace model: ETAs for ground ahead, and how it scored on ground behind
  profile.js        the height profile strip and its distance axis (canvas 2D)
  map.js            deck.gl globe view, camera, follow-latest behaviour
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
- Changing how the forecast is fitted → `fitPace` in `predict.js`, or the `predict*` constants in
  `config.js`. Keep it pure: `main.js` refits it on every paint, and that is only cheap and correct
  while it holds no state of its own.
- Something else predicted about ground ahead → `predictAt` in `predict.js`, then the `at.predicted`
  branch of `hoverTooltipHtml`. Anything that needs it as a POSITION rather than a time — the
  strip's "probably here, now" marker is the one so far — goes through `positionAt`, which is the
  same model inverted, so the two can never disagree.
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
rather than its neighbour — a mistake that looks fine in a screenshot. How wide the
strip asks to be is pinned down at both ends of its rule: a long course gets its fixed
pixels per kilometre, a short one keeps the minimum width instead, the two agree exactly
at the crossover, and a missing or zero-length course still asks for the minimum rather
than collapsing the canvas to nothing.

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
furthest ping the answer is a forecast with a band, or a state rather than a number when the
run is too young to have one.

The forecast is tested on properties rather than on numbers wherever it can be. A constant
pace on a flat course recovers its coefficient exactly and predicts arrival exactly; a run
that slowed recently is forecast slower than its own average, and shortening the half-life
moves it further that way, monotonically. The band always straddles its own estimate and
always widens with distance, and `positionAt` round-trips through `predictAt` to within a
metre — the two are the same model read in opposite directions, so nothing else would catch
them drifting apart.

Two cases carry the design. A leg where the runner did not move must leave every coefficient
**bit-identical** and yet strictly widen the band: that is the whole reason the regression is
on time with no intercept, and it is the assertion that would fail if anyone gave it one.
And every degenerate input has to come back `null` rather than `NaN` — no course, one leg, a
stationary phone, pings that never snapped, a course with no descent to pin its coefficient
down, a run that has already finished.

Against real data the check is stronger than any fixture: `locations/test_3` is a strict
13-ping prefix of `locations/test_2`, so the longer run is ground truth for everything the
shorter one cannot see. That comparison is not in the suite — it is a measurement, not an
invariant, and freezing today's numbers into an assertion would be testing the sample data
rather than the model. The figures it gives today are in "Predicting the rest".

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

Dragging a pinned point is deliberately **not** unit-tested. It is pointer plumbing over
functions that are already covered — the same `readAt`, `interpolateAt` and `courseHoverAt`
the hover and click paths use — and everything that could actually break is a property of
a real browser: whether the camera stays still under the gesture, whether it pans again
afterwards, whether the press that goes nowhere still puts the point down. Faking
`PointerEvent`s would test the fake. It is verified in headless Chrome instead, and that
run is what caught the two defects worth catching: a still press swallowing its own
dismissal, and a leftover "just dragged" flag eating the *next* genuine click.

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

## A note on the globe

The view is deck.gl's `GlobeView`, not a flat `MapView`, because the zoomed-out state now has
something in it: the other runs are dots scattered over a planet rather than over a Mercator sheet
stretched to nothing at the poles. Three things about it are worth writing down, all of them
verified against the 9.3.7 bundle rather than assumed:

- **It is exported as `deck._GlobeView`**, underscore-prefixed — still flagged experimental in
  9.3.7. Same for `_GlobeController` and `_GlobeViewport`.
- **`GlobeView.getViewportType()` hands back a plain `WebMercatorViewport` above zoom 12** and a
  `GlobeViewport` below it. So at every zoom where a course is on screen the projection is exactly
  what it always was, and the sphere only appears in the overview. Zoom is continuous across that
  switch, since the globe viewport applies its own `log2(π·cos(lat))` offset internally — nothing in
  `fitView` has to convert between the two conventions. `fitView` keeps using
  `WebMercatorViewport.fitBounds` as pure arithmetic, which is both necessary (`GlobeViewport` has
  no `fitBounds`) and correct (a course-sized box always fits above zoom 12).
- **`Deck._getViews()` copies the top-level `controller` prop onto the first view, and skips the
  copy when it is falsy.** With one long-lived view instance that mutation *persists*, so
  `setProps({ controller: false })` would set the flag once and never be able to clear it — silently
  killing the drag-a-pinned-point gesture, which works by taking the camera away for the duration.
  So the controller is declared *on* the view and switching it means handing over a fresh instance;
  `map.js` has a `globeView(controller)` factory for exactly that, and nothing passes a top-level
  `controller` prop at all.

Two smaller consequences. The basemap's custom `renderSubLayers` has to set
`_imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT` on its `BitmapLayer` — deck's own default does
this and ours replaces it, and without it every raster tile is interpolated on the Mercator plane
and shears visibly on a sphere. And `map.js` asks deck for the live viewport
(`deckgl.getViewports()[0]`) instead of rebuilding one from the view state, because below zoom 12 a
hand-made `WebMercatorViewport` would answer for a different planet and put pinned tooltips and the
drag gesture in the wrong place.

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
