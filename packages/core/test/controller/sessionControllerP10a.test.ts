import { describe, expect, it } from 'vitest';

import type { LapRecord, LocalSessionRepository, LocationSample, SessionMachineSnapshot } from '../../src/contracts';
import { SessionController, type FacadeStateCore } from '../../src/controller';
import { cleanRecognitionLap, driveLap } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

/**
 * Ticket P10A -- the five HIGH findings the P9 independent reviewer
 * REPRODUCED, each one re-run here against the fix.
 *
 * Every scenario below is the reviewer's own, in their own order of
 * operations. They are kept together because they are one defect with five
 * faces: a session that only became durable when a LAP completed. On the day
 * this app exists for -- a first visit to a circuit whose gate geometry has
 * never been validated, where no lap is detected at all -- that meant the
 * drive reached the disk and then could not be got back off it.
 */

const USER_ID = 'driver-1';

/**
 * A repository whose `saveTelemetry` can be made to fail -- for the first
 * call only, or for every call -- so a transient storage hiccup and a dead
 * disk can be told apart. Everything else delegates.
 */
class FlakyRepository implements LocalSessionRepository {
  /** Remaining `saveTelemetry` calls that will throw before any succeed. */
  failNextTelemetryWrites = 0;
  /** When set, `saveTelemetryBatch` throws -- the lap-row + reclaim transaction. */
  failTelemetryBatch = false;
  readonly telemetryWriteAttempts: number[] = [];

  constructor(private readonly delegate: LocalSessionRepository) {}

  saveCheckpoint(sessionId: string, snapshot: SessionMachineSnapshot, laps: LapRecord[]): Promise<void> {
    return this.delegate.saveCheckpoint(sessionId, snapshot, laps);
  }
  loadCheckpoint(sessionId: string): ReturnType<LocalSessionRepository['loadCheckpoint']> {
    return this.delegate.loadCheckpoint(sessionId);
  }
  saveSession(s: Parameters<LocalSessionRepository['saveSession']>[0]): Promise<void> {
    return this.delegate.saveSession(s);
  }
  listSessions(userId: string, circuitId: string): ReturnType<LocalSessionRepository['listSessions']> {
    return this.delegate.listSessions(userId, circuitId);
  }
  async saveTelemetry(sessionId: string, lapNumber: number, samples: LocationSample[]): Promise<void> {
    this.telemetryWriteAttempts.push(lapNumber);
    if (this.failNextTelemetryWrites > 0) {
      this.failNextTelemetryWrites -= 1;
      throw new Error('temporary write failure');
    }
    return this.delegate.saveTelemetry(sessionId, lapNumber, samples);
  }
  async saveTelemetryBatch(
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
  ): Promise<void> {
    if (this.failTelemetryBatch) throw new Error('lap telemetry transaction failed');
    return this.delegate.saveTelemetryBatch(sessionId, entries);
  }
  loadTelemetry(sessionId: string, lapNumber: number): Promise<LocationSample[]> {
    return this.delegate.loadTelemetry(sessionId, lapNumber);
  }
  getReferenceLap(
    userId: string,
    circuitId: string,
    layoutId: string,
    layoutVersion: number,
  ): ReturnType<LocalSessionRepository['getReferenceLap']> {
    return this.delegate.getReferenceLap(userId, circuitId, layoutId, layoutVersion);
  }
  putReferenceLap(ref: Parameters<LocalSessionRepository['putReferenceLap']>[0]): Promise<void> {
    return this.delegate.putReferenceLap(ref);
  }
  deleteUserData(userId: string): Promise<void> {
    return this.delegate.deleteUserData(userId);
  }
}

function setup(repository: LocalSessionRepository) {
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
    appVersion: 'p10a-test',
    algorithmVersion: 1,
    restartProvider: () => undefined,
    // Silences the deliberate write failures below; the counters are what
    // these tests assert on, not the log.
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

  function snapshot(): FacadeStateCore {
    let current: FacadeStateCore | undefined;
    const unsubscribe = controller.subscribe((s) => {
      current = s;
    });
    unsubscribe();
    return current!;
  }

  async function storedTrace(): Promise<LocationSample[]> {
    const sessionId = controller.diagnostics().sessionId;
    if (sessionId === null) return [];
    const out: LocationSample[] = [];
    for (const key of controller.rawTraceChunkKeys()) {
      out.push(...(await repository.loadTelemetry(sessionId, key)));
    }
    return out;
  }

  return { profile, controller, clock, feed, snapshot, storedTrace, repository };
}

