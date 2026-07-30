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
  minPingMs: 300000,
  maxPingMs: 1800000,
  batteryK: 0.3,
  batteryMid: 25,

  pollGuardMs: 30000, // the commit still has to land AND reach the tree API
  maxPollMs: 900000,  // backoff cap, and the floor poll on a long wait
  // How late a ping can be before we stop treating it as jitter. The interval
  // predicts when the phone WAKES; it then has to take a fix, upload it, and
  // have the commit reach the API, so a little slippage means nothing. Past
  // this it has genuinely missed its slot, and since a failed upload is retried
  // on its NEXT poll rather than on its own, there is nothing to find until then.
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

  // --- snapping pings onto a run's course, when it has a .gpx ---------------
  snapMeters: 500,     // further than this from the course and a ping is left where it is
  // Both of these are metres of cost per metre of movement, so they're directly
  // comparable to how far off-course a fix is. Backwards is all but forbidden;
  // forwards is only nudged — enough to break a circular course's start/finish
  // tie, not enough to fight real progress. See snap.js for the reasoning.
  snapBackPenalty: 1,
  snapForwardBias: 0.02,
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
  profileSmoothPx: 3
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
const V = 'v10';

/**
 * Each run's caches get their own namespace, so switching runs never evicts the
 * one you came from. `snap` holds each ping's place on the course, which is the
 * expensive thing we only ever want to compute once per ping.
 */
export function keysFor(run) {
  return {
    points: `lt.points.${V}.${run}`,
    snap: `lt.snap.${V}.${run}`
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

// When the index was last fetched. Persisted so the refresh throttle survives a
// page reload — in memory it resets, and refresh-mashing spends the budget.
export const LS_REFRESH   = `lt.refresh.${V}`;

// There is no layer preference to store any more. The waypoints, the raw fixes
// and the visitor's own dot were three checkboxes and each of them had the same
// answer every time it was asked, so all three are simply on — see `pointLayers`
// and `createUi`.
