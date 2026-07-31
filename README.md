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
  UTMB/                 a course and no pings yet — an upcoming run
```

| URL | Shows |
|---|---|
| `/` | whichever run **pinged** most recently, and it keeps following — a new race takes over the plain link as soon as it starts |
| `/?run=test` | `locations/test/`, pinned; never overridden |
| `/?run=locations/test` | the same thing, so you can paste a path straight from GitHub |

**Adding a run is just making a folder** — no config, no code. The picker lists
whatever subfolders exist, newest first, and hides itself when there's only one.
A run that has pinged within the last hour is marked live, with a `●` in the picker
and a pulsing dot beside the title.

The folder name is the run's **identity**: the `?run=` key, the cache namespace, the
label on its dot when you're looking at another race. It is also its *name* on screen
unless the run says otherwise — drop a [`course_settings.json`](#course_settingsjson)
in and it can be called "Ultra Trail de Mont Blanc" while staying `UTMB` in the URL.

A folder holding only a `.gpx`, or only a `course_settings.json`, is a run too — an
upcoming one. It sorts by its
scheduled start rather than by a last ping it hasn't got, so it sits at the *top*
of the picker where it can be found; see "The course". Being top of the picker is
not being the landing view, though: the plain `/` link follows the run that pinged
last, because opening on a race that hasn't started means opening on an empty map,
possibly while a real one is underway two options down the list. An upcoming run
only becomes the default when no run in the repo has ever pinged.

An upcoming race is also **never marked live**, and that had to be made explicit
rather than left to the arithmetic. A start time is a time in the *future*, so it
is larger than every real ping; "has it pinged within the last hour" asked of a
race three weeks out comes back as *yes* if you let a start time anywhere near it.
Liveness is a claim about a phone being out there, and only a ping is evidence of
one.

A file sitting loose in `locations/` belongs to no run and is never shown. An unknown
or malformed `run` falls back to the newest run rather than erroring.

Each run keeps its own point cache, and **switching runs costs no API requests at all**
— see below.

Every *other* run is also marked on the map, as an outlined dot with its name on it, sitting
where that run was last seen. Clicking one opens it, which is the second way in besides the
picker. Switching happens **in place** — the URL is pushed rather than navigated to, the camera
flies from one course to the other, and nothing is torn down and rebuilt. The back button walks
back through the runs you looked at.

That flight is sized from the distance (`transitionDuration: 'auto'`) rather than given a fixed
length, because two races can be on different continents and 900 ms across 1,000 km is a teleport
with extra steps. `FlyToInterpolator` pulls the camera up over a long move and back down at the far
end, which is what makes a switch read as a journey between two places instead of a cut to somewhere
unrelated. Short moves — following the runner to the next ping, centring a point clicked on the
height strip — keep the fixed 900 ms; they are already on screen, and the flight is only there to
say the view moved rather than jumped.

**The flight leaves immediately**, before anything has been fetched. The dot drawn for that run is a
position the page has had all along, so the camera sets off towards it at once and the real fit —
the pings, then the whole course — retargets the arc as each arrives. Waiting for the data to land
before starting to move is what made a switch still feel like the page load it replaced. For the
same reason the panel says `Loading…` rather than `No locations yet` while it waits: the latter is a
claim about the *run*, and nothing has been asked yet.

Two traps worth recording, because in both cases the symptom is nothing like the cause:

- **Handing deck a view state mid-flight ends the transition where it stands** — even the
  interpolated one deck itself just reported. So `render()` updates layers alone while a flight is
  running, and only `setViewState` may push a camera. Without that, a switch flew out and then froze
  the instant the new points, the forecast and the other runs' dots arrived — three redraws within a
  few milliseconds — leaving the camera roughly over the new course and never zooming in.
- **Replacing one flight with another has deck report the interruption *while* it is being handed the
  replacement**, from inside that very `setProps`. So the `onTransitionInterrupt` handler cannot
  simply settle: it would strip the transition props off the flight that is only just starting and
  clear the in-flight flag, and the next redraw would then end it on the spot. Each move carries a
  token and only the current one's callbacks act. This is exactly the path a switch takes, twice
  over, as it retargets from the dot to the pings to the course.

## On screen

Two numbers, both in the panel top left. **How long since the last ping**, on the top line, and
**how long the run has been going**, below the run name. Not how many pings there are, and not
what second the browser last checked GitHub — that second is the page's business, and the dot
already says whether polling is healthy.

The panel says three things and says them all the same way: a small 11 px uppercase caption —
`COURSE`, `ELAPSED`, `FINISH` — with its value under it in 20 px, all six lines starting on one pixel
column and every block the same distance from the one above. They had drifted into three sizes, two
inks and two indents, which made a panel of equal facts look like a hierarchy nobody had meant. The
run name takes two corrections to join in: it is a `<select>` stretched over a sizer, and the border
and padding that control needs are subtracted back out of the heading's own margins, or the name
would sit two pixels low and one pixel right of the clock underneath it. The heading is also `display:
block` rather than `inline-block` for the same reason — an inline-block rides a text baseline and
drags the line box's descender space along under it, which put four extra pixels between the name and
`ELAPSED`.

**The run name is also the run picker.** There used to be a name and, stacked underneath it, a
dropdown listing that same name; now there is one control. At rest it is typeset exactly as the
heading was, and it grows a border and a chevron only when pointed at, so it stops looking like a
widget until you go looking for one. With a single run it is inert and visually identical — hiding
it, as the old separate picker did, would now take the run's name off the screen with it. Inside
the open list a `●` marks the runs that are still live; the one already on screen never gets one,
because its own liveness is the pulsing dot one line above.

**The name shown is the run's `label` if it has one**, from its
[`course_settings.json`](#course_settingsjson) — in the heading, in every option of the picker, and
in the tab title. The folder name stays the identity underneath: it is the option's `value`, the
`?run=` key and the cache namespace, so a race can be `UTMB` in the URL and "Ultra Trail de Mont
Blanc" on screen. A run with no label is called by its folder, as everything was before.

**Under the name, what the course *is*:** `165.0 km · 9,900 m climb`, small and quiet, in the same
type as the finish's range. The stated figures from the settings file win here — an official distance
is what the entrants signed up for, whatever a hand-traced GPX adds up to — and the measured course
is the fallback, so a run that states nothing still gets a line. Nothing known, no line.

**It hands focus back after a mouse pick.** A `<select>` keeps focus once it has been used, and on
this page that cost two things: the browser drew its own focus ring around what is also the page's
heading, and the next press on the map went on moving focus off the control instead of starting a pan
— so the first drag after switching runs simply did not happen. It blurs itself on `change`, but only
when a pointer is what reached into it: some browsers fire `change` for every step of arrowing through
the options, and blurring there would take the control out from under a keyboard user mid-choice, who
is the one person the focus ring is for.

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

The clock ticks each second while the run is live. It **stops** when the run is over, and its label
changes from "Elapsed" to "Total". A clock still counting hours after the finish would be claiming the
race is still on.

Deciding *when* it is over is the interesting part, and an hour of silence is not the answer. That was
the rule, and a mountain section with no network beat it outright: the clock froze mid-race, relabelled
itself "Total", and the panel announced a finish two ridges early. So a quiet phone gets a second
question asked about it — could the runner still plausibly be on the course? The forecast already
answers that, because it is the same condition that keeps the orange marker on the map, and the clock
now stops exactly when the marker does: when the predicted position crosses the finish line.

The order of authority is: a ping marked `is_finish` ends the run outright, whatever anything else
thinks; otherwise a ping within the hour, or a prediction that has not yet reached the line, keeps it
running. That bounds the failure honestly rather than removing it — a phone that dies at 20 km of 160
keeps the clock going for as long as the last measured pace says the rest would take, and then every
reading reverts at once. A run with no course has no forecast and so keeps the plain one-hour rule,
which is the honest answer there: with no route there is no finish line to predict crossing.

What it counts *from* has two answers, in order of authority. If the run's settings named a
`start_datetime`, that is the gun, and it wins: a ping written on the drive to the start line is not
the beginning of the race. Otherwise it is the first ping, which is what this box counted from before
a run could schedule itself, and still the only answer available for a run that says nothing.

Before the gun the same box counts down instead:

```
STARTS IN
28d 17h
```

It needs no pings at all to say that, which is what lets a course-only folder be worth opening.
Inside the last day it switches to the same `h:mm:ss` the race clock uses, so the digits don't jump
when it flips over; above a day it reads in days and hours, because `700:18:42` is a number nobody
reads as a date, and seconds on a four-week countdown are precision nobody asked for.

At the gun it flips to `ELAPSED 0:00:00` and starts running — before any ping has arrived. That is a
claim from the timetable rather than from the phone, and it is the honest one to make in the gap
between the start and the first fix, when the alternative is an empty panel. The ticker beside it
says which silence you're looking at: `Not started yet` before the gun, `No locations yet` after it.

Under it, once the run has enough legs to fit one, sits the **predicted finish** and its range:

```
ESTIMATED FINISH
13:24
13:16 – 13:33
```

The caption carries the hedge, which is why the number does not. It used to read `FINISH` over a
`~13:24`, and a tilde is a hedge fighting tabular figures for room in the one place on the panel where
the digits have to stay aligned; the word says it better and costs nothing, because the box only ever
appears while the run is live and so every time in it is a guess.

On a race longer than a day all three times pick up a raised `⁺¹`; see "Times are 24-hour". It is the
same rule the tooltips use, in ems, so it raises correctly over a 20 px value and an 11 px range
alike. The same question as
the clock, asked forwards, and typeset identically to it — the range underneath
is what says which of the two is a guess, and it is not decoration: it is the part that stops a single
number being read as a promise. It shows only while the run is live, and never at all for a run that has
finished: a forecast is a claim about a phone that is still out there. See "Predicting the rest".

### The news bar

`news_banner` in a run's [`course_settings.json`](#course_settingsjson) puts one line across the
bottom of the window, directly above the height strip:

> Official Race Odometer [here](https://some.url)

It is the only thing on screen that says something a **person wrote** rather than something a phone
measured, which is why it looks different from everything else: full width, no caption, and out of
the panel where all the readings live. There is nothing there at all when a run has nothing to say —
same as the height strip on a run with no course.

**Exactly one line, always.** A bar that can wrap is a bar that reflows the map every time you edit a
sentence, and the map is what people came for. A message too long for the width scrolls right to
left instead, at a constant speed derived from its own length — scrolling every message in a fixed
number of seconds would blur a long one and make a short one crawl. It loops seamlessly, which is the
only reason there are two copies of the text in the markup: the track slides by exactly half its own
width, and half of a two-copy track is one copy, so the join lands pixel-perfect with nothing
measured. A message that fits is simply centred and stays still.

Under `prefers-reduced-motion` nothing moves at all — and a long message becomes **scrollable by
hand**, with the same edge fades the height strip uses to say there is more. Merely stopping the
animation would leave the message truncated with no way to reach the rest of it, which is the one
outcome worse than either.

`**bold**`, `*italic*`, `` `code` `` and `[text](https://…)` render; everything else is text. See
[`course_settings.json`](#course_settingsjson) for what that subset refuses and why.

### Knowing a run is over

Without being told, the page can only guess — from the clock and from the forecast, as above. Neither
can tell a finished race from a phone in a tunnel, and the guess is an hour late at best and a whole
predicted race late at worst.

So the phone marks its last upload. It is an **ordinary ping** — coordinates, battery and all — with
one extra field, `"is_finish": true`. Three things change the moment it lands:

- the dot stops pulsing, the clock freezes to "Total", and the ticker reads `Finished 12m ago`;
- polling drops straight to one request every 15 minutes, skipping the whole overdue ladder;
- if the run has a course, the finish is pinned to the **end** of it — see "The course" below.

Only the newest ping counts. A finish with pings after it is a phone that was restarted, and the run
is plainly going again, so the page treats it as live once more. That rule is why the panel and the
poll schedule can never disagree: both read the same last point.

It also means a `is_finish` sent *before* a scheduled start — a phone test-fired the day before —
freezes the clock to "Total" for a race that hasn't happened. Self-inflicted, and self-correcting the
moment a real ping lands after it, so it is left alone rather than guarded against.

One limit worth knowing: a finished run that is *not* the one on screen keeps its `●` in the run
picker for the usual hour. The index comes from GitHub's tree API, which lists paths and never file
contents, so a run has to be opened before its finish is visible.

**One dot, two signals.** Its colour is the last poll's outcome — green for fine, red for failed,
with the reason spelled out underneath — and it pulses while the run is live, by the same test the
clock uses: a ping within the hour, or a prediction still short of the finish line. There used to be a second dot for that; two of them side by side just read as
decoration.

That ticker is also the main control. **Click it to fly back to the newest fix**; panning the map
turns following off, and the ticker dims to say so. There is no separate Follow button because
"where is the runner" and "take me there" were never two questions.

**There are no layer switches.** There were three — points of interest, raw points, your own
location — and each of them turned out to have the same answer every time it was asked, which makes a
control furniture rather than a choice. All three are simply on now, and the panel is three lines
shorter.

The **points of interest** are drawn wherever the GPX carries them, on the map and on the height strip
both. The **raw points** — the audit trail showing where each fix really was before it snapped, joined
to it by a dashed line — are always drawn too, and instead pushed down the stack by alpha alone: faint
enough to read as a smudge behind the reading, there the moment you go looking for it. That is a
straight improvement on a switch that was off by default, which meant almost nobody ever saw what the
snapper had done. **Your own location** is asked for as the page opens; see "Where *you* are".

### Sunrise and sunset, where they happened

Every ping carries a position and a moment, so the page can say where the runner was standing when the
sun came up — and on a race that runs through the night that is a fact nothing else on the screen
gives. Each crossing is marked on the course, on the map and on the height strip both:

```
        🌅 06:42                 🌃 21:07
   ─────●──────────────────────────●─────
```

The glyph, the local time, and a dot you can hover for the rest: the race clock at that moment, how
far in it was, and how high. On La Diagonale des Fous — 45 hours, two nights — that is four marks, at
50, 90, 120 and 165 km.

**🌃 rather than 🌇 for sunset.** The obvious pair is 🌅 and 🌇 and it is unusable: both are a sun on a
horizon, and at the 19 px these are drawn at the two marks a night puts on a course are the same
picture. A starry skyline is unmistakable beside a sunrise, and it says the thing the runner cares
about anyway — the head torch goes on.

**The position is interpolated between the two pings either side**, along the course where both of them
snapped to it, so a mark sits on the route round the bends rather than on a chord across them. Where
the phone had been quiet a while the tooltip says so — `interpolated across 1h 40m` — because a
position pulled out of a blackout is an estimate, and it is worth one clause to admit it.

**Only crossings inside the measured span are marked**, between the first ping and the last. Tonight's
sunset on a live run is deliberately not projected onto the forecast: it would move every time the
model refits, and it would be drawn in the same idiom as the marks either side of it that are
measurements.

The times are computed here rather than fetched — the standard sunrise equation is fifty lines of trig
in `sun.js`, against a page that has no build step and would otherwise be adding a script tag and a
third-party origin for arithmetic that has not changed since 1991. **The course's own elevation goes
into it**, which is the part worth knowing about: standing 2,500 m up puts the horizon 1.7° below level
and brings sunrise the better part of ten minutes forward, so these marks do not agree with an almanac
written for the valley, and should not. It assumes the horizon is actually visible, which in a valley
it is not — much closer than pretending the runner is at the beach, and the error is minutes.

The same arithmetic decides the **weather glyph** on every ping tooltip, which is why a clear ping at
02:00 draws the moon that was up rather than a midday sun — see [what a tooltip
says](#what-a-tooltip-says) below. That is one crossing serving both, on purpose: a mark saying the sun had set and a tooltip four
pixels away drawing a sun would be the page contradicting itself about the same minute.

Two things fell out of building it. The glyph on the map is an `IconLayer` over a canvas the page
rasterises itself, because deck.gl cannot draw a colour emoji as *text*: with `sdf` on and off alike a
`TextLayer` renders 🌅 as a solid filled square while the digits beside it come out perfectly — its font
atlas keeps each glyph's coverage and throws its colour away, which is right for lettering and fatal
for an emoji. So each half of the label goes through the pipeline that can render it: the glyph as an
icon, the time as text with the same halo the waypoint labels use. And the mark is drawn *above* the
pings, which is against this stack's usual order and was also measured: deck picks the topmost pickable
layer, every fix carries a 16 px invisible hit disc, and a mark interpolated between two pings five
minutes apart sat inside one at every usable zoom — so underneath, hovering a sunrise returned the
neighbouring ping's tooltip. The cost is the reverse: where a mark lands on a fix, the mark's 5 px owns
the middle of that fix's 16 px, and the ping is still there six pixels away.

### What a tooltip says

A ping tooltip is a **status bar, the weather, the run's figures, and then whatever a person wrote**,
in that order:

```
01:48:00⁺¹ · latest              ▭ 24%  ▂▄▆_
──────────────────────────
        ⛅ 11°C  Partly Cloudy
──────────────────────────
🕒  16h 48m    +42m
📏  23.9 km    +1.1 km
🏃  6:12 min/km   9.7 km/h
📈  1,400 m    +141 m
📉  195 m      +54 m
❤️  141 bpm
──────────────────────────
Over the Col du Bonhomme, legs are going
──────────────────────────
Open in Google Maps
```

Every band is closed by a rule, including the two that used to run straight on into what followed:
the status bar, which is a statement about a handset rather than about a runner, and the Maps link,
which was reading as part of whatever row happened to be above it.

**The top line is a phone's status bar.** The time on the left, the battery and the signal on the
right — which is exactly what those three readings are, so a reader who has held a phone already
knows how to read it. It also gets two readings off the list below without losing them.

Those two icons are **drawn, not lettered**, and they are the only SVG on a card otherwise made of
emoji. The reason is that they carry their readings *in their shape*: `🔋` is the same glyph at 4% as
at 100%, so it could only ever label a number, while a cell drawn one fifth full has already said it,
and `📶` is four bars whatever the signal is. Twelve lines of SVG buys a status bar that means what a
status bar means. Both inherit the line's ink through `currentColor`, so neither needs a rule in
either colour scheme, and neither goes red when low — this page spends its one accent colour on the
run itself. The battery keeps its percentage as text beside the cell, because on a tracker that is not
decoration: a phone at 6% is a run about to stop reporting, and "about a fifth" is not that warning.
The signal has no text at all; `3/4` lives in the icon's label, where a screen reader and a resting
pointer both find it.

**The weather is its own line**, between the status bar and the run, centred and in a different voice
— larger glyph, italic label, no tabular figures — because it is the only reading on the card that
nothing about the run produced, and the centring is most of what says so: every reading under it
starts on one column, and this one deliberately does not. It is closed by a rule like everything
else — it was leaning against figures it is only the *setting* for — but sits tighter than the other
bands, top and bottom. One centred line needs less room to read as its own thing than a block of
rows does, and at the same 6 px either side it was taking up the height of three readings. It is also the setting rather than the story, and it belongs above the
figures it explains: 4°C and rain is the first thing that accounts for a pace. There is no
thermometer beside the temperature any more. The sky and the air are one reading from one sensor, and
giving each an icon made two readings out of it, so the sky's own glyph does duty for both. The label
stays next to the glyph rather than being replaced by it — a glyph is a category, and "Rain and
thunder" and "Isolated Thunderstorms" draw the same cloud.

**Time and distance lead the readings, at full weight.** They are the two figures somebody opened the
tooltip for; everything under them qualifies one of the two, and that is the difference between a
hierarchy and a list. Each reading is a **total** with the leg that got there beside it, quieter —
these were typeset identically before, which turned three answers into six equal numbers. Climb is two
rows rather than one, because "focus on the total" cannot be done to a row holding two totals and two
legs.

Two rows are gone from the top of the card. **The coordinates**, six decimal places of them, and
`snapped 12 m` beside them: diagnostics, and they used to sit above how far in and how long in. The
raw fix still reaches the one place it is worth anything, which is the Google Maps link.

**Pace is stated twice, in both units, on one row.** A `km/h` figure is one division away from a
`min/km` one, but the two audiences for it do not convert: a runner thinks in minutes per kilometre and
will not divide 3600 by anything, while anyone following by car, bike or map thinks in km/h. Deriving
the second from the first costs a division and means the two can never disagree — and it goes in the
column the *legs* live in, quietly, because that column is already where "the same reading, said as
context" belongs. Two rows claimed two measurements, and there is only one.

The pace row has no total to lead on, because a pace is always about a stretch and the stretch that
matters is the one just finished. It is timed against the previous *snapped* ping rather than the
previous ping: the numerator is course distance, so a gap timed from a fix that never landed on the
route would divide this stretch of ground by less time than it took.

A pace also needs a leg long enough to divide. On the 165 km run in this repo, a five-minute ping that
advanced 24 m along the course reported `209:47/km` — arithmetically exact, and about nothing at all,
because a pace divides distance by time and a short enough distance divides *noise* by time. Below
`paceMinMeters` (100 m, a tenth of the unit being quoted) there is simply no pace row, and no speed row
either: one missing measurement, so both readings of it go. This is not a cap on slow paces: 22:14/km
up a col is a fact and it gets printed.

**Heart rate is in with the run's figures**, last of them, rather than off among the handset readings.
It is the one number on the card that says what the last kilometre *cost*, which makes it a fact about
the run in the way a pace is; battery and signal are facts about a handset, and they are up in the
status bar where handset facts go.

Legs that round away are left off. `stats.down` comes back as fractions of a metre left over from the
elevation threshold, so a flat kilometre used to draw a column of `+0 m` — and beside a total, `+0 m`
reads as a measured zero rather than as a number too small to have a digit.

**The icons are emoji**, which is a trade taken with open eyes: they arrive in the platform's own
colour and metrics and no stylesheet here can reach them. What buys that back is the weather, where a
drawn set would need fifteen glyphs for a vocabulary everybody can already read. Having accepted them
there, using them for the rest is the only way the tooltip has one voice — the two status icons
excepted, for the reason above.

Three of the choices took a screenshot to make. Climb is a **rising and a falling chart**, not an
arrow: `⬆️` and `⬇️` render as filled blue tiles that outweighed every number on the card and fought
the one accent colour the page has, while `📈` and `📉` are the shape the height strip at the bottom of
the page draws these very numbers as, so the glyph and the graph agree. Pace is a **runner**, not the
stopwatch it obviously wanted — a stopwatch at 11 px is a small circle with hands on it, and so is the
clock two rows above. And distance is a **ruler** rather than a map pin, because a pin says "a place"
and the reading is a length.

The **weather glyph is matched on keywords**, worst weather first, rather than looked up in a table of
Apple's condition names. The phone composes its own wording — every ping here says `Sunny`, which is
not any WeatherKit case description — so a table would be a table of guesses about someone else's
string formatting, and a label that missed it would draw nothing, which is the one outcome worse than
drawing something approximate. The order carries real information too: "Rain and thunder" is a
thunderstorm and not rain, and "Mostly Cloudy" is the cloudy answer while "Partly Cloudy" and "Mostly
Clear" are both the in-between one. An unrecognised label falls through to `🌡` rather than to nothing,
so the line keeps its shape — and that case is genuinely "some temperature, no idea what sky", which
is the one place a thermometer is still the right icon.

Night *used* to be deliberately not distinguished, on the grounds that a moon for "Clear" at 02:00
needs a sunrise table to be right and would otherwise be wrong for half the year anywhere far enough
north — which is where these races tend to be. [`sun.js`](src/sun.js) is now exactly that table, so
the objection is spent. `weatherHtml` asks `isDaylight` whether the sun was up over *that ping*, at
its own place and its own moment and — where it snapped — at the course's height there. That is the
same crossing, at the same altitude-corrected horizon, that puts the 🌅 and 🌃 marks on the course, so
the glyph on the tooltip and the marks a few pixels away cannot contradict each other about whether a
minute was dark. Ordinary noon is unaffected: every ping in this repo that carries weather was taken
in daylight and draws exactly what it drew before.

Only the two glyphs that **draw a sun** change after dark. Rain, fog, wind, snow and a thunderstorm
look the same at midnight, and drawing them differently would be inventing a distinction the label
does not make. `⛅` becomes a plain `☁️`, because Unicode has the sun behind three different amounts of
cloud and nothing lunar behind any of them — so for the hours it cannot be drawn, the three-way
distinction between "Mostly Cloudy", "Partly Cloudy" and "Mostly Clear" lives on the label sitting
beside the glyph, which still spells out which of them it was.

And a **clear night draws the moon it actually was** — 🌑🌒🌓🌔🌕🌖🌗🌘, from the date, not a fixed
crescent. On a clear night the phase is precisely the fact a night runner wants: a full moon is a trail
you can see without the torch, and a new one is why the head torch battery matters. It is only ever
drawn on a *clear* night, which is what keeps it honest — the page never claims a moon nobody could
have seen through the cloud. **It is mirrored below the equator.** 🌒 is a crescent lit on its right,
which is a crescent seen from the north; the same moon over Réunion, where La Diagonale is run, leans
the other way, and reflecting the index swaps waxing for waning while leaving the new and full moons —
the two symmetric ones — alone. The phase comes from the elongation, how far round the sky the moon has
moved from the sun, which is what a phase physically is; the moon's ecliptic latitude is dropped and
two small periodic terms with it, worth a degree and a half against buckets three and a half days wide.

`🌑` is the one glyph worth a warning: it is a dark disc, and the tooltip has a dark theme. Checked in
both, and it survives — Apple draws it a dark *blue*, which reads against the near-black card. It is
also the correct answer, and a new moon genuinely is nothing to look at.

**A ping carries no prediction.** It used to be scored against the forecast made before it arrived —
`Predicted 12:36 · 47s late` — which was a reading about the *model* on a card about a runner, and it
cost a quadratic walk-forward backtest on every paint to produce. The one place a prediction belongs is
ground nobody has reached yet, which is the hover tooltip, and that is now the only place it appears.

### Times are 24-hour, and say which day of the race they are on

Every clock time in the app is `HH:MM:SS` in the viewer's own zone, 24-hour, with no AM/PM and no
date. The date used to lead every tooltip — "Jul 28, 2026, 12:06:01 PM" — repeated across all four
hundred pings of a run that happened on one afternoon.

But on a race longer than a day the date *is* load-bearing, and what it was carrying is only ever
which **day of the race** this is. So that is what gets said, in two characters:

```
16:25:28⁺²  ·  finish
```

That is the real finish of a 45-hour ultra in `locations/`, and without the `⁺²` it is a lie about
which afternoon. The predicted finish in the panel carries the same tag for a sharper version of the
same reason: it is the one reading on the page where getting the day wrong sends somebody to a finish
line 24 hours early. Days are **calendar** days in local time, not 24-hour blocks — a race from 06:00
to 22:00 is sixteen hours long and entirely day 0, while one from 23:30 to 00:30 is one hour long and
crosses into day 1, because the question is "which morning is this" and only a calendar answers it.
Each timestamp is asked for its own UTC offset, so a race running through a daylight-saving change
still counts days the way the clock on the wall did. The tag goes negative as readily as positive: a
warm-up ping sent the evening before a 06:00 gun really is on the day before.

These were three `Intl.DateTimeFormat` instances and are now four lines of `padStart`. The formatter
can be told its hour cycle but not to stop being localised — with an undefined locale it still picks
its own separators, its own numerals and its own view on leading zeroes — and there is nothing left
here for a locale to decide. Removing it also made the whole display layer deterministic in a test,
which is why the day-tag cases can be written at all. `metres()` went the same way for consistency:
every word in a tooltip is English, so a number grouped to some other convention beside them is a page
that cannot decide.

### The prediction, as a diagram

Hovering ground the runner hasn't reached gives the one guess on the page, fenced off by a rule from
everything that was measured, and drawn as a little diagram rather than written as three sentences:

```
           PREDICTED
            09:01⁺¹
   ────────▄▄▄▄▄▄▄▄────────
   08:54⁺¹   15m 28s   09:09⁺¹
🕒  11h 2m
```

A forecast has a shape — a moment in the middle, a window either side of it, a width — so each part
sits where the part it describes is. The predicted time is centred; the bar under it grows outwards
from that same centre; the two edges of the window sit at the two ends of the bar, with the distance
between them written *between* them, where it reads as the gap those two numbers describe rather than
as a third figure under a pair. Nothing has to be read to see how uncertain the answer is, which is
what `Likely 14:40 – 15:05` asked for instead. The width says only the duration: the bar directly
above it already says the word "wide". Under all of it, the race clock at that moment — as an ordinary
reading row, back on the left margin and at full weight, which is exactly how a ping states the
elapsed time it *measured*. They are one reading, one of them a guess, and typesetting them alike is
what says so. Only the part above it is a diagram.

**The prediction leads the card**, above the distance and the climb, and is the one band there with no
rule above it. It is the answer to the question that made somebody point at ground nobody has reached
— "when will he be here" — and the distance and the height are how far away "here" is. A ping tooltip
is the same argument reversed: nothing on one is a guess, so the measured readings lead and there is
no prediction at all.

The bar's **length is the width of the forecast window**. It is the only thing in a tooltip readable
without reading: two predictions half an hour apart are worth comparing, and comparing
`14:40 – 15:05` with `16:02 – 16:11` otherwise means arithmetic.

Its track is a **fixed 186 px** (`--pred-w`), not the width of the card, and the row of edge times
shares that width so it goes on labelling the ends of the bar above it. A track that stretched to fit
broke the bar's one claim in the quietest possible way: a tooltip is only as wide as its contents, and
`09:01` and `23:45⁺¹` are different numbers of characters, so the same window drew a slightly
different length on two tooltips. Measured in a browser across both: 186 px each, whatever the times
say.

Its scale is fixed — `uncertaintyRefMs`, 30 minutes to the full track — so the same fill always means
the same span, on every ping of every run. The two alternatives both fail: a track spanning the window
itself would be full width always and so say nothing about how uncertain anything is, and one scaled
to the time remaining would change the ruler between one tooltip and the next. Windows wider than the
reference pin at full width rather than overflowing; a forecast that uncertain is simply "very", and
the figures are written out beside it. The fill grows from the middle rather than from a left edge,
because the middle is where the predicted time is and the window is symmetric about it; growing from
one end would draw the near edge as fixed and the far edge as the only uncertain one.

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

Every ping is one colour — the accent orange, the newest one included. There were two before this,
a blue for the trail and the accent for the newest, which said "two kinds of thing" about one kind of
thing; what actually marks the newest fix is its size, its ring and its pulsing halo, and those were
doing the work already. Before that there was a time ramp and a legend to decode it, and the only
thing anyone read off it was how fresh the newest fix was, which the ticker now says in words. The
trail dots carry no ring at all: a ring keeps overlapping fixes legible as separate marks, and on a
course pinged every few minutes it turned a stretch of trail into a chain of little targets instead of
a trace. All the colours are CSS custom properties in [`index.html`](index.html) — `--accent`,
`--course`, `--viewer`, `--surface-*` — and [`colors.js`](src/colors.js) reads whichever of light or
dark is active.

### Where *you* are

**The page asks the browser where you are as it opens**, and marks it with a blue pulsing dot. It is
the only thing on the map that isn't about the race, and it is the other half of a spectator's
question: the pings say where the runner is, and without this anyone planning to intercept them had to
hold their own position in their head or go and look at a different map.

This used to be a checkbox, off by default, on the argument that a page which demands your location
before you have asked it for anything is a page nobody trusts. The argument lost to what actually
happened: it was the one control on the panel nobody found. The browser's own prompt is the consent —
it is asked once per site, it is the mechanism designed for exactly this question, and a refusal is
honoured permanently, below.

Blue, because a blue dot has meant "you" on every map anyone has used, and it is now the only thing on
this map that isn't orange — the pings having given up their blue. The ring and the halo finish the
job: a ping carries no ring at all, and the only other pulsing mark on screen is the newest fix, which
pulses orange. It sits **under** the course and the pings, like the other runs' dots, for one extra
reason: the accuracy circle can be a kilometre across and would wash the route out.

That circle is drawn at whatever radius the browser admits to, in **metres**, so it shrinks as you
zoom out — it is an area of ground, not a mark on a screen. A wifi-derived fix can be a kilometre
wide and a GPS one ten metres, and those two must not look alike. It is the same refusal to
over-claim as the raw-versus-snapped trail and the forecast's band; a bare dot on a 1 km fix would be
the same lie in a new place. A fix that reports no usable accuracy gets no circle at all rather than
one drawn from a number that means nothing.

Three things it deliberately does **not** do:

- **It never moves the camera.** Watching a race on another continent draws a dot you cannot see, and
  that is the honest outcome — the alternative is taking the race off screen to show you a fact about
  yourself you already knew.
- **It never asks twice.** The prompt is raised once, as the page loads, and a refusal ends it: the
  watch is stopped rather than left running where it can never report anything, and nothing in the
  page re-asks. Only the browser's own site settings can give the permission back.
- **It stores nothing about the position.** Where you were last time is a fact about a person, not
  about a race, and this page has no reason to keep it.

Nothing appears on the height strip. The visitor has no place on an axis of distance-along-the-course,
and inventing one would mean claiming they are on it.

While the prompt is up the panel's last line reads `Locating you…`, which is the only thing on screen
explaining what that prompt is for. If the browser refuses or fails, that line says why —
`Your location: blocked`, `unavailable`, `no signal` — rather than going to the panel's error line,
which belongs to the poll loop and is rewritten every pass. See [`geo.js`](src/geo.js).

> ⚠️ Geolocation needs a **secure context**. `https://` and `localhost` count; `http://192.168.x.x`
> does not — and over that the API is fully present and every call to it fails, which looks exactly
> like a bug in this code. The page doesn't ask at all where asking cannot work, and says nothing
> about locating you either, so a panel with no location line on it is the symptom. Check the URL
> first. See "Running it".

## The course

Drop a `.gpx` file into a run's folder and it becomes that run's course:

```
locations/test/
  test.gpx                          the course
  2026-07-28T12_06_01+02_00.json    the pings
```

Any `.gpx` directly inside the folder is found. It is never treated as a ping, so adding one can't
make a finished race look live — but a folder holding **only** a course is still a run, an upcoming
one, and that is most of the point: a race is worth putting on the map before it starts, so you can
see the route, the height profile and how long there is to wait. Track segments (`<trk>`) are
preferred; a file with only a route (`<rte>`) works too. If a run somehow has several `.gpx` files the
first alphabetically wins — arbitrary, but stable, which is what matters for the cache.

### When the race starts

`start_datetime` in the run's [`course_settings.json`](#course_settingsjson) is the gun:

```
locations/UTMB/
  UTMB.gpx                the course
  course_settings.json    "start_datetime": "2026-08-28T09:00:00+02:00"
```

ISO 8601, with a little give, because this one is typed by a person rather than written by a phone:
seconds are optional, the zone may be `Z`, `+02:00`, `+0200` or even `+02_00`, and leaving the zone
off means *your* zone — which is rarely what you want, since a race is watched from elsewhere as
often as not, so write the offset. A date with no time is refused rather than read as midnight; a gun
time invented out of nothing is worse than no gun time at all. A run whose settings say nothing about
a start has none, and everything below simply doesn't apply to it.

> The `+02_00` spelling is accepted for one reason: filenames in this repo can't hold a colon, so
> every timestamp anyone here has typed writes the offset that way, and one copied into a settings
> file should mean what it looks like it means. In JSON there is no such constraint — write `+02:00`.

This **used to be the GPX's filename** (`UTMB_2026-08-28T09_00_00+02_00.gpx`). Nothing reads a
filename for a time any more. Two things were wrong with it: moving the gun meant renaming a file,
and a race with no route mapped yet couldn't have a start at all. Name the `.gpx` whatever reads
well; the alphabetically first one in the folder is still the course.

Two things follow from a start being known:

- **The clock counts the race, not the folder.** Elapsed time runs from the gun, and before the gun
  it runs backwards as a countdown — see "On screen".
- **Pings from before the gun are drawn, but they don't race.** A fix from the drive to the start, or
  from a warm-up jog, is a real position of a real phone, so it stays on the map where the GPS put
  it. It is simply never placed on the course — and because everything downstream keys on *having*
  been placed there, that one refusal is the whole exclusion: no distance along the route, no climb,
  no elapsed time in its tooltip, and no vote in the pace model. A warm-up lap of the start field
  would otherwise read as the first 400 m of the race, at a pace nobody is going to hold for 170 km.

  This is why the snap cache records the start it was computed against, alongside the course's sha
  and the snap radius. The gun lives in a different file from the course, so a start edited mid-race
  changes nothing else in that tuple — without recording it, nothing could notice.

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

  Somewhere in that faint half is one more mark: **where the runner probably is right now**, drawn
  as a heavy opaque stroke laid over the skyline for the span of the 80% range. It is the forecast
  read the way round a distance axis can answer — the tooltips ask "when will he be *here*", and
  this asks "where is he *now*" — and it creeps forward with the clock rather than waiting for a
  ping. The map carries the same mark, as a highlight of the trace itself over the same range. In
  both views it is deliberately *only* the range: no dot at the mean, no caps at the bounds, because
  the model claims a stretch and marking a point on it invites the eye to read a precision that
  isn't there. Once the prediction runs off the end of the course it disappears: a phone that
  stopped reporting three days ago is not "probably at the finish line". That disappearance is also
  what stops the elapsed clock — see "The race clock" — so the map and the panel cannot disagree
  about whether the run is still on.

  In both views the band is drawn **under the pings**. It is a guess about the course; a ping is a
  measurement. Drawn on top, as it was on the map, it covered the pulsing dot whenever the phone went
  quiet long enough for the band to slide over the newest fix — hiding the one mark on screen that is
  known behind the one that isn't, in exactly the situation where the known one matters most.

- **Each ping carries its climb**, in the tooltip: metres up and down since the run started, and
  over the stretch since the previous ping. Alongside them, distance and elapsed time in the same
  shape — how far and how long since the start, and since the ping before — and the pace of the leg
  just finished, in both units.

- **Anywhere on the course can be asked about.** Hovering the route on the map, or the terrain on
  the strip, gives a tooltip for that spot: how far in, how high, and what the climb is to there.
  Behind the runner it says only that, and no time: interpolating a clock across a five-minute gap is
  arithmetic on a straight line through ground that was climbed at whatever pace it was climbed at,
  and the pings either side both carry times somebody actually recorded. Ahead of them the time is
  **forecast**, with a window:

  ```
  📏 15.0 km
  ⛰️ 81 m

        PREDICTED · 1h 18m in
               12:55
       ──────▄▄▄▄▄▄▄▄──────
       12:51          13:00
               8m 52s
  ```

  Drawn as a diagram, so the answer and how much it is worth arrive together rather than as two
  sentences — see "The prediction, as a diagram". A run too young to fit a model still says "Not
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

### Pings are bigger than they look

A drawn trail dot is a few pixels across, which is a thumb's width of nothing. On a phone, tapping a
fix was a game of chance, and most misses landed on the course band underneath and opened the wrong
*kind* of tooltip. So the pings get the same treatment the route already had: an invisible disc
`pointHitPx` (16 px) in radius, over every ping, above the course's band and pickable in its place.
Neither the trail nor the course line is pickable itself — one mark, one answer.

This is a **trade**, and it is the right way round rather than free. Where the trail is dense those
discs cover the route, so hovering the course *between* two pings gets harder the further you zoom
out. The pings are the readings; the ground between them is context, and it is still reachable
wherever the dots are not.

**Its tooltip can be walked into.** The strip's hover tooltip sits directly above the strip and holds
a Google Maps link, so reaching that link means taking the cursor off the canvas — and the tooltip
used to dismiss itself on the way. Checking `relatedTarget` for the tooltip was supposed to allow
that one move, and it does, but the tip is only as wide as its contents and there are nine pixels of
gap under it: a cursor heading for the link crosses the map, or the space beside the tip, and every
one of those is a `relatedTarget` that is not the tooltip. So leaving the strip now *schedules* the
dismissal (`TIP_GRACE_MS`, 320 ms) and arriving at the tip — or returning to the strip — cancels it.
A pointer that has really gone elsewhere never cancels, and the tooltip goes a moment later.

The height strip makes the same trade harder. There, a dot's target is a **full-height column** of the
chart: the hit test measures horizontal distance only, and ignores the cursor's y entirely. The strip's
x-axis is distance and its y-axis is height, so the only question a press on it can be asking is "which
point on the course" — nobody chooses an altitude. Aiming at a 4 px dot that also sits at whatever
height the terrain happens to have was two degrees of freedom for a one-dimensional question, and on a
phone it mostly missed. The cost is that the terrain between two pings is now hard to hover on the
strip, which is accepted: that tooltip is still one hover away on the map.

**Trail dots are sized on the ground, not on the screen.** `trailDotM` (30 m) with both ends clamped
to `trailDotMinPx`–`trailDotMaxPx` (2–5 px). A dot fixed in *pixels* is the same size at every zoom,
so pulling back to see a whole 170 km race packed four hundred unshrinking dots into a few hundred
pixels of route and the trace thickened into a bar. Sized on the ground it thins as you pull back,
which is what the eye expects of a trace, while the clamps keep it from vanishing at continent scale
or swelling into a blob at street level. The newest fix keeps its pixel size, its ring and its halo —
at far zoom that is now most of what makes it findable among the rest.

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

A run's [`course_settings.json`](#course_settingsjson) is free on exactly the same terms, and for
every run at once: the listing already names each one and carries its sha, and the bodies are a few
hundred bytes off the CDN. One fetch per run per edit, per browser, ever — and nothing at all on a
poll that found no edits.

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

### Known limitation

`flat` is **moving** pace. Time spent standing still widens the band, because it is real scatter, but
it does not push the estimate later — so on a race with long aid-station stops the forecast will run
optimistic. The fix would be a stoppage term rather than a tweak to any constant in `config.js`.

The model was measured this way while it was being built, by a walk-forward backtest that fitted the
forecast for ping *i* on pings `0..i-1` only: mean absolute error **1.6 min** over the nine unseen
pings of `test_3`, all nine inside the 80% band, and a finish predicted at 13:24 (13:16–13:33) against
an actual 13:22. That code (`deriveForecastErrors`) has been **deleted** along with the tooltip row it
fed. It was quadratic — n fits over up to n legs, on every paint — and it was answering a question
about the model on a card about a runner. Anyone wanting the figure again should write it as a test
rather than as a row.

## Data format

One file per fix, named with the capture time as ISO 8601 with **every colon replaced by `_`**:

```
locations/test/2026-07-28T12_06_01+02_00.json
```

The timestamp lives *only* in the filename — there is no time field in the body:

```json
{"lat":46.57352593732256,"lon":-0.7721662634749413,"btry":49}
```

Only `lat` and `lon` are required. Everything else is optional and the map handles files that carry
any, all, or none of them:

| field | what it is | where it shows |
| --- | --- | --- |
| `btry` | battery percentage | the tooltip, and the poll schedule |
| `ntwrk` | network strength on the phone, `0`–`4` | the tooltip, as `3/4` |
| `wthr` | temperature and sky as one string, `"28°C and Sunny"` | the tooltip, split in two |
| `bpm` | heart rate, from whatever the phone is paired with | the tooltip |
| `msg` | a note from the runner | the tooltip |
| `img` | an image URL | the tooltip |
| `is_finish` | the phone's last upload of the run | see "Knowing a run is over" |

Files are never edited once written.

A run's `.gpx` follows no naming convention at all — call it whatever reads well. The alphabetically
first `.gpx` in the folder is the course.

`ntwrk` is range-checked rather than merely required to be a number: the tooltip renders it as `3/4`,
so a `7` there would be a claim about a scale that doesn't exist, and a value outside `0`–`4` is
dropped. `0` is kept and shown — a phone with no bars is the interesting case, because it explains the
gap in the trail on either side of that ping.

`bpm` is range-checked for the same reason, and the low end is the point of it: `20`–`260`, so a `0`
is dropped rather than drawn. A zero is a watch that wasn't being worn or hadn't found a pulse, and a
resting heart rate of nought is not a reading anyone should be shown.

`wthr` arrives as one string with the temperature and the sky glued together by an " and " the phone
composed. Those are two readings, not one — a number you compare with the last ping's, and a word you
don't — so `splitWeather` pulls them apart for display: the temperature keeps its digits and the sky
becomes a glyph *and* keeps its wording, on the tooltip's own weather line. It splits on the *first* " and " only, so a label carrying one of its own ("Rain and
thunder") survives intact, and a string with none is passed through whole rather than sliced on a
guess — which is also what covers a phone that one day sends the label alone.

Both `ntwrk` and `wthr` landed on pings that had already been committed, which is why `V` in
`config.js` went to `v8`: a browser holding those files from an earlier visit stored them without
either, and `hydrate` diffs on sha, which never changes. One forced re-hydrate, free — every body
comes from the CDN. Same situation as `v6` and `is_finish`, and `bpm` made it a fourth time at `v10`.

Scheduled starts took it to `v9`, and for a *different* kind of reason — the first bump about the
shape of the **index** rather than the shape of a point. The tree listing is fetched with an
`If-None-Match`, and the tree of a repo nobody has pushed to answers `304`, on which the cached index
is handed straight back: the shape only ever changes when a body actually arrives. So a browser
holding the `v8` tree would keep reading records with no start in them, and with course-only folders
already pruned out, and nothing would ever prompt it to look again — the whole feature invisible on
precisely the machines that had visited before it shipped. The per-run snap caches go with it, since
those hold snaps for pings that must now be left alone.

`v10` is `bpm`, and it is the `v6`/`v8` story for the third time: the heart rate is already sitting in
files that were committed before the reader learned to look for one.

`v11` is `v9` in reverse, and it bites in the same place. The scheduled start has *left* the index —
it used to be read out of the course's filename and folded into the tree record, and it now comes
from `course_settings.json`, a separate file with a separate blob sha and its own cache. A browser
holding the `v10` tree would go on reading a start off records the new code never writes, showing a
countdown sourced from a filename convention that no longer exists, and no settings edit could
correct it. The snap caches go with it for the `v9` reason: every stored distance-along was computed
against a gun time, and the answer now comes from somewhere else entirely.

### `course_settings.json`

Everything else in a run's folder is a *measurement* — a ping is where a phone was, a course is where
the route goes. This one file is the only place a run makes a **statement** about itself:

```json
{
  "id": "UTMB",
  "label": "Ultra Trail de Mont Blanc",
  "start_datetime": "2026-08-28T09:00:00+02:00",
  "ping_frequency": { "min_interval": 5, "max_interval": 30, "k": 0.3, "midpoint": 25 },
  "news_banner": "Official Race Odometer [here](https://some.url)",
  "distance": 165,
  "total_ascent": 9900
}
```

The whole file is optional, **so is every field in it**, and an unusable field costs that field and
nothing else. These are written by hand, mid-race, quite possibly on a phone: a parser that threw the
document away over a distance typed as `"165 km"` would take the race's name off the screen. So every
field is read the way a ping's optional fields are — taken if it is the shape it should be, dropped
without comment if it isn't. `ping_frequency` is the one exception, and there is a reason below.

| field | type | what it does |
| --- | --- | --- |
| `id` | string | **ignored.** For whoever is editing the file, so a block pasted into the wrong folder is visible to a human reading it. The folder name is the run's identity and a file may not rename its own run. |
| `label` | string | what the run is **called**, everywhere on screen: the heading, the picker, the tab title. Plain text — emoji and accents are fine, markup is not. The folder name stays the `?run=` key. |
| `start_datetime` | ISO 8601 | the gun. See "When the race starts". |
| `ping_frequency` | object | the phone's own ping curve, for this run. See below. |
| `news_banner` | string | one line shown between the height strip and the map. A tiny Markdown subset. |
| `distance` | number, **km** | shown under the course name. |
| `total_ascent` | number, **m** | shown beside it. |

**The stated figures win.** Everywhere else on this page a measurement beats a claim, because the
claim is a guess about what happened; here the claim *is* the race. An official 165 km is what the
entrants signed up for and what every sign on the course says, whatever a hand-traced GPX adds up to.
The course is the fallback, so a run that says nothing still gets a line — and either half may come
from either source, so naming only `distance` gets that distance beside the course's own climb.

**`label` is plain text on purpose.** It reaches an `<option>`, `document.title` and a WebGL text
layer, none of which can render markup — so Markdown there would show as literal asterisks in two
places out of three. Emoji and accents need nothing done to them; the page is UTF-8 throughout.

**`news_banner` renders four constructs and refuses everything else:** `[text](https://…)`,
`**bold**`, `*italic*`, `` `code` ``. Written by hand rather than pulled in as a dependency — this
repo has none, and a Markdown library is a large thing to take on for four things. The message is
HTML-escaped *first*, so markup in it is text; only `http:` and `https:` are ever linked, and a
`javascript:` URL falls through visibly un-linked rather than being silently swallowed. An unclosed
`**` is two asterisks, not a guess. The bar is exactly one line tall — a bar that can wrap is one
that reflows the map every time you edit a sentence — and a message too long for the width scrolls
right-to-left at a constant speed, or becomes scrollable by hand under `prefers-reduced-motion`.

#### `ping_frequency`, and why it is the one clamped field

The phone picks its own ping interval from a logistic on its battery, and this page derives its poll
schedule from the same curve — see "Polling when a ping is due". Naming the curve per run is what
lets one repo hold races tracked by two differently-configured phones. Anything you leave out falls
back to `config.js`, so `{ "midpoint": 20 }` is a legal file that moves the knee and leaves the ends
alone.

**The units are not uniform**, and this is the likeliest thing to get wrong:

| key | unit |
| --- | --- |
| `min_interval` | minutes |
| `max_interval` | minutes |
| `k` | per battery-percentage-**point** — not a time |
| `midpoint` | a battery **percentage** — not a time |

This is a file in a repo reaching into the poll scheduler, and GitHub allows **60 API requests an
hour per IP**. A `min_interval` of `0` — a plausible typo, and the default value of an empty form
field — makes every branch of `nextPollMs` return its 30-second floor, which spends the entire hourly
budget in half an hour and locks the map out for everyone behind that connection, on every run, until
the reset. Nothing on screen would say why. So:

- **`min_interval` may not go below two minutes** (`CONFIG.pingFloorMs`). At two minutes the page
  polls about 30 times an hour, leaving room for a second viewer.
- **A malformed curve falls back whole, never half.** A sane `min` beside a nonsense `max` is not
  four independent numbers, it is one shape, and half of it applied to half of the default is a curve
  nobody chose. A file asking for less than the floor is *ignored*, not clamped up to it — silently
  honouring a curve you didn't write is how you end up debugging a schedule that matches neither the
  file nor the default.

Only those four constants are per-run. The fallback rate, the refresh floor, the backoff cap, the
poll guard and the jitter window all stay in `config.js`: they are properties of *this page's*
relationship with the GitHub API rather than of any phone. A settings file gets to say how often its
phone pings; it does not get to say how often the map polls.

#### Editing it mid-race

You can, and it costs nothing. The file is a blob in the tree listing the page already fetches, so
its sha arrives free; the body comes from the CDN, content-addressed and cached forever, so one
version is fetched at most once per browser. In the steady state — every sha matching what is already
stored — the settings pass makes **zero** requests. Settings are fetched for *every* run rather than
just the one on screen, because the picker has to label them all and upcoming ones sort by a gun time
that lives in here; that is one small file per run per edit, and nothing at all otherwise.

An edit lands on the next poll. **Worst case is about 15 minutes**: a run that has declared itself
finished backs its schedule off to `maxPollMs`, and a banner on a finished race is exactly the thing
you'd want to edit. Longer if the tab is in the background — it keeps its schedule but spends no
requests until you come back to it — or if the rate limit is in a backoff window.

Two failure rules are worth knowing, because both are silent if you get them backwards:

- **A settings fetch that fails keeps the last known values.** Degrading to nothing would drop the
  run's gun time, and a missing gun is not a cosmetic loss: every warm-up ping would snap onto the
  course, and the distance, climb, pace and forecast built on them would all be quietly wrong.
- **A deleted settings file removes its settings — unless the listing was truncated.** A tree that
  hit GitHub's 100k-entry cap and dropped entries looks exactly like a repo where those files were
  deleted, and acting on it would strip the gun times off runs whose settings are sitting right there
  in the folder.

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

Those four constants are the **fallback**. A run whose `course_settings.json` names a
`ping_frequency` uses its own curve instead, so one repo can hold races tracked by two
differently-configured phones — see [`course_settings.json`](#course_settingsjson) for the units and
for why `min_interval` is the one clamped field in this app. Nothing else about the schedule is
per-run: the refresh floor, the backoff cap, the poll guard and the jitter window belong to this
page's relationship with the GitHub API, not to any phone.

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

  An upcoming run has no ping to predict from, so it sits at that floor. Nothing wakes the page *at*
  the gun, either — the countdown ticks locally once a second and flips to a running clock on time
  regardless, and the first actual ping is picked up within a quarter of an hour of landing. Teaching
  the schedule about start times would mean giving a module that currently knows only about batteries
  a second thing to know, for a quarter of an hour.

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

An upcoming run gets no dot at all, because a dot marks where a run was last *seen* and this one has
never been anywhere; its GPX is never downloaded either. It is dropped **before** the cap rather than
after, so a race that sorts to the very top by its start time can't quietly spend a slot that a run
with an actual position to draw could have used.

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
  github.js         data layer: the tree request, the run index, the point cache, the settings cache
  settings.js       reads a run's course_settings.json — the only place a run states anything
  geo.js            the visitor's own position, from the browser (the only device API here)
  points.js         cache -> sorted array, time position, bounding box
  gpx.js            reads a .gpx into segments and waypoints (no dependencies)
  course.js         projects it to metres: distance along, climb, loop detection, grid index
  snap.js           puts each ping on the course, once, and remembers where
  schedule.js       when the next ping is due, from the battery the last one reported
  stats.js          per-ping time, distance and climb, interpolating a hovered spot, and where
                    the run was at a given moment
  sun.js            sunrise and sunset times, placing them on the run's own trace, whether a
                    given moment was daylight, and the moon's phase
  predict.js        the run's own pace model: ETAs for ground ahead, and how it scored on ground behind
  profile.js        the height profile strip and its distance axis (canvas 2D)
  news.js           the one-line news bar: a tiny safe Markdown subset, and when to scroll it
  map.js            deck.gl instance, camera, follow-latest behaviour
  layers.js         layer construction + tooltip markup
  pin.js            the tooltip a click pins in place, shared by both views
  colors.js         reads the CSS colour tokens
  util.js           time parsing (ping filenames and hand-written starts), 24-hour clocks, race days,
                    pace, formatting, escaping, pool, storage guard
  sw-register.js    installs the service worker and offers the update
sw.js               the service worker: what the app caches, and what it must never cache
manifest.webmanifest  name, icons, colours — what makes it installable
icons/
  icon.svg          the mark; render.py rasterises the PNGs beside it
vendor/
  deck.gl-*.min.js  vendored, not a CDN link — see "Offline" below
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

- New data field from the phone → `github.js` (`fetchPoint`) and `layers.js` (`tooltipHtml`) — plus a
  bump of `V` in `config.js`, every time. The field is always already sitting in files that were
  committed before the reader learned to look for it, and `hydrate` diffs on sha, which never changes,
  so without the bump it stays invisible forever on exactly the browsers that had visited before. This
  has now happened four times (`v6`, `v8`, `v10`); assume it applies rather than checking.
- New thing a run should be able to **state about itself** → a field in `course_settings.json`, read
  in `settings.js`. Every field there is optional and an unusable one is dropped silently, so adding
  one breaks no existing file. If it changes what a *cached* record means, bump `V` as well — that is
  what `v11` was.
- Something that needs to know **where the run was at a moment** → `traceAt` in `stats.js`, which is
  the measured counterpart to `positionAt` in `predict.js`: that one guesses forward from the model,
  this one reads backwards off the trace, and both hand back a place on the course. The sun marks are
  its only caller so far.
- Something that needs to know **whether a moment was dark** → `isDaylight` in `sun.js`, which answers
  it from the same crossings the 🌅 and 🌃 marks are placed at, so nothing built on it can disagree with
  what the map already shows. It takes an elevation for the same reason those do. `moonPhase` is beside
  it for anything that wants to say *how* dark.
- A new reading → decide first which of the three it is, because the card is laid out by that and
  nothing else. A fact about the **handset** goes in the status bar on the title line (`statusHtml`);
  a fact about the **weather** joins the weather line; a fact about the **run** is a `reading()` row.
  Putting a phone's battery among the race figures is what the status bar exists to undo.
- Another weather label the ladder has not met → a keyword in `WEATHER` in `layers.js`, in the right
  place in the order. Deliberately not a table of Apple's condition names: the phone composes its own
  wording, and the ladder's order is what decides that "Rain and thunder" is a storm rather than rain.
- New visual layer → `layers.js`, then include it in `pointLayers`.
- New panel or control → `index.html` for markup/CSS, `ui.js` for behaviour.
- New colour → a token in `index.html`, then read it in `colors.js`. Never a literal in a layer.
- New URL parameter → `route.js`.
- Different repo, poll rate, snap threshold, or how big a target anything is → `config.js` only.
- The phone changed how often it pings → the four battery constants in `config.js`, which mirror
  its script. If the *shape* of its rule changed, `pingIntervalMs` in `schedule.js` too.
- A different rule for when to poll → `nextPollMs` in `schedule.js`. Keep it pure: `main.js`
  recomputes it after every refresh, and that is only safe while it holds no state.
- Something else read out of the GPX → `gpx.js`, then `course.js` if it needs measuring.
- Something else read out of a **filename** → `util.js`, then `buildIndex` in `github.js`, which is
  the only place the layout of the repo is interpreted. A fact about a run that no ping can carry
  belongs on the index record, not on the parsed course: the index arrives a poll earlier, survives
  in `localStorage`, and is what a run with no course at all still has.
- Changing how a ping picks its place on the course → the cost function in `snap.js`. Anything that
  changes *which* pings belong on it goes in the cache's version tuple beside `courseSha`, or a warm
  cache will keep answers computed under the old rule.
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
- Another layer → `allLayers` in `map.js`, which is the whole stack in draw order in one place.
  Resist making it optional: the three switches this page used to have all had the same answer every
  time they were asked, and a control like that is furniture. Alpha and draw order are usually the
  real answer to "this is secondary".
- Anything else asked of the DEVICE rather than of GitHub → `geo.js`, wired up in `main.js` beside the
  geolocation watch. Keep the pure half exported and tested: a device API can't be exercised in
  `node --test`, but the shape of what it hands back can.

## Running it

No install step. Serve the repo root and open it:

```sh
npm run dev          # or: python3 -m http.server 8000
```

Then open http://localhost:8000/.

**Use `localhost`, not your machine's LAN address**, if you want to test the "you are here" dot.
Geolocation is only available in a secure context: `https://` and `localhost` qualify,
`http://192.168.x.x` does not. Over that address `navigator.geolocation` is fully present and every
call to it fails, so the symptom looks like broken code rather than a blocked API — the page doesn't
ask there at all, for exactly that reason. To try it on a phone, use the deployed HTTPS URL.

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

`course_settings.json` is tested at the two seams where a mistake would be *silent*. On the caching
side: settings cost zero API requests, an unchanged sha is never refetched, a **failed fetch keeps
the last known values** rather than dropping a gun time, a file that will not parse costs its run
nothing it already had, a deleted file is mirrored, and a **truncated listing is not a deletion**. On
the parsing side: any subset is legal, an unusable field costs that field alone, `id` is ignored, and
a `min_interval` under the floor is *refused* rather than clamped — with a case for every way a
partial ping curve could sneak through, because that one reaches the API budget.

The news bar's Markdown gets a test per ordering bug it is built to avoid, since all of them are
invisible until the wrong day: that a code span containing `*` is not emphasised from the inside,
that an asterisk in a URL stays in the URL rather than having an `<em>` pushed into the middle of the
`href`, that `**x**` is bold and not two empty italics, that only `http:`/`https:` are ever linked,
and that a quote in a link label cannot break out of the tag.

The course work is covered the same way. The GPX parser is tested against a real MapOut
export, [`test/fixtures/test.gpx`](test/fixtures/test.gpx), rather than a string written to
suit the parser — namespaces, `<extensions>` and all. It lives under `test/` for a reason
learned the hard way: it started out in `locations/test/`, where a folder with a GPX in it
*is* a run in the picker, so clearing out the fake runs deleted it and the suite failed at
import until it was moved here. the grid index is checked against brute force over a few hundred probes,
since it is an optimisation and must never change an answer; and the snapper is
pinned down on the two things that are easy to get quietly wrong — that on a closed
loop the same coordinate resolves to the start when it arrives first and the finish
when it arrives last, and that growing a run one ping at a time gives byte-identical
results to snapping it all at once, at one projection per ping.

The profile's arithmetic is tested without a canvas anywhere near it: that smoothing
settles column-to-column noise without moving a summit or sagging the ends of the
course towards sea level, and that hovering picks the dot you are actually pointing at
rather than its neighbour — a mistake that looks fine in a screenshot. That hit test is
also pinned on its one deliberate blind spot: a dot answers anywhere in its **column**,
top of the chart to bottom, because the y-axis is height and nobody presses at an
altitude on purpose. How wide the
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

Read the other way round — where the run *was* at a moment — the assertions are about the
course rather than about arithmetic: halfway in time between two snapped pings comes back at
the corner of an L-shaped course rather than at the midpoint of the diagonal across it, which
is the difference between a mark on the route and a mark half a kilometre off it. Either
bracketing ping having missed the course gives a raw interpolation and **no distance**, a
moment outside the span gives nothing at all, and the gap between the two pings comes back
alongside the answer so a caller can say how much of it is interpolation.

The sun times are tested mostly by invariant, which is what makes them robust to an argument
about tolerances: the midpoint of sunrise and sunset is solar noon, within the ±17 minutes a
sundial and a clock disagree by over a year; fifteen degrees of longitude is an hour, to
within a minute; a day at 60°N is over 18 hours in June and under 7 in December, and the two
solstices are complements; the sun that never crosses the horizon comes back as an absence
rather than a `NaN`, at both poles and in both seasons; and 2,500 m of elevation moves
sunrise earlier and sunset later by the same five-to-fifteen minutes, symmetrically. On top
of those, two spot-checks against published almanac figures — London at the June solstice and
Quito at the equinox — because a self-consistent reduction can still be self-consistently
wrong.

Placing them is tested against a synthetic overnight run: twelve hours out gives exactly one
sunset and then one sunrise, both inside the ping span and neither at the start or the finish
of the course; a run in daylight gives none; a run with no course still gives marks, with no
distance on them; thirty-six hours gives four, in order, with none counted twice — the scan
runs over UTC days and the crossings belong to solar ones. And the circularity at the heart
of it, that where the runner is decides when the sun rises and vice versa, is pinned by
running the same ground in reverse: the iteration has to converge to a settled answer from
either seed rather than leaving the seed showing through.

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

The model was also checked against real data, by a route worth recording even though the
data has since gone: two runs where the shorter was a strict 13-ping prefix of the longer,
which makes the longer one ground truth for everything the shorter cannot see. Those folders
were throwaway test runs and were deleted — anything under `locations/` shows up in the
picker, so they could not stay — and the comparison was never in the suite anyway: it is a
measurement, not an invariant, and freezing its numbers into an assertion would have been
testing the sample data rather than the model. The figures it gave are in "Predicting the
rest". Reproducing it needs two runs in that prefix relation, from anywhere.

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

Two interaction fixes are verified the same way, over CDP, because both are about where a
pointer *is* rather than about what any function returns: that the run picker leaves focus on
the document after a mouse pick and keeps it after a keyboard one, and that the strip's hover
tooltip survives the walk from the canvas to its own link. The second was checked by
falsification as well — with `TIP_GRACE_MS` set to 0 the walk ends with the cursor over the
map and the tooltip gone, which is exactly the bug.

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

Scheduled starts are tested at the seam each one could fail at. The start parser is checked on
every form the timestamp is allowed to take — including the `+02_00` spelling a filename forces,
which is the one `Date.parse` refuses — and pinned against the *ping* parser it deliberately
isn't: `parseTime` returns NaN for anything with a label in front of the stamp, and that
assertion is there so nobody merges the two functions back together. Everything it must refuse
rather than guess at gets a case — a bare year, a date with no time — because a gun time invented
from nothing is the one failure that would look right on screen.

The ordering has a test for each way a future timestamp could leak somewhere built for past
ones: that an upcoming run is never live however close its gun is, that it sorts to the top of
the picker but not into the landing view, that the picker's order is stable when several runs
have nothing to compare, and that a record with no pings survives the round trip through
`localStorage` — which is the exact trip that made the old code drop these folders instead of
showing them.

The pre-start cut is tested where it lives, in the snapper: that a ping before the gun is
recorded as an explicit *nothing* rather than skipped — skipping it costs a re-snap of the
whole run on every paint — that it leaves progress along the course where it was, so the
sequence reads as though the warm-up never happened, and that moving the gun invalidates the
cache even though the course file's SHA is unchanged. The forecast tests then assert the claim
the whole design leans on rather than merely arguing it: adding unsnapped warm-up pings to a
run changes the fitted pace by *nothing at all*.

The panel has two pieces with their own tests, because it has two pieces with a decision in
them. `clockReading` has six branches, three of which only happen on race morning and so cannot
be waited for; it is pure and returns the label and the value as data, so the countdown, the flip
to zero at the gun, the gap before the first ping, and elapsed-from-the-gun are all reachable
without a DOM or a clock that has to be believed. `stillRunning` is the other, and its cases are
hours apart in real time: a run that pinged eight times and then went quiet is built once, and the
tests assert that the ping rule has given up on it an hour later while the forecast has not, that
the answer flips at the predicted crossing and not a minute either side, that it stays flipped
fifty hours on, and that an `is_finish` outranks all of it. Both are exported for the tests and
called from one place each, so nothing in the panel can hold a second opinion.

The tooltips are tested as markup, since that is what they are: `tooltipHtml` and its two
siblings are pure functions returning strings, and the tests strip the tags and read what a
person would see. Row counts are asserted as well as wording — a ping with nothing derived
gets exactly zero reading rows, a full one gets six — because the failure mode of a tooltip is
not a wrong number, it is a row that quietly stopped appearing.

The two drawn icons are tested on the thing that makes them worth being SVG: that the battery's fill
rectangle is *wider at 100% than at 50%*, that 1% is still a sliver rather than an empty shell, and
that a phone with two bars lights two. The prediction is tested as a diagram — one section, the two
edge times in order at the two ends, a width that is a bare duration — and a ping tooltip is asserted
to carry no prediction and none of the scoring wording at all, which is the row that was deleted.

The clock functions are the reason those tests can exist at all. Every case is built from
**local** date components rather than from an absolute instant, so the assertions hold under any
`TZ` — which is also the point of these having stopped being `Intl.DateTimeFormat`. Both wrong
answers a hand-rolled formatter can give at midnight are pinned (`00:00:00`, never `24:` and
never `0:`), and `dayOffset` is checked against the trap it exists for: sixteen hours inside one
calendar day is `0`, and one hour across midnight is `+1`.

The weather ladder is tested as an *order*, not as a lookup, because the order is what it knows:
"Rain and thunder" must be a storm and not rain, "Freezing Drizzle" must be ice and not drizzle,
"Tropical Storm" must be a cyclone and not a thunderstorm, and "Partly Cloudy", "Mostly Cloudy"
and "Mostly Clear" must be three different answers. An unrecognised label is asserted to reach
the fallback rather than to draw nothing.

Every one of those cases now has a **night twin**, on a fix thirteen hours later at the same place:
"Clear" draws a moon and no sun anywhere in the markup, both cloudy answers draw `☁️` while their
labels still read "Partly Cloudy" and "Mostly Cloudy", and rain, fog, wind, snow, a thunderstorm and
the fallback are asserted to draw the *same* glyph by day and by night — which is the half of this
that could go wrong silently. The daytime fixture's midday is now stated rather than incidental,
since it is what decides those assertions.

`isDaylight` is tested against the crossings it is derived from rather than against a clock: at five
places and four times of year, a minute before each sunrise is night and a minute after it is
daylight, and the same at sunset. That is the property the whole feature rests on — a ping next to a
🌅 mark agreeing with it. At 2,500 m, a minute that is night at sea level is asserted to be daylight,
which is the altitude correction reaching this function too. The two polar skies are
told apart at last: a June midnight at 80°N is daylight for all twenty-four hours and a December noon
is not, and `sunTimes` now says *which* absence it found rather than only that there was one — pinned
at 90°N as well, where the hour angle divides by a cosine of zero and the infinity that comes back
lands on the right side of the range without a branch to help it.

The moon is tested against **published dates** at the four turning points — full and new in June 2025,
the two quarters in July — and then as a *cycle*: sampled every three hours for thirty days from a new
moon, all eight glyphs must appear, each in one unbroken run, and in order. That says the index is a
fraction of a synodic month rather than a lookup that happens to land. The hemisphere mirror is
asserted as a swap (🌒 ↔ 🌘, 🌓 ↔ 🌗) with the new and full moons unchanged, because those two are
symmetric and mirroring must be a no-op on them.

Two tests exist because real data disagreed with the code, and both are recorded as such: a leg
of 24 m over five minutes must produce **no** pace rather than `209:47/km`, and a leg of 0.4 m
must produce no `+0 m` beside its total. Neither was reachable from a hand-written fixture —
they came out of running the 165 km race in `locations/` through the real pipeline, which is
worth doing to any change in this file.

## A note on waypoint labels

The map draws every waypoint's name. deck.gl's `CollisionFilterExtension` is the right tool
for thinning them out when a course carries thirty of them and they overlap at low zoom, and
it is deliberately **not** used: in deck.gl 9.3.7 it culls *every* label in this layer stack.
Verified against the real course on both SwiftShader and the hardware GPU, with and without
`collisionTestProps`, and with the per-frame layer rebuild frozen — the glyphs are laid out
(33 instances, sublayer visible) and simply never drawn. A label you can read beats a label
that tidily avoids its neighbours and isn't there. The height strip does its own overlap
rule in six lines, dropping any label that would run into the previous one.

The sun marks inherit that decision and need it less: there are two per night, and the only
way two of them collide is a course that doubles back near itself between one crossing and
the next — where the honest picture is two marks close together. In the strip they are given a
band of their own just under the waypoint names rather than sharing that row, because two
kinds of label competing for one line is how the collision rule above ends up dropping the
interesting one.

## Offline, and installing it

The page is a PWA: it can be installed to a home screen, and it opens without a
network. Both matter for the same reason — the races this is pointed at are in
mountains, and the signal there is bad exactly when you most want to look.

**Installing.** Android and desktop Chrome offer it themselves. iOS never does:
Share → *Add to Home Screen*. Installed, it runs without browser chrome, which is
worth more here than it sounds — the height strip and the news bar anchor to the
bottom of the window, and Safari's URL bar spends its life moving around down
there.

**Offline.** `sw.js` holds the whole rule set, and it is one rule applied four
times: cache what cannot change, and never cache what must be fresh.

| | strategy | why |
|---|---|---|
| `api.github.com` | **network only** | the listing is the only thing that says a new ping exists. A stale one here looks exactly like a runner who has stopped moving, which is the worst failure this app has. |
| `raw.githubusercontent.com?<sha>` | cache first, forever | `rawUrl` puts the blob sha in the query string, so the URL is content-addressed and its bytes can never change. A URL *without* one is a plain branch path, which can — so that goes to the network. |
| `basemaps.cartocdn.com` | cache first, ~1200 tiles | the ground you have already looked at is the ground you are standing on. Evicted oldest-first once over the cap. |
| same origin | cache first | the app shell, precached on install. |

So a cold open on a dead connection still paints: the shell comes from the cache,
the points come from `localStorage`, and the tiles are whatever you last looked at.
It says how old the newest fix is, as it always does — that line is what keeps
"offline" from being mistaken for "nothing is happening".

**deck.gl is vendored** into `vendor/` rather than linked from unpkg. It is 1.6 MB
and it sits between opening the page and seeing a map, so it has to be precacheable
— and a cross-origin script comes back opaque, which a `Cache` refuses to store.

**Updating.** Bump `VERSION` in `sw.js` whenever a shell file changes; `activate`
deletes every cache not on the keep list. The data and tile caches deliberately do
*not* carry the version, so shipping a CSS tweak cannot throw away the pings of a
race already in progress. The new version is never swapped in automatically — the
panel offers a *Reload* and waits. A tracker that reloads itself out from under
someone watching a runner between checkpoints is worse than one a version behind.

**Icons.** `icons/icon.svg` is the source; `python3 icons/render.py` rasterises the
PNGs, which are committed like everything else. Pillow is the only thing it needs,
and nothing builds at deploy time.

**In development** the worker installs on `localhost` too, since that counts as a
secure context. Worth knowing when a change to `src/` seems not to land: hard-reload,
or tick *Update on reload* in the browser's Application panel.

## Publishing

One-time setup: **Settings → Pages → Deploy from a branch → `main` / `/ (root)`**. The empty
`.nojekyll` file stops Pages running the repo through Jekyll.

Every path in `index.html`, `manifest.webmanifest` and `sw.js` is relative, which is
what lets the whole thing work from the `/location-tracker/` subpath a project Pages
site is served under.
