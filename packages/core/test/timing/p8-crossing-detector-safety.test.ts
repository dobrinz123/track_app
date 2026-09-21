/**
 * Ticket P8 -- the architectural constraint, tested directly at the seam.
 *
 * `CrossingDetector` decides IF a crossing happened from raw fixes and raw
 * geometry; P8 only decides WHEN. These tests break the P8 machinery on
 * purpose -- make the filter throw, make it return nonsense, make it lie about
 * which fix it belongs to -- and assert the detector still emits exactly the
 * same event, timed the way it was before P8.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Gate, LocationSample, QualityLevel, TrackMatch } from '../../src/contracts';
import { interpolateCrossingTime } from '../../src/geometry/intersection';
import { AlongTrackFilter } from '../../src/matching/along-track-filter';
import { CrossingDetector, type ProjectedGate } from '../../src/timing/crossing-detector';

const gate = (id: string, kind: Gate['kind'] = 'startFinish'): Gate => ({
  id,
  kind,
  a: { lat: 0, lon: 0 },
  b: { lat: 0, lon: 10 },
});

const projectedGate = (id: string, kind: Gate['kind'] = 'startFinish'): ProjectedGate => ({
  gate: gate(id, kind),
  aLocal: { e: 0, n: 0 },
  bLocal: { e: 10, n: 0 },
});

const projection = {
  toLocal: ({ lat, lon }: { lat: number; lon: number }) => ({ e: lon, n: lat }),
};

function sample(tMono: number, north: number, speedMps?: number): LocationSample {
  return {
    tMono,
    lat: north,
    lon: 5,
    source: 'replay',
    accuracyM: 3,
    ...(speedMps === undefined ? {} : { speedMps }),
  };
}

function match(
  tMono: number,
  unwrappedProgressM: number,
  quality: QualityLevel = 'good',
): TrackMatch {
  return {
    tMono,
    distanceM: unwrappedProgressM % 1_000,
    progress: (unwrappedProgressM % 1_000) / 1_000,
    unwrappedProgressM,
    lateralM: 0,
    confidence: 0.9,
    sectorIndex: 0,
    quality: { level: quality, reasons: [] },
    onPitLane: false,
  };
}

/**
 * Drives a straight approach to the gate so the filter has a chance to
 * converge. `intervalMs` (P9-FIX1) sweeps the fix rate; the geometry of the
 * final step does not depend on it, so the gate always sits at exactly half
 * the chord and the pre-P8 answer is
 * `interpolateCrossingTime(tPrev, tCurr, 0.5)`.
 */
function approach(
  detector: CrossingDetector,
  options: {
    speedMps?: number | undefined;
    steps?: number;
    stepM?: number;
    intervalMs?: number;
  } = {},
) {
  const steps = options.steps ?? 20;
  const stepM = options.stepM ?? 40;
  const intervalMs = options.intervalMs ?? 1_000;
  const events = [];
  let prevMatch: TrackMatch | null = null;
  let prevSample: LocationSample | null = null;
  for (let i = 0; i < steps; i += 1) {
    // North goes from well before the gate (negative) to well past it; the
    // gate lies on n = 0 and the crossing happens on the last step.
    const north = -((steps - 1 - i) * 2) - 1 + (i === steps - 1 ? 4 : 0);
    const currSample = sample(i * intervalMs, north, options.speedMps);
    const currMatch = match(i * intervalMs, i * stepM);
    events.push(...detector.update(prevMatch, currMatch, prevSample, currSample));
    prevMatch = currMatch;
    prevSample = currSample;
  }
  return events;
}

/**
 * Ticket P9-FIX1. A rate-swept approach whose POSITION and PROGRESS both
 * advance at `TRUE_SPEED_MPS`, so the stream is self-consistent at every fix
 * rate and the along-track filter is given a trajectory it can actually
 * settle on. The final step is symmetric about the gate, so the pre-P8 answer
 * is again `interpolateCrossingTime(tPrev, tCurr, 0.5)` at every rate.
 */
const TRUE_SPEED_MPS = 40;

interface RateRun {
  intervalMs: number;
  steps: number;
  /** Doppler value written onto every fix; `undefined` omits the channel. */
  speedMps?: number | undefined;
  /** Doppler for the LAST fix only, when it must differ from the rest. */
  lastSpeedMps?: number | undefined;
  lastSpeedOverridden?: boolean;
}

function rateSamples(run: RateRun): Array<{ sample: LocationSample; match: TrackMatch }> {
  const stepM = (TRUE_SPEED_MPS * run.intervalMs) / 1_000;
  const out = [];
  for (let i = 0; i < run.steps; i += 1) {
    const north = (i - (run.steps - 1) + 0.5) * stepM;
    const speedMps =
      run.lastSpeedOverridden === true && i === run.steps - 1 ? run.lastSpeedMps : run.speedMps;
    out.push({
      sample: sample(i * run.intervalMs, north, speedMps),
      match: match(i * run.intervalMs, i * stepM),
    });
  }
  return out;
}

