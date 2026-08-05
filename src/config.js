// Everything environment-specific lives here, so nothing below has to be edited
// to point the map at a different repo.

export const CONFIG = {
  owner:  'bertcoerver',
  repo:   'location-tracker',
  branch: 'main',
  dir:    'locations',

  // GitHub allows 60 API requests/hour PER IP, and a 304 costs the same as a
  // 200 — measured, despite the docs saying conditional requests are free. One
  // poll is one request whatever the run count, so the rate is a budget split
  // between everyone behind the same connection.
  //
  // This is only the FALLBACK rate now, for a run whose newest ping predates the
  // `btry` field. Normally schedule.js works out when the next ping is actually
  // due and the page sleeps until then. 240s = 15/hour, room for four viewers.
  pollMs: 240000,
  minRefreshMs: 30000, // floor between refreshes, however they were triggered
  liveMs: 3600000,     // a run with a ping this recent is still running
  concurrency: 8,      // parallel file fetches on a cold start
  maxZoom: 17,         // this tracker often sits still; don't zoom into the void

  // --- when the next ping is due -------------------------------------------
  // The phone picks its own ping interval from a logistic on battery: flat at
  // 5 min above ~45%, slewing hard through 15-35%, flat at 30 min below 15%.
  //
  //   interval = min + (max - min) / (1 + e^(k * (battery - mid)))
  //
  // These four constants MIRROR the phone's script, which is the authority.
  // They live here only because `btry` is what the ping actually carries, and a
  // mismatch is SILENT — the map would just poll at the wrong times, with no
  // symptom anyone would notice. Retune the phone, retune these.
  //
  // They are the FALLBACK now: a run whose `course_settings.json` names a
  // `ping_frequency` overrides them for that run alone, which is what lets one repo
  // hold races tracked by two differently-configured phones. See settings.js.
  minPingMs: 300000,
  maxPingMs: 1800000,
  batteryK: 0.3,
  batteryMid: 25,

  // The shortest ping interval a settings file is allowed to claim.
  //
  // Not a property of any phone — a guard on the API budget, and the only clamp in
  // this app that exists because a file in the repo can reach into the scheduler.
  // `nextPollMs` sleeps about one ping interval, so a claimed interval is very
  // nearly a poll rate: at two minutes that is 30 requests an hour against a limit
  // of 60, leaving room for a second viewer. Below it the page would spend the whole
  // hourly budget and lock every run out, with nothing on screen saying why.
  //
  // A file asking for less doesn't get clamped to this, it gets IGNORED — see
  // `parsePing`. Silently honouring half of a curve nobody chose is how you end up
  // debugging a schedule that matches neither the file nor the default.
  pingFloorMs: 120000,

  // The phone no longer uploads a fix the moment it takes one: it records the
  // ping, then commits it a fixed minute later. So a ping's timestamp and the
  // moment it can possibly be FETCHED are a minute apart, every time, and a
  // schedule built on `t + interval` alone would look for every ping a minute
  // before it could exist. Like the four constants above, this mirrors the
  // phone's script and a mismatch is silent — retune the phone, retune this.
  //
  // Not part of `ping_frequency`: a settings file names its phone's curve, and
  // this lag is the same on every phone writing to this repo.
  uploadLagMs: 60000,
  pollGuardMs: 30000, // the commit still has to land AND reach the tree API
  maxPollMs: 900000,  // backoff cap, and the floor poll on a long wait
  // How late a ping can be before we stop treating it as jitter. The interval
  // plus `uploadLagMs` predicts when the phone COMMITS; the commit still has to
  // reach the API, and neither leg is to the millisecond, so a little slippage
  // means nothing. Past this it has genuinely missed its slot, and since a
  // failed upload is retried on its NEXT poll rather than on its own, there is
  // nothing to find until then.
  lateJitterMs: 120000,

  // --- the other runs, as dots on the map -----------------------------------
  // How many of them to mark, most recently active first.
  //
  // Each one costs a single ~200-byte CDN fetch — the newest ping of that run,
  // to find out where it is — and NOTHING against the API budget: the tree
  // response already lists every run's files and their shas, which is how we
  // know which file is newest and what its content address is. That fetch is
  // content-addressed and persisted, so it happens once per ping in a browser's
  // life; a run that has finished never costs anything again.
  //
  // So this cap is not about the request budget, it is about a cold start: a
  // repo with 400 runs in it should open the newest 40 races rather than fan out
  // 400 fetches to draw dots nobody can tell apart at that zoom.
  beaconLimit: 40,

  // --- where the person LOOKING at the page is ------------------------------
  // Passed straight to `watchPosition`. Nothing here touches the network, so
  // none of it costs anything against the API budget.
  //
  // High accuracy is off on purpose. This dot answers "roughly where am I
  // relative to this race", which a coarse fix answers perfectly well at any
  // zoom a course is legible at — and the accuracy circle is drawn at its true
  // radius, so a poor fix cannot pretend to be a good one. Turning it on wakes
  // the GPS chip and drains the battery of the person watching, who may well be
  // out on the course themselves.
  viewerHighAccuracy: false,
  // A fix half a minute old is a fine answer to "roughly where am I" and costs
  // nothing to give, so let the browser serve one from its own cache.
  viewerMaxAgeMs: 30000,
  viewerTimeoutMs: 15000,

  // --- photos and clips dropped into a run folder ---------------------------
  // How many of them one run will draw, newest filename first.
  //
  // The only bound on this feature's bandwidth, and the reason it needs one is
  // that a media file is three orders of magnitude bigger than a ping: a folder
  // somebody syncs a phone's camera roll into would otherwise be a page load
  // measured in hundreds of megabytes. Forty photos is more than any race has
  // ever wanted and about 15 MB, spent once per browser against a
  // content-addressed URL. Past it the extras are ignored rather than queued —
  // the page degrades to the first forty rather than to a spinner.
  mediaLimit: 40,
  // How long to wait for a video's first frame before giving up on its
  // thumbnail. A container the browser cannot decode fires no event at all, so
  // this is what stops one unplayable clip leaving the atlas pending forever.
  mediaFrameMs: 3000,

  // --- snapping pings onto a run's course, when it has a .gpx ---------------
  // Further than this from the course and a ping is left where it is. Was 500,
  // which is not a threshold so much as an invitation: half a kilometre of slack
  // let a fix sitting 4 m from the route lose to one 460 m away, because at that
  // range the geometry stops being the loudest term in the cost. Measured across
  // the runs in this repo, the worst LEGITIMATE fix is 243 m off — a switchback
  // where the route doubles back inside the GPS's own error — and the outliers
  // that wrecked `test_run` were 251 m and beyond. The line goes between them.
  snapMeters: 250,
  // --- the Viterbi cost function (see snap.js) ------------------------------
  // Every one of these is METRES OF COST, so they add up honestly against how far
  // off-course a fix is. That was true of the old two-term cost as well; what was
  // not true was that its terms described anything physical.
  //
  // How far a fix may sit from where the straight line between two pings says it
  // should be, before the transition cost starts charging for it. GPS error plus
  // the wobble of a traced route: two fixes 100 m apart may honestly be 220 m
  // apart along the ground, and nothing should be inferred from that.
  snapSigmaM: 60,
  // A ceiling on implied speed, in km/h, overridable per run by `max_speed` in
  // course_settings.json. NOT a statement about how fast anybody runs — it is the
  // outer bound of what a leg can imply before the leg itself is in doubt. It sits
  // well above trail-running pace on purpose: `along` is progress along the PLANNED
  // route, and a runner who cuts out a loop of it because the path did not exist
  // advances along the plan faster than they ever moved. Penalising that as if it
  // were teleportation would throw away good fixes to defend an assumption the
  // course file got wrong.
  snapMaxSpeedKmh: 22,
  // And hence soft: a quarter of a metre of cost per metre of excess, so exceeding
  // the ceiling is an argument against a candidate rather than a veto. The term
  // that actually forbids teleporting is the straight-line one, which is charged
  // at full rate because it is a fact about two GPS fixes rather than a guess
  // about a runner.
  snapSpeedPenalty: 0.25,
  // Backwards is now barely discouraged — a tie-breaker, no more. It used to be 1,
  // fifty times the forward bias, and that asymmetry was the whole bug: on a course
  // whose last kilometres overlap its first, jumping 25 km FORWARD to the wrong lap
  // cost less than stepping 1.2 km back to the right one. Real progress is now
  // established by the straight-line term, which needs no thumb on the scale.
  snapBackPenalty: 0.05,
  // What it costs to give up and declare a ping off-course. The escape hatch that
  // makes a single bad fix survivable: a lone outlier pays this once and the pings
  // after it carry on from where the last good one left them, instead of being
  // scored against a position the runner was never in. Just above `snapMeters`, so
  // any candidate inside the threshold is preferred and anything beyond it isn't.
  snapOffCourseCost: 350,
  // States per ping in the trellis, and rows in the cache. See `courseCandidates`.
  snapCandidates: 8,
  // How far apart in `along` two candidates must be to count as different parts of
  // the course rather than two views of the same one.
  snapBranchMeters: 200,
  loopMeters: 250,     // start and finish this close means the course is circular
  // Metres of elevation change that have to accumulate before a rise or a fall
  // counts towards the course's ascent. GPX elevations wobble by a metre or two
  // between adjacent vertices, and summing that wobble is how a 600 m course
  // comes to report 1,400 m of climb. See course.js.
  eleThresholdM: 3,
  // Width, in pixels, of the invisible band that makes the course hoverable and
  // clickable. The drawn line is 3 px, which is a game of skill to hit with a
  // mouse and impossible with a thumb — this is the part you actually point at.
  // Safe to be this generous because deck picks the TOPMOST layer under the
  // cursor and the ping dots are drawn after it, so a wider band never starts
  // swallowing hovers meant for a fix.
  courseHoverPx: 34,
  // Radius, in pixels, of the invisible disc that makes a ping pickable — the same
  // trick as `courseHoverPx` and for the same reason. A drawn dot is a few pixels
  // across, which is a thumb's width of nothing: on a phone, tapping a fix was a
  // game of chance and most taps landed on the course band underneath and opened
  // the wrong kind of tooltip.
  //
  // This is the one number here that is a trade rather than a fit. The discs sit
  // ABOVE the course band, so where the trail is dense they cover it, and hovering
  // the route *between* two pings gets harder as you zoom out. That is the right way
  // round: the pings are the readings and the course is the context.
  pointHitPx: 16,
  // How big a trail dot is, on the ground and on the screen.
  //
  // Metres rather than pixels, with both ends clamped. A dot fixed in PIXELS is the
  // same size at every zoom, so zooming out to see a whole 170 km race packs four
  // hundred unshrinking dots into a few hundred pixels of route and the trace turns
  // into a bar. Sized on the ground it thins out as you pull back, which is what the
  // eye expects of a trace, and the clamps keep it from vanishing at continent scale
  // or swelling into a blob at street level.
  trailDotM: 30,
  trailDotMinPx: 2,
  trailDotMaxPx: 5,
  // How close, in pixels, the pointer has to be to a pinned point before it can
  // be picked up and dragged along the course. Smaller than `courseHoverPx`:
  // there is exactly one selection on screen and it is already marked, so this
  // is aim rather than search — and a generous radius on the map would start
  // stealing pans from the camera.
  dragGrabPx: 22,
  // The same question for a thumb, on the height strip. A finger has no cursor
  // to aim with and no hover to tell it when it is close enough, and the strip's
  // crosshair is one pixel wide — at 22 px most presses missed it and panned the
  // strip instead. Only the strip uses this: there the band is horizontal-only
  // and there is nothing else to press, whereas on the map a radius this wide
  // would start stealing pans from the camera.
  dragGrabTouchPx: 40,

  // --- forecasting the rest of the course ----------------------------------
  // See [predict.js](./predict.js). The model is fitted from ONE run's own
  // pings and nothing else — there is deliberately no shared or seeded state
  // between runs, because a course is run differently by different people on
  // different days, and borrowing yesterday's pace is how a forecast becomes
  // confident and wrong.
  //
  // Recency measured in METRES OF COURSE COVERED, not minutes elapsed. Fatigue
  // and terrain are what make the last hour unlike the first, and both track
  // distance; a phone that drops to 30-minute pings when the battery fades
  // would otherwise silently halve how much history the model looks at.
  //
  // 15 km leaves a 20 km run very nearly evenly weighted — there isn't enough
  // of it for recency to mean much — while on a 160 km ultra the last ~45 km
  // carry most of the fit, which is the regime this was chosen for.
  predictHalfLifeM: 15000,
  // Strength of the pull towards the run's own overall pace, counted in
  // pseudo-legs: at 4, the prior argues about as loudly as four observed legs.
  // It is what stops one slow patch running away with the forecast, and it
  // fades to nothing as a long run accumulates real data.
  predictPriorLegs: 4,
  // Naismith's rule, in the form the regression wants: one metre climbed costs
  // about as much as 7.92 m of flat. Only a PRIOR — a run with real climbing in
  // it will move the coefficient off this — but on a flat course, or in the
  // first half hour, it is the whole of what the model knows about hills.
  predictClimbFactor: 7.92,
  // Two legs is three snapped pings. Below that there is nothing to fit and no
  // forecast is offered, which is honester than one drawn through two dots.
  predictMinLegs: 2,
  // Half-width of the quoted window, in standard deviations: 1.2816 is the 80%
  // central interval. Wide enough to be right most of the time, narrow enough
  // to be worth reading — 95% on real pace scatter comes out at ±20 minutes an
  // hour ahead, which is a window nobody can act on.
  predictBandZ: 1.2816,
  // Floors on the residual scatter, so a near-perfect fit on three legs cannot
  // claim a ten-second window. The fraction is of the mean leg duration, which
  // is what makes it hold at any ping interval.
  predictMinSigmaMs: 30000,
  predictSigmaFloorFrac: 0.08,
  // Guardrails, not part of the model: seconds per metre, so 0.1 is 1:40/km
  // (faster than anyone) and 3.0 is 50:00/km (slower than crawling). They exist
  // to keep a degenerate fit from producing an ETA next week, and a fit that
  // hits one of them is a fit that has gone wrong.
  predictMinPaceSpm: 0.1,
  predictMaxPaceSpm: 3.0,
  // The full width of a tooltip's uncertainty bar, as a span of time.
  //
  // That bar's LENGTH is the width of the forecast window, so it has to be a length
  // OF something fixed: at half an hour, a fifteen-minute window fills half the
  // track on every ping of every run, which is what makes two of them worth
  // comparing. Scaling each bar to its own window would draw every forecast the
  // same width and say nothing; scaling it to the time remaining would change the
  // ruler between one tooltip and the next.
  //
  // Windows wider than this pin at full width rather than overflowing. A forecast
  // that uncertain is simply "very", and the figures are written out beside it.
  uncertaintyRefMs: 1800000,
  // The shortest leg that can carry a pace, in metres of course.
  //
  // A pace divides a distance by a time, so a short enough distance divides noise by
  // a time and reports the answer to the nearest second. Measured on the real runs in
  // this repo: a five-minute ping that advanced 24 m along the course — a runner
  // standing at an aid station, or a snap that barely moved — produced "209:47/km",
  // which is arithmetically exact and says nothing about anybody's running.
  //
  // A tenth of the unit being quoted, so the per-kilometre figure extrapolates by at
  // most a factor of ten. Below it there is no pace rather than a wrong one: see
  // `deriveStats`, which leaves the field off entirely, and the tooltip then has no
  // pace row at all. This does NOT cap slow paces — 22:14/km up a col is a fact, and
  // `fmtPace` will print it.
  paceMinMeters: 100,

  // --- the height profile strip --------------------------------------------
  profileHeight: 112,
  profileMinWidth: 640, // narrower than this and the profile scrolls rather than squashes
  // The narrowest a kilometre of course may be drawn. Without it the x-axis is
  // simply the window, so a 150 km run and a 2 km run get the same pixels and
  // the long one arrives as a smear with no readable hills in it. Below
  // `profileMinWidth` this loses — a 3 km course must not be rendered 72 px
  // wide just because it is short.
  profilePxPerKm: 24,
  // Blur radius in pixel columns, applied when drawing the terrain line. One
  // column is a few tens of metres of course, so this smooths over ~100 m of
  // ground: enough to settle GPS elevation noise, far too little to flatten a
  // hill. The underlying min/max summary is not touched.
  profileSmoothPx: 3,

  // --- the news banner -------------------------------------------------------
  // One line, which is the whole design: a bar that can grow to two lines is a bar
  // that reflows the map under it every time somebody edits a sentence.
  newsHeight: 30,
  // How fast a banner too long to fit crosses the screen, in CSS pixels per second.
  // Slow enough to read at a glance, fast enough that the end of a long sentence
  // arrives before you have given up on it — a 400-px overflow takes about six
  // seconds. The DURATION is derived from this and the text's own width, so the
  // speed is the same whatever the banner says; scrolling every message in a fixed
  // time would make a long one unreadable and a short one crawl.
  newsSpeedPxPerSec: 60,
  // The gap between the end of the message and the start of its repeat. Without one
  // the loop reads as a single run-on sentence with no beginning.
  newsGapPx: 96
};

