import { describe, expect, it } from 'vitest';

import type { CalibrationAttemptRecord, LocalSessionRepository, LocationSample } from '../../src/contracts';
import { SessionController } from '../../src/controller';
import { cleanRecognitionLap } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

/**
 * Ticket P12 item B -- EVERY CALIBRATION ATTEMPT ENDS WITH A PERSISTED,
 * STRUCTURED RECORD, WHATEVER HAPPENED.
 *
 * The owner lost a track day to a Learn lap that parked at ~83% coverage and
 * never produced a verdict. Nothing durable was written for it, so afterwards
 * the device could not say what had happened -- and a Cancel looked exactly
 * like a calibration that was never started.
 */

const USER_ID = 'driver-1';

function setup(repository: LocalSessionRepository = new InMemorySessionRepository()) {
  const { profile, runtime } = tmr();
  const provider = new FakeLocationProvider();
  const clock = new FakeClock(1_000_000);
  const scheduler = new FakeWatchdogScheduler();

  const controller = new SessionController({
    runtimeProfile: runtime,
    circuitProfile: profile,
    locationProvider: provider,
    clock,
    repository,
    userId: USER_ID,
    appVersion: 'p12b-test',
    algorithmVersion: 1,
    restartProvider: () => undefined,
    logger: () => undefined,
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

  async function attempts(): Promise<CalibrationAttemptRecord[]> {
    await controller.flush();
    const sessionId = controller.diagnostics().sessionId!;
    return repository.listCalibrationAttempts!(sessionId);
  }

  return { profile, controller, feed, repository, attempts };
}

describe('P12 item B -- an ACCEPTED calibration leaves a record', () => {
  it('records the accepted outcome with the thresholds it was judged against', async () => {
    const harness = setup();
    await harness.controller.start('calibration');
    harness.feed(cleanRecognitionLap(harness.profile, 22_301));
    await harness.controller.flush();

    const rows = await harness.attempts();
    expect(rows).toHaveLength(1);
    const record = rows[0]!;
    expect(record.outcome).toBe('accepted');
    expect(record.concluded).toBe(true);
    expect(record.endedAtUtc).not.toBeNull();
    expect(record.reachedCompletionThreshold).toBe(true);
    expect(record.forceFinished).toBe(false);
    expect(record.result?.accepted).toBe(true);
    expect(record.coverageFraction).toBeGreaterThan(0.85);
    expect(record.samplesFed).toBeGreaterThan(0);
    expect(record.samplesAccepted).toBeGreaterThan(0);
    // The bars in force, stated rather than assumed (0.85 / 250 m / 0.5 Hz).
    expect(record.thresholds.minCoverageFraction).toBe(0.85);
    expect(record.thresholds.maxUncoveredGapM).toBe(250);
    expect(record.thresholds.minObservedRateHz).toBe(0.5);
    expect(record.thresholds.corridorWidthM).toBe(harness.profile.corridorWidthM);
    expect(record.explanation.join(' ')).toContain('ACCEPTED');
  });
});

describe('P12 item B -- a CANCEL is recorded as a failure, not as an absence', () => {
  it('writes a cancelled record carrying how far the partial lap had got', async () => {
    const harness = setup();
    await harness.controller.start('calibration');
    // A third of a Learn lap, then the driver presses Cancel.
    const learn = cleanRecognitionLap(harness.profile, 22_301);
    harness.feed(learn.slice(0, Math.floor(learn.length / 3)));
    harness.controller.rejectCalibration();

    const rows = await harness.attempts();
    expect(rows).toHaveLength(1);
    const record = rows[0]!;
    expect(record.outcome).toBe('cancelled');
    expect(record.concluded).toBe(true);
    expect(record.endedAtUtc).not.toBeNull();
    expect(record.result?.failureReasons).toContain('CANCELLED');
    expect(record.samplesFed).toBeGreaterThan(0);
    // Readable without the device: the first line says the driver cancelled.
    expect(record.explanation[0]).toContain('CANCELLED');
  });
});

describe('P12 item B -- a STALLED Learn lap is the case this record exists for', () => {
  it('a partial lap force-finished below the completion threshold records as stalled, with the gap and the reasons', async () => {
    const harness = setup();
    await harness.controller.start('calibration');
    // Half a lap: coverage never reaches the 0.98 at which the controller
    // finishes on its own, so nothing concludes -- the owner's 83% day.
    const learn = cleanRecognitionLap(harness.profile, 22_301);
    harness.feed(learn.slice(0, Math.floor(learn.length / 2)));

    // BEFORE the escape hatch: the attempt is already on disk, provisionally.
    const provisional = await harness.attempts();
    expect(provisional).toHaveLength(1);
    expect(provisional[0]!.concluded).toBe(false);
    expect(provisional[0]!.outcome).toBe('stalled');
    expect(provisional[0]!.endedAtUtc).toBeNull();
    expect(provisional[0]!.coverageFraction).toBeGreaterThan(0.1);
    expect(provisional[0]!.explanation.join(' ')).toContain('never finished');

    const outcome = harness.controller.proceedWithoutValidatedCalibration();
    expect(outcome).toBe('armed-unvalidated');

    const rows = await harness.attempts();
    // The SAME attempt id, rewritten -- not a second row.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attemptId).toBe(provisional[0]!.attemptId);
    const record = rows[0]!;
    expect(record.outcome).toBe('stalled');
    expect(record.concluded).toBe(true);
    expect(record.reachedCompletionThreshold).toBe(false);
    expect(record.forceFinished).toBe(true);
    expect(record.result?.accepted).toBe(false);
    expect(record.result?.failureReasons.length).toBeGreaterThan(0);
    // Where it did not look, and how long that stretch was.
    expect(record.uncoveredGap).not.toBeNull();
    expect(record.uncoveredGap!.lengthM).toBeGreaterThan(0);
    // Plain language, naming the measured value and the bar.
    const text = record.explanation.join('\n');
    expect(text).toContain('STALLED');
    expect(text).toContain('INSUFFICIENT_COVERAGE');
    expect(text).toContain('85%');
  });

  it('a session ended mid-Learn-lap closes the attempt as stalled with no verdict', async () => {
    const harness = setup();
    await harness.controller.start('calibration');
    const learn = cleanRecognitionLap(harness.profile, 22_301);
    harness.feed(learn.slice(0, 20));
    const sessionId = harness.controller.diagnostics().sessionId!;
    await harness.controller.endSession();
    await harness.controller.flush();

    const rows = await harness.repository.listCalibrationAttempts!(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('stalled');
    expect(rows[0]!.concluded).toBe(true);
    expect(rows[0]!.result).toBeNull();
    expect(rows[0]!.endedAtUtc).not.toBeNull();
    expect(rows[0]!.explanation.join(' ')).toContain('without the engine ever producing a verdict');
  });
});

describe('P12 item B -- a retry is a NEW attempt, and both are kept', () => {
  it('cancel then retry leaves two rows with distinct ids', async () => {
    const harness = setup();
    await harness.controller.start('calibration');
    const learn = cleanRecognitionLap(harness.profile, 22_301);
    harness.feed(learn.slice(0, 30));
    harness.controller.rejectCalibration();
    await harness.controller.flush();

    // Retry: the same session, a second Learn lap.
    await harness.controller.start('calibration');
    harness.feed(cleanRecognitionLap(harness.profile, 22_303));
    const rows = await harness.attempts();

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.attemptId)).size).toBe(2);
    expect(rows.map((row) => row.outcome)).toEqual(['cancelled', 'accepted']);
  });
});