/** The reviewer's own fixture: ten fixes, all parked on the first centerline point. */
function tenFixesAt(point: { lat: number; lon: number }): LocationSample[] {
  return Array.from({ length: 10 }, (_, index) => ({
    ...point,
    tMono: index * 1_000,
    accuracyM: 3,
    source: 'replay' as const,
  }));
}

describe('P10A H2 -- a crashed ZERO-LAP session is still findable', () => {
  /**
   * REVIEWER REPRODUCTION (composition.ts:3032), verbatim in shape:
   *   start('calibration'); feed ten fixes; flush
   *   -> persisted: 10, checkpoint: null, history: 0
   *
   * Ten fixes on disk and no way to reach them. A foreground process death
   * here leaves bootstrap with an active-session pointer to a session that
   * has neither a checkpoint nor a history row, so it clears the pointer --
   * and the drive is unreachable by recovery, by history, and by the raw
   * export at once.
   */
  it('writes a session record AND an initial checkpoint at recording start, before any lap exists', async () => {
    const repository = new InMemorySessionRepository();
    const { profile, controller, feed, snapshot } = setup(repository);

    await controller.start('calibration');
    feed(tenFixesAt(profile.centerline[0]!));
    await controller.flush();

    const sessionId = controller.diagnostics().sessionId!;
    expect(snapshot().recording.persistedSampleCount).toBe(10);

    // WAS: null. The pre-crash session is now recoverable.
    const checkpoint = await repository.loadCheckpoint(sessionId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.snapshot.state).toBe('calibrating');

    // WAS: 0. The session is in history, so `getSession(id)` answers and the
    // raw export can retrieve the drive.
    const history = await repository.listSessions(USER_ID, profile.circuitId);
    expect(history).toHaveLength(1);
    expect(history[0]!.sessionId).toBe(sessionId);
    expect(history[0]!.laps).toHaveLength(0);
    // Ticket P10A H6: the calibration never concluded, so the honest answer
    // is UNKNOWN -- never "validated".
    expect(history[0]!.calibrationStatus).toBe('unknown');
  });

  it('the recording-start record never overwrites a later lap checkpoint', async () => {
    const repository = new InMemorySessionRepository();
    const { profile, controller, feed } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 10_201));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    feed(driveLap(profile, { seed: 10_202, speedMps: 40, noiseSigmaM: 1 }));
    feed(driveLap(profile, { seed: 10_203, speedMps: 40, noiseSigmaM: 1 }));
    await controller.flush();

    const sessionId = controller.diagnostics().sessionId!;
    const checkpoint = await repository.loadCheckpoint(sessionId);
    expect(checkpoint!.laps.length).toBeGreaterThan(0);
  });
});

describe('P10A H3 -- a failed chunk write is retained and retried, never dropped', () => {
  /**
   * REVIEWER REPRODUCTION (sessionController.ts:1563):
   *   first `saveTelemetry` fails once, storage then works, session ends
   *   -> fed: 10, stored: 8, failed: 1, pending: 0
   *
   * Two fixes gone for good, with nothing anywhere saying so. Calibration and
   * no-lap samples have no other durable copy: the chunk row IS the drive.
   */
  it('a single transient failure loses NOTHING: ten fed, ten stored', async () => {
    const inner = new InMemorySessionRepository();
    const repository = new FlakyRepository(inner);
    repository.failNextTelemetryWrites = 1;
    const { profile, controller, feed, snapshot, storedTrace } = setup(repository);

    await controller.start('calibration');
    feed(tenFixesAt(profile.centerline[0]!));
    await controller.endSession();

    const stored = await storedTrace();
    expect(stored).toHaveLength(10); // WAS: 8
    expect(snapshot().recording.persistedSampleCount).toBe(10);
    // The failure itself is still reported -- storage misbehaved, and the
    // driver's red dot is entitled to know.
    expect(snapshot().recording.failedWriteCount).toBe(1);
    // ...but nothing is outstanding, which is the distinction that matters.
    expect(snapshot().recording.unwrittenSampleCount).toBe(0);
    expect(controller.diagnostics().rawTraceRetainedSampleCount).toBe(0);
  });

  it('a dead disk is reported as an INCOMPLETE recording, live and in the durable session record', async () => {
    const inner = new InMemorySessionRepository();
    const repository = new FlakyRepository(inner);
    // Every telemetry write fails, for the whole session.
    repository.failNextTelemetryWrites = Number.MAX_SAFE_INTEGER;
    const { profile, controller, feed, snapshot } = setup(repository);

    await controller.start('calibration');
    feed(tenFixesAt(profile.centerline[0]!));
    await controller.endSession();

    // The distinction the final flush must be able to draw, reaching the user:
    expect(snapshot().recording.persistedSampleCount).toBe(0);
    expect(snapshot().recording.unwrittenSampleCount).toBe(10);
    expect(snapshot().recording.failedWriteCount).toBeGreaterThan(0);

    const sessionId = controller.diagnostics().sessionId!;
    const stored = (await inner.listSessions(USER_ID, profile.circuitId)).find(
      (s) => s.sessionId === sessionId,
    );
    expect(stored?.trace?.unwrittenSampleCount).toBe(10);
  });
});

