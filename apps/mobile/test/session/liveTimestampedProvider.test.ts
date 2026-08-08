import { describe, expect, it } from 'vitest';
import type { LocationProvider, LocationSample } from '@circuit/core';
import {
  DEFAULT_TELEMETRY_QUALITY_CONFIG,
  InMemorySessionRepository,
  SessionController,
  TelemetryQualityEvaluator,
  cleanRecognitionLap,
} from '@circuit/core';
import {
  ReplayTimeSource,
  ReplayTimestampedLocationProvider,
  ScaledReplayClock,
} from '../../src/session/liveTimestampedProvider';
import { RealSessionFacade } from '../../src/session/realFacade';
import type { FacadeState } from '../../src/session/facade';
import { TMR_CIRCUIT_PROFILE, TMR_RUNTIME_PROFILE } from '../../src/session/tmrProfile';
import { FakeClock } from '../support/coreTestDoubles';

/**
 * A `LocationProvider` test double that only emits while "active" -- unlike
 * core's `FakeLocationProvider` (which ignores start/stop entirely), this
 * models a real provider that genuinely ceases emission once stopped, which
 * is exactly the behavior under test in the `stop()` case below.
 */
class ScriptedProvider implements LocationProvider {
  private readonly listeners = new Set<(s: LocationSample) => void>();
  active = false;

  async start(): Promise<void> {
    this.active = true;
  }

  async stop(): Promise<void> {
    this.active = false;
  }

