import { describe, expect, it } from 'vitest';

import type {
  LapRecord,
  LocalSessionRepository,
  LocationSample,
  SessionMachineSnapshot,
} from '../../src/contracts';
import { SessionController, type FacadeStateCore } from '../../src/controller';
import { cleanRecognitionLap, driveLap } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';
import { SqlSessionRepository } from '../../src/persistence-sql';
import { createRawSqlJsDatabase, wrapSqlJsDatabase } from '../persistence-sql/sqlJsDatabase';

import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

/**
 * Ticket P10B -- the second wave of the P10 independent review: the deeper
 * interruption points the reviewer found in the SAME machinery P10A fixed.
 * Each scenario below is the reviewer's own, with their own parameters.
 *
 * H3-B: pending fixes left every retryable buffer before their lap
 *       transaction committed, and the completeness figures then reported
 *       nothing wrong.
 * H4-B: the lap commit, the reclaim and the recovery checkpoint were not one
 *       unit, so an interruption between them let the next run reuse a lap
 *       number and REPLACE a committed lap's telemetry.
 */

const USER_ID = 'driver-1';

/** Wraps a repository so the lap commit can be made to fail on demand. Everything else delegates. */
class LapCommitFailingRepository implements LocalSessionRepository {
  failLapCommit = false;
  lapCommitAttempts = 0;

  constructor(
    private readonly delegate: LocalSessionRepository,
    /**
     * When false, `saveLapCommit` is not exposed at all -- the controller
     * then drives the FALLBACK path (checkpoint first, telemetry second),
     * which is the other half of the H4-B fix and needs its own coverage.
     */
    atomic = true,
  ) {
    // Deliberately removes the optional method, to model a repository that
    // cannot commit the checkpoint with the lap.
    if (!atomic) this.saveLapCommit = undefined;
  }

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
  saveTelemetry(sessionId: string, lapNumber: number, samples: LocationSample[]): Promise<void> {
    return this.delegate.saveTelemetry(sessionId, lapNumber, samples);
  }
  async saveTelemetryBatch(
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
  ): Promise<void> {
    this.lapCommitAttempts += 1;
    if (this.failLapCommit) throw new Error('lap telemetry transaction failed');
    return this.delegate.saveTelemetryBatch(sessionId, entries);
  }
  saveLapCommit?: (
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
    checkpoint: { snapshot: SessionMachineSnapshot; laps: LapRecord[] },
  ) => Promise<void> = async (sessionId, entries, checkpoint) => {
    this.lapCommitAttempts += 1;
    if (this.failLapCommit) throw new Error('lap telemetry transaction failed');
    if (this.delegate.saveLapCommit !== undefined) {
      return this.delegate.saveLapCommit(sessionId, entries, checkpoint);
    }
    await this.delegate.saveTelemetryBatch(sessionId, entries);
    return this.delegate.saveCheckpoint(sessionId, checkpoint.snapshot, checkpoint.laps);
  };
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
    appVersion: 'p10b-test',
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

  function snapshot(): FacadeStateCore {
    let current: FacadeStateCore | undefined;
    const unsubscribe = controller.subscribe((s) => {
      current = s;
    });
    unsubscribe();
    return current!;
  }

  /** Every GNSS fix this session has on disk, lap rows and chunk rows alike. */
  async function storedFixTMonos(sessionId: string): Promise<Set<number>> {
    const out = new Set<number>();
    for (const key of controller.rawTraceChunkKeys()) {
      for (const sample of await repository.loadTelemetry(sessionId, key)) out.add(sample.tMono);
    }
    for (let lapNumber = 0; lapNumber <= 8; lapNumber += 1) {
      for (const sample of await repository.loadTelemetry(sessionId, lapNumber)) out.add(sample.tMono);
    }
    return out;
  }

  return { profile, controller, clock, feed, snapshot, storedFixTMonos, repository };
}

/**
 * The reviewer's H3-B fixture, verbatim: accepted TMR calibration, then two
 * laps at 10 Hz, 40 m/s, seed 10302, noise 1 m, from `tMono = 200000`.
 */
async function driveTwoLapsWithFailingCommits(repository: LapCommitFailingRepository) {
  const harness = setup(repository);
  const { profile, controller, feed } = harness;
  await controller.start('calibration');
  feed(cleanRecognitionLap(profile, 10_301));
  controller.acceptCalibration();
  await controller.flush();
  controller.arm();

  repository.failLapCommit = true;
  const drive = driveLap(profile, {
    seed: 10_302,
    speedMps: 40,
    noiseSigmaM: 1,
    sampleRateHz: 10,
    lapCount: 2,
    tStartMono: 200_000,
  });
  feed(drive);
  await controller.flush().catch(() => undefined);
  return { ...harness, drive };
}