describe('P10A H4 -- one fix is stored once, because the lap row and its reclaim are one transaction', () => {
  /**
   * REVIEWER REPRODUCTION (rawSessionExport.ts:155):
   *   lap row succeeds, reclaim fails, checkpoint succeeds
   *   -> one unique fix is exported twice.
   *
   * Core's half of the fix is to make that state unreachable: the lap row and
   * the chunk rewrites commit together or not at all. When they do not, the
   * fixes stay in the chunks -- the drive is never lost, only the
   * recomputable per-lap row is missing.
   */
  it('a failed lap-telemetry transaction leaves the chunks intact and writes no lap row', async () => {
    const inner = new InMemorySessionRepository();
    const repository = new FlakyRepository(inner);
    const { profile, controller, feed, storedTrace } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 10_301));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    const beforeFailure = (await storedTrace()).length;
    expect(beforeFailure).toBeGreaterThan(0);

    repository.failTelemetryBatch = true;
    feed(driveLap(profile, { seed: 10_302, speedMps: 40, noiseSigmaM: 1 }));
    feed(driveLap(profile, { seed: 10_303, speedMps: 40, noiseSigmaM: 1 }));
    await expect(controller.flush()).rejects.toThrow('lap telemetry transaction failed');

    const sessionId = controller.diagnostics().sessionId!;
    // No lap row: the transaction did not commit, so the lap did not half-commit.
    expect(await inner.loadTelemetry(sessionId, 1)).toHaveLength(0);
    // And the chunks still hold everything -- no sample is in neither place,
    // and none is in both.
    expect((await storedTrace()).length).toBeGreaterThanOrEqual(beforeFailure);
  });

  it('a successful lap reclaims its range exactly once -- no fix is left in both rows', async () => {
    const inner = new InMemorySessionRepository();
    const { profile, controller, feed, storedTrace } = setup(inner);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 10_311));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    feed(driveLap(profile, { seed: 10_312, speedMps: 40, noiseSigmaM: 1 }));
    feed(driveLap(profile, { seed: 10_313, speedMps: 40, noiseSigmaM: 1 }));
    await controller.flush();

    const sessionId = controller.diagnostics().sessionId!;
    const lapRow = await inner.loadTelemetry(sessionId, 1);
    expect(lapRow.length).toBeGreaterThan(0);
    const unclaimed = await storedTrace();
    const lapRange = { from: lapRow[0]!.tMono, to: lapRow[lapRow.length - 1]!.tMono };
    const overlapping = unclaimed.filter(
      (sample) => sample.tMono >= lapRange.from && sample.tMono <= lapRange.to,
    );
    expect(overlapping).toEqual([]);
  });
});

