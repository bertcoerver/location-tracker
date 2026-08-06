import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCourse } from '../src/course.js';
import { buildForecast as baseBuild, predictAt as basePredict } from '../src/predict-variants/classic.js';
import { buildForecast as dispatchBuild, predictAt as dispatchPredict } from '../src/predict.js';
import { CONFIG } from '../src/config.js';
import { MODELS } from '../src/predict-variants/index.js';
import { deriveStats } from '../src/stats.js';
import * as blend from '../src/predict-variants/v-gross-blend.js';
import * as stoprate from '../src/predict-variants/v-stoprate.js';
import * as fade from '../src/predict-variants/v-fade.js';
import * as calibrated from '../src/predict-variants/v-calibrated.js';

const VARIANTS = { blend, stoprate, fade, calibrated };

// Fixtures copied from predict.test.js — they are file-local there.

const LAT0 = 46.5;
const M_LON = 111320 * Math.cos((LAT0 * Math.PI) / 180);
const MINUTE = 60000;

/** A course due east, a vertex every 100 m, with the given heights. */
function hills(eles) {
  const segments = [eles.map((ele, i) => ({ lat: LAT0, lon: (i * 100) / M_LON, ele }))];
  return buildCourse({ segments, waypoints: [], hasElevation: true }, 'sha');
}

/** 20 km of dead-flat course. */
function flat() {
  return hills(Array.from({ length: 201 }, () => 100));
}

/** A ping at `t` minutes, snapped `along` metres in (or nowhere, with null). */
function ping(name, minutes, along, extra = {}) {
  const point = { name, t: minutes * MINUTE, lat: LAT0, lon: 0, ...extra };
  if (along !== null) point.snap = { along, lon: 0, lat: LAT0, ele: 100, off: 4 };
  return point;
}

/** A run of pings every 5 minutes, each `metres` further on than the last. */
function steady(count, metres, course) {
  const points = Array.from({ length: count },
    (_, i) => ping(`p${i}`, i * 5, i * metres));
  deriveStats(points, course);
  return points;
}

/** The steady run with a 30-minute stall inserted after `count` pings. */
function withStop(count, metres, stallMin, course) {
  const points = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    points.push(ping(`p${i}`, t, i * metres));
    t += 5;
    if (i === Math.floor(count / 2)) {
      points.push(ping(`stall`, t + stallMin - 5, i * metres));
      t += stallMin;
    }
  }
  deriveStats(points, course);
  return points;
}

// --- the contract, for every variant ----------------------------------------

for (const [name, variant] of Object.entries(VARIANTS)) {
  test(`${name}: refuses the runs the baseline refuses`, () => {
    const course = flat();
    assert.equal(variant.buildForecast([], course), null);
    assert.equal(variant.buildForecast(steady(8, 1000, course), null), null);
    assert.equal(variant.buildForecast(steady(2, 1000, course), course), null);

    const finished = steady(8, 1000, course);
    finished[finished.length - 1].is_finish = true;
    assert.equal(variant.buildForecast(finished, course), null);
  });

  test(`${name}: null for ground at or behind the anchor`, () => {
    const course = flat();
    const forecast = variant.buildForecast(steady(8, 1000, course), course);
    assert.equal(variant.predictAt(forecast, forecast.from.along), null);
    assert.equal(variant.predictAt(forecast, forecast.from.along - 500), null);
    assert.equal(variant.predictAt(null, 10000), null);
  });

  test(`${name}: a sane band around a finite estimate`, () => {
    const course = flat();
    const forecast = variant.buildForecast(withStop(8, 1000, 30, course), course);
    const at = variant.predictAt(forecast, 15000);
    assert.ok(Number.isFinite(at.t) && Number.isFinite(at.sd), 'finite');
    assert.ok(at.lo < at.t && at.t < at.hi, 'band straddles the estimate');
    assert.ok(at.sd > 0, 'sd positive');
  });

  test(`${name}: t, lo and hi rise monotonically with distance`, () => {
    const course = flat();
    // A messy run: a stall and uneven pace, to stress the multipliers.
    const points = withStop(10, 900, 30, course);
    const forecast = variant.buildForecast(points, course);
    const baseline = baseBuild(points, course);

    // `lo = t − z·sd` genuinely dips just past the anchor — sd grows as the
    // square root of distance there, faster than the mean — and the BASELINE
    // does it too. What positionAt's bisection needs is that no variant makes
    // that dip materially worse; t and hi must be strictly non-decreasing.
    const dip = (fc, predict) => {
      let worst = 0;
      let prev = null;
      const start = fc.from.along;
      for (let i = 1; i <= 200; i++) {
        const along = start + ((course.length - start) * i) / 200;
        const at = predict(fc, along);
        assert.ok(at, `null inside the course at ${along}`);
        if (prev) {
          assert.ok(at.t >= prev.t, `t fell at ${along}`);
          assert.ok(at.hi >= prev.hi, `hi fell at ${along}`);
          worst = Math.max(worst, prev.lo - at.lo);
        }
        prev = at;
      }
      return worst;
    };

    const ours = dip(forecast, variant.predictAt);
    const theirs = dip(baseline, basePredict);
    assert.ok(ours <= theirs * 2 + 1000,
      `lo dips ${ours / 1000}s against the baseline's ${theirs / 1000}s`);
  });

  test(`${name}: forecast carries the fields the backtest reads`, () => {
    const course = flat();
    const forecast = variant.buildForecast(steady(8, 1000, course), course);
    for (const field of ['flat', 'up', 'down', 'sigma2', 'legs']) {
      assert.ok(Number.isFinite(forecast[field]), `${field} missing`);
    }
    assert.ok(Number.isFinite(forecast.from.t) && Number.isFinite(forecast.from.along));
  });

  test(`${name}: a steady stop-free run predicts like the baseline`, () => {
    const course = flat();
    const points = steady(8, 1000, course);
    const at = variant.predictAt(variant.buildForecast(points, course), 15000);
    const base = basePredict(baseBuild(points, course), 15000);
    // The stop terms are identity on a clean run: r ≈ 1, s ≈ 0. The fade
    // family's literature prior deliberately keeps a couple of percent of fade
    // until the run itself argues it away, so it gets that much slack — over
    // the 40 minutes still to run here, about a minute.
    const slack = ['fade', 'calibrated'].includes(name) ? 75 * 1000 : 30 * 1000;
    assert.ok(Math.abs(at.t - base.t) < slack,
      `drifted ${(at.t - base.t) / 1000}s from the baseline`);
  });

  test(`${name}: works without elevation`, () => {
    const course = buildCourse({
      segments: [Array.from({ length: 201 },
        (_, i) => ({ lat: LAT0, lon: (i * 100) / M_LON }))],
      waypoints: [],
      hasElevation: false
    }, 'sha');
    const forecast = variant.buildForecast(withStop(8, 1000, 30, course), course);
    const at = variant.predictAt(forecast, 15000);
    assert.ok(at && Number.isFinite(at.t));
  });
}

