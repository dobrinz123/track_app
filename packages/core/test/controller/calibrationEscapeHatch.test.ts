import { describe, expect, it } from 'vitest';

import type { LocationSample } from '../../src/contracts';
import { SessionController, type FacadeStateCore } from '../../src/controller';
import { cleanRecognitionLap, driveLap } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

/**
 * Ticket P7R E2 — "calibration must never be a dead end".
 *
 * The owner has already lost one track day to this exact wall: at
 * Transilvania Motor Ring coverage parked at ~0.83, retry, ~0.83 again, no
 * session ever started, nothing recorded. The thresholds are not the bug
 * (they mean something, and this ticket may not move them) — having no way
 * past them is.
 *
 * WHERE THE WALL ACTUALLY IS. A Learn lap reaches `calibrationReview` only
 * once coverage passes the controller's 0.98 completion trigger. A lap stuck
 * below the 0.85 ACCEPTANCE bar therefore never produces a result at all: it
 * does not fail, it never finishes, and the only remaining control is Cancel.
 * The first test below pins that, because the escape hatch is pointless if it
 * is only reachable from a screen the stuck driver never sees.
 *
 * The property under test is then two-sided, and BOTH sides matter:
 *
 *  - a stalled or rejected calibration can still arm a timed session, and
 *  - the session that results is LABELLED, not quietly presented as normal.
 *
 * A test that proved only the first half would be evidence for a change that
 * made the product dishonest.
 */

function setup() {
  const { profile, runtime } = tmr();
  const repository = new InMemorySessionRepository();
  const provider = new FakeLocationProvider();
  const clock = new FakeClock(1_000_000);
  const scheduler = new FakeWatchdogScheduler();

  const controller = new SessionController({
    runtimeProfile: runtime,
    circuitProfile: profile,
    locationProvider: provider,
    clock,
    repository,
    userId: 'driver-1',
    appVersion: 'p7r-calibration-escape-test',
    algorithmVersion: 1,
    restartProvider: () => undefined,
    config: { scheduler, watchdogTimeoutMs: 5_000, watchdogPollMs: 1_000 },
  });

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

  function snapshot(): FacadeStateCore {
    let current: FacadeStateCore | undefined;
    const unsubscribe = controller.subscribe((s) => {
      current = s;
    });
    unsubscribe();
    return current!;
  }

  return { profile, repository, controller, feed, snapshot };
}

/**
 * A Learn lap STALLED below the acceptance bar — the owner's TMR failure,
 * produced honestly by driving only part of the circuit rather than by
 * stubbing the engine.
 */
async function stalledLearnLap(seed: number) {
  const harness = setup();
  await harness.controller.start('calibration');
  const lap = cleanRecognitionLap(harness.profile, seed);
  harness.feed(lap.slice(0, Math.floor(lap.length * 0.7)));
  return harness;
}

describe('P7R E2 -- the wall the owner actually hit', () => {
  it('a Learn lap below the bar NEVER reaches a result: it stalls in `calibrating`', async () => {
    const { controller, snapshot } = await stalledLearnLap(7_201);
    const state = snapshot();
    // Not `calibrationReview`, and no result to show -- so an escape hatch
    // offered only on the result screen would never have been reachable.
    expect(state.sessionState).toBe('calibrating');
    expect(state.calibrationResult).toBeNull();
    expect(state.calibration!.coverageFraction).toBeLessThan(0.85);
    expect(controller.diagnostics().sessionId).not.toBeNull();
  });
});

