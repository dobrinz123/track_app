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
 * Ticket P11C -- A RETRIED OLD LAP COMMIT MUST NOT OVERWRITE A NEWER
 * CHECKPOINT.
 *
 * REVIEWER REPRODUCTION (round 3, sessionController.ts:2375), verbatim:
 *   SQLite; calibration seed 22301, driving seed 22302; two laps at 40 m/s
 *   and 10 Hz; fail ONLY the first lap commit. Lap 2 succeeds, leaving the
 *   checkpoint at laps [1,2]. Advance the clock 2,000 ms and call
 *   `flushRawTrace()`: the lap-1 retry succeeds -- and replaces the
 *   checkpoint with [1], because it commits the snapshot it captured when it
 *   first failed. Restarting with stored identities [1,2], the completed
 *   lap 2 becomes a zero-duration RECOVERY lap, although all 927 of its
 *   telemetry samples are still on disk.
 *
 * No fix is lost; a real completed lap is MISREPRESENTED after a restart,
 * which to the driver reading his session is the same thing.
 *
 * The rule: a checkpoint may only ever be replaced by one that SUPERSEDES
 * it, "newer" being the number of laps it names (`checkpointGeneration`),
 * and the comparison happens inside the same transaction as the write.
 */

const USER_ID = 'driver-1';

/**
 * Fails the FIRST lap commit only -- the reviewer's exact injection. Every
 * later commit, including the retry of the one that failed, goes through.
 *
 * `atomic: false` additionally HIDES `saveLapCommit`, which is what drives
 * `SessionController` down the checkpoint-first FALLBACK path; the failure
 * is then injected at `saveTelemetryBatch`, the fallback's own write.
 */
class FirstLapCommitFailingRepository implements LocalSessionRepository {
  lapCommitAttempts = 0;
  private failed = false;

  constructor(
    private readonly delegate: LocalSessionRepository,
    atomic = true,
  ) {
    if (!atomic) this.saveLapCommit = undefined;
  }

