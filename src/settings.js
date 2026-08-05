// What a run says about itself: `locations/<run>/course_settings.json`.
//
// Everything else the page knows about a run is DERIVED — the pings are measured,
// the course is measured, and the folder name is whatever somebody typed. This file
// is the only place a run gets to make a STATEMENT: what it is called, when it
// starts, what the phone in its pocket is doing, who else is out there with a
// camera, and what it wants to tell you.
//
// The whole file is optional, and so is every field in it. A run with no settings
// behaves exactly as runs did before this existed, and a run naming one field gets
// that field and the defaults for the rest. That is not politeness, it is the only
// shape that works: these files are written by hand, mid-race, on a phone, and a
// parser that rejects the whole document over one bad number would take a race's
// name off the screen because its distance was typed as "165 km".
//
// So every field is read the way `fetchPoint` reads a ping's optional ones: taken if
// it is the shape it should be, dropped without comment if it isn't. The one
// exception is `ping_frequency`, and the reason is below.

import { CONFIG } from './config.js';
import { parseStamp } from './util.js';

/** A number, or undefined — never NaN, never a numeric string that lied. */
function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The four constants of the phone's ping curve, as this run reports them.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS A FILE IN A REPO REACHING INTO THE POLL SCHEDULER, so it is the  │
 * │ one thing here that is clamped rather than merely validated.             │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * `nextPollMs` sleeps for about one ping interval, and GitHub allows 60 API
 * requests an hour per IP. A `min_interval` of 0 — a plausible typo, and the
 * default value of an empty form field — makes every branch of that function
 * return the 30-second floor, which spends the entire hourly budget in half an
 * hour and locks the map out for everyone behind the same connection, on every run,
 * until the reset. Nothing on screen would say why.
 *
 * Hence `pingFloorMs`. And hence the all-or-nothing rule: a curve with a sane `min`
 * and a nonsense `max` is not four independent numbers, it is one shape, and half
 * of it applied to the other half of the default is a curve nobody chose. A
 * malformed block falls back to CONFIG entirely, which is a curve somebody did.
 *
 * Note the units, which are NOT uniform and are the likeliest thing to get wrong:
 * `min_interval` and `max_interval` are MINUTES, `k` is per battery-percentage-
 * point, and `midpoint` is a PERCENTAGE. Only the first two are times.
 *
 * @returns {{minPingMs, maxPingMs, batteryK, batteryMid}|undefined}
 */
function parsePing(raw) {
  if (!raw || typeof raw !== 'object') return undefined;

  // Each key independently falls back, so `{ "midpoint": 20 }` is a legal file that
  // moves the knee of the curve and leaves its ends where the phone's script has them.
  const minPingMs  = raw.min_interval === undefined ? CONFIG.minPingMs : positive(raw.min_interval) * 60000;
  const maxPingMs  = raw.max_interval === undefined ? CONFIG.maxPingMs : positive(raw.max_interval) * 60000;
  const batteryK   = raw.k === undefined ? CONFIG.batteryK : positive(raw.k);
  const batteryMid = raw.midpoint === undefined ? CONFIG.batteryMid : Number(raw.midpoint);

  // `positive` returns undefined on anything unusable, and `undefined * 60000` is
  // NaN, so one finite check catches every way the four could have been mistyped.
  if (![minPingMs, maxPingMs, batteryK, batteryMid].every(Number.isFinite)) return undefined;

  // A battery percentage. Outside 0..100 the logistic still evaluates, but it has
  // stopped being a curve about a battery — the knee sits somewhere no phone can
  // reach, so the interval is pinned at one end for the whole run.
  if (batteryMid < 0 || batteryMid > 100) return undefined;
  if (minPingMs < CONFIG.pingFloorMs) return undefined;
  // Not `<`: equal ends are a legal fixed-interval curve, and the logistic handles
  // it — `min + 0 / anything` is `min` at every battery level.
  if (maxPingMs < minPingMs) return undefined;

  return { minPingMs, maxPingMs, batteryK, batteryMid };
}

