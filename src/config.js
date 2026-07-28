// Everything environment-specific lives here, so nothing below has to be edited
// to point the map at a different repo.

export const CONFIG = {
  owner:  'bertcoerver',
  repo:   'location-tracker',
  branch: 'main',
  dir:    'locations',

  pollMs: 120000,      // 30 requests/hour — inside the 60/hr unauthenticated budget
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
  return { points: `lt.points.${V}${suffix}`, etag: `lt.etag.${V}${suffix}` };
}

// The directory listing used to discover which runs exist. Cached separately
// because it's the parent of every run's own listing.
export const LS_RUNS      = `lt.runs.${V}`;
export const LS_RUNS_ETAG = `lt.runs-etag.${V}`;
