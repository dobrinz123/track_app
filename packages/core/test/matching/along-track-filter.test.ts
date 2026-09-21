import { describe, expect, it } from 'vitest';

import { SeededPrng } from '../../src/fixtures';
import { AlongTrackFilter } from '../../src/matching/along-track-filter';

/**
 * Ticket P8.2. The properties that matter are (a) it really does denoise the
 * along-track coordinate by the factor its covariance claims, and (b) there is
 * no input sequence that leaves it stuck refusing every measurement -- the
 * class of bug this project has been bitten by before.
 */

interface Run {
  /** Posterior distance error at each step, metres. */
  errors: number[];
  /** Raw measurement error at each step, metres. */
  rawErrors: number[];
  converged: boolean[];
}

function steadyRun(
  filter: AlongTrackFilter,
  options: {
    steps?: number;
    speedMps?: number;
    positionSigmaM?: number;
    dopplerSigmaMps?: number;
    dopplerBiasMps?: number;
    seed?: number;
  } = {},
): Run {
  const steps = options.steps ?? 60;
  const speed = options.speedMps ?? 41.67;
  const positionSigma = options.positionSigmaM ?? 3;
  const dopplerSigma = options.dopplerSigmaMps ?? 0.1;
  const bias = options.dopplerBiasMps ?? 0;
  const prng = new SeededPrng(options.seed ?? 7);
  const run: Run = { errors: [], rawErrors: [], converged: [] };

  for (let i = 0; i < steps; i += 1) {
    const truth = i * speed;
    const rawError = prng.gaussian() * positionSigma;
    const estimate = filter.observe({
      tMono: i * 1_000,
      measuredDistanceM: truth + rawError,
      speedMps: speed + bias + prng.gaussian() * dopplerSigma,
      accuracyM: positionSigma,
    });
    if (estimate === null) throw new Error('filter dropped a valid observation');
    run.errors.push(estimate.distanceM - truth);
    run.rawErrors.push(rawError);
    run.converged.push(estimate.converged);
  }
  return run;
}

const rms = (values: readonly number[]): number =>
  Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / values.length);

