// The panel is DOM, and DOM is not what these tests are for. What IS worth
// testing is the one genuinely branchy decision in it: what the race clock says.
// Six cases, three of which only happen on race morning and cannot be waited for,
// so `clockReading` is pure and exported and they are all reachable here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse } from '../src/course.js';
import { isLive } from '../src/github.js';
import { buildForecast, predictAt } from '../src/predict.js';
import { deriveStats } from '../src/stats.js';
import { clockReading, stillRunning } from '../src/ui.js';

const MINUTE = 60000;
const LAT0 = 46.5;
const GUN = Date.parse('2026-08-28T09:00:00+02:00');

/** A ping `minutes` after the gun — negative for one before it. */
const ping = minutes => ({ name: `p${minutes}.json`, t: GUN + minutes * MINUTE });

/** The defaults a quiet, unfinished, unscheduled run would supply. */
const read = over => clockReading({
  start: null, points: [], finish: null, live: false, now: GUN, ...over
});

test('nothing scheduled and nothing reported means no clock at all', () => {
  assert.equal(read(), null);
});

// --- before the gun ----------------------------------------------------------

test('a scheduled run counts down, with no pings needed', () => {
  // The whole point of a course-only folder being a run: the route is on the map,
  // the height profile is drawn, and this says when it begins.
  assert.deepEqual(read({ start: GUN, now: GUN - 4 * 3600000 - 31 * MINUTE }), {
    label: 'Starts in', value: '4:31:00'
  });
});

test('a countdown a month out reads in days, not in hundreds of hours', () => {
  const { label, value } = read({ start: GUN, now: GUN - 29 * 86400000 - 4 * 3600000 });
  assert.equal(label, 'Starts in');
  assert.equal(value, '29d 4h');
});

test('warm-up pings do not start the clock — the gun does', () => {
  // Pings from the drive to the start are real fixes and are drawn, but the race
  // has not begun, so this still counts down rather than claiming an elapsed time.
  assert.deepEqual(read({ start: GUN, points: [ping(-90), ping(-20)], now: GUN - 5 * MINUTE }), {
    label: 'Starts in', value: '0:05:00'
  });
});

// --- after the gun -----------------------------------------------------------

test('at the gun the countdown becomes an elapsed clock at zero', () => {
  assert.deepEqual(read({ start: GUN, now: GUN }), { label: 'Elapsed', value: '0:00:00' });
});

test('the clock runs from the gun while waiting for the first ping', () => {
  // The timetable says the race is on, and with no ping to show this is the only
  // thing on screen saying so. A claim from the schedule rather than from the
  // phone, and the honest one to make in the gap before the first fix.
  assert.deepEqual(read({ start: GUN, now: GUN + 20 * MINUTE }), {
    label: 'Elapsed', value: '0:20:00'
  });
});

test('elapsed time is measured from the gun, not from the first ping', () => {
  // The first ping landed 20 minutes late. The race is still 50 minutes old.
  const reading = read({
    start: GUN, points: [ping(-30), ping(20), ping(45)], live: true, now: GUN + 50 * MINUTE
  });

  assert.deepEqual(reading, { label: 'Elapsed', value: '0:50:00' });
});

test('a scheduled run that has gone quiet freezes at its last ping', () => {
  assert.deepEqual(read({
    start: GUN, points: [ping(20), ping(180)], live: false, now: GUN + 900 * MINUTE
  }), { label: 'Total', value: '3:00:00' });
});

test('a finish freezes the clock there, even with a ping after it', () => {
  // A ping that failed to upload and arrived late does not restart the race: it
  // ended when the phone said it did.
  const finish = { ...ping(200), is_finish: true };
  assert.deepEqual(read({
    start: GUN, points: [ping(20), finish, ping(240)], finish, live: false, now: GUN + 900 * MINUTE
  }), { label: 'Total', value: '3:20:00' });
});

// --- no schedule at all ------------------------------------------------------