// --- what each candidate exists to fix ---------------------------------------

test('a 30-minute stall pushes every stop-aware forecast later than the baseline', () => {
  const course = flat();
  const points = withStop(10, 1000, 30, course);
  const base = basePredict(baseBuild(points, course), 18000);

  for (const name of ['blend', 'stoprate', 'fade']) {
    const variant = VARIANTS[name];
    const at = variant.predictAt(variant.buildForecast(points, course), 18000);
    assert.ok(at.t > base.t + 2 * MINUTE,
      `${name} gained only ${(at.t - base.t) / MINUTE} min on the baseline`);
  }
});

test('stoprate: the budget rate is zero on a clean run, positive after a stall', () => {
  const course = flat();
  const clean = stoprate.buildForecast(steady(8, 1000, course), course);
  const stalled = stoprate.buildForecast(withStop(8, 1000, 30, course), course);
  assert.ok(clean.stopRate < 0.005, `clean run budgets ${clean.stopRate} s/m`);
  assert.ok(stalled.stopRate > clean.stopRate + 0.01, 'stall not picked up');
});

test('fade: a positive split raises the exponent, an even run does not', () => {
  const course = flat();
  const even = fade.fadeExponent(steady(12, 1000, course));

  // Same ground, second half 60% slower.
  const points = [];
  let t = 0;
  for (let i = 0; i < 12; i++) {
    points.push(ping(`p${i}`, t, i * 1000));
    t += i < 6 ? 5 : 8;
  }
  deriveStats(points, course);
  const faded = fade.fadeExponent(points);

  assert.ok(faded > even, `faded ${faded} not above even ${even}`);
  assert.ok(faded > 1.05, `positive split only reached ${faded}`);
  assert.ok(even <= 1.06, `even run claimed fade ${even}`);
});

test('fade: longer horizons cost more per metre than shorter ones', () => {
  const course = flat();
  const points = [];
  let t = 0;
  for (let i = 0; i < 12; i++) {
    points.push(ping(`p${i}`, t, i * 1000));
    t += i < 6 ? 5 : 8;
  }
  deriveStats(points, course);
  const forecast = fade.buildForecast(points, course);

  const near = fade.predictAt(forecast, 12000).t - forecast.from.t;
  const far = fade.predictAt(forecast, 19000).t - fade.predictAt(forecast, 18000).t;
  assert.ok(far > near, `last km ${far / 1000}s not above first km ${near / 1000}s`);
});

test('the dispatcher runs the configured default and stamps the forecast', () => {
  const course = flat();
  const points = withStop(10, 1000, 30, course);

  assert.ok(MODELS[CONFIG.predictModel], `default "${CONFIG.predictModel}" not registered`);
  const forecast = dispatchBuild(points, course);
  assert.equal(forecast.model, MODELS[CONFIG.predictModel], 'forecast not stamped');

  // predictAt dispatches on the stamp, so the dispatcher's answer must be the
  // default model's answer, not classic's.
  const direct = MODELS[CONFIG.predictModel];
  const at = dispatchPredict(forecast, 18000);
  const expected = direct.predictAt(direct.buildForecast(points, course), 18000);
  assert.equal(at.t, expected.t);
  assert.equal(at.sd, expected.sd);
});

test('calibrated: the band floor engages far out and leaves the mean alone', () => {
  const course = flat();
  const points = withStop(10, 1000, 30, course);
  const plain = fade.buildForecast(points, course);
  const wrapped = calibrated.buildForecast(points, course);

  const along = 19000;
  const before = fade.predictAt(plain, along);
  const after = calibrated.predictAt(wrapped, along);

  assert.equal(after.t, before.t, 'calibration moved the mean');
  assert.ok(after.sd >= before.sd, 'floor made the band narrower');
  // The floor is a fraction of remaining time; hours out it must be the binder.
  const remaining = (after.t - wrapped.from.t) / 1000;
  assert.ok(after.sd >= 0.09 * remaining * 1000, 'floor not engaged');
});
