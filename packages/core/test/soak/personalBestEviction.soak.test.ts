import { describe, expect, it } from 'vitest';

import type { LocationSample, QualityAssessment } from '../../src/contracts';
import { buildReferenceLap } from '../../src/reference';
import { SessionController, type FacadeStateCore } from '../../src/controller';
import { cleanRecognitionLap, driveLap } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';
import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from '../controller/testSupport';

/**
 * Pins blind-verifier finding B1 (PB-capture-at-crossing): `SessionController`
 * must build a lap's PB candidate reference SYNCHRONOUSLY at the moment the
 * lap completes (`onLapCompleted`, reading `SessionPipelineCore.matches`
 * before anything else can touch it), not later from inside the deferred SQL
 * persistence queue. `matches` is a rolling, capped buffer (M2 fix,
 * `pipelineCore.ts`'s `boundedTelemetry`) -- if construction were deferred, a
 * burst of later laps' samples can evict a completed lap's own matched
 * telemetry from that buffer before the deferred build runs, silently
 * dropping what should have been a legitimate PB.
 *
 * A real fixture large enough to overflow the DEFAULT 2000-sample cap would
 * make this test slow and its intent opaque. Instead this uses
 * `PipelineCoreConfig.maxMatches` (added by this same fix's ticket,
 * `controller/pipelineCore.ts`) to shrink the cap to something a short,
 * fast-running fixture can genuinely overflow -- eviction is then verified
 * STRUCTURALLY (inspecting the controller's internal rolling buffer directly)
 * rather than assumed.
 */

function last<T>(items: readonly T[]): T {
  const value = items[items.length - 1];
  if (value === undefined) throw new Error('expected at least one item');
  return value;
}

interface InspectedMatch {
  tMono: number;
  unwrappedProgressM: number;
  quality: QualityAssessment;
}

/** Reads the private `SessionPipelineCore.matches` buffer straight off a live controller -- same technique as `track-day.soak.test.ts`'s `internalBufferSizes` helper. */
function matchesBuffer(controller: SessionController): InspectedMatch[] {
  const inspected = controller as unknown as { core: { matches: InspectedMatch[] } };
  return inspected.core.matches;
}

