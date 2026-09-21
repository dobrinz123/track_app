import { describe, expect, it } from 'vitest';

import type { LocalSessionRepository, LocationSample } from '../../src/contracts';
import { SessionController, type FacadeStateCore } from '../../src/controller';
import { cleanRecognitionLap, driveLap, multiLapSession } from '../../src/fixtures';
import { InMemorySessionRepository } from '../../src/persistence';

import {
  ControllableRepository,
  FakeClock,
  FakeLocationProvider,
  FakeWatchdogScheduler,
  tmr,
} from './testSupport';

/**
 * Ticket P7M M1 -- "the raw GNSS trace must reach storage regardless of
 * whether any lap is ever detected", and M2 -- "the driver must be able to
 * tell working from silently broken".
 *
 * Before M1, `saveTelemetry` had exactly ONE caller: `onLapCompleted`,
 * filtered to that lap's time range. A session with no detected crossing --
 * the realistic outcome of a first visit to a circuit whose start/finish gate
 * was traced from aerial imagery and never validated on site -- persisted
 * NOTHING of the drive, so a geometry problem cost the entire day's data
 * rather than one afternoon's lap times.
 */

function setup(existingRepository?: LocalSessionRepository) {
  const { profile, runtime } = tmr();
  const repository = existingRepository ?? new InMemorySessionRepository();
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
    appVersion: 'p7m-raw-trace-test',
    algorithmVersion: 1,
    restartProvider: () => undefined,
    config: { scheduler, watchdogTimeoutMs: 5_000, watchdogPollMs: 1_000 },
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

  /**
   * The controller's CURRENT state. `subscribe` calls back synchronously
   * with it, which is the documented way to read a snapshot -- needed for
   * the persisted-sample counter, which is deliberately not emitted on
   * (see `flushRawTrace`).
   */
  function snapshot(): FacadeStateCore {
    let current: FacadeStateCore | undefined;
    const unsubscribe = controller.subscribe((s) => {
      current = s;
    });
    unsubscribe();
    return current!;
  }

  /** Every sample the unclaimed-trace chunks still hold, in capture order. */
  async function readTrace(): Promise<LocationSample[]> {
    const sessionId = controller.diagnostics().sessionId;
    if (sessionId === null) return [];
    const out: LocationSample[] = [];
    for (const key of controller.rawTraceChunkKeys()) {
      out.push(...(await repository.loadTelemetry(sessionId, key)));
    }
    return out;
  }

  return { profile, repository, provider, clock, controller, states, feed, readTrace, snapshot };
}

const last = <T,>(items: readonly T[]): T => {
  const value = items[items.length - 1];
  if (value === undefined) throw new Error('expected at least one item');
  return value;
};

describe('P7M M1 -- direction A: a session that completes NO lap still comes home with its trace', () => {
  it('persists every fed sample even though nothing was ever timed', async () => {
    const { profile, controller, states, feed, readTrace } = setup();

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 4_001));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    // Two-thirds of a lap: the car crosses the line once (out lap -> timing)
    // and then the session ends with the lap still in progress. Nothing here
    // ever produced a completed `LapRecord`, so pre-P7M nothing at all would
    // have been written.
    const drive = driveLap(profile, { seed: 4_002 });
    const partial = drive.slice(0, Math.floor(drive.length * 0.66));
    feed(partial);

    await controller.endSession();

    expect(last(states).laps).toHaveLength(0);
    const trace = await readTrace();
    // Calibration lap + the partial drive: every sample the provider emitted.
    const fedCount = cleanRecognitionLap(profile, 4_001).length + partial.length;
    expect(trace).toHaveLength(fedCount);
    expect(trace.map((s) => s.tMono)).toEqual(
      [...cleanRecognitionLap(profile, 4_001), ...partial].map((s) => s.tMono),
    );
  });

  it('a Learn lap that never reaches its coverage threshold is still on disk -- the geometry can be rebuilt from it', async () => {
    const { profile, controller, feed, readTrace } = setup();

    await controller.start('calibration');
    // Never accepted, never armed: the whole drive happens in `calibrating`,
    // which is exactly what a wrong centerline produces on site.
    const learn = driveLap(profile, { seed: 4_003 }).slice(0, 40);
    feed(learn);
    await controller.flush();

    const trace = await readTrace();
    expect(trace).toHaveLength(learn.length);
  });

  it('the trace is already durable mid-drive -- a force-quit loses at most one flush interval', async () => {
    const { profile, controller, feed, readTrace } = setup();

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 4_004));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    const drive = driveLap(profile, { seed: 4_005 });
    feed(drive.slice(0, 80));
    // NO endSession(), NO flush() -- this is the app being killed.
    await controller.flush();

    const trace = await readTrace();
    const pending = controller.diagnostics().rawTracePendingCount;
    expect(trace.length).toBeGreaterThan(0);
    expect(pending).toBeLessThanOrEqual(25);
    // Everything except the still-unflushed tail is already on disk.
    expect(trace.length).toBe(cleanRecognitionLap(profile, 4_004).length + 80 - pending);
  });

  it('checkpointNow() -- the app-background hook -- flushes the tail too', async () => {
    const { profile, controller, feed, readTrace } = setup();

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 4_006));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    feed(driveLap(profile, { seed: 4_007 }).slice(0, 10));

    await controller.checkpointNow();
    expect(controller.diagnostics().rawTracePendingCount).toBe(0);
    expect((await readTrace()).length).toBe(cleanRecognitionLap(profile, 4_006).length + 10);
  });
});

