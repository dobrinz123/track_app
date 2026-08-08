import { describe, expect, it } from 'vitest';
import type { LocationProvider, LocationSample } from '@circuit/core';
import {
  DEFAULT_TELEMETRY_QUALITY_CONFIG,
  InMemorySessionRepository,
  SessionController,
  TelemetryQualityEvaluator,
  cleanRecognitionLap,
  multiLapSession,
  type FacadeStateCore,
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

  it('toVirtual() offsets from the run anchor without scaling, independent of real time', () => {
    const realClock = new FakeClock(0);
    const timeSource = new ReplayTimeSource(realClock, 10, 500);

    // A fixture's own tMono values, anchored at its first sample (1_000) to a run
    // anchored at virtual 500 (as `beginRun()` would return for the very first run).
    expect(timeSource.toVirtual(1_000, 1_000, 500)).toBe(500);
    expect(timeSource.toVirtual(2_000, 1_000, 500)).toBe(1_500); // +1000ms of ORIGINAL spacing, unscaled
    expect(timeSource.toVirtual(1_500, 1_000, 500)).toBe(1_500); // monotonic floor: would be 1_000, clamped up to the prior 1_500

    // Real-time elapsing has no effect on the offset math itself -- it is a pure fixture-time offset.
    realClock.advance(1_000_000);
    expect(timeSource.toVirtual(3_000, 1_000, 500)).toBe(2_500);
  });

  it('toVirtual() never returns a value below the last one it ever returned (monotonic across calls)', () => {
    const realClock = new FakeClock(0);
    const timeSource = new ReplayTimeSource(realClock, 10, 0);

    expect(timeSource.toVirtual(1_000, 1_000, 0)).toBe(0);
    expect(timeSource.toVirtual(1_100, 1_000, 0)).toBe(100);
    // A later call with an anchor/offset that would compute BELOW the last returned
    // value (e.g. a new, differently-anchored run) is clamped up, never backward.
    expect(timeSource.toVirtual(1_000, 1_000, 50)).toBe(100);
  });

  describe('beginRun()', () => {
    it('returns virtualNow() for the very first run', () => {
      const realClock = new FakeClock(0);
      const timeSource = new ReplayTimeSource(realClock, 10, 500);
      realClock.advance(20);
      expect(timeSource.beginRun()).toBe(500 + 20 * 10);
    });

    it('returns virtualNow() when it already exceeds the last virtual tMono emitted by a prior run', () => {
      const realClock = new FakeClock(0);
      const timeSource = new ReplayTimeSource(realClock, 10, 0);
      timeSource.toVirtual(1_000, 1_000, timeSource.beginRun()); // run 1 emits virtual 0
      realClock.advance(1_000); // 1s real = 10s virtual elapses before run 2 starts
      expect(timeSource.beginRun()).toBe(10_000); // virtualNow(), not the stale run-1 value (0)
    });

    it('returns the last virtual tMono emitted by a prior run when virtualNow() has not caught up to it yet', () => {
      const realClock = new FakeClock(0);
      const timeSource = new ReplayTimeSource(realClock, 10, 0);
      const run1Anchor = timeSource.beginRun(); // 0
      timeSource.toVirtual(1_000, 1_000, run1Anchor); // virtual 0
      timeSource.toVirtual(6_000, 1_000, run1Anchor); // virtual 5_000 -- run 1 ran far ahead in fixture-relative time
      // No real time advances before run 2 starts -- virtualNow() is still 0, well
      // behind run 1's last emitted virtual tMono (5_000).
      expect(timeSource.beginRun()).toBe(5_000);
    });
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

  it(
    "re-anchors each run to virtualNow() at that run's start() (never a fixed epoch) and never " +
      'emits a tMono before the last one a prior run on the same source emitted -- two sequential ' +
      'runs on ONE ReplayTimeSource, simulating calibration -> session (the follow-up pacing bug)',
    async () => {
      const inner = new ScriptedProvider();
      const realClock = new FakeClock(0);
      const speedFactor = 10;
      const timeSource = new ReplayTimeSource(realClock, speedFactor, 0);
      const clock = new ScaledReplayClock(timeSource);
      const wrapper = new ReplayTimestampedLocationProvider(inner, timeSource);

      // ---- Run 1 (models the calibration lap): starts immediately, delivers two samples.
      await wrapper.start();
      const firstRun: LocationSample[] = [];
      wrapper.subscribe((s) => firstRun.push(s));
      inner.deliver(sample(5_000));
      realClock.advance(50); // 50ms real = 500ms virtual between the two samples
      inner.deliver(sample(5_500));
      expect(firstRun.map((s) => s.tMono)).toEqual([0, 500]);
      // Captured now, not after run 2: `firstRun`'s subscription is never explicitly
      // unsubscribed (mirrors the app never unsubscribing either), so it would otherwise
      // keep receiving run 2's samples too and `.at(-1)` would read the wrong run.
      const lastOfRun1 = firstRun.at(-1)!.tMono;
      await wrapper.stop();

      // ---- Idle gap (models a human reviewing the Calibration Result screen, or the
      // fixture simply draining, before the next run starts): 8s of real time elapses
      // with NO samples flowing -- virtualNow() keeps advancing regardless.
      realClock.advance(8_000); // 8s real = 80_000ms virtual
      const clockAtRun2Start = clock.now();

      // ---- Run 2 (models the timing session, restarted by the watchdog): must anchor
      // to "now", NOT back to the fixed epoch (0) or run 1's small virtual range --
      // that was the follow-up bug (currentLapMs reading hundreds of seconds).
      await wrapper.start();
      const secondRun: LocationSample[] = [];
      wrapper.subscribe((s) => secondRun.push(s));
      inner.deliver(sample(9_000)); // a fresh fixture's own first sample -- its absolute tMono is irrelevant to the anchor
      realClock.advance(50);
      inner.deliver(sample(9_500));

      // Run 2's first sample lands within a small bound of clock.now() at run-2 start.
      expect(secondRun[0]!.tMono).toBeGreaterThanOrEqual(clockAtRun2Start);
      expect(secondRun[0]!.tMono - clockAtRun2Start).toBeLessThanOrEqual(1);

      // Run 2 preserves its own original spacing (500ms), same as run 1 did.
      expect(secondRun[1]!.tMono - secondRun[0]!.tMono).toBe(500);

      // Every run-2 sample tMono >= run 1's last sample tMono -- never jumps backward
      // across the run boundary.
      for (const s of secondRun) expect(s.tMono).toBeGreaterThanOrEqual(lastOfRun1);
    },
  );

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

  /** Advances `realClock` by each sample's original inter-sample gap (scaled by `speedFactor`) before delivering it -- simulates `ReplayLocationProvider`'s real, accelerated delivery cadence. */
  function feedWithPacing(
    inner: ScriptedProvider,
    realClock: FakeClock,
    speedFactor: number,
    fixture: readonly LocationSample[],
  ): void {
    let previousOriginalTMono: number | null = null;
    for (const original of fixture) {
      if (previousOriginalTMono !== null) {
        realClock.advance(Math.max(0, original.tMono - previousOriginalTMono) / speedFactor);
      }
      previousOriginalTMono = original.tMono;
      inner.deliver(original);
    }
  }

  it(
    'regression: currentLapMs stays bounded and lap 1 completes with the correct duration after a real-time ' +
      'idle gap + provider restart between calibration and timing (the follow-up pacing bug: currentLapMs ' +
      'previously read minutes within seconds of the first crossing)',
    async () => {
      const speedFactor = 10;
      const timingFixture = multiLapSession(TMR_CIRCUIT_PROFILE, 2, 801);

      // ---- "Ground truth" run: the SAME timing fixture driven through a fresh,
      // gap-free controller (skips calibration via start('session'), same as ADR-0003
      // §3 recovery) -- establishes what a CORRECT lap 1 duration looks like, to
      // compare the restart-scenario run below against.
      const referenceRepository = new InMemorySessionRepository();
      const referenceInner = new ScriptedProvider();
      const referenceRealClock = new FakeClock(0);
      const referenceTimeSource = new ReplayTimeSource(referenceRealClock, speedFactor, 0);
      const referenceProvider = new ReplayTimestampedLocationProvider(referenceInner, referenceTimeSource);
      const referenceController = new SessionController({
        runtimeProfile: TMR_RUNTIME_PROFILE,
        circuitProfile: TMR_CIRCUIT_PROFILE,
        locationProvider: referenceProvider,
        clock: new ScaledReplayClock(referenceTimeSource),
        repository: referenceRepository,
        userId: 'driver-1',
        appVersion: 'apps-mobile-test',
        algorithmVersion: 1,
        restartProvider: () => {},
      });
      const referenceStates: FacadeStateCore[] = [];
      referenceController.subscribe((s) => referenceStates.push(s));
      await referenceController.start('session'); // skips calibration -- lands directly in 'armed'
      referenceController.arm();
      feedWithPacing(referenceInner, referenceRealClock, speedFactor, timingFixture);

      const referenceLap1 = referenceStates.at(-1)?.laps[0];
      expect(referenceLap1).toBeDefined();
      const referenceLap1DurationMs = referenceLap1!.durationMs;
      expect(referenceLap1DurationMs).toBeGreaterThan(0);

      // ---- Restart scenario: RealSessionFacade full flow (calibrate -> accept ->
      // [idle real-time gap] -> provider restart, mirroring composition.ts's FIXED
      // watchdog restartProvider -> arm -> first lap).
      const repository = new InMemorySessionRepository();
      const inner = new ScriptedProvider();
      const realClock = new FakeClock(0);
      const timeSource = new ReplayTimeSource(realClock, speedFactor, 0);
      const clock = new ScaledReplayClock(timeSource);
      const provider = new ReplayTimestampedLocationProvider(inner, timeSource);
      // Mirrors composition.ts's FIXED dev-replay restartProvider: restarts the
      // WRAPPER (not a raw inner provider), so a restart begins a new, properly
      // re-anchored ReplayTimeSource run (`beginRun()`). Wired into the controller
      // AND invoked directly below (standing in for a live watchdog tick, which
      // this test does not otherwise drive) -- the SAME function either way.
      const restartProvider = async (): Promise<void> => {
        await provider.stop();
        await provider.start();
      };
      const controller = new SessionController({
        runtimeProfile: TMR_RUNTIME_PROFILE,
        circuitProfile: TMR_CIRCUIT_PROFILE,
        locationProvider: provider,
        clock,
        repository,
        userId: 'driver-1',
        appVersion: 'apps-mobile-test',
        algorithmVersion: 1,
        restartProvider,
      });
      const events: FacadeState[] = [];
      const facade = new RealSessionFacade(controller);
      facade.subscribe((s) => events.push(s));

      facade.beginCalibration();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inner.active).toBe(true);

      feedWithPacing(inner, realClock, speedFactor, cleanRecognitionLap(TMR_CIRCUIT_PROFILE, 802));
      expect(events.at(-1)!.sessionState).toBe('calibrationReview');
      expect(events.at(-1)!.calibrationResult?.accepted).toBe(true);

      facade.acceptCalibration();
      await controller.flush();
      expect(events.at(-1)!.sessionState).toBe('armed');

      // ---- Idle real-time gap: models a human reviewing the Calibration Result
      // screen (or the fixture simply draining) before tapping Accept/Arm -- exactly
      // what let clock.now() run far ahead of a stale wrapper anchor in the bug.
      realClock.advance(8_000); // 8s real = 80s virtual

      // ---- The watchdog would restart the provider here (real app: ADR-0003 §1,
      // triggered by the idle gap above); this test drives that restart directly,
      // via the SAME `restartProvider` function the controller was constructed with.
      await restartProvider();

      facade.arm();
      expect(events.at(-1)!.sessionState).toBe('armed'); // mode flips to 'live'; state itself advances on the first crossing

      const currentLapMsSamples: number[] = [];
      let previousOriginalTMono: number | null = null;
      for (const original of timingFixture) {
        if (previousOriginalTMono !== null) {
          realClock.advance(Math.max(0, original.tMono - previousOriginalTMono) / speedFactor);
        }
        previousOriginalTMono = original.tMono;
        inner.deliver(original);
        currentLapMsSamples.push(events.at(-1)!.currentLapMs);
      }

      // The bug: currentLapMs read hundreds of seconds within moments of the first
      // crossing, because samples were stamped into a stale, long-past virtual range
      // while clock.now() had kept advancing through the idle gap. Fixed: every
      // observed currentLapMs stays within a generous multiple of a REAL lap's
      // duration -- never blows up to (idleGapMs * speedFactor) territory.
      const maxObservedCurrentLapMs = Math.max(...currentLapMsSamples);
      expect(maxObservedCurrentLapMs).toBeLessThanOrEqual(2 * referenceLap1DurationMs);

      const completedLap1 = events.at(-1)!.laps[0];
      expect(completedLap1).toBeDefined();
      expect(Math.abs(completedLap1!.durationMs - referenceLap1DurationMs)).toBeLessThanOrEqual(2_000);
    },
  );
});
