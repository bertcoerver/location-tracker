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

/** "3m ago" — coarse on purpose; the exact time is in the tooltip. */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
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
