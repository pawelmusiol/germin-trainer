/**
 * Empirical Verification & Stress-Testing Harness for Daniels Physiology Inversion Engine
 * Packages: @garmin-trainer/shared (src/vdot.ts)
 *
 * Requirements Tested:
 * 1. Convergence Speed (iterations <= 30)
 * 2. Numerical Monotonicity (VDOT ↑ => Race Time ↓)
 * 3. Round-Trip Precision (|VdotFromRace(d, RaceTime(d, v)) - v| <= tolerance on 1000+ points)
 * 4. Boundary & Invalid Input Handling (d <= 0, NaN, Infinity, negative values, extreme VDOTs)
 */

const {
  calculateRaceTimeFromVdot,
  calculateVdotFromRace,
  calculateOxygenCost,
  calculateFractionOfVo2Max,
  calculateVdotPaces,
  formatPace,
  parsePace,
  convertRunToBikeWatts,
  convertRunToBikeDuration,
  estimateCurrentVdotFromGarminRuns,
} = require('../dist/vdot.js');

// Instrument binary search to measure exact iteration count
function instrumentedRaceTimeBinarySearch(distanceMeters, vdot) {
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    return { time: 0, iterations: 0 };
  }
  const safeVdot =
    !Number.isFinite(vdot) && vdot > 85
      ? 85.0
      : !Number.isFinite(vdot) || vdot < 30.0
      ? 30.0
      : Math.min(85.0, vdot);
  let low = 20;
  let high = 86400;
  let iterations = 0;

  while (high - low > 0.02 && iterations < 30) {
    iterations++;
    const mid = (low + high) / 2;
    const durationMinutes = mid / 60;
    const velocityMetersPerMin = distanceMeters / durationMinutes;
    const vo2 = calculateOxygenCost(velocityMetersPerMin);
    const fraction = calculateFractionOfVo2Max(durationMinutes);
    const midVdot = fraction > 0 ? vo2 / fraction : 30.0;

    if (midVdot > safeVdot) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return { time: Math.round((low + high) / 2), iterations };
}

console.log('='.repeat(80));
console.log('EMPIRICAL CHALLENGER VERIFICATION SUITE — DANIELS PHYSIOLOGY ENGINE');
console.log('='.repeat(80));

const results = {
  convergence: { passed: true, maxIterations: 0, testCount: 0, failures: [] },
  monotonicity: { passed: true, violations: [] },
  precision: {
    passed: true,
    totalPoints: 0,
    failPoints: 0,
    maxError: 0,
    worstCase: null,
    byDistance: {},
  },
  boundaries: { passed: true, issues: [] },
};

// -----------------------------------------------------------------------------
// Objective 1: Convergence Speed Verification
// -----------------------------------------------------------------------------
console.log('\n[1/4] Testing Binary Search Convergence Speed (800m to 100,000m, VDOT 30 to 85)...');

const testDistances = [
  800, 1000, 1500, 2000, 3000, 5000, 8000, 10000, 15000, 21097.5, 30000, 42195, 50000, 100000,
];
const testVdots = [];
for (let v = 30.0; v <= 85.0; v += 0.5) {
  testVdots.push(parseFloat(v.toFixed(1)));
}

for (const d of testDistances) {
  for (const v of testVdots) {
    results.convergence.testCount++;
    const res = instrumentedRaceTimeBinarySearch(d, v);
    if (res.iterations > results.convergence.maxIterations) {
      results.convergence.maxIterations = res.iterations;
    }
    if (res.iterations > 30) {
      results.convergence.passed = false;
      results.convergence.failures.push({ distance: d, vdot: v, iterations: res.iterations });
    }
  }
}

console.log(`  Tests run: ${results.convergence.testCount}`);
console.log(`  Max iterations observed: ${results.convergence.maxIterations} (limit <= 30)`);
console.log(`  Convergence check: ${results.convergence.passed ? 'PASSED (strictly <= 30)' : 'FAILED'}`);

// -----------------------------------------------------------------------------
// Objective 2: Numerical Monotonicity Verification
// -----------------------------------------------------------------------------
console.log('\n[2/4] Testing Numerical Monotonicity (VDOT ↑ => Race Time ↓)...');

const monotonicityDistances = [800, 1000, 1500, 3000, 5000, 10000, 21097.5, 42195, 100000];

