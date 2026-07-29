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

  // --- the height profile strip --------------------------------------------
  profileHeight: 112,
  profileMinWidth: 640, // narrower than this and the profile scrolls rather than squashes
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
const V = 'v6';

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

// When the index was last fetched. Persisted so the refresh throttle survives a
// page reload — in memory it resets, and refresh-mashing spends the budget.
export const LS_REFRESH   = `lt.refresh.${V}`;

// Which optional layers are switched on. Not per-run: turning the raw fixes off
// is a preference about how you like to read the map, not a fact about a race.
export const LS_LAYERS    = `lt.layers.${V}`;
