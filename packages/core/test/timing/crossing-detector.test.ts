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

  /**
   * Ticket P7M M4. The bound used to be a flat 120 m regardless of how long
   * the gap it spanned lasted, so a three-second dropout at 150 km/h
   * (~126 m) silently skipped the crossing and cost the lap.
   */
  describe('P7M M4 -- the step bound is scaled by elapsed time, not flat', () => {
    it('a 126 m step across a 3 s fix gap (150 km/h) is tested, not discarded', () => {
      const detector = new CrossingDetector([projectedGate('sf')], projection);
      const events = cross(detector, 0, 130, 0, 3_000, -63, 63);
      expect(events).toHaveLength(1);
      expect(events[0]?.direction).toBe('forward');
      expect(detector.stepDiagnostics().skippedSteps).toBe(0);
    });

    it('the SAME 126 m step across a nominal 1 s interval is still refused -- no car covers it', () => {
      const detector = new CrossingDetector([projectedGate('sf')], projection);
      expect(cross(detector, 0, 130, 0, 1_000, -63, 63)).toEqual([]);
      expect(detector.stepDiagnostics()).toEqual({ skippedSteps: 1, widestSkippedStepM: 126 });
    });

    it('a teleport -- 200 m in 100 ms, 7200 km/h -- is refused however short the interval', () => {
      const detector = new CrossingDetector([projectedGate('sf')], projection);
      expect(cross(detector, 0, 200, 0, 100, -100, 100)).toEqual([]);
      expect(detector.stepDiagnostics().skippedSteps).toBe(1);
    });

    it('past the 500 m ceiling a step is refused even at a plausible implied speed', () => {
      const detector = new CrossingDetector([projectedGate('sf')], projection);
      // 600 m over 20 s is 108 km/h -- perfectly drivable, but the straight
      // line between the two fixes is no longer an approximation of the path.
      expect(cross(detector, 0, 600, 0, 20_000, -300, 300)).toEqual([]);
      expect(detector.stepDiagnostics().widestSkippedStepM).toBe(600);
    });

    it('a refused step is counted, and reset() clears the record', () => {
      const detector = new CrossingDetector([projectedGate('sf')], projection);
      cross(detector, 0, 130, 0, 1_000, -63, 63);
      cross(detector, 0, 400, 2_000, 3_000, -200, 200);
      expect(detector.stepDiagnostics()).toEqual({ skippedSteps: 2, widestSkippedStepM: 400 });
      detector.reset();
      expect(detector.stepDiagnostics()).toEqual({ skippedSteps: 0, widestSkippedStepM: 0 });
    });

    it('a non-advancing or non-finite timestamp falls back to the flat bound', () => {
      const detector = new CrossingDetector([projectedGate('sf')], projection);
      // Same tMono on both fixes: no elapsed time to scale by, so 126 m is
      // refused exactly as the pre-P7M bound would have refused it.
      expect(cross(detector, 0, 130, 5_000, 5_000, -63, 63)).toEqual([]);
      expect(detector.stepDiagnostics().skippedSteps).toBe(1);
    });

    it('an explicit maxStepSpeedMps / maxStepCeilingM override is honoured', () => {
      const strict = new CrossingDetector([projectedGate('sf')], projection, { maxStepSpeedMps: 0 });
      // Speed scaling off: only the flat 120 m bound applies, whatever the gap.
      expect(
        strict.update(
          match(0, 0),
          match(10_000, 130),
          sample(0, -63),
          sample(10_000, 63),
        ),
      ).toEqual([]);
    });
  });

  /**
   * Ticket P9: the pit-lane flag must have been up for a while before timing
   * gates are suppressed. Feeds `count` consecutive flagged fixes, parked well
   * away from the gate so nothing crosses while the evidence accumulates.
   */
  function primePitEvidence(detector: CrossingDetector, count: number): void {
    for (let index = 0; index < count; index += 1) {
      const tTo = index * 1_000;
      const tFrom = tTo - 1_000;
      detector.update(
        match(tFrom, 0, 'good', true),
        match(tTo, 0, 'good', true),
        sample(tFrom, -50),
        sample(tTo, -50),
      );
    }
  }

  it('excludes timing gates in pit while allowing pit entry and exit gates', () => {
    const gates = [
      projectedGate('sf', 'startFinish'),
      projectedGate('sector', 'sector'),
      projectedGate('entry', 'pitEntry'),
      projectedGate('exit', 'pitExit'),
    ];
    const detector = new CrossingDetector(gates, projection);
    // Ticket P9: four flagged fixes spanning 3 s -- a car that really is in
    // the pit lane, not one noisy fix.
    primePitEvidence(detector, 4);
    expect(cross(detector, 0, 10, 3_000, 4_000, -1, 1, 'good', 'good', true, true)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gateId: 'entry' }),
        expect.objectContaining({ gateId: 'exit' }),
      ]),
    );

    const second = new CrossingDetector(gates, projection);
    primePitEvidence(second, 4);
    expect(
      cross(second, 0, 10, 3_000, 4_000, -1, 1, 'good', 'good', true, true).map(
        (event) => event.gateId,
      ),
    ).toEqual(['entry', 'exit']);
    expect(second.pitSuppressionDiagnostics().suppressedCrossings).toBe(2);
  });

  it('a single flagged fix no longer deletes the lap (P9)', () => {
    // The pre-P9 rule suppressed every timing gate on this step, so the lap
    // it belonged to simply never appeared.
    const gates = [projectedGate('sf', 'startFinish'), projectedGate('entry', 'pitEntry')];
    const detector = new CrossingDetector(gates, projection);
    expect(
      cross(detector, 0, 10, 0, 1_000, -1, 1, 'good', 'good', false, true).map(
        (event) => event.gateId,
      ),
    ).toEqual(['sf', 'entry']);
    expect(detector.pitSuppressionDiagnostics().suppressedCrossings).toBe(0);
  });
});