describe('P10B H3-B -- a lap whose transaction fails keeps its fixes, and says so', () => {
  /**
   * REVIEWER REPRODUCTION (sessionController.ts:2060):
   *   accepted calibration; two laps at 10 Hz/40 m/s/seed 10302/1 m noise
   *   from tMono=200000; reject both `saveTelemetryBatch` calls
   *   -> NINE fixes disappear (`293100`, `385100`..`385800`), and ending the
   *      session reports `unwrittenSampleCount: 0`.
   *
   * They had left `pendingTrace` when the lap completed and had never
   * reached a chunk row, so a failed transaction dropped them -- while the
   * completeness accounting said nothing was missing at all.
   */
  it('retains every fix the failed lap rows owned, and counts them as unwritten', async () => {
    const repository = new LapCommitFailingRepository(new InMemorySessionRepository());
    const { controller, snapshot, storedFixTMonos, drive } = await driveTwoLapsWithFailingCommits(repository);

    const sessionId = controller.diagnostics().sessionId!;
    const fedTMonos = new Set(drive.map((s) => s.tMono));
    const stored = await storedFixTMonos(sessionId);
    const retained = new Set(controller.diagnostics().rawTraceUnwrittenTMonos);

    // Both lap commits were rejected, so no lap row exists...
    expect(await repository.loadTelemetry(sessionId, 1)).toHaveLength(0);
    expect(await repository.loadTelemetry(sessionId, 2)).toHaveLength(0);

    // ...and NOT ONE fed fix is in neither place. WAS: nine of them were.
    const missing = [...fedTMonos].filter(
      (tMono) => !stored.has(tMono) && !retained.has(tMono),
    );
    expect(missing).toEqual([]);

    // The reviewer's nine, by name. These are the fixes that used to leave
    // every buffer unwritten and unreported; each one is now retained,
    // counted, and queued for retry.
    for (const tMono of [293_100, 385_100, 385_200, 385_300, 385_400, 385_500, 385_600, 385_700, 385_800]) {
      expect(retained.has(tMono)).toBe(true);
    }

    // The accounting says what happened rather than reporting a silent zero.
    expect(snapshot().recording.unwrittenSampleCount).toBeGreaterThan(0);
    expect(snapshot().recording.unwrittenSampleCount).toBe(retained.size);
    expect(snapshot().recording.failedWriteCount).toBeGreaterThan(0);
  });

  /**
   * The same reproduction, continued the way the reviewer continued it:
   * storage is restored and the session ends. Every retained fix must land,
   * and the completeness figures must then -- and only then -- read zero.
   */
  it('retries the lap commits once storage recovers: everything lands, unwritten returns to zero', async () => {
    const repository = new LapCommitFailingRepository(new InMemorySessionRepository());
    const { controller, snapshot, storedFixTMonos, drive } = await driveTwoLapsWithFailingCommits(repository);

    repository.failLapCommit = false;
    await controller.endSession();

    const sessionId = controller.diagnostics().sessionId!;
    const stored = await storedFixTMonos(sessionId);
    for (const sample of drive) expect(stored.has(sample.tMono)).toBe(true);

    // The lap rows this time DID commit, on retry.
    expect((await repository.loadTelemetry(sessionId, 1)).length).toBeGreaterThan(0);
    expect(snapshot().recording.unwrittenSampleCount).toBe(0);

    // And the durable record agrees with the live figure.
    const { profile } = tmr();
    const record = (await repository.listSessions(USER_ID, profile.circuitId)).find(
      (s) => s.sessionId === sessionId,
    );
    expect(record?.trace?.unwrittenSampleCount).toBe(0);
  });

  /**
   * The lap transaction never recovers, but the disk itself is fine. The
   * fixes must still end up stored -- as unclaimed chunk rows, which is
   * where a fix with no lap row belongs -- and the figures must agree.
   * Losing the per-lap ROW costs a recomputable grouping; losing the FIXES
   * is the failure the owner has already lived through once.
   */
  it('lap commits that never succeed still leave every fix on disk, as unclaimed trace', async () => {
    const repository = new LapCommitFailingRepository(new InMemorySessionRepository());
    const { controller, snapshot, storedFixTMonos, drive } = await driveTwoLapsWithFailingCommits(repository);

    await controller.endSession();

    const sessionId = controller.diagnostics().sessionId!;
    const stored = await storedFixTMonos(sessionId);
    const missing = drive.filter((sample) => !stored.has(sample.tMono));
    expect(missing).toEqual([]);
    expect(snapshot().recording.unwrittenSampleCount).toBe(0);
    // No lap row landed -- and that is reported, not hidden.
    expect(await repository.loadTelemetry(sessionId, 1)).toHaveLength(0);
    expect(snapshot().recording.failedWriteCount).toBeGreaterThan(0);

    const { profile } = tmr();
    const record = (await repository.listSessions(USER_ID, profile.circuitId)).find(
      (s) => s.sessionId === sessionId,
    );
    expect(record?.trace?.failedWriteCount).toBeGreaterThan(0);
  });
});