describe('AlongTrackFilter', () => {
  it('beats the raw projection by roughly the factor its covariance predicts', () => {
    const filter = new AlongTrackFilter();
    const run = steadyRun(filter, { steps: 200 });
    const settled = run.errors.slice(50);
    const rawSettled = run.rawErrors.slice(50);
    expect(rms(rawSettled)).toBeGreaterThan(2.4);
    expect(rms(settled)).toBeLessThan(rms(rawSettled) / 1.8);
  });

  it('is not converged until it has settled, and says so', () => {
    const filter = new AlongTrackFilter();
    const run = steadyRun(filter, { steps: 30 });
    expect(run.converged[0]).toBe(false);
    expect(run.converged[run.converged.length - 1]).toBe(true);
    const firstConverged = run.converged.indexOf(true);
    expect(firstConverged).toBeGreaterThanOrEqual(4);
  });

  it('never reports converged while the fixes are too inaccurate to help', () => {
    const filter = new AlongTrackFilter();
    const run = steadyRun(filter, { steps: 60, positionSigmaM: 20 });
    expect(run.converged.some((c) => c)).toBe(false);
  });

  it('re-seeds after a gap instead of extrapolating through it', () => {
    const filter = new AlongTrackFilter();
    steadyRun(filter, { steps: 40 });
    expect(filter.current()?.converged).toBe(true);
    // Ten seconds of nothing, then the car is 400 m further on.
    const after = filter.observe({
      tMono: 50_000,
      measuredDistanceM: 40 * 41.67 + 400,
      speedMps: 41.67,
      accuracyM: 3,
    });
    expect(after?.converged).toBe(false);
    expect(after?.distanceM).toBeCloseTo(40 * 41.67 + 400, 6);
    expect(filter.resetCount).toBe(1);
  });

  it('recovers from a teleport within maxOutlierRun fixes and never wedges', () => {
    const filter = new AlongTrackFilter();
    steadyRun(filter, { steps: 40 });
    const base = 40 * 41.67;
    // A 300 m jump with a plausible clock: rejected once, then accepted as
    // reality. The critical property is that it does NOT keep rejecting.
    filter.observe({ tMono: 40_000, measuredDistanceM: base + 300, speedMps: 41.67, accuracyM: 3 });
    filter.observe({
      tMono: 41_000,
      measuredDistanceM: base + 341.67,
      speedMps: 41.67,
      accuracyM: 3,
    });
    const settled = filter.observe({
      tMono: 42_000,
      measuredDistanceM: base + 383.34,
      speedMps: 41.67,
      accuracyM: 3,
    });
    expect(settled).not.toBeNull();
    expect(Math.abs((settled?.distanceM ?? 0) - (base + 383.34))).toBeLessThan(5);
    // And it comes back to converged rather than staying dead.
    for (let i = 3; i < 20; i += 1) {
      filter.observe({
        tMono: 42_000 + i * 1_000,
        measuredDistanceM: base + 383.34 + i * 41.67,
        speedMps: 41.67,
        accuracyM: 3,
      });
    }
    expect(filter.current()?.converged).toBe(true);
  });

  it('re-seeds on reverse travel rather than fighting it', () => {
    const filter = new AlongTrackFilter();
    steadyRun(filter, { steps: 40 });
    const base = 40 * 41.67;
    const back = filter.observe({
      tMono: 40_000,
      measuredDistanceM: base - 60,
      speedMps: 20,
      accuracyM: 3,
    });
    expect(back?.converged).toBe(false);
    expect(back?.distanceM).toBeCloseTo(base - 60, 6);
  });

  it('survives every degenerate input without wedging or throwing', () => {
    const filter = new AlongTrackFilter();
    const nasty = [
      { tMono: Number.NaN, measuredDistanceM: 0 },
      { tMono: 0, measuredDistanceM: Number.NaN },
      { tMono: 1_000, measuredDistanceM: Number.POSITIVE_INFINITY },
      { tMono: 1_000, measuredDistanceM: 10, speedMps: Number.NaN },
      { tMono: 1_000, measuredDistanceM: 10, speedMps: -1 },
      { tMono: 500, measuredDistanceM: 20, speedMps: 40 }, // clock goes backwards
      { tMono: 500, measuredDistanceM: 20, speedMps: 40 }, // clock stands still
      { tMono: 1_000_000, measuredDistanceM: 1e9, speedMps: 1e6 },
      { tMono: 1_000, measuredDistanceM: 10, accuracyM: -5 },
      { tMono: 2_000, measuredDistanceM: 50, accuracyM: 1e9 },
    ];
    for (const observation of nasty) expect(() => filter.observe(observation)).not.toThrow();

    // After all of that a clean stream must still converge -- proof the filter
    // cannot be left in a state that refuses everything.
    let estimate = null as ReturnType<AlongTrackFilter['observe']>;
    for (let i = 0; i < 40; i += 1) {
      estimate = filter.observe({
        tMono: 2_000_000 + i * 1_000,
        measuredDistanceM: i * 41.67,
        speedMps: 41.67,
        accuracyM: 3,
      });
    }
    expect(estimate?.converged).toBe(true);
  });

  it('works with no Doppler at all, just more slowly and less well', () => {
    const withDoppler = steadyRun(new AlongTrackFilter(), { steps: 200 });
    const noDoppler = new AlongTrackFilter();
    const prng = new SeededPrng(7);
    const errors: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const truth = i * 41.67;
      const estimate = noDoppler.observe({
        tMono: i * 1_000,
        measuredDistanceM: truth + prng.gaussian() * 3,
        speedMps: -1, // iOS: no Doppler solution
        accuracyM: 3,
      });
      if (estimate === null) throw new Error('dropped');
      errors.push(estimate.distanceM - truth);
    }
    expect(Number.isFinite(rms(errors.slice(50)))).toBe(true);
    expect(rms(errors.slice(50))).toBeGreaterThan(rms(withDoppler.errors.slice(50)));
  });

  it('rejects nonsensical configuration loudly', () => {
    expect(() => new AlongTrackFilter({ positionNoiseM: 0 })).toThrow(RangeError);
    expect(() => new AlongTrackFilter({ dopplerNoiseMps: -1 })).toThrow(RangeError);
    expect(() => new AlongTrackFilter({ dopplerProjectionFraction: -0.1 })).toThrow(RangeError);
    expect(() => new AlongTrackFilter({ maxOutlierRun: 0 })).toThrow(RangeError);
    expect(() => new AlongTrackFilter({ convergenceFraction: 1 })).toThrow(RangeError);
    expect(() => new AlongTrackFilter({ minSamplesForConvergence: 1.5 })).toThrow(RangeError);
    expect(() => new AlongTrackFilter({ minPositionNoiseM: 10, maxPositionNoiseM: 5 })).toThrow(
      RangeError,
    );
  });

  it('reset() returns it to the pre-first-observation state', () => {
    const filter = new AlongTrackFilter();
    steadyRun(filter, { steps: 30 });
    expect(filter.current()).not.toBeNull();
    filter.reset();
    expect(filter.current()).toBeNull();
    expect(filter.resetCount).toBe(0);
  });
});