  /** True exactly once: on the first lap-commit attempt of the session. */
  private shouldFail(): boolean {
    if (this.failed) return false;
    this.failed = true;
    return true;
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
    // Only reached on the fallback path (this class hides `saveLapCommit`
    // there); on the atomic path the controller never calls it.
    this.lapCommitAttempts += 1;
    if (this.shouldFail()) throw new Error('lap telemetry transaction failed (first attempt)');
    return this.delegate.saveTelemetryBatch(sessionId, entries);
  }
  saveLapCommit?: (
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
    checkpoint: { snapshot: SessionMachineSnapshot; laps: LapRecord[] },
  ) => Promise<void> = async (sessionId, entries, checkpoint) => {
    this.lapCommitAttempts += 1;
    if (this.shouldFail()) throw new Error('lap telemetry transaction failed (first attempt)');
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
    appVersion: 'p11c-test',
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

  /** Moves the monotonic clock forward without feeding a fix -- the reviewer's "advance the clock 2,000 ms". */
  function advance(ms: number): void {
    wallClock += ms;
    clock.set(wallClock);
  }

  /**
   * Waits for every persistence chain to come to rest.
   *
   * `flush()` rethrows the FIRST rejection it sees, and a rejected lap
   * commit can return it while a LATER lap's commit is still in flight --
   * which is the whole shape of this scenario. A second `flush()` plus a
   * macrotask turn puts the assertions after the last write, not in the
   * middle of it. (Nothing here is under test: it is the test's own
   * synchronisation.)
   */
  async function settle(): Promise<void> {
    await controller.flush().catch(() => undefined);
    await controller.flush().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  function snapshot(): FacadeStateCore {
    let current: FacadeStateCore | undefined;
    const unsubscribe = controller.subscribe((s) => {
      current = s;
    });
    unsubscribe();
    return current!;
  }

  return { profile, runtime, controller, clock, feed, advance, settle, snapshot, provider, scheduler };
}

/**
 * The reviewer's drive, verbatim: accepted TMR calibration from seed 22301,
 * then two laps at 40 m/s and 10 Hz from seed 22302, with the FIRST lap
 * commit rejected.
 */
async function driveReviewerScenario(repository: FirstLapCommitFailingRepository) {
  const harness = setup(repository);
  const { profile, controller, feed } = harness;
  await controller.start('calibration');
  feed(cleanRecognitionLap(profile, 22_301));
  controller.acceptCalibration();
  await controller.flush();
  controller.arm();

  feed(
    driveLap(profile, {
      seed: 22_302,
      speedMps: 40,
      noiseSigmaM: 1,
      sampleRateHz: 10,
      lapCount: 2,
      tStartMono: 200_000,
    }),
  );
  // The first lap commit was rejected, so the lap's own persistence chain
  // rejects; the failure is the scenario, not the assertion.
  await harness.settle();
  return harness;
}

describe('P11C -- a retried lap commit never replaces a newer checkpoint (atomic saveLapCommit path)', () => {
  it("the lap-1 retry persists its telemetry and leaves the checkpoint at [1,2]", async () => {
    const rawDb = await createRawSqlJsDatabase();
    const inner = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const repository = new FirstLapCommitFailingRepository(inner);
    const { controller, advance, settle } = await driveReviewerScenario(repository);
    const sessionId = controller.diagnostics().sessionId!;

    // Lap 2 committed; lap 1's commit did not. This is the reviewer's
    // starting state: the checkpoint names BOTH laps (lap 2's commit
    // captured `[...core.laps]` at its own boundary) ...
    const before = await inner.loadCheckpoint(sessionId);
    expect(before!.laps.map((lap) => lap.lapNumber)).toEqual([1, 2]);
    // ... while lap 1 has no row yet, and lap 2 has all of its fixes.
    expect(await inner.loadTelemetry(sessionId, 1)).toHaveLength(0);
    const lapTwoFixCount = (await inner.loadTelemetry(sessionId, 2)).length;
    expect(lapTwoFixCount).toBeGreaterThan(900); // the reviewer counted 927

    // The reviewer's trigger, verbatim.
    advance(2_000);
    await controller.flushRawTrace();
    await settle();

    // The retry landed: lap 1's row exists now.
    expect((await inner.loadTelemetry(sessionId, 1)).length).toBeGreaterThan(0);
    // ... and lap 2's row is untouched by it.
    expect(await inner.loadTelemetry(sessionId, 2)).toHaveLength(lapTwoFixCount);

    // WAS: [1] -- the retry wrote back the checkpoint it had captured when
    // it first failed, and lap 2 vanished from the recovery record.
    const after = await inner.loadCheckpoint(sessionId);
    expect(after!.laps.map((lap) => lap.lapNumber)).toEqual([1, 2]);
    // Not merely present: still the REAL lap, with its real duration.
    const lapTwo = after!.laps.find((lap) => lap.lapNumber === 2)!;
    expect(lapTwo.durationMs).toBeGreaterThan(0);
    expect(lapTwo.invalidReasons).not.toContain('RECOVERY');
  });

  it('so a restart from that checkpoint restores lap 2 as a real lap, not a zero-duration RECOVERY lap', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const inner = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const repository = new FirstLapCommitFailingRepository(inner);
    const { controller, advance, settle } = await driveReviewerScenario(repository);
    const sessionId = controller.diagnostics().sessionId!;
    const realLapTwo = (await inner.loadCheckpoint(sessionId))!.laps.find((lap) => lap.lapNumber === 2)!;

    advance(2_000);
    await controller.flushRawTrace();
    await settle();

    // The relaunch: a brand-new controller over the SAME database, restored
    // from the stored checkpoint with the lap identities storage holds.
    const reopened = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const stored = await reopened.loadCheckpoint(sessionId);
    const relaunched = setup(reopened);
    relaunched.controller.restoreFromCheckpoint(sessionId, stored!.snapshot, stored!.laps, {
      calibrationStatus: 'unknown',
      storedLapNumbers: [1, 2],
    });

    const restoredLaps = relaunched.snapshot().laps;
    const restoredLapTwo = restoredLaps.find((lap) => lap.lapNumber === 2);
    expect(restoredLapTwo).toBeDefined();
    // WAS: lap 2 was not in the checkpoint at all, so the restore re-made it
    // as the synthetic in-flight lap -- durationMs 0, invalidReasons
    // ['RECOVERY'] -- while its 927 fixes sat on disk unreferenced.
    expect(restoredLapTwo!.durationMs).toBe(realLapTwo.durationMs);
    expect(restoredLapTwo!.durationMs).toBeGreaterThan(0);
    expect(restoredLapTwo!.invalidReasons).not.toContain('RECOVERY');
    // And its telemetry is still exactly where it was.
    expect((await reopened.loadTelemetry(sessionId, 2)).length).toBeGreaterThan(900);
  });
});

describe('P11C -- the same protection on the checkpoint-first FALLBACK path', () => {
  it('a repository without saveLapCommit also keeps the checkpoint at [1,2] across the retry', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const inner = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const repository = new FirstLapCommitFailingRepository(inner, false);
    // The premise of this test: the controller must take the fallback.
    expect(repository.saveLapCommit).toBeUndefined();

    const { controller, advance, settle } = await driveReviewerScenario(repository);
    const sessionId = controller.diagnostics().sessionId!;

    // The fallback writes the checkpoint FIRST, so lap 1's failed commit
    // still reserved lap number 1 -- and lap 2's commit then advanced the
    // checkpoint to both laps.
    const before = await inner.loadCheckpoint(sessionId);
    expect(before!.laps.map((lap) => lap.lapNumber)).toEqual([1, 2]);
    expect(await inner.loadTelemetry(sessionId, 1)).toHaveLength(0);
    const lapTwoFixCount = (await inner.loadTelemetry(sessionId, 2)).length;
    expect(lapTwoFixCount).toBeGreaterThan(900);

    advance(2_000);
    await controller.flushRawTrace();
    await settle();

    // Telemetry retried ...
    expect((await inner.loadTelemetry(sessionId, 1)).length).toBeGreaterThan(0);
    expect(await inner.loadTelemetry(sessionId, 2)).toHaveLength(lapTwoFixCount);
    // ... and the checkpoint did NOT go back to [1].
    const after = await inner.loadCheckpoint(sessionId);
    expect(after!.laps.map((lap) => lap.lapNumber)).toEqual([1, 2]);
    const lapTwo = after!.laps.find((lap) => lap.lapNumber === 2)!;
    expect(lapTwo.durationMs).toBeGreaterThan(0);
    expect(lapTwo.invalidReasons).not.toContain('RECOVERY');
  });

  it('and a restart from it restores lap 2 as a real lap too', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const inner = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const repository = new FirstLapCommitFailingRepository(inner, false);
    const { controller, advance, settle } = await driveReviewerScenario(repository);
    const sessionId = controller.diagnostics().sessionId!;
    const realLapTwo = (await inner.loadCheckpoint(sessionId))!.laps.find((lap) => lap.lapNumber === 2)!;

    advance(2_000);
    await controller.flushRawTrace();
    await settle();

    const reopened = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const stored = await reopened.loadCheckpoint(sessionId);
    const relaunched = setup(reopened);
    relaunched.controller.restoreFromCheckpoint(sessionId, stored!.snapshot, stored!.laps, {
      calibrationStatus: 'unknown',
      storedLapNumbers: [1, 2],
    });

    const restoredLapTwo = relaunched.snapshot().laps.find((lap) => lap.lapNumber === 2);
    expect(restoredLapTwo).toBeDefined();
    expect(restoredLapTwo!.durationMs).toBe(realLapTwo.durationMs);
    expect(restoredLapTwo!.invalidReasons).not.toContain('RECOVERY');
  });
});

