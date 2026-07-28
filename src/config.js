// Everything environment-specific lives here, so nothing below has to be edited
// to point the map at a different repo.

export const CONFIG = {
  owner:  'bertcoerver',
  repo:   'location-tracker',
  branch: 'main',
  dir:    'locations',

  // GitHub allows 60 API requests/hour PER IP, and a 304 costs the same as a
  // 200 — measured, despite the docs saying conditional requests are free. One
  // poll is one request whatever the run count, so this rate is a budget split
  // between everyone behind the same connection: 240s = 15/hour, room for four.
  pollMs: 240000,
  minRefreshMs: 30000, // floor between refreshes, however they were triggered
  liveMs: 3600000,     // a run with a ping this recent is still running
  concurrency: 8,      // parallel file fetches on a cold start
  maxZoom: 17          // this tracker often sits still; don't zoom into the void
};

// localStorage keys. Bump the version suffix when the cached shape changes —
// old entries are then ignored instead of misread.
const V = 'v4';

/**
 * Each run's points get their own cache namespace, so switching runs never
 * evicts the one you came from.
 */
export function keysFor(run) {
  return { points: `lt.points.${V}.${run}` };
}

// The index: every run, its files and its latest ping, from one tree request.
// Not per-run, because one request covers them all.
export const LS_TREE      = `lt.tree.${V}`;
export const LS_TREE_ETAG = `lt.tree-etag.${V}`;

// When the index was last fetched. Persisted so the refresh throttle survives a
// page reload — in memory it resets, and refresh-mashing spends the budget.
export const LS_REFRESH   = `lt.refresh.${V}`;
