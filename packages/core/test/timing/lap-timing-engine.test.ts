import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CrossingEvent, Gate, QualityLevel } from '../../src/contracts';
import {
  CrossingDetector,
  LapTimingEngine,
  type LapTimingProfile,
  type ProjectedGate,
} from '../../src/timing/index';

const makeGate = (id: string, kind: Gate['kind'], sectorIndex?: number): Gate => ({
  id,
  kind,
  a: { lat: 0, lon: 0 },
  b: { lat: 0, lon: 10 },
  ...(sectorIndex === undefined ? {} : { sectorIndex }),
});

const profile: LapTimingProfile = {
  totalLengthM: 1_000,
  startFinishGate: makeGate('sf', 'startFinish'),
  sectorGates: [makeGate('s1', 'sector', 1), makeGate('s2', 'sector', 2)],
};

const noSectorProfile: LapTimingProfile = { ...profile, sectorGates: [] };

function event(
  gateId: string,
  kind: Gate['kind'],
  tCross: number,
  lapDistanceM: number,
  direction: CrossingEvent['direction'] = 'forward',
): CrossingEvent {
  return { gateId, kind, tCross, direction, confidence: 1, lapDistanceM };
}

function feed(
  engine: LapTimingEngine,
  gateId: string,
  kind: Gate['kind'],
  tCross: number,
  progress: number,
  quality: QualityLevel = 'good',
  inPit = false,
) {
  return engine.onCrossing(event(gateId, kind, tCross, progress), quality, inPit);
}

