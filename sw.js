// The service worker: what makes the page survive a bad connection, which on the
// races this thing is pointed at is most of them.
//
// The whole design is one rule applied four times — cache what cannot change, and
// never cache what must be fresh:
//
//   index.html, src/*.js    network-first with a short timeout, cache as the
//                           fallback. These are the files that change, they are
//                           small, and serving them stale is what turned a
//                           one-line CSS fix into four rounds of "did it land?".
//                           Online you are always current; offline you still open.
//   vendor/, icons/         cache-first. Big, and their names change when they do.
//   api.github.com          network only. Chiefly the listing, fetched with an
//                           ETag and `cache: 'no-store'`, which is the ONLY
//                           thing that says a new ping exists. A stale one here
//                           is a runner who has stopped moving. (The commits
//                           call behind it — which .gpx was uploaded last — is
//                           the same host, so this covers it too.)
//   raw.githubusercontent   cache-first WHEN the URL carries a sha, forever.
//                           `rawUrl` in github.js appends the blob sha as the
//                           query string, so such a URL is content-addressed and
//                           its body can never change. Without one it is a plain
//                           branch path, which can — so that goes to the network.
//   basemaps.cartocdn.com   cache-first, capped. The tiles you have looked at are
//                           the tiles you are standing on.
//   same origin             cache-first off the precache. The app shell.
//
// Updating: there is no update prompt and nothing ever calls `location.reload()`.
// Because the code above is network-first, an online launch is already current, so
// the only thing left to swap is this worker — and the standard lifecycle does
// that on the next cold start with no reload at all. Which is also the safer
// behaviour on iOS, where an installed app reloading itself has a history of
// coming back with a viewport the wrong shape.

// Bump on every deploy that changes a shell file. It is what evicts the old
// precache — the caches below are keyed by it, and `activate` deletes every cache
// whose name is not on the current list.
const VERSION = '13';

const SHELL = `shell-v${VERSION}`;
// Neither of these carries the version, and that is the point: they hold bytes
// that a deploy cannot invalidate — sha-addressed blobs and map tiles. Keying them
// to VERSION would throw away every ping and every tile of a race already being
// watched because a stylesheet changed, which is the opposite of what this is for.
const DATA = 'data-v1';
const TILES = 'tiles-v1';
const KEEP = [SHELL, DATA, TILES];

// ~40 KB per @2x tile, so this is a soft ceiling around 50 MB. Tiles are the only
// thing here that grows without bound; everything else is a fixed shell.
const TILE_LIMIT = 1200;
// Trimming walks every key, so it is far too expensive to do on each miss.
const TRIM_EVERY = 50;
let sinceTrim = 0;

// Everything the app needs to paint with no network at all. `test/sw.test.js`
// checks this against the actual contents of src/, so adding a module without
// adding it here fails the suite rather than quietly shipping a worker that
// misses it.
const SHELL_URLS = [
  './',
  './manifest.webmanifest',
  './vendor/deck.gl-9.3.7.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  // The marks the map and the height strip draw. Part of the shell rather than of
  // the data: they never change between deploys, and without them a course opened
  // offline draws every sunrise as a bare dot.
  //
  // No apostrophes in this comment on purpose: test/sw.test.js reads the list out
  // of this file with a regex over quoted strings, and one would look like an entry.
  './icons/sunrise.svg',
  './icons/sunset.svg',
  './icons/photo.svg',
  './icons/prev.svg',
  './icons/next.svg',
  './icons/expand.svg',
  './src/colors.js',
  './src/config.js',
  './src/course.js',
  './src/geo.js',
  './src/github.js',
  './src/glyphs.js',
  './src/gpx.js',
  './src/layers.js',
  './src/main.js',
  './src/map.js',
  './src/media.js',
  './src/news.js',
  './src/pin.js',
  './src/points.js',
  './src/predict.js',
  './src/profile.js',
  './src/route.js',
  './src/schedule.js',
  './src/settings.js',
  './src/shot.js',
  './src/snap.js',
  './src/stats.js',
  './src/sun.js',
  './src/sw-register.js',
  './src/ui.js',
  './src/util.js',
];

