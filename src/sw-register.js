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
 * @param {object} opts
 * @param {(reload: () => void) => void} opts.onUpdateReady called when a new
 *   version is installed and waiting. The argument applies it and reloads.
 */
export function registerSw({ onUpdateReady }) {
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

    // Set only when the reload is one we asked for. `controllerchange` also fires
    // the first time a worker claims the page, and reloading there would bounce
    // every first-time visitor for no reason.
    let applying = false;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (applying) location.reload();
    });

    const offer = worker => onUpdateReady(() => {
      applying = true;
      worker.postMessage('SKIP_WAITING');
    });

    // Already waiting when the page opened — a version installed during an earlier
    // visit that was never applied.
    if (reg.waiting) offer(reg.waiting);

    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        // `installed` with a controller already in place means an update. Without
        // one it is the first install, which is not something to interrupt anyone
        // about: it is already doing its job.
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          offer(worker);
        }
      });
    });

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
