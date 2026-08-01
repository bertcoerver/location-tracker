// Installs the service worker and owns the one decision it deliberately does not
// make for itself: when to swap a new version in. See sw.js.
//
// Nothing here is load-bearing. Every failure path — no support, an insecure
// origin, a registration that throws — leaves a page that works exactly as it did
// before any of this existed, just without the offline cache.

// How often a page that has been left open bothers to ask whether it has been
// redeployed. Cheap (one conditional request for sw.js) but not free, and a race
// is watched for hours.
const CHECK_MS = 30 * 60 * 1000;

/**
 * There is no update callback and nothing here reloads the page.
 *
 * There used to be: a "new version is ready" line with a Reload beside it. It went
 * because of two things measured on a phone. The worker serves index.html and
 * src/ network-first now, so an online launch is ALREADY current and there was
 * nothing left for the reload to fetch. And reloading a standalone web app on iOS
 * makes it lose `viewport-fit=cover` — the viewport shrinks by the height of the
 * status bar but stays pinned to the top, leaving a band of screen along the
 * bottom that is outside the layout viewport and that no stylesheet can paint.
 * The button offering to fix the app was the thing breaking it.
 *
 * The new worker takes over on the next cold start, which is the standard
 * lifecycle and needs no help.
 */
export function registerSw() {
  // `isSecureContext` covers localhost as well as https, so the dev server gets
  // the worker too — worth knowing when a change to src/ seems not to land.
  if (!('serviceWorker' in navigator) || !globalThis.isSecureContext) return;

  // After `load`, so that fetching the worker and precaching a megabyte and a half
  // of deck.gl never competes with the first paint.
  addEventListener('load', async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    } catch {
      return;
    }

    // A tab left open on a race weekend would otherwise never notice a deploy.
    let checked = Date.now();
    const check = () => {
      if (document.hidden || Date.now() - checked < CHECK_MS) return;
      checked = Date.now();
      reg.update().catch(() => {});
    };
    document.addEventListener('visibilitychange', check);
    setInterval(check, CHECK_MS);
  });
}
