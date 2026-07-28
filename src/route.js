// Which run is being viewed, read from the URL:
//
//   /                     whichever run pinged most recently — "show me the race"
//   /?run=vendee-10k      one race, pinned: files in locations/vendee-10k/
//
// The full path form (?run=locations/vendee-10k) is accepted too, since that's
// the shape you'd copy out of a GitHub URL.
//
// Every view is a run. Files sitting loose in locations/ belong to none and are
// never shown — see `buildIndex` in github.js.

/** Names we're willing to put in a URL path. Anything else is treated as absent. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * @param {string} search a `location.search` string, e.g. `?run=vendee-10k`
 * @returns {string|null} the pinned run, or null to mean "pick the newest".
 */
export function parseRun(search) {
  const raw = new URLSearchParams(search).get('run');
  if (!raw) return null;

  // Tolerate a leading `locations/` and any surrounding slashes; reject the rest
  // outright rather than half-cleaning it, so `..` can never reach a fetch URL.
  const name = raw.replace(/^\/*(locations\/)?/, '').replace(/\/+$/, '');
  return SAFE.test(name) ? name : null;
}

/** The page URL for a run — used by the picker. */
export function urlFor(run) {
  return run ? `?run=${encodeURIComponent(run)}` : '.';
}

/** The run pinned by the current URL, or null if it's asking for the newest. */
export function pinnedRun() {
  return parseRun(globalThis.location?.search ?? '');
}