test('an unscheduled run still counts from its first ping', () => {
  // Every run behaved this way before course filenames carried a start, and every
  // run whose course says nothing still does.
  assert.deepEqual(read({ points: [ping(10), ping(40)], live: true, now: GUN + 70 * MINUTE }), {
    label: 'Elapsed', value: '1:00:00'
  });
});

test('an unscheduled quiet run reads first-to-last as a total', () => {
  assert.deepEqual(read({ points: [ping(10), ping(130)], live: false, now: GUN + 900 * MINUTE }), {
    label: 'Total', value: '2:00:00'
  });
});

// --- is the run still underway? ----------------------------------------------
// The other pure decision in the panel, and the one every reading in it hangs off.
// Its interesting cases are hours apart in real time, which is exactly why they are
// here: a phone that has been silent for two hours mid-race cannot be waited for.

/** 20 km of dead-flat course, a vertex every 100 m. */
function flatCourse() {
  const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
  const segments = [Array.from({ length: 201 },
    (_, i) => ({ lat: LAT0, lon: (i * 100) / M_LON, ele: 100 }))];
  return buildCourse({ segments, waypoints: [], hasElevation: true }, 'sha');
}

/**
 * A run that pinged every 5 minutes from the gun, a kilometre at a time, and then
 * went quiet — so its last ping is at 7 km and 35 minutes past the gun, and 13 km
 * of course are left at 5 min/km. The forecast has it finishing 65 minutes later.
 */
function quietAt7km() {
  const course = flatCourse();
  const points = Array.from({ length: 8 }, (_, i) => ({
    name: `p${i}.json`, t: GUN + i * 5 * MINUTE, lat: LAT0, lon: 0,
    snap: { along: i * 1000, lat: LAT0, lon: 0, ele: 100, off: 3 }
  }));
  deriveStats(points, course);
  return { course, points, forecast: buildForecast(points, course), last: points[7].t };
}

test('a recent ping is enough on its own, course or no course', () => {
  const record = { latest: GUN + 30 * MINUTE };
  assert.equal(stillRunning({
    finish: null, record, forecast: null, now: GUN + 40 * MINUTE
  }), true);
});

test('with no course, silence past the hour ends the run — the old rule, kept', () => {
  // Nothing to predict a finish line from, so the clock is all there is to go on.
  const record = { latest: GUN + 30 * MINUTE };
  assert.equal(stillRunning({
    finish: null, record, forecast: null, now: GUN + 95 * MINUTE
  }), false);
});

test('a two-hour blackout mid-race is still a race', () => {
  // The reported bug: a mountain section with no network, and the panel called the
  // race over an hour in. 13 km of course left at the pace it had measured, so the
  // runner is plausibly out there for another hour after `isLive` has given up.
  const { forecast, last } = quietAt7km();
  const record = { latest: last };
  const now = last + 60 * MINUTE;

  assert.equal(isLive(record, now), false, 'the ping rule has given up by now');
  assert.equal(stillRunning({ finish: null, record, forecast, now }), true);
});

test('and it ends when the prediction crosses the line, not before', () => {
  const { forecast, course, last } = quietAt7km();
  const record = { latest: last };
  // 13 km at 5 min/km after the last ping, so the crossing is 65 minutes out.
  const crossing = predictAt(forecast, course.length).t;

  assert.ok(crossing > last + 60 * MINUTE, `crossing is only ${(crossing - last) / MINUTE} min out`);
  assert.equal(stillRunning({ finish: null, record, forecast, now: crossing - MINUTE }), true);
  assert.equal(stillRunning({ finish: null, record, forecast, now: crossing + MINUTE }), false);
  // And it stays over: this is not a window that reopens.
  assert.equal(stillRunning({ finish: null, record, forecast, now: crossing + 3000 * MINUTE }), false);
});

test('a finish outranks a prediction that has not reached the line', () => {
  // The phone said it was done. Whatever the arithmetic thinks is left of the
  // course, the race ended when the phone said so.
  const { forecast, points, last } = quietAt7km();
  const finish = { ...points[7], is_finish: true };
  assert.equal(stillRunning({
    finish, record: { latest: last }, forecast, now: last + MINUTE
  }), false);
});