self.addEventListener('install', event => {
  // `addAll` is atomic: one 404 and the whole install fails, leaving the previous
  // worker in charge. That is the right failure — a half-populated precache would
  // serve an app shell with a hole in it.
  event.waitUntil(caches.open(SHELL).then(cache => cache.addAll(SHELL_URLS)));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map(n => (KEEP.includes(n) ? null : caches.delete(n))));
    // Take over the pages that are already open. Safe here in a way it would not
    // be mid-session: nothing activates until the page has asked it to.
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;

  // Not returning a response at all is the cleanest "network only": the browser
  // does exactly what it would have done with no worker installed, including
  // honouring the `no-store` and `If-None-Match` that github.js sets by hand.
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    // Only the app's own URL. Answering every same-origin navigation with the
    // shell would shadow any other page ever added to this repo, including a
    // debug page written specifically to be readable when the shell is suspect.
    const scope = new URL(self.registration.scope).pathname;
    if (url.pathname === scope || url.pathname === `${scope}index.html`) {
      event.respondWith(shell());
    }
    return;
  }

  // Deliberately before the same-origin branch: this is the app's own code, and
  // it is the one thing here that must never be a deploy behind.
  if (url.origin === self.location.origin && url.pathname.includes('/src/')) {
    event.respondWith(fresh(req));
    return;
  }

  if (url.hostname === 'api.github.com') return;

  if (url.hostname === 'raw.githubusercontent.com') {
    // `?<sha>` means content-addressed. See `rawUrl`.
    if (url.search) event.respondWith(immutable(req));
    return;
  }

  if (url.hostname.endsWith('basemaps.cartocdn.com')) {
    event.respondWith(tile(req));
    return;
  }

  if (url.origin === self.location.origin) event.respondWith(asset(req));
});

/** How long the network gets before the cache answers instead. */
const NET_TIMEOUT = 3000;

/** `promise`, but rejecting if it has not settled within `ms`. */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * The app shell. Network-first, so an online launch is never a deploy behind, with
 * the precached copy behind a 3 s timeout so a bad connection costs three seconds
 * rather than the whole page. `ignoreSearch` because every deep link into this app
 * is the same document with a different `?run=` on it.
 */
async function shell() {
  const cache = await caches.open(SHELL);
  try {
    const res = await withTimeout(fetch('./', { cache: 'no-store' }), NET_TIMEOUT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cache.put('./', res.clone()).catch(() => {});
    return res;
  } catch {
    const cached = await cache.match('./', { ignoreSearch: true });
    return cached || Response.error();
  }
}

/** One of the app's own modules, on the same terms as the shell. */
async function fresh(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await withTimeout(fetch(req, { cache: 'no-store' }), NET_TIMEOUT);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    const cached = await cache.match(req);
    return cached || Response.error();
  }
}

/** A precached file, with the network as the fallback for anything not in it. */
async function asset(req) {
  const cached = await caches.match(req, { cacheName: SHELL });
  if (cached) return cached;
  return fetch(req);
}

/**
 * A sha-addressed blob: cache-first and never revalidated, because the URL cannot
 * point at different bytes tomorrow. This is what makes a run you have already
 * watched replay with no network.
 */
async function immutable(req) {
  const cache = await caches.open(DATA);
  const cached = await cache.match(req);
  if (cached) return cached;

  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

/** A basemap tile: cache-first, and trimmed back to `TILE_LIMIT` now and then. */
async function tile(req) {
  const cache = await caches.open(TILES);
  const cached = await cache.match(req);
  if (cached) return cached;

  const res = await fetch(req);

  // An opaque response cannot be `put` at all — it throws rather than returning a
  // rejected promise in some engines, hence the try. Tiles come back CORS-clean
  // in practice; when they do not, the map still draws, it just will not persist.
  if (res.ok && res.type !== 'opaque') {
    try {
      await cache.put(req, res.clone());
      if (++sinceTrim >= TRIM_EVERY) {
        sinceTrim = 0;
        await trim(cache);
      }
    } catch { /* quota, or an opaque response after all */ }
  }

  return res;
}

/**
 * Evict oldest-first back to the cap. `cache.keys()` resolves in insertion order,
 * so this is FIFO rather than true LRU — for map tiles the two barely differ, and
 * an exact LRU would mean writing an access timestamp on every hit.
 */
async function trim(cache) {
  const keys = await cache.keys();
  const excess = keys.length - TILE_LIMIT;
  for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
}