describe('P10A H5 -- a resumed session never sheds its calibration label', () => {
  /**
   * REVIEWER REPRODUCTION (sessionController.ts:978):
   *   rejected calibration -> escape -> checkpoint -> restore -> start('session')
   *   -> `matchingUnvalidated` goes true -> FALSE.
   *
   * The dashboard then shows a resumed, never-calibrated session as an
   * ordinary one.
   */
  it('restore + start(session) keeps `unvalidated` -- in memory and on disk', async () => {
    const repository = new InMemorySessionRepository();
    const { profile, controller, feed, snapshot } = setup(repository);

    await controller.start('calibration');
    // Ten fixes parked on one point: nowhere near the coverage bar, so the
    // engine REJECTS what the escape hatch force-finishes -- the reviewer's
    // exact setup.
    feed(tenFixesAt(profile.centerline[0]!));
    expect(controller.proceedWithoutValidatedCalibration()).toBe('armed-unvalidated');
    expect(snapshot().matchingUnvalidated).toBe(true);
    expect(snapshot().calibrationStatus).toBe('unvalidated');

    await controller.checkpointNow();
    await controller.flush();
    const sessionId = controller.diagnostics().sessionId!;
    const checkpoint = await repository.loadCheckpoint(sessionId);

    controller.restoreFromCheckpoint(sessionId, checkpoint!.snapshot, checkpoint!.laps);
    await controller.start('session');

    expect(snapshot().matchingUnvalidated).toBe(true); // WAS: false
    expect(snapshot().calibrationStatus).toBe('unvalidated');
  });

  it('a restore in a FRESH process reads the provenance back from the durable record', async () => {
    const repository = new InMemorySessionRepository();
    const first = setup(repository);

    await first.controller.start('calibration');
    first.feed(tenFixesAt(first.profile.centerline[0]!));
    expect(first.controller.proceedWithoutValidatedCalibration()).toBe('armed-unvalidated');
    await first.controller.checkpointNow();
    await first.controller.flush();
    const sessionId = first.controller.diagnostics().sessionId!;

    // What the host reads on the next launch, the way `composition.ts` does.
    const storedStatus = (await repository.listSessions(USER_ID, first.profile.circuitId)).find(
      (s) => s.sessionId === sessionId,
    )?.calibrationStatus;
    expect(storedStatus).toBe('unvalidated');

    // A genuinely new controller -- nothing carried in memory.
    const second = setup(repository);
    const checkpoint = await repository.loadCheckpoint(sessionId);
    second.controller.restoreFromCheckpoint(sessionId, checkpoint!.snapshot, checkpoint!.laps, {
      calibrationStatus: storedStatus,
    });
    await second.controller.start('session');
    expect(second.snapshot().matchingUnvalidated).toBe(true);
  });

  it('a resume with NO readable provenance is `unknown`, never `validated`', async () => {
    const repository = new InMemorySessionRepository();
    const first = setup(repository);
    await first.controller.start('calibration');
    first.feed(cleanRecognitionLap(first.profile, 10_401));
    first.controller.acceptCalibration();
    await first.controller.flush();
    const sessionId = first.controller.diagnostics().sessionId!;
    const checkpoint = await repository.loadCheckpoint(sessionId);

    const second = setup(repository);
    // The host could not read the record (a corrupt row, a failed read) and
    // therefore says nothing.
    second.controller.restoreFromCheckpoint(sessionId, checkpoint!.snapshot, checkpoint!.laps);
    await second.controller.start('session');
    expect(second.snapshot().calibrationStatus).toBe('unknown');
    expect(second.snapshot().matchingUnvalidated).toBe(false);
  });
});

describe('P10A H6 -- provenance lives WITH the session, not in a side log', () => {
  it('an accepted calibration is recorded as `validated` the moment it is accepted, not at session end', async () => {
    const repository = new InMemorySessionRepository();
    const { profile, controller, feed } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 10_501));
    controller.acceptCalibration();
    await controller.flush();

    const sessionId = controller.diagnostics().sessionId!;
    const stored = (await repository.listSessions(USER_ID, profile.circuitId)).find(
      (s) => s.sessionId === sessionId,
    );
    // No `endSession()` has happened: a crash right now still leaves the
    // truth on disk.
    expect(stored?.calibrationStatus).toBe('validated');
  });

  it('an escaped calibration is recorded as `unvalidated` before the driver goes out', async () => {
    const repository = new InMemorySessionRepository();
    const { profile, controller, feed } = setup(repository);

    await controller.start('calibration');
    feed(tenFixesAt(profile.centerline[0]!));
    expect(controller.proceedWithoutValidatedCalibration()).toBe('armed-unvalidated');
    await controller.flush();

    const sessionId = controller.diagnostics().sessionId!;
    const stored = (await repository.listSessions(USER_ID, profile.circuitId)).find(
      (s) => s.sessionId === sessionId,
    );
    expect(stored?.calibrationStatus).toBe('unvalidated');
  });
});