describe('P11C -- the monotonic rule does not block a checkpoint that genuinely IS newer', () => {
  /**
   * The guard's opposite failure mode: refusing a legitimate advance. An
   * undisturbed three-lap session must still end with a checkpoint naming
   * all three -- this is what goes red if "supersedes" is ever tightened
   * into "never replace", on either the atomic or the fallback path.
   */
  it('an undisturbed session still advances its checkpoint to every lap (atomic path)', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const repository = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const { profile, controller, feed, settle } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 22_311));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    feed(
      driveLap(profile, {
        seed: 22_312,
        speedMps: 40,
        noiseSigmaM: 1,
        sampleRateHz: 1,
        lapCount: 3,
        tStartMono: 200_000,
      }),
    );
    await settle();

    const sessionId = controller.diagnostics().sessionId!;
    expect((await repository.loadCheckpoint(sessionId))!.laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 3]);
  });

  it('and so does one on the fallback path', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const inner = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    // Never fails: `shouldFail` is consumed here before any lap completes.
    const repository = new FirstLapCommitFailingRepository(inner, false);
    const { profile, controller, feed, settle } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 22_321));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    // Burn the single injected failure on a write that is not a lap commit,
    // so this session's lap commits all succeed.
    await repository.saveTelemetryBatch(controller.diagnostics().sessionId!, []).catch(() => undefined);

    feed(
      driveLap(profile, {
        seed: 22_322,
        speedMps: 40,
        noiseSigmaM: 1,
        sampleRateHz: 1,
        lapCount: 3,
        tStartMono: 200_000,
      }),
    );
    await settle();

    const sessionId = controller.diagnostics().sessionId!;
    expect((await inner.loadCheckpoint(sessionId))!.laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 3]);
  });
});

