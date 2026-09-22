import { describe, expect, it } from 'vitest';

import type {
  CalibrationAttemptRecord,
  LocalSessionRepository,
  LocationSample,
  SessionSummary,
} from '../../src/contracts';
import { SessionController } from '../../src/controller';
import { cleanRecognitionLap } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

/**
 * Ticket P14 (Codex P13 round) -- A FAILURE IS NEVER RENDERED AS A CONFIDENT
 * NEGATIVE.
 *
 * H4 (sessionController.ts:2214): the provisional calibration row saved, the
 * CANCEL conclusion did NOT, and nothing ever retried it. Live state said
 * `cancelled`; storage said `stalled, concluded: false` -- and the export read
 * the stale provisional row as the final account of the attempt. The cancel
 * record the owner explicitly asked for was exactly the thing that went
 * missing.
 *
 * H3 (sessionReport.ts:659, controller half): the session row's last stored
 * `unwrittenSampleCount: 0` was read as proof of a complete recording. It is
 * proof of nothing of the kind while the session is still running: a captured
 * fix can be sitting in the pending buffer, and a crash there loses it. The
 * row now says whether recording was ever FINALISED, so "zero unwritten" can
 * be told apart from "zero as of the last write before the crash".
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
    appVersion: 'p14-test',
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

  return { profile, controller, feed, repository, attempts, clock };
}

/**
 * A repository whose `saveCalibrationAttempt` fails for exactly the records
 * the predicate names -- the reviewer's reproduction: the provisional write
 * succeeds and the CONCLUSION write fails.
 */
class SelectivelyFailingRepository extends InMemorySessionRepository {
  failWhile: (record: CalibrationAttemptRecord) => boolean = () => false;
  attemptWriteCount = 0;

  override async saveCalibrationAttempt(record: CalibrationAttemptRecord): Promise<void> {
    this.attemptWriteCount += 1;
    if (this.failWhile(record)) throw new Error('disk full');
    await super.saveCalibrationAttempt(record);
  }
}

describe('P14 H4 -- a calibration conclusion that could not be written is retried and declared', () => {
  it('retains the failed CANCEL record, retries it on flush, and says so until it lands', async () => {
    const repository = new SelectivelyFailingRepository();
    const { profile, controller, feed, attempts } = setup(repository);

    await controller.start('calibration');
    const recognition = cleanRecognitionLap(profile, 14_001);
    feed(recognition.slice(0, Math.floor(recognition.length * 0.5)));
    await controller.flush();

    // Everything written up to here is provisional and it all landed.
    const provisional = await attempts();
    expect(provisional).toHaveLength(1);
    expect(provisional[0]!.concluded).toBe(false);

    // Now the conclusion cannot be written.
    repository.failWhile = (record) => record.concluded;
    controller.rejectCalibration();
    await controller.flush();

    // BEFORE: storage still held `stalled, concluded: false` and nothing said
    // otherwise. AFTER: the controller declares the failure and still holds
    // the record it could not write.
    const failure = controller.calibrationRecordFailure();
    expect(failure, 'the persistence failure is not exposed').not.toBeNull();
    expect(failure!.outcome).toBe('cancelled');
    expect(failure!.detail).toContain('disk full');
    const retained = controller.unpersistedCalibrationAttempts();
    expect(retained).toHaveLength(1);
    expect(retained[0]!.outcome).toBe('cancelled');
    expect(retained[0]!.concluded).toBe(true);

    // Repeated flushes RETRY it -- the old code never did.
    const before = repository.attemptWriteCount;
    await controller.flush();
    expect(repository.attemptWriteCount).toBeGreaterThan(before);
    expect(controller.calibrationRecordFailure()).not.toBeNull();

    // And when storage recovers, the retry lands and the declaration clears.
    repository.failWhile = () => false;
    await controller.flush();
    expect(controller.calibrationRecordFailure()).toBeNull();
    expect(controller.unpersistedCalibrationAttempts()).toHaveLength(0);
    const stored = await attempts();
    const cancelled = stored.find((record) => record.outcome === 'cancelled');
    expect(cancelled, 'the cancel record never reached storage').toBeDefined();
    expect(cancelled!.concluded).toBe(true);
  });

  it('declares nothing when every write succeeds', async () => {
    const { profile, controller, feed } = setup();
    await controller.start('calibration');
    const recognition = cleanRecognitionLap(profile, 14_002);
    feed(recognition.slice(0, Math.floor(recognition.length * 0.5)));
    controller.rejectCalibration();
    await controller.flush();

    expect(controller.calibrationRecordFailure()).toBeNull();
    expect(controller.unpersistedCalibrationAttempts()).toHaveLength(0);
  });
});

describe('P14 H3 -- the session row says whether recording was ever finalised', () => {
  it('is NOT finalised while the session is still recording, and IS after endSession', async () => {
    const repository = new InMemorySessionRepository();
    const { profile, controller, feed } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 14_101));
    controller.acceptCalibration();
    await controller.flush();
    const sessionId = controller.diagnostics().sessionId!;

    const mid = await repository.listSessions(USER_ID, profile.circuitId);
    const midRow = mid.find((s: SessionSummary) => s.sessionId === sessionId);
    expect(midRow, 'no session row while recording').toBeDefined();
    // THE POINT: whatever `unwrittenSampleCount` says right now, it is a
    // RUNNING figure -- captured fixes are still arriving and the buffer is
    // still draining. Read as a final account (which is what the report did)
    // it produces "complete (no captured fix went unwritten)" for a session a
    // crash here would truncate. The row now says so itself.
    expect(typeof midRow!.trace?.unwrittenSampleCount).toBe('number');
    expect(midRow!.trace?.recordingFinalized).toBe(false);

    await controller.endSession();
    const after = await repository.listSessions(USER_ID, profile.circuitId);
    const finalRow = after.find((s: SessionSummary) => s.sessionId === sessionId);
    expect(finalRow!.trace?.recordingFinalized).toBe(true);
  });
});