describe('P7M M1 -- direction B: a normal multi-lap session stores exactly what it stored before', () => {
  it('each lap row holds precisely the samples in its own time range, with no duplication anywhere', async () => {
    const { profile, repository, controller, states, feed, readTrace } = setup();

    await controller.start('calibration');
    const calibration = cleanRecognitionLap(profile, 4_010);
    feed(calibration);
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    // The two fixtures each start their own `tMono` at 0; a real provider's
    // clock is monotonic across the whole session, so the driving fixture is
    // shifted past the calibration lap before it is fed. (Without this, the
    // two halves share timestamps and "is this sample stored twice" cannot be
    // asked by timestamp at all.)
    const tOffset = last(calibration).tMono + 1_000;
    const session = multiLapSession(profile, 3, 4_011).map((sample) => ({
      ...sample,
      tMono: sample.tMono + tOffset,
    }));
    feed(session);
    await controller.flush();
    await controller.endSession();

    const laps = last(states).laps;
    expect(laps.length).toBeGreaterThanOrEqual(2);

    const sessionId = controller.diagnostics().sessionId!;
    const fed = [...calibration, ...session];

    // 1. Lap rows are byte-for-byte what the pre-P7M single writer produced:
    //    the fed samples filtered to `tStart..tEnd`, nothing else.
    for (const lap of laps) {
      const stored = await repository.loadTelemetry(sessionId, lap.lapNumber);
      const expected = session.filter(
        (sample) => sample.tMono >= lap.tStart && sample.tMono <= lap.tEnd,
      );
      expect(stored.map((s) => s.tMono)).toEqual(expected.map((s) => s.tMono));
      expect(stored.length).toBeGreaterThan(0);
    }

    // 2. No sample is stored twice. The continuous flush and the per-lap row
    //    are not two writers of the same data: a lap claims its range out of
    //    the chunks the moment its own row is durable.
    const trace = await readTrace();
    const lapSampleTimes: number[] = [];
    for (const lap of laps) {
      const stored = await repository.loadTelemetry(sessionId, lap.lapNumber);
      lapSampleTimes.push(...stored.map((s) => s.tMono));
    }
    const allTimes = [...lapSampleTimes, ...trace.map((s) => s.tMono)];
    expect(new Set(allTimes).size).toBe(allTimes.length);

    // 3. And nothing is LOST either: lap rows plus unclaimed chunks account
    //    for every sample the provider ever emitted.
    expect(new Set(allTimes)).toEqual(new Set(fed.map((s) => s.tMono)));

    // 4. What survives in the chunks is exactly the out-lap / cool-down /
    //    calibration driving that belongs to no lap row -- which is the data
    //    that used to be thrown away even on a successful day.
    for (const sample of trace) {
      const insideSomeLap = laps.some(
        (lap) => sample.tMono >= lap.tStart && sample.tMono <= lap.tEnd,
      );
      expect(insideSomeLap).toBe(false);
    }
  });

  it('the session summary, checkpoint and PB are untouched by the trace writer', async () => {
    const { profile, repository, controller, states, feed } = setup();

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 4_020));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    feed(multiLapSession(profile, 3, 4_021));
    await controller.flush();
    await controller.endSession();

    const sessionId = controller.diagnostics().sessionId!;
    const sessions = await repository.listSessions('driver-1', profile.circuitId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe(sessionId);
    expect(sessions[0]?.laps).toEqual(last(states).laps);

    const checkpoint = await repository.loadCheckpoint(sessionId);
    expect(checkpoint?.laps).toEqual(last(states).laps);

    const pb = await repository.getReferenceLap(
      'driver-1',
      profile.circuitId,
      profile.layoutId,
      profile.layoutVersion,
    );
    expect(pb).not.toBeNull();
  });

  it('every trace chunk lives at a NEGATIVE lapNumber, so no reader that asks for a real lap can ever see one', async () => {
    const { profile, controller, feed } = setup();
    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 4_030));
    await controller.flush();

    const keys = controller.rawTraceChunkKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(key).toBeLessThan(0);
    // Lap 0 is the learned-circuit out-lap trace (composition.ts's adoption
    // flow) and must stay free too.
    expect(keys).not.toContain(0);
  });
});

