import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/config.js';
import { buildCourse } from '../src/course.js';
import {
  buildForecast, fitPace, legsOf, positionAt, predictAt
} from '../src/predict.js';
import { deriveStats } from '../src/stats.js';

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

/** 10 km flat, then 10 km climbing 100 m per kilometre. */
function rampAt10km() {
  return hills([
    ...Array.from({ length: 100 }, () => 100),
    ...Array.from({ length: 101 }, (_, i) => 100 + i * 10)
  ]);
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

// --- the fit ----------------------------------------------------------------

test('a constant pace on a flat course is recovered exactly', () => {
  const course = flat();
  // 1,000 m every 5 minutes is 0.3 s/m.
  const forecast = buildForecast(steady(8, 1000, course), course);

  assert.ok(Math.abs(forecast.flat - 0.3) < 1e-6, `flat came out ${forecast.flat}`);
  // Nothing left over to explain, so the scatter sits on its floor rather than
  // claiming a certainty the floors exist to deny.
  assert.equal(
    Math.sqrt(forecast.sigma2),
    Math.max(CONFIG.predictMinSigmaMs / 1000, CONFIG.predictSigmaFloorFrac * 300)
  );
});

test('a constant pace predicts arrival exactly', () => {
  const course = flat();
  const points = steady(8, 1000, course);
  const forecast = buildForecast(points, course);

  // Last ping: 7,000 m at 35 min. Another 3,000 m at 0.3 s/m is 15 minutes.
  const at = predictAt(forecast, 10000);
  assert.ok(Math.abs(at.t - 50 * MINUTE) < 1000, `predicted ${at.t / MINUTE} min`);
  assert.ok(at.lo < at.t && at.t < at.hi, 'band does not straddle its own estimate');
});

test('a climb ahead is predicted to cost more than the same distance flat', () => {
  const course = rampAt10km();
  const points = steady(9, 1000, course);   // 8 km in, all of it on the flat part
  const forecast = buildForecast(points, course);

  const overFlat = predictAt(forecast, 9000).t - forecast.from.t;
  const overClimb = predictAt(forecast, 12000).t - predictAt(forecast, 11000).t;

  assert.ok(overClimb > overFlat * 1.5,
    `1 km uphill cost ${overClimb / 1000}s against ${overFlat / 1000}s flat`);
});

test('slower uphill legs push the climb coefficient up', () => {
  const course = rampAt10km();
  // Six flat kilometres at 5 min each, then four uphill at 8 min each.
  const points = [];
  let t = 0;
  for (let i = 0; i <= 10; i++) {
    points.push(ping(`p${i}`, t, i * 1000));
    t += i < 6 ? 5 : 8;
  }
  deriveStats(points, course);

  const forecast = buildForecast(points, course);
  // Each uphill kilometre carries 100 m of ascent and cost 180 s more than a
  // flat one, so the coefficient should land near 1.8 s per metre climbed.
  assert.ok(forecast.up > 1.0, `up came out ${forecast.up}`);
  assert.ok(forecast.flat < 0.4, `flat absorbed the climb instead: ${forecast.flat}`);
});

test('a leg where the runner did not move leaves the coefficients alone', () => {
  const course = flat();
  const moving = steady(8, 1000, course);

  // The same run with one ping repeated at the same distance five minutes later,
  // then carrying on. The stop is real elapsed time and no distance at all.
  const stopped = [
    ...moving.slice(0, 4),
    ping('stop', 20, 3000),
    ...moving.slice(4).map((p, i) => ping(`q${i}`, 25 + i * 5, 4000 + i * 1000))
  ];
  deriveStats(stopped, course);

  const before = buildForecast(moving, course);
  const after = buildForecast(stopped, course);

  // Exact in arithmetic — a zero-distance leg is an all-zero row in the design
  // matrix, and the prior is fitted over moving legs only — so the tolerance
  // here is for the summation order, not for the claim.
  assert.ok(Math.abs(after.flat - before.flat) < 1e-12,
    `a stop moved the pace from ${before.flat} to ${after.flat}`);
  // But it is not free: the scatter, and so the band, has to widen for it.
  assert.ok(after.sigma2 > before.sigma2, 'a stop bought no extra uncertainty');
});

// --- recency ----------------------------------------------------------------

test('a run that has slowed recently is forecast slower than its average', () => {
  const course = flat();
  // Ten fast kilometres at 4 min, then five slow ones at 8 min.
  const points = [];
  let t = 0;
  for (let i = 0; i <= 15; i++) {
    points.push(ping(`p${i}`, t, i * 1000));
    t += i < 10 ? 4 : 8;
  }
  deriveStats(points, course);

  const legs = legsOf(points, course);
  const anchor = points[points.length - 1].snap.along;
  const overall = (t - 0) * MINUTE / 1000 / 15000;   // s/m over the whole run

  const near = fitPace(legs, anchor, 2000);
  const far = fitPace(legs, anchor, 1e9);

  assert.ok(near.flat > far.flat, 'a short half-life did not weight the slow end more');
  assert.ok(near.flat > overall, 'the recent slowdown was averaged away');
});

test('halving the half-life moves the forecast further towards recent legs', () => {
  const course = flat();
  const points = [];
  let t = 0;
  for (let i = 0; i <= 15; i++) {
    points.push(ping(`p${i}`, t, i * 1000));
    t += i < 10 ? 4 : 8;
  }
  deriveStats(points, course);

  const legs = legsOf(points, course);
  const anchor = points[points.length - 1].snap.along;
  const paces = [16000, 8000, 4000, 2000].map(hl => fitPace(legs, anchor, hl).flat);

  for (let i = 1; i < paces.length; i++) {
    assert.ok(paces[i] > paces[i - 1],
      `half-life ${i} did not increase the forecast pace: ${paces}`);
  }
});

// --- uncertainty ------------------------------------------------------------

test('the band widens with distance and always straddles the estimate', () => {
  const course = flat();
  const points = [];
  // Deliberately ragged, so there is real scatter to widen the band with.
  const legMetres = [900, 1200, 800, 1100, 1000, 700, 1300];
  let along = 0;
  points.push(ping('p0', 0, 0));
  legMetres.forEach((m, i) => {
    along += m;
    points.push(ping(`p${i + 1}`, (i + 1) * 5, along));
  });
  deriveStats(points, course);

  const forecast = buildForecast(points, course);
  let previous = 0;
  for (const target of [8000, 10000, 14000, 18000]) {
    const at = predictAt(forecast, target);
    assert.ok(at.lo < at.t && at.t < at.hi, `band inverted at ${target}`);
    assert.ok(at.sd > previous, `band did not widen by ${target}`);
    previous = at.sd;
  }
});

test('ground already behind the runner gets no forecast', () => {
  const course = flat();
  const forecast = buildForecast(steady(8, 1000, course), course);

  assert.equal(predictAt(forecast, 7000), null, 'forecast the anchor itself');
  assert.equal(predictAt(forecast, 3000), null, 'forecast ground already covered');
});

// --- the inverse ------------------------------------------------------------

test('positionAt inverts predictAt to within a metre', () => {
  const course = rampAt10km();
  const forecast = buildForecast(steady(9, 1000, course), course);

  for (const target of [9000, 12000, 16000, 19000]) {
    const at = predictAt(forecast, target);
    const back = positionAt(forecast, at.t);
    assert.ok(Math.abs(back.along - target) < 1,
      `${target} m round-tripped to ${back.along}`);
  }
});

test('the positional range brackets the estimate, and runs out at the finish', () => {
  const course = flat();
  const points = steady(8, 1000, course);
  const forecast = buildForecast(points, course);

  const soon = positionAt(forecast, points[7].t + 10 * MINUTE);
  assert.ok(soon.lo < soon.along && soon.along < soon.hi, 'range does not bracket');

  // Past the predicted finish there is nothing left to be in the middle of.
  const finish = predictAt(forecast, course.length);
  assert.equal(positionAt(forecast, finish.t + MINUTE), null);
  // And before the last ping the phone's own record is the answer.
  assert.equal(positionAt(forecast, points[0].t), null);
});

// --- refusing to answer -----------------------------------------------------

test('nothing to fit means no forecast rather than a bad one', () => {
  const course = flat();

  assert.equal(buildForecast([], course), null, 'forecast from no pings');
  assert.equal(buildForecast(steady(3, 1000, course), null), null, 'forecast with no course');
  assert.equal(buildForecast(steady(2, 1000, course), course), null, 'forecast from one leg');

  // Every ping off the course: positions, but no distance along it.
  const adrift = [ping('a', 0, null), ping('b', 5, null), ping('c', 10, null)];
  assert.equal(buildForecast(adrift, course), null, 'forecast from unsnapped pings');

  // A phone that never moved has no pace to estimate.
  const parked = [ping('a', 0, 500), ping('b', 5, 500), ping('c', 10, 500), ping('d', 15, 500)];
  deriveStats(parked, course);
  assert.equal(buildForecast(parked, course), null, 'forecast from a stationary phone');
});

test('a finished run has no rest of the course to forecast', () => {
  const course = flat();
  const points = steady(8, 1000, course);
  points[points.length - 1].is_finish = true;

  assert.equal(buildForecast(points, course), null);
});

test('a course with no descent leaves that coefficient on its prior', () => {
  const course = rampAt10km();
  const points = steady(15, 1000, course);
  const forecast = buildForecast(points, course);

  // Nothing in this run descends, so nothing can pin the coefficient down. The
  // prior says descent is free, and the fit must come back finite and say so
  // rather than dividing by a singular matrix.
  assert.ok(Number.isFinite(forecast.down));
  assert.ok(Math.abs(forecast.down) < 1e-6, `down came out ${forecast.down}`);
});

test('a course with no elevation forecasts on distance alone', () => {
  const segments = [Array.from({ length: 201 },
    (_, i) => ({ lat: LAT0, lon: (i * 100) / M_LON, ele: null }))];
  const course = buildCourse({ segments, waypoints: [], hasElevation: false }, 'sha');

  const forecast = buildForecast(steady(8, 1000, course), course);
  assert.ok(Math.abs(forecast.flat - 0.3) < 1e-6);
  assert.ok(Number.isFinite(predictAt(forecast, 12000).t));
});

test('a ping that snapped backwards costs time and claims no pace', () => {
  const course = flat();
  const points = [
    ping('a', 0, 0), ping('b', 5, 1000), ping('c', 10, 2000),
    ping('d', 15, 1500)                                   // snapped back 500 m
  ];
  deriveStats(points, course);

  const legs = legsOf(points, course);
  assert.equal(legs[2].dist, 0, 'a backwards leg claimed distance');
  assert.equal(legs[2].dt, 300, 'a backwards leg lost its elapsed time');
});

// --- pings from before the gun --------------------------------------------------

test('unsnapped warm-up pings are invisible to the model', () => {
  // The load-bearing claim of the whole scheduled-start design: `snapAll` declines
  // to place a pre-start ping on the course, and that alone removes it from the
  // pace fit, because everything here filters on `snap`. Asserted rather than
  // argued — if the filter at the top of `buildForecast` ever moves, this goes red.
  const course = flat();
  const race = steady(8, 1000, course);

  // The same run with three warm-up pings in front of it, unsnapped, wandering
  // around at a pace that would wreck any fit that saw them.
  const warmed = [
    ping('w0', -40, null), ping('w1', -25, null), ping('w2', -8, null), ...race
  ];
  deriveStats(warmed, course, race[0].t);

  const clean = buildForecast(race, course);
  const withWarmup = buildForecast(warmed, course);

  assert.equal(withWarmup.flat, clean.flat);
  assert.equal(
    predictAt(withWarmup, course.length).t,
    predictAt(clean, course.length).t
  );
});

test('a run with nothing but warm-up pings gets no forecast', () => {
  // Four unsnapped pings are not four legs. `predictMinLegs` counts ground covered
  // on the course, and none of this was.
  const course = flat();
  const points = [0, 1, 2, 3].map(i => ping(`w${i}`, i * 5, null));
  deriveStats(points, course, 100 * MINUTE);

  assert.equal(buildForecast(points, course), null);
});