describe('LapTimingEngine', () => {
  it('builds a valid lap with ordered sector durations and worst quality', () => {
    const engine = new LapTimingEngine(profile);
    expect(feed(engine, 'sf', 'startFinish', 0, 0)).toBeNull();
    expect(feed(engine, 's1', 'sector', 30_000, 330, 'degraded')).toBeNull();
    expect(engine.currentLap()?.sectorIndex).toBe(1);
    expect(feed(engine, 's2', 'sector', 60_000, 660)).toBeNull();
    const lap = feed(engine, 'sf', 'startFinish', 90_000, 1_000);

    expect(lap).toMatchObject({
      lapNumber: 1,
      tStart: 0,
      tEnd: 90_000,
      durationMs: 90_000,
      valid: true,
      invalidReasons: [],
      quality: 'degraded',
    });
    expect(lap?.sectorTimes).toEqual([
      { sectorIndex: 0, durationMs: 30_000, quality: 'degraded' },
      { sectorIndex: 1, durationMs: 30_000, quality: 'degraded' },
      { sectorIndex: 2, durationMs: 30_000, quality: 'good' },
    ]);
    expect(engine.currentLap()?.lapNumber).toBe(2);
  });

  it('invalidates and still reports observed timing when a sector is skipped', () => {
    const engine = new LapTimingEngine(profile);
    feed(engine, 'sf', 'startFinish', 0, 0);
    feed(engine, 's2', 'sector', 50_000, 600);
    const lap = feed(engine, 'sf', 'startFinish', 90_000, 1_000);
    expect(lap?.valid).toBe(false);
    expect(lap?.invalidReasons).toContain('MISSED_SECTOR_GATE');
    expect(lap?.sectorTimes).toEqual([
      { sectorIndex: 0, durationMs: 50_000, quality: 'good' },
      { sectorIndex: 2, durationMs: 40_000, quality: 'good' },
    ]);
  });

  it('invalidates and reports all intervals when a sector gate is duplicated', () => {
    const engine = new LapTimingEngine(profile);
    feed(engine, 'sf', 'startFinish', 0, 0);
    feed(engine, 's1', 'sector', 20_000, 250);
    feed(engine, 's1', 'sector', 30_000, 300);
    feed(engine, 's2', 'sector', 60_000, 650);
    const lap = feed(engine, 'sf', 'startFinish', 90_000, 1_000);
    expect(lap?.valid).toBe(false);
    expect(lap?.invalidReasons).toContain('DUPLICATE_SECTOR_GATE');
    expect(lap?.invalidReasons).not.toContain('MISSED_SECTOR_GATE');
    expect(lap?.sectorTimes).toHaveLength(4);
  });

  it.each([
    ['duration', 59_999, 1_000],
    ['distance', 90_000, 899],
  ] as const)('uses both %s thresholds for SHORT_LAP', (_case, duration, distance) => {
    const engine = new LapTimingEngine(noSectorProfile);
    feed(engine, 'sf', 'startFinish', 0, 0);
    const lap = feed(engine, 'sf', 'startFinish', duration, distance);
    expect(lap?.invalidReasons).toContain('SHORT_LAP');
  });

  it('records PIT_TRANSIT when any observed point during the lap is in pit', () => {
    const engine = new LapTimingEngine(profile);
    feed(engine, 'sf', 'startFinish', 0, 0);
    feed(engine, 's1', 'sector', 30_000, 330, 'good', true);
    feed(engine, 's2', 'sector', 60_000, 660);
    expect(feed(engine, 'sf', 'startFinish', 90_000, 1_000)?.invalidReasons).toContain(
      'PIT_TRANSIT',
    );
  });

  it('requires strictly more than the configured continuous low-quality window', () => {
    const exact = new LapTimingEngine(profile);
    feed(exact, 'sf', 'startFinish', 0, 0, 'unreliable');
    feed(exact, 's1', 'sector', 10_000, 330, 'good');
    feed(exact, 's2', 'sector', 60_000, 660);
    expect(feed(exact, 'sf', 'startFinish', 90_000, 1_000)?.invalidReasons).not.toContain(
      'LOW_QUALITY',
    );

    const over = new LapTimingEngine(profile);
    feed(over, 'sf', 'startFinish', 0, 0, 'unreliable');
    feed(over, 's1', 'sector', 10_001, 330, 'unreliable');
    feed(over, 's2', 'sector', 60_000, 660, 'good');
    expect(feed(over, 'sf', 'startFinish', 90_000, 1_000)?.invalidReasons).toContain('LOW_QUALITY');
  });

  it('accepts external invalidation hooks including PAUSE_GAP', () => {
    const engine = new LapTimingEngine(profile);
    feed(engine, 'sf', 'startFinish', 0, 0);
    engine.markInvalid('PAUSE_GAP');
    feed(engine, 's1', 'sector', 30_000, 330);
    feed(engine, 's2', 'sector', 60_000, 660);
    expect(feed(engine, 'sf', 'startFinish', 90_000, 1_000)?.invalidReasons).toContain('PAUSE_GAP');
  });

  it('invalidates a progress drawdown greater than 30 m as REVERSE_TRAVEL', () => {
    const engine = new LapTimingEngine(profile);
    feed(engine, 'sf', 'startFinish', 0, 0);
    feed(engine, 's1', 'sector', 30_000, 500);
    feed(engine, 's2', 'sector', 60_000, 469);
    expect(feed(engine, 'sf', 'startFinish', 90_000, 1_000)?.invalidReasons).toContain(
      'REVERSE_TRAVEL',
    );
  });

  it('ignores reverse events and exposes a non-negative resettable live view', () => {
    const engine = new LapTimingEngine(noSectorProfile);
    engine.onCrossing(event('sf', 'startFinish', 0, 0, 'reverse'), 'good', false);
    expect(engine.currentLap()).toBeNull();
    feed(engine, 'sf', 'startFinish', 100, 0);
    engine.onCrossing(event('sf', 'startFinish', 200, 1_000, 'reverse'), 'good', false);
    expect(engine.currentLap()?.elapsedMs(50)).toBe(0);
    expect(engine.currentLap()?.lapNumber).toBe(1);
    engine.reset();
    expect(engine.currentLap()).toBeNull();
  });

  it('never emits a non-positive lap for random timestamp jitter', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -5_000, max: 5_000 }), {
          minLength: 1,
          maxLength: 100,
        }),
        (jitter) => {
          const engine = new LapTimingEngine(noSectorProfile, { minLapMs: 0 });
          feed(engine, 'sf', 'startFinish', 0, 0);
          let t = 0;
          jitter.forEach((delta, index) => {
            t += delta;
            const lap = feed(engine, 'sf', 'startFinish', t, (index + 1) * 1_000);
            if (lap !== null) expect(lap.durationMs).toBeGreaterThan(0);
          });
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never turns start/finish jitter inside rearm distance into a short lap', () => {
    const localGate: ProjectedGate = {
      gate: makeGate('sf', 'startFinish'),
      aLocal: { e: 0, n: 0 },
      bLocal: { e: 10, n: 0 },
    };
    const projection = {
      toLocal: ({ lat, lon }: { lat: number; lon: number }) => ({ e: lon, n: lat }),
    };
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 49.999, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 1, max: 59_999 }),
        (jitterProgress, jitterTime) => {
          const detector = new CrossingDetector([localGate], projection);
          const engine = new LapTimingEngine(noSectorProfile);
          const crossing = (time: number, progress: number) =>
            detector.update(
              {
                tMono: time - 1,
                distanceM: 0,
                progress: 0,
                unwrappedProgressM: progress,
                lateralM: 0,
                confidence: 1,
                sectorIndex: 0,
                quality: { level: 'good', reasons: [] },
                onPitLane: false,
              },
              {
                tMono: time + 1,
                distanceM: 0,
                progress: 0,
                unwrappedProgressM: progress,
                lateralM: 0,
                confidence: 1,
                sectorIndex: 0,
                quality: { level: 'good', reasons: [] },
                onPitLane: false,
              },
              { tMono: time - 1, lat: -1, lon: 5, source: 'replay' },
              { tMono: time + 1, lat: 1, lon: 5, source: 'replay' },
            );

          const first = crossing(0, 0)[0];
          if (first !== undefined) engine.onCrossing(first, 'good', false);
          const duplicate = crossing(jitterTime, jitterProgress)[0];
          const lap = duplicate === undefined ? null : engine.onCrossing(duplicate, 'good', false);
          expect(lap === null || lap.durationMs >= 60_000).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('starts fresh sessions at lap 1 by default (MUST DO #5, no behavior change)', () => {
    const engine = new LapTimingEngine(profile);
    feed(engine, 'sf', 'startFinish', 0, 0);
    expect(engine.currentLap()?.lapNumber).toBe(1);
  });

  it('honors config.initialLapNumber for the first lap it starts (MUST DO #5)', () => {
    const engine = new LapTimingEngine(profile, { initialLapNumber: 4 });
    expect(feed(engine, 'sf', 'startFinish', 0, 0)).toBeNull();
    expect(engine.currentLap()?.lapNumber).toBe(4);
    const lap = feed(engine, 'sf', 'startFinish', 90_000, 1_000);
    expect(lap?.lapNumber).toBe(4);
    // Numbering continues normally past the seeded value.
    expect(engine.currentLap()?.lapNumber).toBe(5);
  });

  it('reset() returns to initialLapNumber, not the hardcoded 1', () => {
    const engine = new LapTimingEngine(profile, { initialLapNumber: 4 });
    feed(engine, 'sf', 'startFinish', 0, 0);
    feed(engine, 'sf', 'startFinish', 90_000, 1_000);
    expect(engine.currentLap()?.lapNumber).toBe(5);
    engine.reset();
    expect(engine.currentLap()).toBeNull();
    feed(engine, 'sf', 'startFinish', 0, 0);
    expect(engine.currentLap()?.lapNumber).toBe(4);
  });

  it('keeps valid sector sums within one millisecond of lap duration', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 20_000, max: 100_000 }),
          fc.integer({ min: 20_000, max: 100_000 }),
          fc.integer({ min: 20_000, max: 100_000 }),
        ),
        ([first, second, third]) => {
          const engine = new LapTimingEngine(profile);
          feed(engine, 'sf', 'startFinish', 0, 0);
          feed(engine, 's1', 'sector', first, 330);
          feed(engine, 's2', 'sector', first + second, 660);
          const lap = feed(engine, 'sf', 'startFinish', first + second + third, 1_000);
          expect(lap?.valid).toBe(true);
          const sectorSum =
            lap?.sectorTimes.reduce((sum, sector) => sum + sector.durationMs, 0) ?? 0;
          expect(sectorSum).toBeLessThanOrEqual((lap?.durationMs ?? 0) + 1);
        },
      ),
      { numRuns: 500 },
    );
  });
});
