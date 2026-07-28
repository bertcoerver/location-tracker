// Everything environment-specific lives here, so nothing below has to be edited
// to point the map at a different repo.

export const CONFIG = {
  owner:  'bertcoerver',
  repo:   'location-tracker',
  branch: 'main',
  dir:    'locations',

  // GitHub allows 60 API requests/hour PER IP, and a 304 costs the same as a
  // 200 — measured, despite the docs saying conditional requests are free. Each
  // poll is one request, so this rate is a budget split between everyone behind
  // the same connection: 240s = 15/hour, leaving room for four viewers.
  pollMs: 240000,
  minRefreshMs: 30000, // floor between refreshes, however they were triggered
  runsTtlMs: 3600000,  // subfolders appear when you create a race, not every poll
  concurrency: 8,      // parallel file fetches on a cold start
  maxZoom: 17          // this tracker often sits still; don't zoom into the void
};

// localStorage keys. Bump the version suffix when the cached shape changes —
// old entries are then ignored instead of misread.
const V = 'v3';

/**
 * Each run gets its own cache namespace. Without this, switching runs would
 * diff a new listing against another run's points and refetch everything.
 * `run` is null for the unsorted feed at the root of `locations/`.
 */
export function keysFor(run) {
  const suffix = run ? `.${run}` : '';
  return {
    points: `lt.points.${V}${suffix}`,
    etag:   `lt.etag.${V}${suffix}`,
    // When this run was last fetched. Persisted so the refresh throttle survives
    // a page reload — in memory it resets, and refresh-mashing spends the budget.
    // Keyed per run so opening a different one is never made to wait.
    refresh: `lt.refresh.${V}${suffix}`
  };
}

// The directory listing used to discover which runs exist. Cached separately
// because it's the parent of every run's own listing.
export const LS_RUNS      = `lt.runs.${V}`;
export const LS_RUNS_ETAG = `lt.runs-etag.${V}`;
export const LS_RUNS_AT   = `lt.runs-at.${V}`;
