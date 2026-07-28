// Which run is being viewed, read from the URL:
//
//   /                     the unsorted feed — files sitting in locations/ itself
//   /?run=vendee-10k      one race — files in locations/vendee-10k/
//
// The full path form (?run=locations/vendee-10k) is accepted too, since that's
// the shape you'd copy out of a GitHub URL.

import { CONFIG } from './config.js';

/** Names we're willing to put in a URL path. Anything else is treated as absent. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * @param {string} search a `location.search` string, e.g. `?run=vendee-10k`
 * @returns {string|null} the run name, or null for the unsorted root feed.
 */
export function parseRun(search) {
  const raw = new URLSearchParams(search).get('run');
  if (!raw) return null;

  // Tolerate a leading `locations/` and any surrounding slashes; reject the rest
  // outright rather than half-cleaning it, so `..` can never reach a fetch URL.
  const name = raw.replace(/^\/*(locations\/)?/, '').replace(/\/+$/, '');
  return SAFE.test(name) ? name : null;
}

/** The repo path a run's files live under. */
export function dirFor(run) {
  return run ? `${CONFIG.dir}/${run}` : CONFIG.dir;
}

/** The page URL for a run — used by the picker. */
export function urlFor(run) {
  return run ? `?run=${encodeURIComponent(run)}` : '.';
}

export function currentRun() {
  return parseRun(globalThis.location?.search ?? '');
}