function rateApproach(detector: CrossingDetector, run: RateRun) {
  const events = [];
  let prevMatch: TrackMatch | null = null;
  let prevSample: LocationSample | null = null;
  for (const { sample: currSample, match: currMatch } of rateSamples(run)) {
    events.push(...detector.update(prevMatch, currMatch, prevSample, currSample));
    prevMatch = currMatch;
    prevSample = currSample;
  }
  return events;
}

/**
 * Whether an INDEPENDENT along-track filter, fed exactly what the detector's
 * private one is fed on the same stream, has converged by the crossing. This
 * is what makes the fallback assertions below bite: a bit-identical timestamp
 * would otherwise also be explained by the filter never having settled, which
 * is not the property under test.
 */
function rateFilterConverged(run: RateRun): boolean {
  const filter = new AlongTrackFilter();
  let converged = false;
  for (const { sample: currSample, match: currMatch } of rateSamples(run)) {
    const estimate = filter.observe({
      tMono: currSample.tMono,
      measuredDistanceM: currMatch.unwrappedProgressM,
      speedMps: currSample.speedMps,
      accuracyM: currSample.accuracyM,
    });
    converged = estimate?.converged ?? false;
  }
  return converged;
}

function linearAnswer(run: RateRun): number {
  return interpolateCrossingTime(
    (run.steps - 2) * run.intervalMs,
    (run.steps - 1) * run.intervalMs,
    0.5,
  );
}

