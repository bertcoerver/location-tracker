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
import * as cadence from '../src/predict-variants/v-cadence.js';
import * as kalman from '../src/predict-variants/v-kalman.js';
import * as bootstrap from '../src/predict-variants/v-bootstrap.js';
import { effortBlocks, effortNodes } from '../src/predict-variants/effort.js';

const VARIANTS = { blend, stoprate, fade, calibrated, cadence, kalman, bootstrap };

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

/**
 * A run of pings every `minutes`, each `metres` further on than the last.
 *
 * Five minutes is the cadence every recorded run in `locations/` actually pings
 * at, and therefore the cadence every model here was tuned on. The parameter is
 * for `cadence`, which is the one model that asks how far apart these are.
 */
function steady(count, metres, course, minutes = 5) {
  const points = Array.from({ length: count },
    (_, i) => ping(`p${i}`, i * minutes, i * metres));
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
    // Load-bearing for `cadence`, which is the one model that can lower this
    // gate: two pings 1 km apart over five minutes clear neither the ground nor
    // the time it asks for, so it refuses them exactly like everything else. The
    // gate opens on evidence, not on cadence alone — see the cold-start test.
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

    // The stop terms are identity on a clean run: r ≈ 1, s ≈ 0. What is NOT
    // identity is a fatigue prior — every model carrying one deliberately keeps
    // a few per cent of fade until the run itself argues it away, and there is
    // no run here long enough to argue. Those models are held to a tenth of the
    // time still to come; the rest, which claim nothing about fatigue, have to
    // land on the baseline's answer.
    const prior = ['fade', 'calibrated', 'cadence', 'kalman', 'bootstrap'].includes(name);
    const slack = prior ? 0.1 * (base.t - baseBuild(points, course).from.t) : 30 * 1000;
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

  // Every model except `classic` itself, by two different routes: the first
  // three price the stop on top of the moving-pace fit, the last two never saw
  // a moving pace at all — the stall is simply inside a block.
  for (const name of ['blend', 'stoprate', 'fade', 'kalman', 'bootstrap']) {
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

test('effort blocks bill a stop to the ground around it', () => {
  const course = flat();
  const clean = effortBlocks(steady(8, 1000, course), course);
  const stalled = effortBlocks(withStop(8, 1000, 30, course), course);

  // Every block has somewhere to go and a time to get there — no leg divides a
  // duration by no distance, which is the whole point of blocking.
  for (const block of [...clean, ...stalled]) {
    assert.ok(block.e > 0 && block.dt > 0, 'degenerate block');
  }
  // The stall shows up as time, not as an extra block.
  assert.equal(stalled.length, clean.length);
  const gross = list => list.reduce((s, b) => s + b.dt, 0) / list.reduce((s, b) => s + b.e, 0);
  assert.ok(gross(stalled) > gross(clean) * 1.5, 'stall not billed anywhere');
});

test('effort nodes span the anchor to the finish', () => {
  const course = flat();
  const nodes = effortNodes(course, 7000);
  assert.equal(nodes[0].along, 7000);
  assert.equal(nodes[nodes.length - 1].along, course.length);
  for (let i = 1; i < nodes.length; i++) {
    assert.ok(nodes[i].along > nodes[i - 1].along, 'nodes not ascending');
    assert.ok(nodes[i].e > 0, 'node with no effort in it');
  }
});

test('kalman: fading is read off the run, and an even run reports none', () => {
  const course = flat();
  const even = kalman.buildForecast(steady(12, 1000, course), course);

  // Same ground, second half 60% slower.
  const points = [];
  let t = 0;
  for (let i = 0; i < 12; i++) {
    points.push(ping(`p${i}`, t, i * 1000));
    t += i < 6 ? 5 : 8;
  }
  deriveStats(points, course);
  const faded = kalman.buildForecast(points, course);

  assert.ok(faded.r > even.r, `faded trend ${faded.r} not above even ${even.r}`);
  assert.ok(faded.r > 0, 'a positive split reported no drift at all');
  assert.ok(Math.abs(even.r) < 1e-5, `even run claimed drift ${even.r}`);
});

test('kalman: the band widens faster than the horizon does', () => {
  // On an ULTRA-length course, because that is the regime the claim is about.
  // Over the first few kilometres the opposite is true and should be: block
  // scatter averages away as 1/distance, so the band there is proportionally
  // TIGHTER the further ahead you look. Drift only takes over once there is
  // enough race left for the runner to become a different runner.
  const course = hills(Array.from({ length: 1501 }, () => 100));
  const forecast = kalman.buildForecast(steady(20, 1000, course), course);

  // What `calibrated` has to impose with a floor, this model produces on its
  // own: the sd as a SHARE of the time still to run grows with the horizon,
  // because the level and the trend both wander on the way there.
  const share = along => {
    const at = kalman.predictAt(forecast, along);
    return at.sd / (at.t - forecast.from.t);
  };
  assert.ok(share(140000) > share(50000) * 1.5,
    `far ${share(140000).toFixed(3)} vs near ${share(50000).toFixed(3)}`);
});

test('bootstrap: the band leans late, and repeats itself exactly', () => {
  const course = flat();
  const points = withStop(10, 1000, 30, course);
  const forecast = bootstrap.buildForecast(points, course);
  const at = bootstrap.predictAt(forecast, 19000);

  // Right-skewed by construction: a runner can lose two hours and cannot gain
  // them. No other model here can say anything but "± the same amount".
  assert.ok(at.hi - at.t > (at.t - at.lo) * 1.05,
    `late tail ${(at.hi - at.t) / MINUTE} min vs early ${(at.t - at.lo) / MINUTE} min`);

  // Same run in, same band out — a figure that shivers between repaints is a
  // bug, and a seeded generator is what stops it.
  const again = bootstrap.predictAt(bootstrap.buildForecast(points, course), 19000);
  assert.deepEqual(again, at);
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

// --- cadence -----------------------------------------------------------------
//
// Distances to compare two models over: the whole course ahead of the anchor,
// which `steady(8, 1000, ...)` leaves at 7 km of the 20 km `flat()`.
const AHEAD = [8000, 10000, 13000, 16000, 20000];

test('cadence: at five-minute pings it is calibrated, exactly', () => {
  const course = flat();
  const points = withStop(10, 1000, 30, course);

  const cad = cadence.buildForecast(points, course);
  const cal = calibrated.buildForecast(points, course);

  // This is the test that makes `cadence` safe as the shipped default. Every run
  // recorded in `locations/` pings at 5.1 minutes, so if this holds, switching
  // the default cannot have moved a single forecast the repo has ever drawn.
  assert.equal(cad.rho, 1, 'a five-minute run was not read as the reference');
  assert.equal(cad.sigma2, cal.sigma2, 'leg scatter was shrunk at the reference');
  assert.deepEqual(cad.cov, cal.cov, 'parameter covariance was shrunk');

  for (const along of AHEAD) {
    assert.deepEqual(
      cadence.predictAt(cad, along),
      calibrated.predictAt(cal, along),
      `the two disagreed at ${along} m`
    );
  }
});

test('cadence: coarse pings narrow the band and leave the estimate alone', () => {
  const course = flat();
  // Even 25-minute pings, but uneven ground under them — 600 m then 1400 m,
  // alternating. A perfectly steady fixture will not do here: with no residuals
  // the fit sits on its own sigma floor, calibrated's `0.15 × remaining` floor
  // wins at every distance, and the shrink is real but invisible in `sd`. Real
  // legs have scatter, and this is the smallest fixture that produces some
  // while leaving the median gap exactly 25 minutes.
  const points = Array.from({ length: 8 },
    (_, i) => ping(`p${i}`, i * 25, Math.floor(i / 2) * 2000 + (i % 2) * 600));
  deriveStats(points, course);

  const cad = cadence.buildForecast(points, course);
  const cal = calibrated.buildForecast(points, course);

  // Just under 5: the reference is the phone's MEASURED 5-minute cadence, which
  // carries its upload lag, not a round 300 seconds. See `PING_REF_S`.
  assert.ok(cad.rho > 4.5 && cad.rho < 5, `25-minute pings read as rho ${cad.rho}`);
  // sigma2 / rho^0.5, and the same divisor through the covariance. Asserted on
  // the forecast rather than only on `sd`, because calibrated's own floor is a
  // fraction of the time remaining and can mask the shrink hours out.
  const shrink = Math.sqrt(cad.rho);
  assert.ok(Math.abs(cad.sigma2 * shrink - cal.sigma2) < 1e-6, 'sigma2 not shrunk');
  for (let j = 0; j < 3; j++) {
    for (let k = 0; k < 3; k++) {
      assert.ok(Math.abs(cad.cov[j][k] * shrink - cal.cov[j][k]) < 1e-9,
        `cov[${j}][${k}] not shrunk with it`);
    }
  }

  let narrower = 0;
  for (const along of AHEAD) {
    const after = cadence.predictAt(cad, along);
    const before = calibrated.predictAt(cal, along);
    assert.equal(after.t, before.t, `the estimate moved at ${along} m`);
    assert.ok(after.sd <= before.sd, `the band widened at ${along} m`);
    if (after.sd < before.sd) narrower++;
  }
  assert.ok(narrower > 0, 'the band never actually narrowed');
});

test('cadence: the cold start opens on ground and time, not on leg count', () => {
  const course = flat();
  // One leg: two pings, 25 minutes and 4 km apart. Three pings is fifty-two
  // minutes of race at this cadence, and this run is not less informed than a
  // five-minute run that has already been forecasting for a quarter of an hour.
  const points = [ping('p0', 0, 0), ping('p1', 25, 4000)];
  deriveStats(points, course);

  assert.equal(calibrated.buildForecast(points, course), null,
    'the leg-counting gate no longer refuses this');

  const forecast = cadence.buildForecast(points, course);
  assert.ok(forecast, 'cadence refused a leg worth 4 km');
  assert.equal(forecast.legs, 1);

  const at = cadence.predictAt(forecast, course.length);
  assert.ok(Number.isFinite(at.t) && at.t > forecast.from.t);
  // And it says so widely. A one-leg fit that quoted a tight window would be
  // worse than the blank panel it replaces.
  const remaining = (at.t - forecast.from.t) / 1000;
  assert.ok(at.sd >= 0.1 * remaining * 1000,
    `one leg claimed a window of ±${at.sd / 1000}s over ${remaining}s`);
});

test('cadence: rho is clamped, so an hourly phone is not extrapolated to', () => {
  const course = flat();
  const points = steady(8, 1000, course, 60);

  const cad = cadence.buildForecast(points, course);
  const cal = calibrated.buildForecast(points, course);

  // 60 minutes over the 5-minute reference is 12, and the model must not believe
  // it: the backtest measured the effect out to ~25-minute pings, and past the
  // clamp the band stays wider than the power law asks for.
  assert.equal(cad.rho, 6, `hourly pings read as rho ${cad.rho}`);
  assert.ok(Math.abs(cal.sigma2 / cad.sigma2 - Math.sqrt(6)) < 1e-9,
    'the shrink was not taken at the clamped rho');
});
