import { readFileSync } from 'node:fs';

import type { Database } from 'sql.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type {
  CircuitProfile,
  LapRecord,
  LocalSessionRepository,
  LocationProvider,
  LocationSample,
  MonotonicClock,
  ReferenceLap,
  SessionMachineSnapshot,
  SessionSummary,
} from '../../src/contracts';
import {
  SessionController,
  type FacadeStateCore,
  type WatchdogScheduler,
} from '../../src/controller';
import { cleanRecognitionLap, driveLap, pitLaneTransitLap, SeededPrng } from '../../src/fixtures';
import { SqlSessionRepository, type SqlDatabase } from '../../src/persistence-sql';
import { loadProfileFromJson, type RuntimeProfile } from '../../src/profile';
import { runSessionPipeline } from '../../src/replay';
import {
  createRawSqlJsDatabase,
  wrapExistingSqlJsDatabase,
} from '../persistence-sql/sqlJsDatabase';

interface TmrV2 {
  profile: CircuitProfile;
  runtime: RuntimeProfile;
}

export function tmrV2(): TmrV2 {
  const json = readFileSync(
    new URL('../../assets/circuits/transilvania-motor-ring.v2.json', import.meta.url),
    'utf8',
  );
  const loaded = loadProfileFromJson(json);
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

export function last<T>(items: readonly T[]): T {
  const value = items[items.length - 1];
  if (value === undefined) throw new Error('expected at least one item');
  return value;
}

class SoakClock implements MonotonicClock {
  constructor(private value = 1_000_000) {}

  now(): number {
    return this.value;
  }

  advance(ms: number): void {
    this.value += ms;
  }
}

class SoakLocationProvider implements LocationProvider {
  private readonly listeners = new Set<(sample: LocationSample) => void>();
  startCount = 0;
  stopCount = 0;

  async start(): Promise<void> {
    this.startCount += 1;
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
  }

  subscribe(cb: (sample: LocationSample) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  push(sample: LocationSample): void {
    for (const listener of this.listeners) listener(sample);
  }
}

class InspectableScheduler implements WatchdogScheduler {
  private readonly handles = new Map<number, () => void>();
  private nextHandle = 1;
  setCount = 0;

  get activeCount(): number {
    return this.handles.size;
  }

  setInterval(fn: () => void, _ms: number): unknown {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.setCount += 1;
    this.handles.set(handle, fn);
    return handle;
  }

  clearInterval(handle: unknown): void {
    this.handles.delete(handle as number);
  }

  tick(): void {
    for (const fn of [...this.handles.values()]) fn();
  }
}

class RecordingRepository implements LocalSessionRepository {
  readonly checkpointLapCounts: number[] = [];
  readonly pbDurations: number[] = [];

  constructor(readonly delegate: LocalSessionRepository) {}

  async saveCheckpoint(
    sessionId: string,
    snapshot: SessionMachineSnapshot,
    laps: LapRecord[],
  ): Promise<void> {
    this.checkpointLapCounts.push(laps.length);
    await this.delegate.saveCheckpoint(sessionId, snapshot, laps);
  }

  loadCheckpoint(
    sessionId: string,
  ): Promise<{ snapshot: SessionMachineSnapshot; laps: LapRecord[] } | null> {
    return this.delegate.loadCheckpoint(sessionId);
  }

  saveSession(summary: SessionSummary): Promise<void> {
    return this.delegate.saveSession(summary);
  }

  listSessions(userId: string, circuitId: string): Promise<SessionSummary[]> {
    return this.delegate.listSessions(userId, circuitId);
  }

  saveTelemetry(sessionId: string, lapNumber: number, samples: LocationSample[]): Promise<void> {
    return this.delegate.saveTelemetry(sessionId, lapNumber, samples);
  }

  loadTelemetry(sessionId: string, lapNumber: number): Promise<LocationSample[]> {
    return this.delegate.loadTelemetry(sessionId, lapNumber);
  }

  getReferenceLap(
    userId: string,
    circuitId: string,
    layoutId: string,
    layoutVersion: number,
  ): Promise<ReferenceLap | null> {
    return this.delegate.getReferenceLap(userId, circuitId, layoutId, layoutVersion);
  }

  async putReferenceLap(reference: ReferenceLap): Promise<void> {
    await this.delegate.putReferenceLap(reference);
    this.pbDurations.push(reference.durationMs);
  }

  deleteUserData(userId: string): Promise<void> {
    return this.delegate.deleteUserData(userId);
  }
}

const EMPTY_ARMED_SNAPSHOT: SessionMachineSnapshot = {
  state: 'armed',
  lapNumber: 0,
  context: {
    lapNumber: 0,
    priorState: null,
    pendingInvalidReasons: [],
    gnssDegraded: false,
    preflightFailureReasons: [],
  },
};

interface ControllerRig {
  controller: SessionController;
  provider: SoakLocationProvider;
  clock: SoakClock;
  scheduler: InspectableScheduler;
  states: FacadeStateCore[];
  restartCalls: number[];
  feed(samples: readonly LocationSample[]): void;
  feedOne(sample: LocationSample): FacadeStateCore;
}

export function controllerRig(
  tmr: TmrV2,
  repository: LocalSessionRepository,
  sessionId: string | null,
  config: { watchdogTimeoutMs?: number } = {},
): ControllerRig {
  const provider = new SoakLocationProvider();
  const clock = new SoakClock();
  const scheduler = new InspectableScheduler();
  const restartCalls: number[] = [];
  const controller = new SessionController({
    runtimeProfile: tmr.runtime,
    circuitProfile: tmr.profile,
    locationProvider: provider,
    clock,
    repository,
    userId: 'soak-driver',
    appVersion: 'track-day-soak',
    algorithmVersion: 2,
    restartProvider: () => {
      restartCalls.push(clock.now());
    },
    config: {
      scheduler,
      watchdogTimeoutMs: config.watchdogTimeoutMs ?? 5_000,
      watchdogPollMs: 1_000,
    },
  });
  if (sessionId !== null) {
    controller.restoreFromCheckpoint(sessionId, EMPTY_ARMED_SNAPSHOT, []);
  }
  const states: FacadeStateCore[] = [];
  controller.subscribe((state) => states.push(state));
  let previousSampleMono: number | null = null;

  const feedOne = (sample: LocationSample): FacadeStateCore => {
    const elapsed =
      previousSampleMono === null ? 0 : Math.max(0, sample.tMono - previousSampleMono);
    previousSampleMono = sample.tMono;
    clock.advance(elapsed);
    provider.push(sample);
    return last(states);
  };

  return {
    controller,
    provider,
    clock,
    scheduler,
    states,
    restartCalls,
    feed(samples): void {
      for (const sample of samples) feedOne(sample);
    },
    feedOne,
  };
}

export class SampleTimeline {
  private nextTMono = 0;

  append(samples: readonly LocationSample[], gapBeforeMs = 0): LocationSample[] {
    const first = samples[0];
    if (first === undefined) return [];
    const base = first.tMono;
    const start = this.nextTMono + gapBeforeMs;
    const rebased = samples.map((sample) => ({ ...sample, tMono: start + sample.tMono - base }));
    this.nextTMono = (last(rebased).tMono ?? start) + 1_000;
    return rebased;
  }
}

export function oneHzPitLap(profile: CircuitProfile, seed: number): LocationSample[] {
  return pitLaneTransitLap(profile, seed).map((sample, index) => ({
    ...sample,
    tMono: index * 1_000,
  }));
}

function assertPbChainMonotone(durations: readonly number[]): void {
  expect(durations.length).toBeGreaterThan(0);
  for (let index = 1; index < durations.length; index += 1) {
    expect(durations[index]).toBeLessThan(durations[index - 1]!);
  }
}

function internalBufferSizes(controller: SessionController): {
  matches: number;
  stateHistory: number;
} {
  const inspected = controller as unknown as {
    core: { matches: unknown[]; stateHistory: unknown[] };
  };
  return {
    matches: inspected.core.matches.length,
    stateHistory: inspected.core.stateHistory.length,
  };
}

async function sqlRepository(): Promise<{
  raw: Database;
  db: SqlDatabase;
  recording: RecordingRepository;
}> {
  const raw = await createRawSqlJsDatabase();
  const db = wrapExistingSqlJsDatabase(raw);
  const repository = await SqlSessionRepository.create(db);
  return { raw, db, recording: new RecordingRepository(repository) };
}

function countRows(raw: Database, table: string): number {
  const result = raw.exec(`SELECT COUNT(*) AS count FROM ${table}`)[0];
  return Number(result?.values[0]?.[0] ?? 0);
}

function shiftLocal(
  runtime: RuntimeProfile,
  sample: LocationSample,
  deltaE: number,
  deltaN: number,
): LocationSample {
  const local = runtime.projection.toLocal(sample);
  return {
    ...sample,
    ...runtime.projection.toLatLon({ e: local.e + deltaE, n: local.n + deltaN }),
  };
}

interface TrackDayArtifact {
  raw: Database;
  repository: RecordingRepository;
  sessionId: string;
  byteSize: number;
}

let trackDayArtifact: TrackDayArtifact | undefined;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-08-08T08:00:00.000Z'));
});