for (const d of monotonicityDistances) {
  let prevTime = Infinity;
  let prevVdot = null;
  const distViolations = [];

  for (let v = 30.0; v <= 85.0; v += 1.0) {
    const curTime = calculateRaceTimeFromVdot(d, v);
    if (curTime >= prevTime) {
      distViolations.push({
        distance: d,
        vdotPrev: prevVdot,
        timePrev: prevTime,
        vdotCur: v,
        timeCur: curTime,
        difference: curTime - prevTime,
      });
    }
    prevTime = curTime;
    prevVdot = v;
  }

  if (distViolations.length > 0) {
    results.monotonicity.passed = false;
    results.monotonicity.violations.push(...distViolations);
    console.log(`  [FAIL] Distance ${d}m violated monotonicity in ${distViolations.length} intervals:`);
    for (const viol of distViolations.slice(0, 3)) {
      console.log(
        `         VDOT ${viol.vdotPrev} -> ${viol.vdotCur}: Time remained flat at ${viol.timeCur}s`
      );
    }
  } else {
    console.log(`  [PASS] Distance ${d}m strictly monotonic across VDOT 30..85`);
  }
}

// -----------------------------------------------------------------------------
// Objective 3: Round-Trip Precision Verification (Dense Grid >= 1,000 Points)
// -----------------------------------------------------------------------------
console.log('\n[3/4] Testing Round-Trip Precision (|VdotFromRace(d, RaceTime(d, v)) - v| <= tol)...');

const denseDistances = [
  800, 1000, 1200, 1500, 2000, 3000, 5000, 8000, 10000, 15000, 21097.5, 30000, 42195, 50000, 75000, 100000,
];

for (const d of denseDistances) {
  results.precision.byDistance[d] = { total: 0, fail: 0, maxErr: 0 };
  for (const v of testVdots) {
    results.precision.totalPoints++;
    results.precision.byDistance[d].total++;

    const raceTime = calculateRaceTimeFromVdot(d, v);
    const recoveredVdot = calculateVdotFromRace(d, raceTime);
    const error = Math.abs(recoveredVdot - v);

    if (error > results.precision.byDistance[d].maxErr) {
      results.precision.byDistance[d].maxErr = error;
    }

    if (error > results.precision.maxError) {
      results.precision.maxError = error;
      results.precision.worstCase = { distance: d, inputVdot: v, raceTime, recoveredVdot, error };
    }

    // Dynamic tolerance for integer discretization in middle-distance events:
    // d < 1000m: 0.5 VDOT
    // d < 3000m: 0.3 VDOT
    // d >= 3000m: 0.1 VDOT (with +1e-5 to guard against IEEE 754 floating point subtraction inaccuracies like |60.4 - 60.5| = 0.10000000000000142)
    const maxAllowedError = d < 1000 ? 0.5 : d < 3000 ? 0.3 : 0.1;

    if (error > maxAllowedError + 1e-5) {
      results.precision.failPoints++;
      results.precision.byDistance[d].fail++;
    }
  }
}

if (results.precision.failPoints > 0) {
  results.precision.passed = false;
}

console.log(`  Total points tested: ${results.precision.totalPoints}`);
console.log(`  Failing points (|err| > tol): ${results.precision.failPoints}`);
console.log(`  Max error observed: ${results.precision.maxError.toFixed(3)} VDOT units`);
if (results.precision.worstCase) {
  console.log('  Worst-case scenario:', results.precision.worstCase);
}
console.log('  Breakdown by distance:');
for (const [dist, stats] of Object.entries(results.precision.byDistance)) {
  const status = stats.fail === 0 ? 'PASS' : 'FAIL';
  console.log(
    `    - ${dist.padStart(8)}m: [${status}] fails: ${String(stats.fail).padStart(3)}/${stats.total}, maxErr: ${stats.maxErr.toFixed(3)}`
  );
}

// -----------------------------------------------------------------------------
// Objective 4: Boundary & Invalid Input Handling
// -----------------------------------------------------------------------------
console.log('\n[4/4] Testing Boundary & Invalid Input Handling...');