describe('P7M M1 -- a failing trace write is reported, never fatal', () => {
  it('counts and logs the failure, and the session summary is still saved', async () => {
    const repository = new ControllableRepository(new InMemorySessionRepository());
    repository.saveTelemetryShouldReject = true;
    const warnings: string[] = [];
    const { profile, controller, feed } = setup(repository);

    // `console.warn` is the controller's default failure sink.
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      await controller.start('calibration');
      feed(cleanRecognitionLap(profile, 4_100));
      await controller.flush();
      // No lap ever completed, so the ONLY writes attempted are trace
      // flushes -- and `endSession` must still get the summary on disk.
      await controller.endSession();
    } finally {
      console.warn = originalWarn;
    }

    expect(controller.diagnostics().rawTraceWriteFailures).toBeGreaterThan(0);
    expect(warnings.some((line) => line.includes('raw-trace flush failed'))).toBe(true);
    const sessions = await repository.listSessions('driver-1', profile.circuitId);
    expect(sessions).toHaveLength(1);
  });
});

describe('P7M M1 -- a recovery resume does not overwrite the pre-crash trace', () => {
  it('a second run of the SAME session id writes into its own key band', async () => {
    const repository = new InMemorySessionRepository();

    // Launch 1: a drive that never completes a lap, then the app dies.
    const first = setup(repository);
    await first.controller.start('calibration');
    const learn = cleanRecognitionLap(first.profile, 4_090);
    first.feed(learn);
    await first.controller.flush();
    await first.controller.checkpointNow();
    const sessionId = first.controller.diagnostics().sessionId!;
    const firstKeys = first.controller.rawTraceChunkKeys();
    const firstTrace = await first.readTrace();
    expect(firstTrace.length).toBe(learn.length);

    // Launch 2: a brand-new controller resumes the SAME session id.
    const second = setup(repository);
    const checkpoint = await repository.loadCheckpoint(sessionId);
    second.controller.restoreFromCheckpoint(sessionId, checkpoint!.snapshot, checkpoint!.laps, {
      calibrationStatus: 'unknown',
    });
    await second.controller.start('session');
    second.controller.arm();
    second.feed(driveLap(second.profile, { seed: 4_091 }).slice(0, 30));
    await second.controller.flush();

    const secondKeys = second.controller.rawTraceChunkKeys();
    expect(secondKeys.length).toBeGreaterThan(0);
    for (const key of secondKeys) expect(firstKeys).not.toContain(key);

    // Launch 1's trace is still exactly where it was left.
    const stillThere: LocationSample[] = [];
    for (const key of firstKeys) stillThere.push(...(await repository.loadTelemetry(sessionId, key)));
    expect(stillThere.map((s) => s.tMono)).toEqual(firstTrace.map((s) => s.tMono));
  });
});

