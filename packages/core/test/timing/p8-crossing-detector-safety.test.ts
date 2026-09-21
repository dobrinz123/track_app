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

/** Drives a straight approach to the gate so the filter has a chance to converge. */
function approach(
  detector: CrossingDetector,
  options: { speedMps?: number | undefined; steps?: number; stepM?: number } = {},
) {
  const steps = options.steps ?? 20;
  const stepM = options.stepM ?? 40;
  const events = [];
  let prevMatch: TrackMatch | null = null;
  let prevSample: LocationSample | null = null;
  for (let i = 0; i < steps; i += 1) {
    // North goes from well before the gate (negative) to well past it; the
    // gate lies on n = 0 and the crossing happens on the last step.
    const north = -((steps - 1 - i) * 2) - 1 + (i === steps - 1 ? 4 : 0);
    const currSample = sample(i * 1_000, north, options.speedMps);
    const currMatch = match(i * 1_000, i * stepM);
    events.push(...detector.update(prevMatch, currMatch, prevSample, currSample));
    prevMatch = currMatch;
    prevSample = currSample;
  }
  return events;
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