describe('P11C -- the generation column at the repository boundary', () => {
  /**
   * The same rule, exercised directly on `SqlSessionRepository` rather than
   * through a session: `saveLapCommit` writes its telemetry unconditionally
   * and its checkpoint only when it supersedes what is stored.
   */
  it('saveLapCommit writes telemetry always and the checkpoint only when it is newer', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const repository = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const sessionId = `${USER_ID}--generations`;
    const snapshot = { state: 'timing', lapNumber: 3, context: {} } as unknown as SessionMachineSnapshot;
    const lap = (lapNumber: number): LapRecord => ({
      lapNumber,
      tStart: lapNumber * 1_000,
      tEnd: lapNumber * 1_000 + 900,
      durationMs: 900,
      sectorTimes: [],
      valid: true,
      invalidReasons: [],
      quality: 'good',
    });
    const fix = (tMono: number): LocationSample => ({
      tMono,
      lat: 46.7,
      lon: 23.5,
      accuracyM: 3,
      source: 'replay' as const,
    });

    // Generation 2 lands (nothing stored yet).
    await repository.saveLapCommit(sessionId, [{ lapNumber: 2, samples: [fix(2_000)] }], {
      snapshot,
      laps: [lap(1), lap(2)],
    });
    expect((await repository.loadCheckpoint(sessionId))!.laps.map((l) => l.lapNumber)).toEqual([1, 2]);

    // Generation 1 -- an older retry. Telemetry lands; the checkpoint does not.
    await repository.saveLapCommit(sessionId, [{ lapNumber: 1, samples: [fix(1_000)] }], {
      snapshot,
      laps: [lap(1)],
    });
    expect(await repository.loadTelemetry(sessionId, 1)).toHaveLength(1);
    expect((await repository.loadCheckpoint(sessionId))!.laps.map((l) => l.lapNumber)).toEqual([1, 2]);

    // Generation 2 again -- equal, so still no rewrite, and still no loss.
    await repository.saveLapCommit(sessionId, [{ lapNumber: 2, samples: [fix(2_001), fix(2_002)] }], {
      snapshot,
      laps: [lap(1), lap(2)],
    });
    expect(await repository.loadTelemetry(sessionId, 2)).toHaveLength(2);
    expect((await repository.loadCheckpoint(sessionId))!.laps.map((l) => l.lapNumber)).toEqual([1, 2]);

    // Generation 3 -- genuinely newer, so it replaces.
    await repository.saveLapCommit(sessionId, [{ lapNumber: 3, samples: [fix(3_000)] }], {
      snapshot,
      laps: [lap(1), lap(2), lap(3)],
    });
    expect((await repository.loadCheckpoint(sessionId))!.laps.map((l) => l.lapNumber)).toEqual([1, 2, 3]);
  });

  /**
   * A database written by a build that predates the `lapCount` column (schema
   * v3): the ALTER must be applied on open, and both writers must work
   * afterwards. A legacy row's generation is unknown, so it is superseded --
   * and the plain `saveCheckpoint` every recording run makes at its start
   * fills the column in before any lap commit of that run can compare
   * against it.
   */
  it('a v3 database gains the generation column on open and enforces the rule afterwards', async () => {
    const rawDb = await createRawSqlJsDatabase();
    // The v3 shape, by hand: no `lapCount` column at all.
    rawDb.run('CREATE TABLE checkpoints (sessionId TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    const sessionId = `${USER_ID}--legacy-v3`;
    rawDb.run('INSERT INTO checkpoints (sessionId, payload) VALUES (?, ?)', [sessionId, '{"schemaVersion":1,"snapshot":{"state":"armed","lapNumber":0,"context":{}},"laps":[]}']);

    const repository = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    // The legacy row still reads back ...
    expect((await repository.loadCheckpoint(sessionId))!.laps).toHaveLength(0);
    // ... the column exists now ...
    const columns = rawDb.exec('PRAGMA table_info(checkpoints)')[0]!.values.map((row) => String(row[1]));
    expect(columns).toContain('lapCount');

    const snapshot = { state: 'timing', lapNumber: 2, context: {} } as unknown as SessionMachineSnapshot;
    const lap = (lapNumber: number): LapRecord => ({
      lapNumber,
      tStart: lapNumber * 1_000,
      tEnd: lapNumber * 1_000 + 900,
      durationMs: 900,
      sectorTimes: [],
      valid: true,
      invalidReasons: [],
      quality: 'good',
    });
    // ... and once a real checkpoint is written, the rule holds as usual.
    await repository.saveCheckpoint(sessionId, snapshot, [lap(1), lap(2)]);
    await repository.saveLapCommit(sessionId, [{ lapNumber: 1, samples: [] }], { snapshot, laps: [lap(1)] });
    expect((await repository.loadCheckpoint(sessionId))!.laps.map((l) => l.lapNumber)).toEqual([1, 2]);
  });
});