describe('P7M M6 -- the driver can see, from the car, that the drive is being kept', () => {
  it('the persisted count tracks CONFIRMED writes and never gets ahead of storage', async () => {
    const { profile, controller, feed, readTrace, snapshot } = setup();

    await controller.start('calibration');
    expect(snapshot().recording).toEqual({
      persistedSampleCount: 0,
      failedWriteCount: 0,
      // Ticket P10A H3: nothing captured yet, so nothing unwritten.
      unwrittenSampleCount: 0,
    });

    const learn = cleanRecognitionLap(profile, 4_110);
    feed(learn);
    await controller.flush();

    // Exactly what is on disk -- not what passed through memory.
    const stored = (await readTrace()).length;
    expect(snapshot().recording.persistedSampleCount).toBe(stored);
    expect(snapshot().recording.persistedSampleCount).toBeGreaterThan(0);
    expect(snapshot().recording.failedWriteCount).toBe(0);
  });

  it('it only ever grows -- a lap claiming samples out of the chunks re-keys rows, it does not un-store them', async () => {
    const { profile, controller, feed, snapshot } = setup();

    await controller.start('calibration');
    const calibration = cleanRecognitionLap(profile, 4_120);
    feed(calibration);
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    const observed: number[] = [];
    controller.subscribe((s) => observed.push(s.recording.persistedSampleCount));

    const tOffset = last(calibration).tMono + 1_000;
    feed(
      multiLapSession(profile, 3, 4_121).map((sample) => ({ ...sample, tMono: sample.tMono + tOffset })),
    );
    await controller.flush();
    await controller.endSession();

    for (let i = 1; i < observed.length; i += 1) {
      expect(observed[i]!).toBeGreaterThanOrEqual(observed[i - 1]!);
    }
    expect(snapshot().recording.persistedSampleCount).toBeGreaterThan(0);
  });

  it('every sample the provider emitted is accounted for on disk by the end of the session', async () => {
    const { profile, repository, controller, states, feed, readTrace, snapshot } = setup();

    await controller.start('calibration');
    const calibration = cleanRecognitionLap(profile, 4_130);
    feed(calibration);
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    const tOffset = last(calibration).tMono + 1_000;
    const session = multiLapSession(profile, 3, 4_131).map((sample) => ({
      ...sample,
      tMono: sample.tMono + tOffset,
    }));
    feed(session);
    await controller.flush();
    await controller.endSession();

    const sessionId = controller.diagnostics().sessionId!;
    let onDisk = (await readTrace()).length;
    for (const lap of last(states).laps) {
      onDisk += (await repository.loadTelemetry(sessionId, lap.lapNumber)).length;
    }
    expect(snapshot().recording.persistedSampleCount).toBe(onDisk);
    expect(onDisk).toBe(calibration.length + session.length);
  });

  it('a storage that refuses writes FREEZES the counter and raises the failure flag -- it never reports progress that did not happen', async () => {
    const repository = new ControllableRepository(new InMemorySessionRepository());
    const { profile, controller, feed, snapshot } = setup(repository);
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      await controller.start('calibration');
      feed(cleanRecognitionLap(profile, 4_140).slice(0, 30));
      await controller.flush();
      const healthy = snapshot().recording.persistedSampleCount;
      expect(healthy).toBeGreaterThan(0);
      expect(snapshot().recording.failedWriteCount).toBe(0);

      // Storage starts refusing mid-session.
      repository.saveTelemetryShouldReject = true;
      feed(driveLap(profile, { seed: 4_141 }).slice(0, 30));
      await controller.flush();

      expect(snapshot().recording.persistedSampleCount).toBe(healthy); // frozen, not advanced.
      expect(snapshot().recording.failedWriteCount).toBeGreaterThan(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe('P7M M2 -- the driving screen can tell "working" from "silently broken"', () => {
  it('starts unknown, reports matched while the car is on the circuit', async () => {
    const { profile, controller, states, feed } = setup();
    expect(last(states).trackMatch.state).toBe('unknown');

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 4_040));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    feed(driveLap(profile, { seed: 4_041 }).slice(0, 30));

    expect(last(states).trackMatch.state).toBe('matched');
    expect(last(states).trackMatch.lateralM).not.toBeNull();
    expect(last(states).trackMatch.lateralM!).toBeLessThan(profile.corridorWidthM);
  });

  it('a car well off the traced centerline reports offTrack -- the case a "good" GNSS pill cannot express', async () => {
    const { profile, controller, states, feed } = setup();

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 4_050));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    const drive = driveLap(profile, { seed: 4_051 });
    // ~0.003 degrees of latitude is ~330 m -- far outside any corridor, with
    // fix quality left completely untouched. This is the misplaced-geometry
    // shape of failure: a perfect sky, and nothing being timed.
    const offset = drive.slice(0, 40).map((sample) => ({ ...sample, lat: sample.lat + 0.003 }));
    feed(offset);

    expect(last(states).trackMatch.state).toBe('offTrack');
    // The quality metric still says the fixes themselves are fine, which is
    // precisely why this state had to exist.
    expect(last(states).gnssQuality).not.toBe('invalid');
  });

  it('one bad fix does NOT flash the warning -- it takes a sustained 3 s of no match', async () => {
    const { profile, controller, states, feed } = setup();

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 4_060));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    const drive = driveLap(profile, { seed: 4_061 });
    feed(drive.slice(0, 20));
    expect(last(states).trackMatch.state).toBe('matched');

    // A single displaced fix, then straight back on line.
    feed([{ ...drive[20]!, lat: drive[20]!.lat + 0.003 }]);
    expect(last(states).trackMatch.state).toBe('matched');

    feed(drive.slice(21, 25));
    expect(last(states).trackMatch.state).toBe('matched');
  });

  it('recovers to matched as soon as the car is back on the circuit', async () => {
    const { profile, controller, states, feed } = setup();

    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 4_070));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();

    const drive = driveLap(profile, { seed: 4_071 });
    feed(drive.slice(0, 30).map((sample) => ({ ...sample, lat: sample.lat + 0.003 })));
    expect(last(states).trackMatch.state).toBe('offTrack');

    feed(drive.slice(30, 40));
    expect(last(states).trackMatch.state).toBe('matched');
  });

  it('an ended session makes no claim about where the car is', async () => {
    const { profile, controller, states, feed } = setup();
    await controller.start('calibration');
    feed(cleanRecognitionLap(profile, 4_080));
    controller.acceptCalibration();
    await controller.flush();
    controller.arm();
    feed(driveLap(profile, { seed: 4_081 }).slice(0, 20));
    await controller.endSession();

    expect(last(states).trackMatch).toEqual({ state: 'unknown', lateralM: null, confidence: null });
  });
});
