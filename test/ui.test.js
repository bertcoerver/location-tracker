// The panel is DOM, and DOM is not what these tests are for. What IS worth
// testing is the one genuinely branchy decision in it: what the race clock says.
// Six cases, three of which only happen on race morning and cannot be waited for,
// so `clockReading` is pure and exported and they are all reachable here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clockReading } from '../src/ui.js';

const MINUTE = 60000;
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
