import { describe, expect, it } from 'vitest';

import type {
  LapRecord,
  LocalSessionRepository,
  LocationSample,
  SessionMachineSnapshot,
} from '../../src/contracts';
import { SessionController, type FacadeStateCore } from '../../src/controller';
import { cleanRecognitionLap, driveLap } from '../../src/fixtures';
import { SqlSessionRepository } from '../../src/persistence-sql';
import { createRawSqlJsDatabase, wrapSqlJsDatabase } from '../persistence-sql/sqlJsDatabase';

import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

/**
 * Ticket P12 item D (HIGH, Codex round 4, sessionController.ts:1540) -- THE
 * FALLBACK CHECKPOINT WATERMARK LEAKED BETWEEN SESSION IDS.
 *
 * REVIEWER REPRODUCTION, verbatim: complete two laps in session A on a
 * repository WITHOUT `saveLapCommit`; end A; restore an empty session B on the
 * SAME controller; start, arm, drive two laps. B gets real 92.662738 s and
 * 92.665024 s laps with 927 telemetry samples each, but its checkpoint stays
 * `[]` and a restart restores no completed laps -- because A's watermark of 2
 * suppressed B's checkpoint writes at the `generation > watermark` test.
 *
 * Nothing was lost: the fixes are in their chunk rows and the lap rows are on
 * disk. What was lost is the RECOVERY RECORD -- and on a track day a session
 * that restores as empty is, to the driver, a session that did not happen.
 */

const USER_ID = 'driver-1';

/**
 * The reviewer's repository: a real SQL store with `saveLapCommit` HIDDEN, so
 * every lap commit takes `writeLapCommit`'s checkpoint-first fallback path --
 * the only path the process-wide watermark ever gated.
 */
class NoLapCommitRepository implements LocalSessionRepository {
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
  saveTelemetry(sessionId: string, lapNumber: number, samples: LocationSample[]): Promise<void> {
    return this.delegate.saveTelemetry(sessionId, lapNumber, samples);
  }
  saveTelemetryBatch(
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
  ): Promise<void> {
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
    appVersion: 'p12d-test',
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

  return { profile, controller, feed, settle, snapshot };
}

describe('P12 item D -- the fallback checkpoint watermark is scoped to one session', () => {
  it('a second session on the SAME controller still writes its own checkpoints', async () => {
    const rawDb = await createRawSqlJsDatabase();
    const inner = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const repository = new NoLapCommitRepository(inner);
    // The premise: the controller must take the checkpoint-first fallback.
    expect((repository as LocalSessionRepository).saveLapCommit).toBeUndefined();

    const harness = setup(repository);
    const { profile, controller, feed, settle } = harness;

    // --- Session A: two real laps, ending with a watermark of 2. ------------
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
    await settle();
    const sessionA = controller.diagnostics().sessionId!;
    await controller.endSession();
    await settle();
    const checkpointA = await inner.loadCheckpoint(sessionA);
    expect(checkpointA!.laps.map((lap) => lap.lapNumber)).toEqual([1, 2]);

    // --- Session B: restored EMPTY on the same controller, then driven. -----
    const sessionB = `${USER_ID}--session-b`;
    await inner.saveCheckpoint(sessionB, { state: 'idle', lapNumber: 0, context: {} }, []);
    controller.restoreFromCheckpoint(
      sessionB,
      { state: 'idle', lapNumber: 0, context: {} },
      [],
      { calibrationStatus: 'unknown' },
    );
    await controller.start('session');
    await controller.flush();
    controller.arm();
    feed(
      driveLap(profile, {
        seed: 22_402,
        speedMps: 40,
        noiseSigmaM: 1,
        sampleRateHz: 10,
        lapCount: 2,
        tStartMono: 900_000,
      }),
    );
    await settle();

    // B really did drive two laps -- the reviewer measured 92.66 s each.
    const liveLaps = harness.snapshot().laps;
    expect(liveLaps).toHaveLength(2);
    for (const lap of liveLaps) expect(lap.durationMs).toBeGreaterThan(0);
    // ... and its telemetry is on disk, which was never the failure.
    expect((await inner.loadTelemetry(sessionB, 1)).length).toBeGreaterThan(900);
    expect((await inner.loadTelemetry(sessionB, 2)).length).toBeGreaterThan(900);

    // WAS: `[]` -- A's leftover watermark of 2 suppressed both of B's
    // checkpoint writes, so nothing on disk said B had completed a lap.
    const checkpointB = await inner.loadCheckpoint(sessionB);
    expect(checkpointB).not.toBeNull();
    expect(checkpointB!.laps.map((lap) => lap.lapNumber)).toEqual([1, 2]);

    // And the restart that reads it back sees two REAL laps, not none and not
    // a synthetic RECOVERY lap.
    const relaunched = setup(inner);
    relaunched.controller.restoreFromCheckpoint(sessionB, checkpointB!.snapshot, checkpointB!.laps, {
      calibrationStatus: 'unknown',
      storedLapNumbers: [1, 2],
    });
    // Laps 1 and 2 come back as the real laps they were. (The restore also
    // appends its usual synthetic in-flight RECOVERY lap, because the stored
    // snapshot was mid-session -- that is the documented `restoreFromCheckpoint`
    // behaviour and not what this test is about.)
    const restored = relaunched.snapshot().laps;
    for (const lapNumber of [1, 2]) {
      const lap = restored.find((entry) => entry.lapNumber === lapNumber);
      expect(lap, `lap ${String(lapNumber)} restored`).toBeDefined();
      expect(lap!.durationMs).toBeGreaterThan(0);
      expect(lap!.invalidReasons).not.toContain('RECOVERY');
    }
  });

  it("session A's checkpoint is untouched by session B's writes", async () => {
    const rawDb = await createRawSqlJsDatabase();
    const inner = await SqlSessionRepository.create(wrapSqlJsDatabase(rawDb));
    const repository = new NoLapCommitRepository(inner);
    const harness = setup(repository);
    const { profile, controller, feed, settle } = harness;

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
    await settle();
    const sessionA = controller.diagnostics().sessionId!;
    await controller.endSession();
    await settle();

    const sessionB = `${USER_ID}--session-b`;
    controller.restoreFromCheckpoint(
      sessionB,
      { state: 'idle', lapNumber: 0, context: {} },
      [],
      { calibrationStatus: 'unknown' },
    );
    await controller.start('session');
    await controller.flush();
    controller.arm();
    feed(
      driveLap(profile, {
        seed: 22_402,
        speedMps: 40,
        noiseSigmaM: 1,
        sampleRateHz: 10,
        lapCount: 1,
        tStartMono: 900_000,
      }),
    );
    await settle();

    // B's single lap must never be able to rewrite A's two-lap checkpoint --
    // scoping the watermark by session must not turn into cross-session
    // writes.
    const checkpointA = await inner.loadCheckpoint(sessionA);
    expect(checkpointA!.laps.map((lap) => lap.lapNumber)).toEqual([1, 2]);
  });
});