describe('P12 item B -- a repository that cannot store attempts is not an error', () => {
  it('the controller still builds the record and the session still starts', async () => {
    const repository = new InMemorySessionRepository();
    // A store with no attempt support at all, like a legacy/test double.
    // Written out method by method rather than spread: the repository's
    // methods live on its PROTOTYPE, so `{ ...repository }` would be an
    // object with no methods and the test would pass for the wrong reason.
    const stripped: LocalSessionRepository = {
      saveCheckpoint: (id, snapshot, laps) => repository.saveCheckpoint(id, snapshot, laps),
      loadCheckpoint: (id) => repository.loadCheckpoint(id),
      saveSession: (s) => repository.saveSession(s),
      listSessions: (u, c) => repository.listSessions(u, c),
      saveTelemetry: (id, lap, samples) => repository.saveTelemetry(id, lap, samples),
      saveTelemetryBatch: (id, entries) => repository.saveTelemetryBatch(id, entries),
      loadTelemetry: (id, lap) => repository.loadTelemetry(id, lap),
      getReferenceLap: (u, c, l, v) => repository.getReferenceLap(u, c, l, v),
      putReferenceLap: (ref) => repository.putReferenceLap(ref),
      deleteUserData: (u) => repository.deleteUserData(u),
    };
    delete stripped.saveCalibrationAttempt;
    delete stripped.listCalibrationAttempts;
    delete stripped.saveLapCommit;

    const harness = setup(stripped);
    await harness.controller.start('calibration');
    harness.feed(cleanRecognitionLap(harness.profile, 22_301));
    await harness.controller.flush();

    expect(harness.controller.calibrationAttemptRecord()?.outcome).toBe('accepted');
    expect(stripped.listCalibrationAttempts).toBeUndefined();
  });
});