describe('P7R E2 -- a stalled calibration is a decision, not a dead end', () => {
  it('arms a timed session from a stalled Learn lap, and says so', async () => {
    const { controller, snapshot } = await stalledLearnLap(7_202);
    expect(snapshot().matchingUnvalidated).toBe(false);

    expect(controller.proceedWithoutValidatedCalibration()).toBe('armed-unvalidated');

    const armed = snapshot();
    expect(armed.sessionState).toBe('armed');
    // THE HONESTY HALF. Without this the change would simply be a way to
    // launder a failed calibration into an ordinary-looking session.
    expect(armed.matchingUnvalidated).toBe(true);
  });

  it('does NOT move the bar: the engine still judged the lap, and still said no', async () => {
    const { controller, snapshot } = await stalledLearnLap(7_203);
    controller.proceedWithoutValidatedCalibration();

    const result = snapshot().calibrationResult;
    expect(result).not.toBeNull();
    // The verdict the escape overrode is the engine's own, recorded as it
    // stands -- never rewritten to `accepted` to make the session look fine.
    expect(result!.accepted).toBe(false);
    expect(result!.diagnostics.coverageFraction).toBeLessThan(0.85);
    expect(result!.failureReasons).toContain('INSUFFICIENT_COVERAGE');
  });

  it('the label survives the rest of the run -- it is not a one-emission flash', async () => {
    const { controller, snapshot } = await stalledLearnLap(7_204);
    controller.proceedWithoutValidatedCalibration();
    expect(snapshot().matchingUnvalidated).toBe(true);
    await controller.endSession();
    expect(snapshot().matchingUnvalidated).toBe(true);
  });

  it('the session still records its drive afterwards -- the point of going out at all', async () => {
    const { profile, repository, controller, feed, snapshot } = await stalledLearnLap(7_205);
    controller.proceedWithoutValidatedCalibration();
    const sessionId = controller.diagnostics().sessionId!;

    feed(driveLap(profile, { seed: 7_305 }).slice(0, 120));
    await controller.endSession();

    // Ticket P7M M1's unclaimed chunk rows, written whatever the timing
    // engine made of the drive -- and ticket P7R E1 is how they get out.
    const chunks = await Promise.all(
      controller.rawTraceChunkKeys().map((key) => repository.loadTelemetry(sessionId, key)),
    );
    expect(chunks.flat().length).toBeGreaterThan(0);
    expect(snapshot().recording.persistedSampleCount).toBeGreaterThan(0);
  });
});

describe('P7R E2 -- an honest calibration is never mislabelled', () => {
  it('an ORDINARY accepted calibration is not labelled unvalidated', async () => {
    const harness = setup();
    await harness.controller.start('calibration');
    harness.feed(cleanRecognitionLap(harness.profile, 7_206));
    expect(harness.snapshot().calibrationResult?.accepted).toBe(true);

    harness.controller.acceptCalibration();
    expect(harness.snapshot().sessionState).toBe('armed');
    expect(harness.snapshot().matchingUnvalidated).toBe(false);
  });

  it('force-finishing a lap the engine ACCEPTS arms it as an ordinary session, unlabelled', async () => {
    const harness = setup();
    await harness.controller.start('calibration');
    harness.feed(cleanRecognitionLap(harness.profile, 7_207));
    // The completion trigger already fired, so this is the review branch --
    // and the verdict there is `accepted`, which must not be re-badged.
    expect(harness.snapshot().sessionState).toBe('calibrationReview');
    expect(harness.snapshot().calibrationResult?.accepted).toBe(true);

    expect(harness.controller.proceedWithoutValidatedCalibration()).toBe('armed-accepted');
    expect(harness.snapshot().sessionState).toBe('armed');
    expect(harness.snapshot().matchingUnvalidated).toBe(false);
  });

  it('refuses where there is no calibration to conclude, and mutates nothing', async () => {
    const harness = setup();
    expect(harness.controller.proceedWithoutValidatedCalibration()).toBe('refused');
    expect(harness.snapshot().sessionState).toBe('idle');
    expect(harness.snapshot().matchingUnvalidated).toBe(false);
  });

  it('the NEXT session is not tainted by an earlier override', async () => {
    // The app replaces the controller between sessions
    // (`composition.ts`'s `rebuildProductionController`), so "the label does
    // not leak forward" is a statement about the next session, not about
    // re-driving the same controller. Asserted over a SHARED repository, so
    // the two sessions really are successive outings of one install.
    const first = await stalledLearnLap(7_208);
    first.controller.proceedWithoutValidatedCalibration();
    expect(first.snapshot().matchingUnvalidated).toBe(true);
    await first.controller.endSession();
    await first.controller.dispose();

    const second = setup();
    await second.controller.start('calibration');
    expect(second.snapshot().matchingUnvalidated).toBe(false);
    second.feed(cleanRecognitionLap(second.profile, 7_209));
    second.controller.acceptCalibration();
    expect(second.snapshot().sessionState).toBe('armed');
    expect(second.snapshot().matchingUnvalidated).toBe(false);
  });

  it('is refused once the session is already armed -- a second tap cannot re-arm or re-label', async () => {
    const { controller, snapshot } = await stalledLearnLap(7_210);
    expect(controller.proceedWithoutValidatedCalibration()).toBe('armed-unvalidated');
    // The screen replaces itself on the first outcome, but a double tap that
    // beats the navigation must be inert rather than dispatching a second
    // CALIBRATION_ACCEPTED into a state machine that has moved on.
    expect(controller.proceedWithoutValidatedCalibration()).toBe('refused');
    expect(snapshot().sessionState).toBe('armed');
    expect(snapshot().matchingUnvalidated).toBe(true);
  });
});