describe('CrossingDetector P8 safety', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits the crossing even when the along-track filter throws on every fix', () => {
    vi.spyOn(AlongTrackFilter.prototype, 'observe').mockImplementation(() => {
      throw new Error('filter exploded');
    });
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    const events = approach(detector, { speedMps: 40 });
    expect(events).toHaveLength(1);
    expect(events[0]?.gateId).toBe('sf');
    expect(Number.isFinite(events[0]?.tCross)).toBe(true);
  });

  it('emits the crossing when the filter returns nonsense', () => {
    vi.spyOn(AlongTrackFilter.prototype, 'observe').mockImplementation(() => ({
      tMono: Number.NaN,
      distanceM: Number.NaN,
      speedMps: Number.NaN,
      distanceSigmaM: Number.NaN,
      converged: true,
    }));
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    const events = approach(detector, { speedMps: 40 });
    expect(events).toHaveLength(1);
    expect(Number.isFinite(events[0]?.tCross)).toBe(true);
  });

  it('ignores a filter estimate that does not belong to the bracketing fixes', () => {
    vi.spyOn(AlongTrackFilter.prototype, 'observe').mockImplementation(() => ({
      tMono: 999_999, // never matches either bracketing sample
      distanceM: 1_000,
      speedMps: 40,
      distanceSigmaM: 0.5,
      converged: true,
    }));
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    const fused = approach(detector, { speedMps: 40 });
    const reference = new CrossingDetector([projectedGate('sf')], projection, {
      alongTrackFusion: false,
    });
    const linear = approach(reference, { speedMps: 40 });
    expect(fused[0]?.tCross).toBe(linear[0]?.tCross);
    expect(detector.timingDiagnostics().fusedCrossings).toBe(0);
  });

  it('a fix stream with no speed is bit-identical to the pre-P8 interpolation', () => {
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    const events = approach(detector, { speedMps: undefined });
    expect(events).toHaveLength(1);

    // Recompute the pre-P8 answer independently from the same geometry: the
    // final step runs from n = -3 to n = +3, so the gate at n = 0 sits at
    // exactly half the chord.
    const steps = 20;
    const tPrev = (steps - 2) * 1_000;
    const tCurr = (steps - 1) * 1_000;
    expect(Object.is(events[0]?.tCross, interpolateCrossingTime(tPrev, tCurr, 0.5))).toBe(true);
    expect(detector.timingDiagnostics().kinematicCrossings).toBe(0);
    expect(detector.timingDiagnostics().fusedCrossings).toBe(0);
  });

  it('a fix stream with iOS speed = -1 is bit-identical to the pre-P8 interpolation', () => {
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    const events = approach(detector, { speedMps: -1 });
    const steps = 20;
    expect(
      Object.is(events[0]?.tCross, interpolateCrossingTime((steps - 2) * 1_000, (steps - 1) * 1_000, 0.5)),
    ).toBe(true);
  });

  it('with both stages off it is bit-identical to the pre-P8 interpolation even with good speeds', () => {
    const on = new CrossingDetector([projectedGate('sf')], projection, {
      dopplerCrossingTime: false,
      alongTrackFusion: false,
    });
    const events = approach(on, { speedMps: 40 });
    const steps = 20;
    expect(
      Object.is(events[0]?.tCross, interpolateCrossingTime((steps - 2) * 1_000, (steps - 1) * 1_000, 0.5)),
    ).toBe(true);
  });

  it('reset() clears the along-track state as well as the rearm state', () => {
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    approach(detector, { speedMps: 40 });
    expect(detector.timingDiagnostics().fusedCrossings).toBeGreaterThanOrEqual(0);
    detector.reset();
    expect(detector.timingDiagnostics()).toEqual({
      kinematicCrossings: 0,
      fusedCrossings: 0,
      alongTrackResets: 0,
    });
  });

  /**
   * Ticket P9-FIX1, Codex MEDIUM on `crossing-detector.ts:466`.
   *
   * P8's stated contract is that without valid Doppler the crossing instant is
   * bit-identical to the pre-P8 linear interpolation. It was not. The
   * along-track filter runs on position alone, so on a dense stream it
   * CONVERGES with no speed channel at all and hands its own inferred
   * velocities to the kinematic model: Codex measured 9938.461538461539 ms
   * (linear) against 9946.915566660227 ms (defaults) at 10 Hz, with both the
   * fusion and the kinematic counter incremented. The one shipped
   * missing-speed test ran only at 1 Hz, where the filter has not settled by
   * the crossing -- which is exactly why it passed.
   *
   * So the sweep is over the supported rate range, over every way a device
   * says "no Doppler", and it asserts the filter DID converge first.
   */
  describe('P9-FIX1: no valid Doppler means the pre-P8 instant, at every rate', () => {
    const RATES = [
      { hz: 1, intervalMs: 1_000, steps: 40 },
      { hz: 2, intervalMs: 500, steps: 60 },
      { hz: 5, intervalMs: 200, steps: 120 },
      { hz: 10, intervalMs: 100, steps: 200 },
    ] as const;
    const ABSENT: ReadonlyArray<readonly [string, number | undefined]> = [
      ['channel omitted', undefined],
      ['iOS -1', -1],
      ['NaN', Number.NaN],
    ];

    it.each(RATES.map((rate) => [`${rate.hz} Hz`, rate] as const))(
      '%s: no Doppler in any of its three forms may move the instant',
      (label, rate) => {
        const expected = linearAnswer(rate);
        for (const [name, speedMps] of ABSENT) {
          const detector = new CrossingDetector([projectedGate('sf')], projection);
          const events = rateApproach(detector, { ...rate, speedMps });
          expect(events, `${name}: the crossing itself must survive`).toHaveLength(1);
          expect(
            Object.is(events[0]?.tCross, expected),
            `${name} at ${label}: ${String(events[0]?.tCross)} !== linear ${String(expected)}`,
          ).toBe(true);
          const diagnostics = detector.timingDiagnostics();
          expect(diagnostics.kinematicCrossings, `${name} at ${label}`).toBe(0);
          expect(diagnostics.fusedCrossings, `${name} at ${label}`).toBe(0);
        }
      },
    );

    it('the position-only filter really does converge at the dense rates', () => {
      // Without this the sweep above could be satisfied by a filter that never
      // settled, and it would not be testing the contract at all. This is the
      // condition the shipped 1 Hz test never reached.
      expect(rateFilterConverged({ intervalMs: 100, steps: 200 })).toBe(true);
      expect(rateFilterConverged({ intervalMs: 200, steps: 120 })).toBe(true);
    });

    it('one valid endpoint is not enough: both bracketing fixes must carry Doppler', () => {
      const run = {
        intervalMs: 100,
        steps: 200,
        speedMps: TRUE_SPEED_MPS,
        lastSpeedMps: -1,
        lastSpeedOverridden: true,
      };
      const detector = new CrossingDetector([projectedGate('sf')], projection);
      const events = rateApproach(detector, run);
      expect(events).toHaveLength(1);
      expect(Object.is(events[0]?.tCross, linearAnswer(run))).toBe(true);
      expect(detector.timingDiagnostics().kinematicCrossings).toBe(0);
      expect(detector.timingDiagnostics().fusedCrossings).toBe(0);
    });

    it('with valid Doppler at that same rate the refinement DOES still run', () => {
      // The other half of the bite: what was added is a Doppler gate, not a
      // rate gate, so it must not have switched the refinement off wholesale.
      const detector = new CrossingDetector([projectedGate('sf')], projection);
      const events = rateApproach(detector, {
        intervalMs: 100,
        steps: 200,
        speedMps: TRUE_SPEED_MPS,
      });
      expect(events).toHaveLength(1);
      const diagnostics = detector.timingDiagnostics();
      expect(diagnostics.kinematicCrossings + diagnostics.fusedCrossings).toBeGreaterThan(0);
    });
  });

  it('refuses an along-track correction wider than the configured bound', () => {
    // maxAlongTrackCorrectionM = 0 means "no fusion may move the answer at
    // all", which must therefore reproduce the P8.1-only result exactly.
    const bounded = new CrossingDetector([projectedGate('sf')], projection, {
      maxAlongTrackCorrectionM: 0,
    });
    const p81Only = new CrossingDetector([projectedGate('sf')], projection, {
      alongTrackFusion: false,
    });
    expect(approach(bounded, { speedMps: 40 })[0]?.tCross).toBe(
      approach(p81Only, { speedMps: 40 })[0]?.tCross,
    );
  });
});