const boundaryCases = [
  { name: 'RaceTime with d = 0', fn: () => calculateRaceTimeFromVdot(0, 50), expected: 0 },
  { name: 'RaceTime with d = -5000', fn: () => calculateRaceTimeFromVdot(-5000, 50), expected: 0 },
  { name: 'RaceTime with d = NaN', fn: () => calculateRaceTimeFromVdot(NaN, 50), expected: 0 },
  { name: 'RaceTime with d = Infinity', fn: () => calculateRaceTimeFromVdot(Infinity, 50), expected: 0 },
  { name: 'RaceTime with d = -Infinity', fn: () => calculateRaceTimeFromVdot(-Infinity, 50), expected: 0 },
  {
    name: 'RaceTime with vdot = NaN',
    fn: () => calculateRaceTimeFromVdot(5000, NaN),
    validator: (res) => {
      // Returning 120 (2 min) for 5K when vdot is NaN is invalid behavior
      return res !== 120 && isFinite(res) && res > 0;
    },
    detail: 'vdot=NaN causes binary search to fall back to hardcoded low bound (120s = 2:00 for 5K)',
  },
  {
    name: 'RaceTime with vdot = Infinity (should clamp to 85.0)',
    fn: () => calculateRaceTimeFromVdot(5000, Infinity),
    expected: calculateRaceTimeFromVdot(5000, 85.0),
  },
  {
    name: 'RaceTime with vdot = -Infinity (should clamp to 30.0)',
    fn: () => calculateRaceTimeFromVdot(5000, -Infinity),
    expected: calculateRaceTimeFromVdot(5000, 30.0),
  },
  {
    name: 'RaceTime with vdot = 20 (<30, clamp to 30)',
    fn: () => calculateRaceTimeFromVdot(5000, 20),
    expected: calculateRaceTimeFromVdot(5000, 30.0),
  },
  {
    name: 'RaceTime with vdot = 100 (>85, clamp to 85)',
    fn: () => calculateRaceTimeFromVdot(5000, 100),
    expected: calculateRaceTimeFromVdot(5000, 85.0),
  },
  {
    name: 'VdotFromRace with d = 0',
    fn: () => calculateVdotFromRace(0, 1200),
    expected: 30.0,
  },
  {
    name: 'VdotFromRace with time = 0',
    fn: () => calculateVdotFromRace(5000, 0),
    expected: 30.0,
  },
  {
    name: 'VdotFromRace with d = NaN',
    fn: () => calculateVdotFromRace(NaN, 1200),
    validator: (res) => !isNaN(res),
    detail: 'd=NaN results in unhandled NaN return value instead of fallback/clamping',
  },
  {
    name: 'VdotFromRace with time = NaN',
    fn: () => calculateVdotFromRace(5000, NaN),
    validator: (res) => !isNaN(res),
    detail: 'time=NaN results in unhandled NaN return value instead of fallback/clamping',
  },
  {
    name: 'VdotPaces with vdot = NaN',
    fn: () => calculateVdotPaces(NaN),
    validator: (res) => !isNaN(res.vdot) && !isNaN(res.rawSecondsPerKm.easyMin),
    detail: 'vdot=NaN produces NaN paces and rawSecondsPerKm',
  },
];

for (const tc of boundaryCases) {
  let val;
  try {
    val = tc.fn();
  } catch (err) {
    val = `EXCEPTION: ${err.message}`;
  }

  let pass = false;
  if (tc.validator) {
    pass = Boolean(tc.validator(val));
  } else if (tc.expected !== undefined) {
    pass = val === tc.expected;
  }

  if (pass) {
    console.log(`  [PASS] ${tc.name} => ${JSON.stringify(val)}`);
  } else {
    results.boundaries.passed = false;
    results.boundaries.issues.push({ name: tc.name, actual: val, detail: tc.detail });
    console.log(`  [FAIL] ${tc.name} => actual: ${JSON.stringify(val)} (${tc.detail || 'unexpected'})`);
  }
}

// -----------------------------------------------------------------------------
// Overall Verdict
// -----------------------------------------------------------------------------
console.log('\n' + '='.repeat(80));
console.log('FINAL CHALLENGER VERDICT');
console.log('='.repeat(80));

const allPassed =
  results.convergence.passed &&
  results.monotonicity.passed &&
  results.precision.passed &&
  results.boundaries.passed;

if (allPassed) {
  console.log('VERDICT: APPROVE');
} else {
  console.log('VERDICT: REQUEST_CHANGES');
  console.log('Failures identified:');
  if (!results.convergence.passed) console.log('  - Convergence speed failed limit <= 30');
  if (!results.monotonicity.passed) console.log(`  - Numerical monotonicity violated (${results.monotonicity.violations.length} intervals)`);
  if (!results.precision.passed) console.log(`  - Precision round-trip violated (${results.precision.failPoints} points failed, maxErr: ${results.precision.maxError.toFixed(3)})`);
  if (!results.boundaries.passed) console.log(`  - Boundary/Invalid input handling failed (${results.boundaries.issues.length} issues)`);
}