// localStorage keys. Bump the version suffix when the cached shape changes —
// old entries are then ignored instead of misread.
//
// v6: points carry `is_finish`. The bump is load-bearing rather than tidy. A
// finish file is an ordinary ping, so a browser that cached it BEFORE this code
// shipped stored it without the flag — and since `hydrate` diffs on sha, and the
// sha never changes, it would never be refetched and the finish would stay
// invisible on that browser forever. One forced re-hydrate fixes it, and costs
// nothing against the API budget: every body comes from the CDN.
//
// v7: raw URLs carry the blob sha, and this bump is what repairs the damage the
// old ones did. A file edited in place kept its address, so `hydrate` refetched
// on the new sha and `force-cache` returned the old body — and the record was
// then stored with the NEW sha and the OLD content. Those records look current
// to the diff, so they would never be refetched, and the content-addressed URL
// would never even be tried. Discarding them is the only way out.
// v8: points carry `ntwrk` and `wthr`, and this is the v6 situation exactly. Both
// fields are on pings that were already committed when the reader learned to look
// for them, so a browser holding those files from an earlier visit stored them
// without either — and `hydrate` diffs on sha, which never changes, so the
// weather would stay invisible on that browser forever. One forced re-hydrate,
// free against the API budget, every body coming from the CDN.
//
// v9: the index record grew `start`, its `latest` sentinel became null, and folders
// holding only a course are runs. Two independent reasons, either enough on its own.
//
// The listing is fetched with `If-None-Match`, and the tree of a repo nobody has
// pushed to answers 304 — on which `refreshIndex` hands back the CACHED index,
// because the shape only ever changes when a body actually arrives. A browser
// holding the v8 tree would go on reading records with no `start` in them and with
// course-only folders already pruned out, and nothing would ever prompt it to look
// again: no countdown, no upcoming race in the picker, the whole feature invisible
// on exactly the machines that had visited before it shipped.
//
// And `lt.snap` now records the start its `along` values were computed against. A v8
// snap cache has no such field, so every pre-start ping in it is still snapped to
// the course, and nothing else in the version tuple can notice — a GPX renamed to
// move the gun keeps its blob sha. See `snapAll`.
//
// v10: points carry `bpm`, and this is the v6 and v8 situation a third time. The
// heart rate is already sitting in files that were committed before the reader
// learned to look for it, `hydrate` diffs on sha, and a sha never changes — so a
// browser holding those bodies from an earlier visit would go on showing a tooltip
// with no pulse in it forever. One forced re-hydrate, free against the API budget,
// every body coming from the CDN.
//
// v11: a run's scheduled start has left the index. It used to be read out of the
// course's FILENAME and folded into the tree record by `buildIndex`; it now comes
// from that run's `course_settings.json`, which is a separate file with a separate
// blob sha and its own cache. This is the v9 situation in reverse and it bites in
// the same place: the listing is fetched with `If-None-Match`, and a repo nobody has
// pushed to answers 304 — on which `refreshIndex` hands back the CACHED index. A
// browser holding the v10 tree would go on reading a `start` off records the new code
// never writes, so it would show a countdown sourced from a filename convention that
// no longer exists, and no settings edit could ever correct it.
//
// And `lt.snap` goes with it, for the reason it went at v9: every stored `along` was
// computed against a gun time, `snapAll` records which one, and the answer now comes
// from somewhere else entirely. A pre-gun ping snapped under the old start would keep
// its place on the course with nothing able to notice.
//
// v12: the index record grew a `media` map, and this is the v9 and v11 situation a
// third time. The listing is fetched with `If-None-Match`, and the tree of a repo
// nobody has pushed to answers 304 — on which `refreshIndex` hands back the CACHED
// index. A browser holding the v11 tree would go on reading records that have no
// `media` key in them at all, and nothing would ever prompt it to look again: no
// photograph on the map, ever, on exactly the machines that had visited before the
// feature shipped.
//
// v13: `MEDIA_RE` admits `.mp4`, `.m4v` and `.mov`, and this is v12 again in
// miniature. What decides whether a file is media is `buildIndex`, which runs over
// the tree — and the tree is the thing served from cache on a 304. A browser holding
// the v12 index has already sorted every existing file into `media` or `files` under
// the old pattern, and a clip that was ignored then stays ignored forever, however
// many times the page is reloaded. The one place the extension list is applied is the
// one place that never runs again.
//
// v14: `lt.snap` changed SHAPE, not merely values. `byName` used to hold each ping's
// chosen place on the course; it now holds the candidate places it could occupy, and
// the choosing happens on every load. A v13 entry read by this code is not a stale
// answer that the staleness tuple would catch — it is a `{along, lon, lat, ele, off}`
// where a list belongs, which is not wrong so much as unreadable. The tuple guards
// against caches computed under different ASSUMPTIONS; this is a different format,
// and only the namespace can catch it.
//
// v15: `parseExif` reads a caption, and `lt.media` is the cache that would hide it.
// That cache is diffed on BLOB SHA — a photograph is opened and parsed once ever per
// browser, which is the whole point of it — so a file whose bytes have not changed is
// never read again, however much the reader has learnt to look for since. The caption
// lives in bytes that were already downloaded and simply not looked at, and only a new
// namespace makes anything look.
//
// v16: `parseSettings` reads `crew`, and `lt.settings` is the cache that would hide
// it — the same trap as v15 one file over. Settings are diffed on the settings file's
// BLOB SHA, so a browser holding a v15 parse of a `course_settings.json` that has not
// been touched since will never fetch it again, and would hold a record with no crew
// in it forever. The list is already sitting in the file; only a new namespace makes
// anything read it. Which matters more here than a missing caption did: without it
// every crew photograph is silently treated as one of the runner's own, interpolated
// onto the course and counted into his distance.
const V = 'v16';

