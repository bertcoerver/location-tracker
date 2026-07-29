// Small, dependency-free helpers. Everything here is a pure function except
// `storage`, which is a thin guard around localStorage.

/**
 * Location filenames are ISO 8601 with every colon replaced by `_`:
 *   `2026-07-28T12_06_01+02_00.json` -> `2026-07-28T12:06:01+02:00`
 * The capture time exists ONLY in the filename — there is no time field in the
 * body — so this is the single source of truth for when a fix happened.
 *
 * @returns {number} epoch milliseconds, or NaN if the name doesn't parse.
 */
export function parseTime(name) {
  return Date.parse(name.replace(/\.json$/, '').replace(/_/g, ':'));
}

export const fmtTime = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeStyle: 'medium'
});

export const fmtClock = new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' });

/**
 * A clock time without the seconds, for times nobody measured.
 *
 * Everything a ping reports is exact to the second and shown with `fmtClock`. A
 * forecast is exact to about ten minutes, and quoting "13:24:40" for it would be
 * claiming a precision the band printed beside it explicitly denies.
 */
export const fmtHm = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

/**
 * A duration in one unit: "45s", "3m", "2h", "4d".
 *
 * Coarse on purpose. It answers "is this still warm", which needs one glanceable
 * number, not a precise one — the exact time is in the tooltip. Both directions
 * of that question share this rounding: [`ago`](#ago) looks backwards and the
 * panel's "next ~17m" looks forwards, and two sets of thresholds that were meant
 * to agree would eventually stop agreeing.
 *
 * Negative spans clamp to zero: a countdown that has run out reads "0s", and
 * whoever asked is expected to say something better than that.
 */
export function coarse(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60)    return `${s}s`;
  if (s < 3600)  return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** "3m ago" — see [`coarse`](#coarse) for why it's this rough. */
export function ago(ms, now = Date.now()) {
  return `${coarse(now - ms)} ago`;
}

/**
 * An exact span between two moments: "12s", "4m 12s", "1h 23m".
 *
 * Not [`ago`](#ago), which is deliberately coarse because it answers "is this
 * still warm" about a single moving number. This one sits in a tooltip next to
 * the timestamp it was measured from, where rounding 4m 12s to "4m" throws away
 * the part being read.
 *
 * Two units at most — an hour and a half is 1h 30m, and nobody wants the
 * seconds by then.
 */
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest ? `${m}m ${rest}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  // 59.6 minutes rounding to 60 would read "1h 60m".
  return m === 60 ? `${h + 1}h` : m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * A race clock: "0:04:12", "2:14:07". Always h:mm:ss, so the digits sit still
 * as it ticks rather than shuffling sideways when a unit rolls over.
 */
export function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const pad = n => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}

/**
 * A Google Maps deep link for a coordinate, optionally naming the pin.
 *
 * Six decimals is about 10 cm, which is well past what a phone's GPS knows.
 *
 * Two URL forms, and the choice is forced. `search/?api=1&query=` is the
 * documented one, but `query` takes EITHER a coordinate or a place name: pass a
 * name and Google moves the pin to whatever it matched, which is worse than the
 * blank info card you get from a coordinate. The `?q=lat,lon(Label)` form is the
 * older scheme Google no longer documents, and it is the only one that drops a
 * pin at an exact coordinate and labels it. So: labelled links take the old
 * form, and anything without a label stays on the supported one.
 *
 * The parentheses are the delimiters, so a label containing one would break the
 * parse — those come out. Everything else is percent-encoded.
 */
export function mapsUrl(lat, lon, label = '') {
  const at = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  const name = label.replace(/[()]/g, '').trim();
  return name
    ? `https://maps.google.com/?q=${at}(${encodeURIComponent(name)})`
    : `https://www.google.com/maps/search/?api=1&query=${at}`;
}

/** Run `fn` over `items` with at most `n` in flight. Order of results is not guaranteed. */
export async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) out.push(await fn(items[i++]));
    })
  );
  return out;
}

/**
 * Wraps `fn` so it runs at most once per `ms`, and never concurrently with
 * itself. Calls arriving too soon are DROPPED rather than queued — this guards
 * a poll, so a stale skip is harmless and a backlog of them is not.
 *
 * @param {object}        [opts]
 * @param {() => number}  [opts.now]   injectable clock, so this is testable without timers.
 * @param {{get: () => number, set: (t: number) => void}} [opts.store]
 *   where the last-run time is kept. Defaults to memory, which resets on reload;
 *   pass `persistedAt()` to make the interval survive one.
 */
export function throttle(fn, ms, { now = Date.now, store = memoryStore() } = {}) {
  let inFlight = null;

  return (...args) => {
    if (inFlight) return inFlight;                 // coalesce, don't stack
    if (now() - store.get() < ms) return Promise.resolve();
    store.set(now());
    inFlight = Promise.resolve(fn(...args)).finally(() => { inFlight = null; });
    return inFlight;
  };
}

function memoryStore() {
  let last = -Infinity;
  return { get: () => last, set: t => { last = t; } };
}

/**
 * A throttle store backed by localStorage, so the interval outlives the page.
 * Falls back to memory semantics when storage is unavailable (`storage.get`
 * returns null), which is the safe direction: refresh rather than block.
 */
export function persistedAt(key) {
  return {
    get: () => Number(storage.get(key)) || -Infinity,
    set: t => storage.set(key, t)
  };
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/**
 * localStorage is a cache, never a source of truth. In private mode or over
 * quota it throws, so every call is guarded and failure is reported rather than
 * thrown — the map keeps working from memory, it just refetches on reload.
 */
export const storage = {
  get(key) {
    try {
      const raw = globalThis.localStorage?.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  /** @returns {boolean} whether the value was actually persisted. */
  set(key, value) {
    try {
      globalThis.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      globalThis.localStorage.removeItem(key);
    } catch { /* nothing to do */ }
  }
};