/**
 * One run's settings file, normalised into the shape the rest of the app reads.
 *
 * Pure, and the only place the layout of that file is interpreted — the same role
 * `buildIndex` plays for the layout of the repo.
 *
 * Keys are ABSENT rather than null when the file didn't say, so `??` works all the
 * way down and a caller can't accidentally read "no label" as a label.
 *
 * `id` is deliberately not returned. It is there for whoever is editing the file, so
 * a settings block pasted into the wrong folder is visible to a human reading it;
 * the folder name is what the URL, the caches and the beacons key on, and letting a
 * file rename its own run would mean a run that is one thing to the tree API and
 * another to everything downstream.
 *
 * @param {object} raw the parsed JSON body.
 * @returns {{label?, start?, ping?, banner?, distance?, totalAscent?, maxSpeed?, crew?,
 *            runner?}}
 */
export function parseSettings(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  // Trimmed, because a label is measured to size the heading and trailing space
  // measures as width. Empty after trimming is the same as absent: the folder name
  // is a better answer than a blank heading.
  if (typeof raw.label === 'string' && raw.label.trim()) out.label = raw.label.trim();

  // Who else is out there with a camera. See `crewOf` in media.js for what a name
  // here does: it makes `MARIAM_*.jpg` a photograph of the CREW rather than of the
  // runner, which changes where it may be drawn and whether it may be drawn at all.
  //
  // Casing is preserved rather than normalised, because this string is shown to a
  // reader on the photograph's card. The ALL-CAPS rule belongs to the filename, and
  // is applied there — a name is written here the way its owner writes it.
  //
  // Members are filtered individually rather than the list being rejected whole,
  // which is the same bargain every other field here makes and not the one
  // `parsePing` makes: four numbers are one curve and half of it is nobody's, but a
  // list of people with one blank in it is still a list of people.
  if (Array.isArray(raw.crew)) {
    const crew = raw.crew
      .filter(name => typeof name === 'string' && name.trim())
      .map(name => name.trim());
    if (crew.length) out.crew = crew;
  }

  // And who is running, when the run cares to say. Read like `label` and used for
  // one thing: signing the photographs that are his, the way a crew member's are
  // signed with theirs.
  //
  // Optional in the way that matters — a run that names nobody credits nobody, and
  // its photographs are captioned exactly as they were before this existed. The
  // byline is only worth drawing on every picture in a folder when there is a
  // second person's name it could have said instead.
  if (typeof raw.runners_name === 'string' && raw.runners_name.trim()) {
    out.runner = raw.runners_name.trim();
  }

  // `parseStamp` rather than `Date.parse`, and this is not incidental. The convention
  // this repo already uses for times writes the UTC offset as `+02_00`, because a
  // colon cannot go in a filename — and that form, pasted into JSON where it is
  // perfectly legible and perfectly wrong, is exactly what `Date.parse` returns NaN
  // on. `parseStamp` normalises `+02_00`, `+02:00` and `+0200` alike, so a start time
  // copied from a filename means what it looks like it means. See util.js.
  const start = parseStamp(raw.start_datetime);
  if (start !== null) out.start = start;

  const ping = parsePing(raw.ping_frequency);
  if (ping) out.ping = ping;

  if (typeof raw.news_banner === 'string' && raw.news_banner.trim()) {
    out.banner = raw.news_banner.trim();
  }

  // Kilometres and metres, as a race announces them rather than as the GPX measures
  // them. Both are stated facts and both win over the measurement when present — an
  // official 165 km is what the race is, whatever a traced route adds up to.
  const distance = positive(raw.distance);
  if (distance !== undefined) out.distance = distance;

  const totalAscent = positive(raw.total_ascent);
  if (totalAscent !== undefined) out.totalAscent = totalAscent;

  // km/h, and the only field here that the SNAPPING reads. How fast a leg of this
  // particular run may imply the runner went before the snapper starts doubting
  // the fix rather than believing it. A stated fact like the two above, and for
  // the same reason: `along` measures progress along the PLANNED route, so a
  // course whose paths turned out not to exist on the ground is one where cutting
  // the plan short is normal and the ceiling has to be loose enough to allow it.
  // Absent, `CONFIG.snapMaxSpeedKmh` applies.
  const maxSpeed = positive(raw.max_speed);
  if (maxSpeed !== undefined) out.maxSpeed = maxSpeed;

  return out;
}