/**
 * Each run's caches get their own namespace, so switching runs never evicts the
 * one you came from. `snap` holds each ping's place on the course, which is the
 * expensive thing we only ever want to compute once per ping.
 *
 * `media` holds what each photo said about itself — a time, maybe a coordinate,
 * and nothing else. No pixels: a decoded thumbnail is megabytes and would empty
 * the 5 MB quota on a handful of files, while the images themselves are already
 * kept by the HTTP cache under a content-addressed URL. What is worth storing is
 * the EXIF read, because that is the part that costs a download.
 */
export function keysFor(run) {
  return {
    points: `lt.points.${V}.${run}`,
    snap: `lt.snap.${V}.${run}`,
    media: `lt.media.${V}.${run}`
  };
}

// The index: every run, its files and its latest ping, from one tree request.
// Not per-run, because one request covers them all.
export const LS_TREE      = `lt.tree.${V}`;
export const LS_TREE_ETAG = `lt.tree-etag.${V}`;

// Where every OTHER run was last seen: one small record per run, so the dots
// marking them are on screen before any network call. Not per-run for the same
// reason the tree isn't — it is one fact about all of them at once.
export const LS_BEACONS   = `lt.beacons.${V}`;

// What every run says about itself: one parsed `course_settings.json` per run, in
// one record. Not per-run, for the same reason the tree isn't — the picker labels
// every run and sorts the upcoming ones by their gun, so this is read for all of them
// on every paint and fetched for none of them most of the time.
//
// Held SEPARATELY from the index rather than folded into it, which is the whole
// design. The index's invalidation key is the tree ETag; a settings file's is its own
// blob sha. Merging them would put one value under two keys with only one ever
// checked, and since a 304 makes `refreshIndex` return the cached index untouched,
// the merged half would be permanently one poll stale.
export const LS_SETTINGS  = `lt.settings.${V}`;

// When the index was last fetched. Persisted so the refresh throttle survives a
// page reload — in memory it resets, and refresh-mashing spends the budget.
export const LS_REFRESH   = `lt.refresh.${V}`;

// There is no layer preference to store any more. The waypoints, the raw fixes
// and the visitor's own dot were three checkboxes and each of them had the same
// answer every time it was asked, so all three are simply on — see `pointLayers`
// and `createUi`.