describe('P10B H4-B -- the lap commit, its reclaim and the recovery checkpoint are one unit', () => {
  /**
   * REVIEWER REPRODUCTION (sessionController.ts:2076): interrupt after a
   * successful lap batch but before `saveCheckpoint`. The reopened database
   * held 93 fixes in lap 1, no checkpoint laps and two remaining chunk
   * fixes; resuming from that checkpoint and completing another lap reused
   * lap number 1 and replaced the row -- all 93 fixes gone.
   *
   * Against a real sql.js database, reopened: the checkpoint can no longer
   * lag the lap row, because they commit together.
   */
  it('a reopened database never holds a committed lap row that its checkpoint does not know about', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const repository = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const { profile, controller, feed } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 10_401));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    feed(driveLap(profile, { seed: 10_402, speedMps: 40, noiseSigmaM: 1, sampleRateHz: 1 }));
    feed(driveLap(profile, { seed: 10_403, speedMps: 40, noiseSigmaM: 1, sampleRateHz: 1 }));
    await controller.flush();
    const sessionId = controller.diagnostics().sessionId!;

    // Reopen the SAME underlying database, as a relaunch would.
    const reopened = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const lapOne = await reopened.loadTelemetry(sessionId, 1);
    const checkpoint = await reopened.loadCheckpoint(sessionId);
    expect(lapOne.length).toBeGreaterThan(0);
    // WAS: the checkpoint could name no laps while lap 1's row existed.
    expect(checkpoint!.laps.map((lap) => lap.lapNumber)).toContain(1);
  });

  /**
   * The atomicity itself, injected: a repository whose STANDALONE
   * `saveCheckpoint` always fails. Before this fix the lap's checkpoint was
   * exactly such a standalone write made after the committed batch, so this
   * is the reviewer's interruption in test form -- lap 1's row on disk, the
   * checkpoint naming no laps. Now the checkpoint rides inside the lap
   * transaction and lands with it.
   */
  it('the checkpoint lands with the lap even when standalone checkpoint writes cannot', async () => {
    const inner = new InMemorySessionRepository();
    const repository = new LapCommitFailingRepository(inner);
    // Every checkpoint write OUTSIDE the lap transaction fails.
    repository.saveCheckpoint = async () => {
      throw new Error('interrupted before the checkpoint');
    };
    const { profile, controller, feed } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 10_409));
    controller.acceptCalibration();
    await controller.flush().catch(() => undefined);
    controller.arm();
    feed(driveLap(profile, { seed: 10_410, speedMps: 40, noiseSigmaM: 1, sampleRateHz: 1 }));
    feed(driveLap(profile, { seed: 10_411, speedMps: 40, noiseSigmaM: 1, sampleRateHz: 1 }));
    await controller.flush().catch(() => undefined);

    const sessionId = controller.diagnostics().sessionId!;
    expect((await inner.loadTelemetry(sessionId, 1)).length).toBeGreaterThan(0);
    // WAS: null -- a committed lap row with a checkpoint that never knew.
    const checkpoint = await inner.loadCheckpoint(sessionId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.laps.map((lap) => lap.lapNumber)).toContain(1);
  });

  /**
   * The damaged state itself -- a database interrupted BEFORE this fix
   * existed, which is what the owner's phone may already hold. Lap 1's row
   * is on disk; the checkpoint names no laps. Resuming must not reuse lap
   * number 1.
   */
  it('a resume reads the lap identities storage already committed, so it cannot overwrite them', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const repository = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const sessionId = `${USER_ID}--interrupted`;

    // The reviewer's damaged state, built directly: a committed lap 1 row,
    // and a checkpoint that predates it.
    const lapOneFixes: LocationSample[] = Array.from({ length: 93 }, (_, index) => ({
      tMono: 100_000 + index * 1_000,
      lat: 46.7 + index * 1e-5,
      lon: 23.5,
      accuracyM: 3,
      source: 'replay' as const,
    }));
    await repository.saveTelemetry(sessionId, 1, lapOneFixes);
    const { profile, controller, feed } = setup(repository);
    await repository.saveCheckpoint(
      sessionId,
      { state: 'armed', lapNumber: 0, context: {} } as unknown as SessionMachineSnapshot,
      [],
    );

    const checkpoint = await repository.loadCheckpoint(sessionId);
    expect(checkpoint!.laps).toHaveLength(0); // exactly the reviewer's reopened state

    // The host enumerates what storage actually holds (mobile:
    // `readStoredGnssLapNumbers`) and hands it to the restore.
    controller.restoreFromCheckpoint(sessionId, checkpoint!.snapshot, checkpoint!.laps, {
      storedLapNumbers: [1],
    });
    await controller.start('session');
    controller.arm();
    feed(driveLap(profile, { seed: 10_404, speedMps: 40, noiseSigmaM: 1, sampleRateHz: 1 }));
    feed(driveLap(profile, { seed: 10_405, speedMps: 40, noiseSigmaM: 1, sampleRateHz: 1 }));
    await controller.flush();

    // WAS: lap number 1 reused, its row REPLACED, all 93 fixes lost.
    const lapOne = await repository.loadTelemetry(sessionId, 1);
    expect(lapOne).toHaveLength(93);
    expect(lapOne.map((s) => s.tMono)).toEqual(lapOneFixes.map((s) => s.tMono));
    // The new lap took the next free identity instead.
    expect((await repository.loadTelemetry(sessionId, 2)).length).toBeGreaterThan(0);
  });

  /** The A/B of the fix: the same damaged database, restored WITHOUT the stored identities -- i.e. exactly as P10A shipped -- loses lap 1's fixes. */
  it('and without those identities the same resume replaces lap 1 -- this is what the reviewer measured', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const repository = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const sessionId = `${USER_ID}--interrupted-ab`;
    const lapOneFixes: LocationSample[] = Array.from({ length: 93 }, (_, index) => ({
      tMono: 100_000 + index * 1_000,
      lat: 46.7 + index * 1e-5,
      lon: 23.5,
      accuracyM: 3,
      source: 'replay' as const,
    }));
    await repository.saveTelemetry(sessionId, 1, lapOneFixes);
    await repository.saveCheckpoint(
      sessionId,
      { state: 'armed', lapNumber: 0, context: {} } as unknown as SessionMachineSnapshot,
      [],
    );
    const { profile, controller, feed } = setup(repository);
    const checkpoint = await repository.loadCheckpoint(sessionId);

    controller.restoreFromCheckpoint(sessionId, checkpoint!.snapshot, checkpoint!.laps);
    await controller.start('session');
    controller.arm();
    feed(driveLap(profile, { seed: 10_412, speedMps: 40, noiseSigmaM: 1, sampleRateHz: 1 }));
    feed(driveLap(profile, { seed: 10_413, speedMps: 40, noiseSigmaM: 1, sampleRateHz: 1 }));
    await controller.flush();

    // Lap number 1 was reused, so the row now holds the NEW lap's fixes --
    // the 93 originals are gone, with no copy left anywhere (their chunk
    // copies were reclaimed by the run that was interrupted).
    const lapOne = await repository.loadTelemetry(sessionId, 1);
    expect(lapOne.map((s) => s.tMono)).not.toEqual(lapOneFixes.map((s) => s.tMono));
    expect(lapOne.some((s) => s.tMono === lapOneFixes[0]!.tMono)).toBe(false);
  });

  /**
   * A repository that cannot commit both together is driven in the SAFE
   * order instead: the checkpoint first. An interruption then reserves the
   * lap number without a row to lose, and every fix is still in the chunks.
   */
  it('without an atomic lap commit, the checkpoint is written FIRST so a failure can only reserve a lap number', async () => {
    const inner = new InMemorySessionRepository();
    const repository = new LapCommitFailingRepository(inner, false);
    expect(repository.saveLapCommit).toBeUndefined();
    const { profile, controller, feed } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 10_406));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    repository.failLapCommit = true;
    feed(driveLap(profile, { seed: 10_407, speedMps: 40, noiseSigmaM: 1, sampleRateHz: 1 }));
    feed(driveLap(profile, { seed: 10_408, speedMps: 40, noiseSigmaM: 1, sampleRateHz: 1 }));
    await controller.flush().catch(() => undefined);

    const sessionId = controller.diagnostics().sessionId!;
    // No lap row (the batch failed) ...
    expect(await inner.loadTelemetry(sessionId, 1)).toHaveLength(0);
    // ... but the checkpoint has claimed the lap number, so a resumed run
    // starts at 2 and cannot replace anything.
    const checkpoint = await inner.loadCheckpoint(sessionId);
    expect(checkpoint!.laps.map((lap) => lap.lapNumber)).toContain(1);
  });
});
