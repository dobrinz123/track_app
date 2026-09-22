import { describe, expect, it } from 'vitest';

import type { LocalSessionRepository, LocationSample } from '../../src/contracts';
import { SessionController } from '../../src/controller';
import { cleanRecognitionLap, driveLap, multiLapSession } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

import { FakeClock, FakeLocationProvider, FakeWatchdogScheduler, tmr } from './testSupport';

/**
 * Ticket D2 (flow review F2/F3) -- THE LAPS A CRASHED SESSION DROVE MUST BE
 * ON ITS SESSION ROW, NOT ONLY IN ITS CHECKPOINT.
 *
 * Before this, the `sessions` row was written exactly twice: once at
 * recording start with `laps: []`, and once by `endSession()`. A session that
 * was interrupted between them -- a force-quit mid-lap, the whole reason the
 * recovery banner exists -- left every completed lap in the checkpoint alone.
 * "Discard" on that banner overwrites the checkpoint, and starting the next
 * session replaces the pointer the checkpoint hangs off, so either one turned
 * a four-lap outing into History's "0 laps · best —" with no warning.
 *
 * These tests drive the controller the way the app does and read the
 * repository the way History does.
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
    appVersion: 'd2-test',
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

  return { profile, controller, feed, repository };
}

describe('D2 -- a completed lap reaches the durable session row, not just the checkpoint', () => {
  it('the session row carries every completed lap WHILE the session is still running (no endSession())', async () => {
    const repository = new InMemorySessionRepository();
    const { profile, controller, feed } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 8_001));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    feed(multiLapSession(profile, 3, 8_002));
    await controller.flush();

    const sessionId = controller.diagnostics().sessionId!;
    const checkpoint = await repository.loadCheckpoint(sessionId);
    const lapsInCheckpoint = checkpoint?.laps.length ?? 0;
    expect(lapsInCheckpoint).toBeGreaterThan(0);

    // THE ASSERTION: the row History reads agrees with the checkpoint the
    // recovery banner counts. Before the fix this was 0.
    const sessions = await repository.listSessions(USER_ID, profile.circuitId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.laps).toHaveLength(lapsInCheckpoint);
    expect(sessions[0]!.laps.map((l) => l.lapNumber)).toEqual(
      checkpoint!.laps.map((l) => l.lapNumber),
    );

    // Still an unfinalised recording -- only endSession() may claim that.
    expect(sessions[0]!.trace?.recordingFinalized).toBe(false);
  });

  it('a lap whose commit FAILS is not published to the session row (the checkpoint stays the authority)', async () => {
    class RejectingRepository extends InMemorySessionRepository {
      rejectTelemetry = false;
      override async saveTelemetry(
        ...args: Parameters<InMemorySessionRepository['saveTelemetry']>
      ): Promise<void> {
        if (this.rejectTelemetry) throw new Error('saveTelemetry failed');
        await super.saveTelemetry(...args);
      }
      override async saveLapCommit(
        ...args: Parameters<InMemorySessionRepository['saveLapCommit']>
      ): Promise<void> {
        if (this.rejectTelemetry) throw new Error('saveLapCommit failed');
        await super.saveLapCommit(...args);
      }
    }
    const repository = new RejectingRepository();
    const { profile, controller, feed } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 9_001));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    repository.rejectTelemetry = true;
    feed(driveLap(profile, { seed: 9_002, speedMps: 40, noiseSigmaM: 1 }));
    feed(driveLap(profile, { seed: 9_003, speedMps: 40, noiseSigmaM: 1 }));
    await controller.flush().catch(() => undefined);

    const sessions = await repository.listSessions(USER_ID, profile.circuitId);
    expect(sessions).toHaveLength(1);
    // The write never landed, so the row must not claim the lap happened.
    expect(sessions[0]!.laps).toHaveLength(0);
  });

  it('endSession() still wins: the final row is finalised and no earlier write shortens it', async () => {
    const repository = new InMemorySessionRepository();
    const { profile, controller, feed } = setup(repository);

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 10_001));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    feed(multiLapSession(profile, 2, 10_002));
    await controller.flush();

    const midRun = (await repository.listSessions(USER_ID, profile.circuitId))[0]!;
    await controller.endSession();
    const final = (await repository.listSessions(USER_ID, profile.circuitId))[0]!;

    expect(final.laps.length).toBeGreaterThanOrEqual(midRun.laps.length);
    expect(final.trace?.recordingFinalized).toBe(true);
  });
});
