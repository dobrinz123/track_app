import { describe, expect, it } from 'vitest';
import type { Gate, LocationSample, QualityLevel, TrackMatch } from '../../src/contracts';
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

function sample(tMono: number, north: number, east = 5): LocationSample {
  return { tMono, lat: north, lon: east, source: 'replay' };
}

function match(
  tMono: number,
  unwrappedProgressM: number,
  quality: QualityLevel = 'good',
  onPitLane = false,
  confidence = 0.9,
): TrackMatch {
  return {
    tMono,
    distanceM: unwrappedProgressM % 1_000,
    progress: (unwrappedProgressM % 1_000) / 1_000,
    unwrappedProgressM,
    lateralM: 0,
    confidence,
    sectorIndex: 0,
    quality: { level: quality, reasons: [] },
    onPitLane,
  };
}

function cross(
  detector: CrossingDetector,
  progressFrom: number,
  progressTo: number,
  tFrom: number,
  tTo: number,
  northFrom = -1,
  northTo = 1,
  qualityFrom: QualityLevel = 'good',
  qualityTo: QualityLevel = 'good',
  inPitFrom = false,
  inPitTo = false,
) {
  return detector.update(
    match(tFrom, progressFrom, qualityFrom, inPitFrom),
    match(tTo, progressTo, qualityTo, inPitTo),
    sample(tFrom, northFrom),
    sample(tTo, northTo),
  );
}

describe('CrossingDetector', () => {
  it('uses geometry direction and interpolates monotonic time and unwrapped progress', () => {
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    expect(cross(detector, 10, 20, 1_000, 2_000)).toEqual([
      {
        gateId: 'sf',
        kind: 'startFinish',
        tCross: 1_500,
        direction: 'forward',
        confidence: 0.9,
        lapDistanceM: 15,
      },
    ]);
  });

  it('requires both previous inputs', () => {
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    expect(detector.update(null, match(1, 1), null, sample(1, 1))).toEqual([]);
  });

  it('suppresses forward jitter until rearm distance advances, and reset clears rearm state', () => {
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    expect(cross(detector, 5, 15, 0, 10)).toHaveLength(1);
    expect(cross(detector, 20, 30, 20, 30)).toEqual([]);
    expect(cross(detector, 20, 30, 30, 40, 1, -1)).toEqual([]);
    expect(cross(detector, 55, 65, 40, 50)).toHaveLength(1);

    detector.reset();
    expect(cross(detector, 20, 30, 60, 70)).toHaveLength(1);
  });

  it('reports reverse crossings without consuming forward rearm state', () => {
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    expect(cross(detector, 5, 15, 0, 10, 1, -1)[0]?.direction).toBe('reverse');
    expect(cross(detector, 6, 16, 20, 30)[0]?.direction).toBe('forward');
  });

  it('rejects invalid matched samples and caps unreliable crossing confidence', () => {
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    expect(cross(detector, 0, 10, 0, 10, -1, 1, 'invalid', 'good')).toEqual([]);
    expect(cross(detector, 0, 10, 20, 30, -1, 1, 'good', 'invalid')).toEqual([]);

    const unreliableDetector = new CrossingDetector([projectedGate('sf')], projection);
    const event = cross(unreliableDetector, 0, 10, 0, 10, -1, 1, 'good', 'unreliable')[0];
    expect(event?.confidence).toBeLessThanOrEqual(0.3);
  });

  it('emits nothing for a step beyond the maximum plausible distance', () => {
    const detector = new CrossingDetector([projectedGate('sf')], projection);
    expect(cross(detector, 0, 10, 0, 2_000, -100, 100)).toEqual([]);
  });

  it('excludes timing gates in pit while allowing pit entry and exit gates', () => {
    const gates = [
      projectedGate('sf', 'startFinish'),
      projectedGate('sector', 'sector'),
      projectedGate('entry', 'pitEntry'),
      projectedGate('exit', 'pitExit'),
    ];
    const detector = new CrossingDetector(gates, projection);
    expect(cross(detector, 0, 10, 0, 10, -1, 1, 'good', 'good', true, true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gateId: 'entry' }),
        expect.objectContaining({ gateId: 'exit' }),
      ]),
    );
    expect(
      cross(
        new CrossingDetector(gates, projection),
        0,
        10,
        0,
        10,
        -1,
        1,
        'good',
        'good',
        true,
        true,
      ).map((event) => event.gateId),
    ).toEqual(['entry', 'exit']);
  });
});
