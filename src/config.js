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
export const LS_POINTS = 'lt.points.v2';
export const LS_ETAG   = 'lt.etag.v2';