afterAll(() => {
  vi.useRealTimers();
});

describe.sequential('TMR v2 production track-day soak', () => {
  it('1. survives a 90-minute, 1 Hz mixed track-day session with bounded live memory and durable laps', async () => {
    const tmr = tmrV2();
    const sql = await sqlRepository();
    const sessionId = 'soak-driver--track-day-90m';
    const rig = controllerRig(tmr, sql.recording, sessionId);
    const timeline = new SampleTimeline();

    await rig.controller.start('calibration');
    rig.feed(timeline.append(cleanRecognitionLap(tmr.profile, 10_001)));
    expect(last(rig.states).sessionState).toBe('calibrationReview');
    expect(last(rig.states).calibrationResult?.accepted).toBe(true);
    rig.controller.acceptCalibration();
    await rig.controller.flush();
    rig.controller.arm();

    const targetSamples = 5_400;
    const trackSamples: LocationSample[] = [];
    let expectedLaps = 0;
    let seed = 20_000;
    let cleanLapCount = 0;
    const lapFactories: Array<() => LocationSample[]> = [
      () =>
        driveLap(tmr.profile, {
          seed: seed++,
          speedMps: Math.min(48, 34 + cleanLapCount++),
          noiseSigmaM: 1,
        }),
      () => driveLap(tmr.profile, { seed: seed++, speedMps: 36, noiseSigmaM: 4 }),
      () => driveLap(tmr.profile, { seed: seed++, speedMps: 18, noiseSigmaM: 1 }),
      () => oneHzPitLap(tmr.profile, seed++),
    ];
    let factoryIndex = 0;
    while (true) {
      const segment = timeline.append(lapFactories[factoryIndex % lapFactories.length]!());
      if (trackSamples.length + segment.length > targetSamples) break;
      trackSamples.push(...segment);
      expectedLaps += 1;
      factoryIndex += 1;
    }
    const held = last(trackSamples);
    while (trackSamples.length < targetSamples) {
      trackSamples.push({
        ...held,
        tMono: last(trackSamples).tMono + 1_000,
        speedMps: 0,
      });
    }
    const trackStartMono = trackSamples[0]!.tMono;
    for (let index = 0; index < trackSamples.length; index += 1) {
      trackSamples[index] = { ...trackSamples[index]!, tMono: trackStartMono + index * 1_000 };
    }

    expect(trackSamples).toHaveLength(5_400);
    expect(last(trackSamples).tMono - trackSamples[0]!.tMono).toBe(5_399_000);
    expect(() => rig.feed(trackSamples)).not.toThrow();
    await rig.controller.flush();

    const state = last(rig.states);
    const diagnostics = rig.controller.diagnostics();
    expect(expectedLaps).toBeGreaterThanOrEqual(20);
    expect(state.laps, JSON.stringify(state.laps)).toHaveLength(expectedLaps);
    expect(new Set(state.laps.map((lap) => lap.lapNumber)).size).toBe(expectedLaps);
    expect(sql.recording.checkpointLapCounts).toEqual(
      Array.from({ length: expectedLaps }, (_, index) => index + 1),
    );
    const checkpoint = await sql.recording.loadCheckpoint(sessionId);
    expect(checkpoint?.laps).toHaveLength(expectedLaps);

    for (const lap of state.laps.filter((candidate) => candidate.valid)) {
      const telemetry = await sql.recording.loadTelemetry(sessionId, lap.lapNumber);
      expect(telemetry.length).toBeGreaterThan(0);
      expect(
        telemetry.every((sample) => sample.tMono >= lap.tStart && sample.tMono <= lap.tEnd),
      ).toBe(true);
    }
    assertPbChainMonotone(sql.recording.pbDurations);
    const finalReference = await sql.recording.getReferenceLap(
      'soak-driver',
      tmr.profile.circuitId,
      tmr.profile.layoutId,
      tmr.profile.layoutVersion,
    );
    expect(finalReference?.durationMs).toBe(
      Math.min(...state.laps.filter((lap) => lap.valid).map((lap) => lap.durationMs)),
    );
    const tailSamples = trackSamples.filter(
      (sample) => sample.tMono > last(state.laps).tEnd,
    ).length;
    expect(diagnostics.rawSampleBufferSize).toBe(tailSamples);
    const internals = internalBufferSizes(rig.controller);
    expect(internals.matches).toBeLessThanOrEqual(2_000);
    expect(internals.stateHistory).toBeLessThanOrEqual(200);

    await rig.controller.endSession();
    const history = await sql.recording.listSessions('soak-driver', tmr.profile.circuitId);
    expect(history).toHaveLength(1);
    expect(history[0]?.laps).toHaveLength(expectedLaps);
    const byteSize = sql.raw.export().byteLength;
    trackDayArtifact = { raw: sql.raw, repository: sql.recording, sessionId, byteSize };
  });

  it('2. carries PB and reference deltas across three controllers on one sql.js database', async () => {
    const tmr = tmrV2();
    const sql = await sqlRepository();
    const speeds = [36, 44, 32];
    const pbAtSessionStart: Array<number | null> = [];
    const pbAtSessionEnd: number[] = [];
    const deltaSeen: boolean[] = [];

    for (let sessionIndex = 0; sessionIndex < 3; sessionIndex += 1) {
      const rig = controllerRig(tmr, sql.recording, `soak-driver--multi-${sessionIndex + 1}`);
      await rig.controller.start('session');
      pbAtSessionStart.push(last(rig.states).pbMs);
      rig.controller.arm();
      const timeline = new SampleTimeline();
      rig.feed(
        timeline.append(
          driveLap(tmr.profile, {
            seed: 30_000 + sessionIndex,
            lapCount: 2,
            speedMps: speeds[sessionIndex]!,
            noiseSigmaM: 1,
          }),
        ),
      );
      await rig.controller.flush();
      deltaSeen.push(
        rig.states.some((state) => state.delta !== null && state.delta.confidence > 0),
      );
      const reference = await sql.recording.getReferenceLap(
        'soak-driver',
        tmr.profile.circuitId,
        tmr.profile.layoutId,
        tmr.profile.layoutVersion,
      );
      expect(reference).not.toBeNull();
      pbAtSessionEnd.push(reference!.durationMs);
      await rig.controller.endSession();
      const history = await sql.recording.listSessions('soak-driver', tmr.profile.circuitId);
      expect(history).toHaveLength(sessionIndex + 1);
    }

    expect(pbAtSessionStart[0]).toBeNull();
    expect(pbAtSessionStart[1]).toBe(pbAtSessionEnd[0]);
    expect(pbAtSessionStart[2]).toBe(pbAtSessionEnd[1]);
    expect(pbAtSessionEnd[1]).toBeLessThan(pbAtSessionEnd[0]!);
    expect(pbAtSessionEnd[2]).toBe(pbAtSessionEnd[1]);
    expect(deltaSeen[1]).toBe(true);
    expect(deltaSeen[2]).toBe(true);
  });

  it('3. restores a mid-lap checkpoint without mixing monotonic-clock epochs or lap numbers', async () => {
    const tmr = tmrV2();
    const sql = await sqlRepository();
    const sessionId = 'soak-driver--recovery';
    const first = controllerRig(tmr, sql.recording, sessionId);
    const firstTimeline = new SampleTimeline();

    await first.controller.start('session');
    first.controller.arm();
    first.feed(
      firstTimeline.append(
        driveLap(tmr.profile, { seed: 40_001, lapCount: 3, speedMps: 40, noiseSigmaM: 1 }),
      ),
    );
    const partial = driveLap(tmr.profile, { seed: 40_002, speedMps: 40, noiseSigmaM: 1 });
    first.feed(firstTimeline.append(partial.slice(0, Math.floor(partial.length / 2))));
    await first.controller.flush();
    expect(last(first.states).laps).toHaveLength(3);
    expect(last(first.states).sessionState).toBe('timing');
    await first.controller.checkpointNow();

    const stored = await sql.recording.loadCheckpoint(sessionId);
    expect(stored).not.toBeNull();
    const pbBefore = await sql.recording.getReferenceLap(
      'soak-driver',
      tmr.profile.circuitId,
      tmr.profile.layoutId,
      tmr.profile.layoutVersion,
    );
    expect(pbBefore).not.toBeNull();

    const recovered = controllerRig(tmr, sql.recording, null);
    recovered.controller.restoreFromCheckpoint(sessionId, stored!.snapshot, stored!.laps);
    const recoveryLap = last(last(recovered.states).laps);
    expect(recoveryLap.valid).toBe(false);
    expect(recoveryLap.invalidReasons).toContain('RECOVERY');
    await recovered.controller.start('session');
    expect(last(recovered.states).pbMs).toBe(pbBefore!.durationMs);
    recovered.controller.arm();
    recovered.feed(
      new SampleTimeline().append(
        driveLap(tmr.profile, { seed: 40_003, lapCount: 2, speedMps: 30, noiseSigmaM: 1 }),
      ),
    );
    await recovered.controller.flush();

    const laps = last(recovered.states).laps;
    expect(laps.map((lap) => lap.lapNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(laps[3]?.invalidReasons).toContain('RECOVERY');
    for (const lap of laps.filter((candidate) => !candidate.invalidReasons.includes('RECOVERY'))) {
      expect(lap.durationMs).toBeGreaterThan(0);
      expect(lap.durationMs).toBeLessThan(10 * 60_000);
      expect(lap.tEnd).toBeGreaterThan(lap.tStart);
    }
    const pbAfter = await sql.recording.getReferenceLap(
      'soak-driver',
      tmr.profile.circuitId,
      tmr.profile.layoutId,
      tmr.profile.layoutVersion,
    );
    expect(pbAfter?.durationMs).toBe(pbBefore!.durationMs);
  });

  it('4. resists a seeded 30-lap GNSS-chaos storm without timing corruption', () => {
    const tmr = tmrV2();
    const prng = new SeededPrng(50_001);
    const timeline = new SampleTimeline();
    const samples: LocationSample[] = [];

    for (let lapIndex = 0; lapIndex < 30; lapIndex += 1) {
      let lap = driveLap(tmr.profile, {
        seed: 51_000 + lapIndex,
        speedMps: 40,
        noiseSigmaM: 0.5,
      }).map((sample) => ({ ...sample }));
      const adversity = Math.floor(prng.next() * 5);
      const middle = Math.floor(lap.length * (0.3 + prng.next() * 0.4));
      if (adversity === 0) {
        lap = lap.map((sample, index) =>
          Math.abs(index - middle) <= 4
            ? shiftLocal(tmr.runtime, sample, prng.gaussian() * 10, prng.gaussian() * 10)
            : sample,
        );
      } else if (adversity === 1) {
        const gapMs = 5_000 + Math.floor(prng.next() * 3_001);
        lap = lap.map((sample, index) => ({
          ...sample,
          tMono: sample.tMono + (index >= middle ? gapMs : 0),
        }));
      } else if (adversity === 2) {
        const sample = lap[middle];
        if (sample !== undefined) lap[middle] = shiftLocal(tmr.runtime, sample, 500, 0);
      } else if (adversity === 3) {
        lap = lap.map((sample, index) =>
          Math.abs(index - middle) <= 3 ? shiftLocal(tmr.runtime, sample, 30, 0) : sample,
        );
      } else {
        lap = lap.map((sample, index) =>
          Math.abs(index - middle) <= 4 ? { ...sample, accuracyM: 35 } : sample,
        );
      }
      samples.push(...timeline.append(lap));
    }

    const result = runSessionPipeline(tmr.runtime, samples, {
      corridorWidthM: tmr.profile.corridorWidthM,
    });
    expect(result.laps, JSON.stringify(result.laps)).toHaveLength(30);
    expect(new Set(result.laps.map((lap) => lap.lapNumber)).size).toBe(30);
    for (const lap of result.laps) {
      expect(lap.durationMs).toBeGreaterThan(0);
      if (!lap.valid) expect(lap.invalidReasons.length).toBeGreaterThan(0);
      if (lap.valid) {
        const sectorSum = lap.sectorTimes.reduce((sum, sector) => sum + sector.durationMs, 0);
        expect(sectorSum).toBeCloseTo(lap.durationMs, 6);
      }
    }
  });

  it('5. restarts the provider exactly once per repeated watchdog gap and keeps timing 10 laps', async () => {
    const tmr = tmrV2();
    const sql = await sqlRepository();
    const rig = controllerRig(tmr, sql.recording, 'soak-driver--watchdog', {
      watchdogTimeoutMs: 5_000,
    });
    await rig.controller.start('session');
    rig.controller.arm();
    const samples = new SampleTimeline().append(
      driveLap(tmr.profile, { seed: 60_001, lapCount: 10, speedMps: 40, noiseSigmaM: 1 }),
    );
    const prng = new SeededPrng(60_002);
    const triggerIndices = new Set<number>();
    const partitionSize = Math.floor(samples.length / 10);
    for (let partition = 0; partition < 10; partition += 1) {
      triggerIndices.add(
        partition * partitionSize + Math.floor(partitionSize * (0.25 + prng.next() * 0.5)),
      );
    }

    let expectedRestarts = 0;
    for (let index = 0; index < samples.length; index += 1) {
      if (triggerIndices.has(index)) {
        rig.clock.advance(5_001 + Math.floor(prng.next() * 2_000));
        rig.scheduler.tick();
        expectedRestarts += 1;
        expect(rig.restartCalls).toHaveLength(expectedRestarts);
        rig.clock.advance(100);
        rig.scheduler.tick();
        expect(rig.restartCalls).toHaveLength(expectedRestarts);
      }
      rig.feedOne(samples[index]!);
    }
    await rig.controller.flush();

    expect(expectedRestarts).toBe(10);
    expect(rig.controller.diagnostics().watchRestarts).toBe(10);
    expect(last(rig.states).laps).toHaveLength(10);
    expect(rig.scheduler.activeCount).toBe(1);
    expect(rig.scheduler.setCount).toBe(1);
    await rig.controller.endSession();
    expect(rig.scheduler.activeCount).toBe(0);
  });

  it('6. remains healthy through 10 calibrate-reject cycles and an accepted eleventh attempt', async () => {
    const tmr = tmrV2();
    const sql = await sqlRepository();
    const rig = controllerRig(tmr, sql.recording, 'soak-driver--calibration-marathon');
    const timeline = new SampleTimeline();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await rig.controller.start('calibration');
      expect(last(rig.states).calibration?.coverageFraction).toBe(0);
      expect(rig.scheduler.activeCount).toBe(1);
      rig.feed(timeline.append(cleanRecognitionLap(tmr.profile, 70_000 + attempt)));
      const review = last(rig.states);
      expect(review.sessionState).toBe('calibrationReview');
      expect(review.calibrationResult?.accepted).toBe(true);
      expect(review.calibrationResult!.diagnostics.coverageFraction).toBeGreaterThanOrEqual(0.95);
      expect(review.calibrationResult!.diagnostics.samplesAccepted).toBeLessThan(150);
      rig.controller.rejectCalibration();
      expect(last(rig.states).sessionState).toBe('awaitingCalibration');
    }

    await rig.controller.start('calibration');
    expect(last(rig.states).calibration?.coverageFraction).toBe(0);
    rig.feed(timeline.append(cleanRecognitionLap(tmr.profile, 70_100)));
    expect(last(rig.states).calibrationResult?.accepted).toBe(true);
    rig.controller.acceptCalibration();
    await rig.controller.flush();
    rig.controller.arm();
    rig.feed(
      timeline.append(driveLap(tmr.profile, { seed: 70_101, speedMps: 40, noiseSigmaM: 1 })),
    );
    await rig.controller.flush();
    expect(last(rig.states).laps).toHaveLength(1);
    expect(last(rig.states).laps[0]?.valid).toBe(true);
    expect(rig.provider.startCount).toBe(1);
    expect(rig.scheduler.activeCount).toBe(1);
  });

  it('7. keeps live delta finite, smooth, and neutral throughout degraded windows', async () => {
    const tmr = tmrV2();
    const sql = await sqlRepository();
    const baseline = controllerRig(tmr, sql.recording, 'soak-driver--delta-reference');
    await baseline.controller.start('session');
    baseline.controller.arm();
    baseline.feed(
      new SampleTimeline().append(
        driveLap(tmr.profile, { seed: 80_001, speedMps: 40, noiseSigmaM: 0.5 }),
      ),
    );
    await baseline.controller.flush();
    await baseline.controller.endSession();

    const rig = controllerRig(tmr, sql.recording, 'soak-driver--delta-live');
    await rig.controller.start('session');
    expect(last(rig.states).pbMs).not.toBeNull();
    rig.controller.arm();
    let samples = new SampleTimeline().append(
      driveLap(tmr.profile, {
        seed: 80_002,
        lapCount: 5,
        speedMps: ({ lapIndex }) => [40, 41, 39, 42, 38][Math.min(lapIndex, 4)]!,
        noiseSigmaM: 0.5,
      }),
    );
    samples = samples.map((sample, index) => {
      if (index >= 120 && index <= 127) return { ...sample, accuracyM: 35 };
      if (index >= 330 && index <= 337) return { ...sample, accuracyM: 60 };
      return { ...sample };
    });
    samples = samples.map((sample, index) => ({
      ...sample,
      tMono: sample.tMono + (index >= 240 ? 6_000 : 0),
    }));

    const observations: Array<{ sample: LocationSample; state: FacadeStateCore }> = [];
    for (const sample of samples) observations.push({ sample, state: rig.feedOne(sample) });
    await rig.controller.flush();

    const deltaObservations = observations.filter(
      (
        observation,
      ): observation is {
        sample: LocationSample;
        state: FacadeStateCore & { delta: NonNullable<FacadeStateCore['delta']> };
      } => observation.state.delta !== null,
    );
    expect(deltaObservations.length).toBeGreaterThan(100);
    for (const { state } of deltaObservations) {
      expect(Number.isFinite(state.delta.deltaMs)).toBe(true);
      expect(Number.isFinite(state.delta.confidence)).toBe(true);
      if (state.delta.estimatedLapMs !== undefined) {
        expect(Number.isFinite(state.delta.estimatedLapMs)).toBe(true);
      }
    }

    const degraded = deltaObservations.filter(
      ({ state }) => state.gnssQuality === 'unreliable' || state.gnssQuality === 'invalid',
    );
    expect(degraded.length).toBeGreaterThan(10);
    expect(degraded.every(({ state }) => state.delta.display === 'neutral')).toBe(true);

    for (let index = 1; index < deltaObservations.length; index += 1) {
      const previous = deltaObservations[index - 1]!;
      const current = deltaObservations[index]!;
      const smoothPair =
        previous.state.sessionState === 'timing' &&
        current.state.sessionState === 'timing' &&
        previous.state.lapNumber === current.state.lapNumber &&
        (previous.state.gnssQuality === 'good' || previous.state.gnssQuality === 'degraded') &&
        (current.state.gnssQuality === 'good' || current.state.gnssQuality === 'degraded') &&
        current.sample.tMono - previous.sample.tMono <= 1_500;
      if (smoothPair) {
        const changeMs = Math.abs(current.state.delta.deltaMs - previous.state.delta.deltaMs);
        expect(
          changeMs,
          JSON.stringify({
            index,
            previousTMono: previous.sample.tMono,
            currentTMono: current.sample.tMono,
            lapNumber: current.state.lapNumber,
            previousDeltaMs: previous.state.delta.deltaMs,
            currentDeltaMs: current.state.delta.deltaMs,
          }),
        ).toBeLessThan(1_500);
      }
    }
  });

  it('8. keeps the 90-minute SQLite database below 15 MB and deletes every user-data row', async () => {
    expect(trackDayArtifact).toBeDefined();
    const artifact = trackDayArtifact!;
    expect(artifact.byteSize).toBeLessThan(15 * 1024 * 1024);
    expect(countRows(artifact.raw, 'sessions')).toBeGreaterThan(0);
    expect(countRows(artifact.raw, 'telemetry')).toBeGreaterThan(0);
    expect(countRows(artifact.raw, 'checkpoints')).toBeGreaterThan(0);
    expect(countRows(artifact.raw, 'reference_laps')).toBeGreaterThan(0);

    await artifact.repository.deleteUserData('soak-driver');
    for (const table of [
      'sessions',
      'laps',
      'checkpoints',
      'telemetry',
      'reference_laps',
      'settings',
    ]) {
      expect(countRows(artifact.raw, table), table).toBe(0);
    }
    expect(countRows(artifact.raw, 'schema_migrations')).toBe(1);
    expect(await artifact.repository.loadCheckpoint(artifact.sessionId)).toBeNull();
  });
});