describe('P11C -- the in-memory reference repository enforces the same rule', () => {
  /**
   * `InMemorySessionRepository` is the semantic reference every other store
   * is measured against, so the monotonic rule has to hold there too -- with
   * the comparison in the same synchronous, un-awaited block as the write,
   * which is that store's equivalent of "inside the transaction".
   */
  it('an older saveLapCommit stores its telemetry and leaves the newer checkpoint alone', async () => {
    const repository = new InMemorySessionRepository();
    const sessionId = `${USER_ID}--in-memory`;
    const snapshot = { state: 'timing', lapNumber: 2, context: {} } as unknown as SessionMachineSnapshot;
    const lap = (lapNumber: number): LapRecord => ({
      lapNumber,
      tStart: lapNumber * 1_000,
      tEnd: lapNumber * 1_000 + 900,
      durationMs: 900,
      sectorTimes: [],
      valid: true,
      invalidReasons: [],
      quality: 'good',
    });
    const fix: LocationSample = { tMono: 1_000, lat: 46.7, lon: 23.5, accuracyM: 3, source: 'replay' };

    await repository.saveLapCommit(sessionId, [{ lapNumber: 2, samples: [fix] }], {
      snapshot,
      laps: [lap(1), lap(2)],
    });
    await repository.saveLapCommit(sessionId, [{ lapNumber: 1, samples: [fix] }], {
      snapshot,
      laps: [lap(1)],
    });

    expect(await repository.loadTelemetry(sessionId, 1)).toHaveLength(1);
    // WAS: [1] -- the older retry replaced the checkpoint wholesale.
    expect((await repository.loadCheckpoint(sessionId))!.laps.map((l) => l.lapNumber)).toEqual([1, 2]);

    // ... and a genuinely newer one still replaces it.
    await repository.saveLapCommit(sessionId, [{ lapNumber: 3, samples: [fix] }], {
      snapshot,
      laps: [lap(1), lap(2), lap(3)],
    });
    expect((await repository.loadCheckpoint(sessionId))!.laps.map((l) => l.lapNumber)).toEqual([1, 2, 3]);
  });
});