  subscribe(cb: (s: LocationSample) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Delivers a sample to subscribers only while active. */
  deliver(sample: LocationSample): void {
    if (!this.active) return;
    for (const listener of this.listeners) listener(sample);
  }
}

function sample(tMono: number, extra: Partial<LocationSample> = {}): LocationSample {
  return { tMono, lat: 46.435, lon: 25.06, source: 'replay', ...extra };
}

describe('ReplayTimeSource', () => {
  it('virtualNow() = virtualStartMono + realElapsed * speedFactor', () => {
    const realClock = new FakeClock(1_000_000);
    const timeSource = new ReplayTimeSource(realClock, 10, 500);

    expect(timeSource.virtualNow()).toBe(500); // no real time elapsed yet

    realClock.advance(100); // 100ms of real time
    expect(timeSource.virtualNow()).toBe(500 + 100 * 10);

    realClock.advance(50);
    expect(timeSource.virtualNow()).toBe(500 + 150 * 10);
  });

  it('defaults virtualStartMono to 0', () => {
    const realClock = new FakeClock(0);
    const timeSource = new ReplayTimeSource(realClock, 4);
    expect(timeSource.virtualNow()).toBe(0);
    realClock.advance(10);
    expect(timeSource.virtualNow()).toBe(40);
  });

  it('toVirtual() offsets from the anchor without scaling, independent of real time', () => {
    const realClock = new FakeClock(0);
    const timeSource = new ReplayTimeSource(realClock, 10, 500);

    // A fixture's own tMono values, anchored at its first sample (1_000).
    expect(timeSource.toVirtual(1_000, 1_000)).toBe(500);
    expect(timeSource.toVirtual(2_000, 1_000)).toBe(1_500); // +1000ms of ORIGINAL spacing, unscaled
    expect(timeSource.toVirtual(1_500, 1_000)).toBe(1_000);

    // Real-time elapsing has no effect on toVirtual -- it is a pure fixture-time offset.
    realClock.advance(1_000_000);
    expect(timeSource.toVirtual(2_000, 1_000)).toBe(1_500);
  });
});

describe('ScaledReplayClock', () => {
  it('now() reads the shared ReplayTimeSource', () => {
    const realClock = new FakeClock(0);
    const timeSource = new ReplayTimeSource(realClock, 5, 1_000);
    const clock = new ScaledReplayClock(timeSource);

    expect(clock.now()).toBe(1_000);
    realClock.advance(20);
    expect(clock.now()).toBe(1_000 + 20 * 5);
  });
});

describe('ReplayTimestampedLocationProvider', () => {
  it('preserves original inter-sample tMono spacing in the virtual domain, discarding the real clock reading at delivery', async () => {
    const inner = new ScriptedProvider();
    const realClock = new FakeClock(0);
    const speedFactor = 10;
    const timeSource = new ReplayTimeSource(realClock, speedFactor, 500_000);
    const wrapper = new ReplayTimestampedLocationProvider(inner, timeSource);
    await wrapper.start();

    const received: LocationSample[] = [];
    wrapper.subscribe((s) => received.push(s));

    // Fixture-relative original tMono spacing: 0, 1000, 1000 (1Hz-style cadence).
    // Real-clock advances used to simulate the ACCELERATED (speedFactor=10) real-time
    // delivery pace -- 100ms real per 1000ms of original fixture spacing.
    inner.deliver(sample(10_000));
    realClock.advance(100);
    inner.deliver(sample(11_000));
    realClock.advance(100);
    inner.deliver(sample(12_000));

    // Anchored at the first sample's own tMono (10_000) -> virtualStartMono (500_000);
    // every later sample offset by exactly its ORIGINAL fixture-relative delta, NOT by
    // the real clock reading at delivery time.
    expect(received.map((s) => s.tMono)).toEqual([500_000, 501_000, 502_000]);
  });

  it('re-anchors to the first sample observed after each start()', async () => {
    const inner = new ScriptedProvider();
    const realClock = new FakeClock(0);
    const timeSource = new ReplayTimeSource(realClock, 10, 0);
    const wrapper = new ReplayTimestampedLocationProvider(inner, timeSource);

    await wrapper.start();
    const firstRun: LocationSample[] = [];
    wrapper.subscribe((s) => firstRun.push(s));
    inner.deliver(sample(5_000));
    inner.deliver(sample(6_000));
    expect(firstRun.map((s) => s.tMono)).toEqual([0, 1_000]);

    await wrapper.stop();
    await wrapper.start(); // new run -- must re-anchor, not keep accumulating off the old anchor
    const secondRun: LocationSample[] = [];
    wrapper.subscribe((s) => secondRun.push(s));
    inner.deliver(sample(9_000));
    inner.deliver(sample(9_500));
    expect(secondRun.map((s) => s.tMono)).toEqual([0, 500]);
  });

  it('preserves every other sample field unchanged', async () => {
    const inner = new ScriptedProvider();
    const timeSource = new ReplayTimeSource(new FakeClock(0), 10, 0);
    const wrapper = new ReplayTimestampedLocationProvider(inner, timeSource);
    await wrapper.start();

    const received: LocationSample[] = [];
    wrapper.subscribe((s) => received.push(s));
    inner.deliver(sample(1, { accuracyM: 3, speedMps: 12, headingDeg: 90 }));

    expect(received[0]).toMatchObject({ lat: 46.435, lon: 25.06, accuracyM: 3, speedMps: 12, headingDeg: 90, source: 'replay' });
  });

  it('stop() delegates to the inner provider and ceases emission', async () => {
    const inner = new ScriptedProvider();
    const timeSource = new ReplayTimeSource(new FakeClock(0), 10, 0);
    const wrapper = new ReplayTimestampedLocationProvider(inner, timeSource);
    await wrapper.start();
    expect(inner.active).toBe(true);

    const received: LocationSample[] = [];
    wrapper.subscribe((s) => received.push(s));
    inner.deliver(sample(1));
    expect(received).toHaveLength(1);

    await wrapper.stop();
    expect(inner.active).toBe(false);

    inner.deliver(sample(2)); // inner is stopped -- must be a no-op
    expect(received).toHaveLength(1);
  });

  it("subscribe()'s unsubscribe stops only that listener", async () => {
    const inner = new ScriptedProvider();
    const timeSource = new ReplayTimeSource(new FakeClock(0), 10, 0);
    const wrapper = new ReplayTimestampedLocationProvider(inner, timeSource);
    await wrapper.start();

    const a: LocationSample[] = [];
    const b: LocationSample[] = [];
    const unsubscribeA = wrapper.subscribe((s) => a.push(s));
    wrapper.subscribe((s) => b.push(s));

    inner.deliver(sample(1));
    unsubscribeA();
    inner.deliver(sample(2));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  it('clock.now() and a sample delivered "now" share the same virtual domain (sample tMono <= clock.now(), small bound)', async () => {
    const inner = new ScriptedProvider();
    const realClock = new FakeClock(0);
    const speedFactor = 10;
    const timeSource = new ReplayTimeSource(realClock, speedFactor, 0);
    const clock = new ScaledReplayClock(timeSource);
    const wrapper = new ReplayTimestampedLocationProvider(inner, timeSource);
    await wrapper.start();

    // Records each sample alongside clock.now() read AT THE MOMENT OF DELIVERY
    // (not the final clock reading) -- that pairing is what "a sample delivered
    // now" means.
    const pairs: Array<{ tMono: number; clockNow: number }> = [];
    wrapper.subscribe((s) => pairs.push({ tMono: s.tMono, clockNow: clock.now() }));

    // Simulate accelerated real-time delivery: 100ms real per 1000ms of original spacing.
    inner.deliver(sample(0));
    realClock.advance(100);
    inner.deliver(sample(1_000));
    realClock.advance(100);
    inner.deliver(sample(2_000));

    expect(pairs).toHaveLength(3);
    for (const { tMono, clockNow } of pairs) {
      expect(tMono).toBeLessThanOrEqual(clockNow);
      expect(clockNow - tMono).toBeLessThanOrEqual(1); // small bound
    }
  });
});

describe('Dev-replay pacing regression (the fixed bug)', () => {
  it('the clean recognition lap fixture at speedFactor 10 produces ZERO invalid/IMPOSSIBLE_JUMP verdicts through TelemetryQualityEvaluator', async () => {
    const fixture = cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 601);
    const inner = new ScriptedProvider();
    const realClock = new FakeClock(0);
    const speedFactor = 10;
    const timeSource = new ReplayTimeSource(realClock, speedFactor, 0);
    const wrapper = new ReplayTimestampedLocationProvider(inner, timeSource);

    const received: LocationSample[] = [];
    wrapper.subscribe((s) => received.push(s));
    await wrapper.start();

    let previousOriginalTMono: number | null = null;
    for (const original of fixture) {
      // Simulate the accelerated (speedFactor=10) real-time delivery cadence
      // ReplayLocationProvider actually schedules: real delay = original gap / speedFactor.
      if (previousOriginalTMono !== null) {
        realClock.advance(Math.max(0, original.tMono - previousOriginalTMono) / speedFactor);
      }
      previousOriginalTMono = original.tMono;
      inner.deliver(original);
    }

    expect(received.length).toBe(fixture.length);

    const evaluator = new TelemetryQualityEvaluator(DEFAULT_TELEMETRY_QUALITY_CONFIG);
    let previous: LocationSample | undefined;
    const invalidVerdicts: string[] = [];
    for (const s of received) {
      const assessment = evaluator.assess(s, previous);
      if (assessment.level === 'invalid') invalidVerdicts.push(...assessment.reasons);
      previous = s;
    }

    expect(invalidVerdicts).toEqual([]);
    expect(invalidVerdicts.filter((r) => r === 'IMPOSSIBLE_JUMP')).toHaveLength(0);
  });

  it('sample tMono spacing in the virtual domain equals the original fixture spacing (±1ms)', async () => {
    const fixture = cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 602);
    const inner = new ScriptedProvider();
    const realClock = new FakeClock(0);
    const speedFactor = 10;
    const timeSource = new ReplayTimeSource(realClock, speedFactor, 0);
    const wrapper = new ReplayTimestampedLocationProvider(inner, timeSource);

    const received: LocationSample[] = [];
    wrapper.subscribe((s) => received.push(s));
    await wrapper.start();
    for (const original of fixture) inner.deliver(original);

    for (let i = 1; i < fixture.length; i += 1) {
      const originalGap = fixture[i]!.tMono - fixture[i - 1]!.tMono;
      const virtualGap = received[i]!.tMono - received[i - 1]!.tMono;
      expect(Math.abs(virtualGap - originalGap)).toBeLessThanOrEqual(1);
    }
  });

  it('regression: RealSessionFacade + ScaledReplayClock + ReplayTimestampedLocationProvider reaches calibration accepted (coverage >= 95%) on the clean recognition lap at speedFactor 10 -- this is the exact bug (calibration used to stall at ~8% coverage OFF TRACK)', async () => {
    const repository = new InMemorySessionRepository();
    const inner = new ScriptedProvider();
    const realClock = new FakeClock(0);
    const speedFactor = 10;
    const timeSource = new ReplayTimeSource(realClock, speedFactor, 0);
    const clock = new ScaledReplayClock(timeSource);
    const provider = new ReplayTimestampedLocationProvider(inner, timeSource);

    const controller = new SessionController({
      runtimeProfile: TMR_RUNTIME_PROFILE,
      circuitProfile: TMR_CIRCUIT_PROFILE,
      locationProvider: provider,
      clock,
      repository,
      userId: 'driver-1',
      appVersion: 'apps-mobile-test',
      algorithmVersion: 1,
      restartProvider: () => {},
    });

    const events: FacadeState[] = [];
    const facade = new RealSessionFacade(controller);
    facade.subscribe((s) => events.push(s));

    facade.beginCalibration();
    await new Promise((resolve) => setTimeout(resolve, 0)); // flush beginCalibration()'s .then() / controller.start()'s provider.start()
    expect(inner.active).toBe(true);

    const fixture = cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 603);
    let previousOriginalTMono: number | null = null;
    for (const original of fixture) {
      if (previousOriginalTMono !== null) {
        realClock.advance(Math.max(0, original.tMono - previousOriginalTMono) / speedFactor);
      }
      previousOriginalTMono = original.tMono;
      inner.deliver(original);
    }

    const finalState = events.at(-1)!;
    expect(finalState.sessionState).toBe('calibrationReview');
    expect(finalState.calibrationResult?.accepted).toBe(true);
    expect(finalState.calibration?.coverageFraction).toBeGreaterThanOrEqual(0.95);
  });
});
