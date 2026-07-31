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

// An ISO 8601 timestamp, allowing `_` wherever a colon belongs. Anchored to
// nothing, so it is found wherever in the string it sits.
const STAMP = /(\d{4}-\d{2}-\d{2})T(\d{2})[_:](\d{2})(?:[_:](\d{2}))?(Z|[+-]\d{2}[_:]?\d{2})?/;

/**
 * A scheduled time written by hand, or null if there isn't one.
 *
 * This is how a run announces when its race starts: `start_datetime` in its
 * `course_settings.json` — the one fact about a run that no ping could ever carry,
 * because the whole use of it is to be known before any ping exists.
 *
 * The `_`-for-`:` tolerance is why this is not `Date.parse`, and it is not
 * historical. Filenames in this repo cannot hold a colon, so every timestamp anyone
 * here has ever typed writes the UTC offset as `+02_00` — and that form, carried
 * across into a JSON file where it is perfectly legible, is exactly what
 * `Date.parse` returns NaN on. Both spellings mean the same instant to a reader, so
 * both mean it here.
 *
 * Also deliberately NOT [`parseTime`](#parseTime), which reads the whole basename
 * and so chokes on anything either side of the timestamp. The contracts differ too:
 * a ping with no parsable time is a broken ping and gets NaN, while a run that named
 * no start is the ordinary case and gets null.
 *
 * A date needs a time beside it to count. `2026-08-28` alone would have to be read
 * as midnight in some zone, and a gun time invented out of nothing is worse than
 * no gun time at all. Seconds are optional because nobody writes `:00` for a race
 * that starts on the hour. With no offset the browser's own zone is used, which is
 * what someone typing a local start time meant — though a race is watched from
 * elsewhere as often as not, so writing the offset is always the better answer.
 *
 * `+0200` with no separator is accepted and normalised rather than handed to
 * `Date.parse` as-is. That form is unambiguous to a reader, but only `±HH:MM` is
 * actually specified and engines differ on the rest — and of the three available
 * outcomes, a gun time silently landing two hours out on one browser is the worst.
 */
export function parseStamp(name) {
  const m = STAMP.exec(String(name ?? ''));
  if (!m) return null;
  const [, date, h, min, s = '00', zone = ''] = m;
  // `+02_00`, `+02:00` and `+0200` all become `+02:00`. `Z` and absent pass through.
  const tz = zone && zone !== 'Z' ? `${zone.slice(0, 3)}:${zone.slice(-2)}` : zone;
  const t = Date.parse(`${date}T${h}:${min}:${s}${tz}`);
  return Number.isNaN(t) ? null : t;
}

const DAY_MS = 86400000;

const pad2 = n => String(n).padStart(2, '0');

/**
 * A wall-clock time in the viewer's own zone: "14:06:01". 24-hour, always.
 *
 * Built by hand rather than by `Intl.DateTimeFormat`, which is what this used to
 * be. The formatter can be told the hour cycle, but not to stop being localised:
 * with an undefined locale it still picks its own separator, its own numerals and
 * its own idea of whether a leading zero belongs there. This app shows one wording
 * everywhere and there is nothing left for a locale to decide — the DATE is gone
 * from every reading (see `dayTag` for what replaced it), and what remains is
 * three numbers and two colons.
 *
 * The zone is still the viewer's, which is the one thing a local `Date` is for: a
 * race is watched from wherever it is watched from, and the times of day worth
 * seeing are the ones on the watch of whoever is looking.
 */
export function fmtClock(t) {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * The same clock without the seconds, for times nobody measured.
 *
 * Everything a ping reports is exact to the second and shown with `fmtClock`. A
 * forecast is exact to about ten minutes, and quoting "13:24:40" for it would be
 * claiming a precision the band printed beside it explicitly denies.
 */
export function fmtHm(t) {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * Which day of the run a moment falls on, counted in LOCAL CALENDAR days from
 * `origin`: 0 on the day of the start, 1 on the morning after, -1 the evening
 * before.
 *
 * Calendar days and not 24-hour blocks, which is the whole reason this isn't a
 * division. A race starting at 06:00 and finishing at 22:00 the same evening is
 * sixteen hours long and is entirely day 0; one starting at 23:30 and finishing at
 * 00:30 is one hour long and crosses into day 1. The question being answered is
 * "which morning is this", and only a calendar answers it.
 *
 * Each timestamp is asked for its OWN UTC offset rather than sharing one, so a
 * race that runs through a daylight-saving change still counts days the way the
 * clock on the wall did.
 */
export function dayOffset(t, origin) {
  const localDay = ms => {
    // `getTimezoneOffset` is minutes to ADD to local to reach UTC, so subtracting
    // it shifts the instant to a UTC value whose date parts are the local ones.
    const d = new Date(ms);
    return Math.floor((ms - d.getTimezoneOffset() * 60000) / DAY_MS);
  };
  return localDay(t) - localDay(origin);
}

/**
 * "+1" for a moment on a later calendar day than the run's start, "-1" for an
 * earlier one, and "" — nothing at all — for the ordinary case.
 *
 * What a full date used to do, in two characters. A tooltip on a one-day run has
 * no business repeating the date four hundred times, and a tooltip on a two-day
 * ultra cannot leave it out: "09:12" on its own is a lie about which morning. The
 * one fact the date was carrying is which day of the RACE it is, and that is a
 * single digit.
 *
 * The negative is offered as readily as the positive. A warm-up ping sent the
 * evening before a 06:00 start really is on the day before, and a run whose
 * pre-gun fixes silently read as day 0 would be hiding the thing that makes them
 * pre-gun.
 *
 * @param {number|null} origin the run's start, from `originOf`. Null — a run with
 *   nothing raced yet — means there is no race day to number from, so no tag.
 */
export function dayTag(t, origin) {
  if (origin === null || origin === undefined || !Number.isFinite(origin)) return '';
  const days = dayOffset(t, origin);
  return days === 0 ? '' : days > 0 ? `+${days}` : String(days);
}

/**
 * A pace, as minutes and seconds per kilometre: "5:32".
 *
 * Deliberately not capped at an hour the way `fmtElapsed` isn't: a runner walking
 * a steep col really does take 22 minutes over a kilometre, and "22:14" is the
 * fact. The unit is left to the caller to write, since a bare "5:32" beside a
 * stopwatch icon would read as a duration.
 *
 * @param {number} msPerKm
 */
export function fmtPace(msPerKm) {
  const s = Math.max(0, Math.round(msPerKm / 1000));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

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
 * Time until something: "29d 18h" while it is far off, "4:31:07" inside the last
 * day.
 *
 * Two shapes on purpose. [`fmtElapsed`](#fmtElapsed) alone would render a race
 * four weeks out as "700:18:42", which is arithmetically correct and completely
 * unreadable — hours stop being a unit anyone can hold somewhere around fifty of
 * them. And seconds ticking on a four-week countdown is precision nobody asked
 * for, while the last day before a race is exactly where they start to matter.
 *
 * Under a day it IS `fmtElapsed`, so the countdown and the elapsed clock it turns
 * into at the gun are typeset identically and the digits don't jump when it flips.
 */
export function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 86400) return fmtElapsed(s * 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  // No minutes at this range: "29d 18h 42m" is three units of a number that is
  // going to be read once and remembered as "about a month".
  return h ? `${d}d ${h}h` : `${d}d`;
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