describe('SessionController PB-capture-at-crossing (blind-verifier B1)', () => {
  it('stores lap 1 (the fastest lap) as the final PB even after its own matched telemetry has been evicted from the rolling buffer by slower laps that follow it', async () => {
    const { profile, runtime } = tmr();
    const repository = new InMemorySessionRepository();
    const provider = new FakeLocationProvider();
    const clock = new FakeClock(1_000_000);
    const scheduler = new FakeWatchdogScheduler();

    // Small enough that several slower laps' worth of samples overflow it,
    // but comfortably above one fast lap's own matched-sample count (~69 at
    // 55 m/s over TMR's ~3746 m travel distance including padding) so the
    // synchronous, at-crossing-time build this test pins still has lap 1's
    // own telemetry intact the instant it completes.
    const REDUCED_MAX_MATCHES = 90;

    const controller = new SessionController({
      runtimeProfile: runtime,
      circuitProfile: profile,
      locationProvider: provider,
      clock,
      repository,
      userId: 'driver-1',
      appVersion: 'pb-eviction-test',
      algorithmVersion: 1,
      restartProvider: () => undefined,
      config: { scheduler, pipeline: { maxMatches: REDUCED_MAX_MATCHES } },
    });

    const states: FacadeStateCore[] = [];
    controller.subscribe((s) => states.push(s));

    let wallClock = clock.now();
    let previousTMono: number | null = null;
    function feed(samples: readonly LocationSample[]): void {
      for (const sample of samples) {
        const delta = previousTMono === null ? 0 : Math.max(0, sample.tMono - previousTMono);
        previousTMono = sample.tMono;
        wallClock += delta;
        clock.set(wallClock);
        provider.push(sample);
      }
    }

    // Captured the instant lap 1 completes (same synchronous emission that
    // `onLapCompleted` -> `buildPbCandidate` runs inside) -- i.e. exactly the
    // buffer state the FIX reads from. Recorded via a second subscriber
    // rather than by splitting the fixture into separate `driveLap()` calls:
    // restarting a fresh `driveLap()` fixture mid-session would itself
    // fabricate a large apparent position jump (each call always starts its
    // simulated drive near the start/finish line again), which is not the
    // scenario under test.
    let matchesRightAfterLap1: number | null = null;
    controller.subscribe((s) => {
      if (matchesRightAfterLap1 === null && s.laps.length === 1) {
        matchesRightAfterLap1 = matchesBuffer(controller).length;
      }
    });

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 990));
    expect(last(states).sessionState).toBe('calibrationReview');
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    // One continuous 4-lap drive: lap 1 fast (55 m/s, ~69 samples) then three
    // much slower laps (20 m/s, ~187 samples each) -- each of which alone
    // already exceeds REDUCED_MAX_MATCHES, guaranteeing lap 1's original
    // matches are evicted from the rolling window well before the session
    // ends.
    const LAP_SPEEDS_MPS = [55, 20, 20, 20];
    feed(
      driveLap(profile, {
        seed: 991,
        lapCount: LAP_SPEEDS_MPS.length,
        speedMps: ({ lapIndex }) => LAP_SPEEDS_MPS[Math.min(lapIndex, LAP_SPEEDS_MPS.length - 1)]!,
        noiseSigmaM: 1,
      }),
    );
    await controller.flush();

    // Sanity: the reduced cap must not have already evicted lap 1's own
    // telemetry DURING lap 1 itself -- otherwise even the synchronous,
    // at-crossing-time build this test pins would (correctly) fail to build a
    // reference from it, and this test would not be exercising the intended
    // scenario at all.
    expect(matchesRightAfterLap1).not.toBeNull();
    expect(matchesRightAfterLap1!).toBeGreaterThanOrEqual(2);
    expect(matchesRightAfterLap1!).toBeLessThan(REDUCED_MAX_MATCHES);

    const finalState = last(states);
    const lap1 = finalState.laps[0]!;
    expect(lap1.valid).toBe(true);
    expect(finalState.laps).toHaveLength(4);
    expect(finalState.laps.every((lap) => lap.valid)).toBe(true);
    // Every follow-up lap really is slower than lap 1 -- otherwise a later,
    // legitimately faster lap replacing the PB would be indistinguishable
    // from the bug this test targets.
    for (const lap of finalState.laps.slice(1)) {
      expect(lap.durationMs).toBeGreaterThan(lap1.durationMs);
    }

    // --- Eviction really happened (structural proof) -----------------------
    const finalMatches = matchesBuffer(controller);
    expect(finalMatches.length).toBeLessThanOrEqual(REDUCED_MAX_MATCHES);
    const lap1MatchesStillPresent = finalMatches.filter(
      (m) => m.tMono >= lap1.tStart && m.tMono <= lap1.tEnd,
    );
    expect(lap1MatchesStillPresent).toHaveLength(0);

    // A build attempted from THIS (post-eviction) buffer -- i.e. exactly what
    // a deferred, "build inside the SQL queue" implementation would have used
    // instead of capturing matches synchronously at crossing time -- fails.
    // This is the sensitivity proof: it shows the revert this test guards
    // against (deferred build) really would break the PB replacement below,
    // using the SAME `buildReferenceLap` the controller itself calls.
    const deferredBuildAttempt = buildReferenceLap({
      profile,
      lap: lap1,
      matches: finalMatches,
      userId: 'driver-1',
      recordedAtUtc: new Date().toISOString(),
      sessionId: controller.diagnostics().sessionId!,
      appVersion: 'pb-eviction-test',
      algorithmVersion: 1,
    });
    expect(deferredBuildAttempt.ok).toBe(false);

    // --- The actual, fixed behavior: PB is lap 1's time regardless ---------
    const finalPb = await repository.getReferenceLap(
      'driver-1',
      profile.circuitId,
      profile.layoutId,
      profile.layoutVersion,
    );
    expect(finalPb).not.toBeNull();
    expect(finalPb!.durationMs).toBe(lap1.durationMs);
    expect(finalPb!.durationMs).toBeLessThan(Math.min(...finalState.laps.slice(1).map((l) => l.durationMs)));
  });
});
