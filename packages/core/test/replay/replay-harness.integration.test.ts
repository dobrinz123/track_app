import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CircuitProfile, ReferenceLap, SessionPipelineResult } from '../../src/contracts';
import {
  cleanRecognitionLap,
  driveLap,
  impossibleJumpLap,
  lowQualitySamplesLap,
  multiLapSession,
  outOfOrderTimestampsLap,
  pauseResumeSession,
  pbImprovementSession,
  pitLaneTransitLap,
  reverseTravelLap,
  signalLossLap,
  slowerLapSession,
  startLineJitterLap,
  stoppedOnLineSession,
  wraparoundSession,
} from '../../src/fixtures';
import { loadProfileFromJson, type RuntimeProfile } from '../../src/profile';
import { buildReferenceLap, shouldReplacePb } from '../../src/reference';
import {
  runCalibration,
  runSessionPipeline,
  type ReplayMatchedTelemetry,
  type ReplayRejectedSample,
} from '../../src/replay';

interface TmrFixture {
  profile: CircuitProfile;
  runtime: RuntimeProfile;
}

function tmr(): TmrFixture {
  const json = readFileSync(
    new URL('../../assets/circuits/transilvania-motor-ring.v1.json', import.meta.url),
    'utf8',
  );
  const loaded = loadProfileFromJson(json);
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

function diagnostics<T>(result: SessionPipelineResult, key: string): T {
  return result.diagnostics[key] as T;
}

function referenceFrom(
  profile: CircuitProfile,
  result: SessionPipelineResult,
  lapIndex = 0,
): ReferenceLap {
  const lap = result.laps[lapIndex];
  if (lap === undefined) throw new Error(`Missing lap ${lapIndex + 1}`);
  const built = buildReferenceLap({
    profile,
    lap,
    telemetry: diagnostics<ReplayMatchedTelemetry[]>(result, 'matches'),
    userId: 'integration-driver',
    recordedAtUtc: '2026-08-06T12:00:00.000Z',
    sessionId: `integration-session-${lapIndex + 1}`,
    appVersion: 'integration-test',
    algorithmVersion: 1,
  });
  if (!built.ok) throw new Error(`${built.error}:${JSON.stringify(lap)}`);
  return built.reference;
}

describe('ReplayHarness production pipeline integration', () => {
  it('1. calibrates a clean TMR recognition lap clockwise with full coverage', () => {
    const { profile, runtime } = tmr();
    const result = runCalibration(runtime, cleanRecognitionLap(profile, 101));
    expect(result.accepted, JSON.stringify(result)).toBe(true);
    expect(result.diagnostics.directionDetected).toBe('clockwise');
    expect(result.diagnostics.coverageFraction).toBeGreaterThanOrEqual(0.95);
  });

  it('2. times exactly three valid TMR laps and completes the session', () => {
    const { profile, runtime } = tmr();
    const calibration = cleanRecognitionLap(profile, 102);
    const result = runSessionPipeline(runtime, multiLapSession(profile, 3, 103), {
      calibrateFirst: calibration,
    });
    expect(result.calibration?.accepted).toBe(true);
    expect(result.laps).toHaveLength(3);
    expect(
      result.laps.every((lap) => lap.valid),
      JSON.stringify(result.laps),
    ).toBe(true);
    for (const lap of result.laps) {
      expect(lap.durationMs).toBeGreaterThan(65_000);
      expect(lap.durationMs).toBeLessThan(130_000);
      expect(lap.sectorTimes.reduce((sum, sector) => sum + sector.durationMs, 0)).toBeCloseTo(
        lap.durationMs,
        6,
      );
    }
    expect(result.finalState).toBe('sessionComplete');
  });

  it('3. accepts a faster PB candidate and rejects a slower candidate', () => {
    const { profile, runtime } = tmr();
    const improving = runSessionPipeline(runtime, pbImprovementSession(profile, 104));
    expect(improving.laps).toHaveLength(3);
    const firstReference = referenceFrom(profile, improving, 0);
    const fasterReference = referenceFrom(profile, improving, 2);
    expect(
      shouldReplacePb(firstReference, {
        reference: fasterReference,
        lap: improving.laps[2]!,
        fullTelemetry: true,
        expectedSectorCount: profile.sectorGates.length + 1,
      }),
    ).toBe(true);

    const slowing = runSessionPipeline(runtime, slowerLapSession(profile, 105));
    const slowingFirstReference = referenceFrom(profile, slowing, 0);
    const slowReference = referenceFrom(profile, slowing, 1);
    expect(
      shouldReplacePb(slowingFirstReference, {
        reference: slowReference,
        lap: slowing.laps[1]!,
        fullTelemetry: true,
        expectedSectorCount: profile.sectorGates.length + 1,
      }),
    ).toBe(false);
  });

  it('4. reports near-zero identical delta, negative faster delta, and positive slower delta', () => {
    const { profile, runtime } = tmr();
    const baselineSamples = driveLap(profile, { seed: 106, speedMps: 40, noiseSigmaM: 1 });
    const baseline = runSessionPipeline(runtime, baselineSamples);
    const reference = referenceFrom(profile, baseline);
    const identical = runSessionPipeline(runtime, baselineSamples, { referenceLap: reference });
    const faster = runSessionPipeline(
      runtime,
      driveLap(profile, { seed: 106, speedMps: 46, noiseSigmaM: 1 }),
      { referenceLap: reference },
    );
    const slower = runSessionPipeline(
      runtime,
      driveLap(profile, { seed: 106, speedMps: 34, noiseSigmaM: 1 }),
      { referenceLap: reference },
    );
    expect(identical.deltas[identical.deltas.length - 1]?.deltaMs).toBeCloseTo(0, -2);
    expect(Math.min(...faster.deltas.map((delta) => delta.deltaMs))).toBeLessThan(-1_000);
    expect(Math.max(...slower.deltas.map((delta) => delta.deltaMs))).toBeGreaterThan(1_000);
  });

  it('5. never silently validates a lap affected by 15 s signal loss', () => {
    const { profile, runtime } = tmr();
    const result = runSessionPipeline(runtime, signalLossLap(profile, 107));
    expect(result.laps).toHaveLength(1);
    expect(result.laps[0]?.valid).toBe(false);
    expect(result.laps[0]?.invalidReasons).toContain('LOW_QUALITY');
  });

  it('6. rejects a 500 m jump without a phantom crossing or lap corruption', () => {
    const { profile, runtime } = tmr();
    const result = runSessionPipeline(runtime, impossibleJumpLap(profile, 108));
    const rejected = diagnostics<ReplayRejectedSample[]>(result, 'rejectedSamples');
    expect(rejected.some((sample) => sample.reasons.includes('IMPOSSIBLE_JUMP'))).toBe(true);
    expect(result.crossings.filter((event) => event.kind === 'startFinish')).toHaveLength(2);
    expect(result.laps).toHaveLength(1);
    expect(result.laps[0]?.valid, JSON.stringify(result.laps)).toBe(true);
  });

  it('7. counts exactly one forward start crossing during low-speed line jitter', () => {
    const { profile, runtime } = tmr();
    const result = runSessionPipeline(runtime, startLineJitterLap(profile, 109));
    expect(
      result.crossings.filter(
        (event) => event.kind === 'startFinish' && event.direction === 'forward',
      ),
    ).toHaveLength(1);
    expect(result.laps).toHaveLength(0);
  });

  it('8. does not complete a reverse lap and marks reverse travel on the open lap', () => {
    const { profile, runtime } = tmr();
    const result = runSessionPipeline(runtime, reverseTravelLap(profile, 110));
    expect(result.laps).toHaveLength(0);
    expect(diagnostics<boolean>(result, 'reverseTravelDetected')).toBe(true);
    expect(diagnostics<string[]>(result, 'appliedInvalidReasons')).toContain('REVERSE_TRAVEL');
  });

  it('9. detects pit entry/exit, visits inPit, and invalidates pit transit', () => {
    const { profile, runtime } = tmr();
    const result = runSessionPipeline(runtime, pitLaneTransitLap(profile, 111));
    expect(result.crossings.some((event) => event.kind === 'pitEntry')).toBe(true);
    expect(result.crossings.some((event) => event.kind === 'pitExit')).toBe(true);
    expect(
      diagnostics<string[]>(result, 'stateHistory'),
      JSON.stringify({ crossings: result.crossings, diagnostics: result.diagnostics }),
    ).toContain('inPit');
    expect(
      result.laps.some((lap) => lap.invalidReasons.includes('PIT_TRANSIT')),
      JSON.stringify({ laps: result.laps, crossings: result.crossings }),
    ).toBe(true);
  });

  it('10. emits no duplicate crossing while stationary on the S/F gate for 60 s', () => {
    const { profile, runtime } = tmr();
    const result = runSessionPipeline(runtime, stoppedOnLineSession(profile, 112));
    const starts = result.crossings.filter(
      (event) => event.kind === 'startFinish' && event.direction === 'forward',
    );
    expect(starts).toHaveLength(3);
    expect(result.laps).toHaveLength(2);
  });

  it('11. applies PAUSE_GAP only to the affected lap and leaves the next lap valid', () => {
    const { profile, runtime } = tmr();
    const result = runSessionPipeline(runtime, pauseResumeSession(profile, 113));
    expect(result.laps).toHaveLength(2);
    expect(result.laps[0]?.invalidReasons).toContain('PAUSE_GAP');
    expect(result.laps[0]?.valid).toBe(false);
    expect(result.laps[1]?.valid, JSON.stringify(result.laps)).toBe(true);
  });

  it('12. rejects non-increasing timestamps and continues the pipeline', () => {
    const { profile, runtime } = tmr();
    const result = runSessionPipeline(runtime, outOfOrderTimestampsLap(profile, 114));
    const rejected = diagnostics<ReplayRejectedSample[]>(result, 'rejectedSamples');
    expect(rejected.some((sample) => sample.level === 'invalid')).toBe(true);
    expect(rejected.some((sample) => sample.reasons.includes('NON_INCREASING_TIMESTAMP'))).toBe(
      true,
    );
    expect(result.laps).toHaveLength(1);
  });

  it('13. interpolates an early wrap crossing and keeps unwrapped progress monotone', () => {
    const { profile, runtime } = tmr();
    const samples = wraparoundSession(profile, 115);
    const result = runSessionPipeline(runtime, samples);
    const firstCrossing = result.crossings.find(
      (event) => event.kind === 'startFinish' && event.direction === 'forward',
    );
    expect(firstCrossing?.tCross).toBeGreaterThan(samples[0]?.tMono ?? -1);
    expect(firstCrossing?.tCross).toBeLessThan(3_000);
    const matches = diagnostics<ReplayMatchedTelemetry[]>(result, 'matches');
    for (let index = 1; index < matches.length; index += 1) {
      expect(matches[index]?.unwrappedProgressM).toBeGreaterThanOrEqual(
        (matches[index - 1]?.unwrappedProgressM ?? 0) - 1,
      );
    }
    expect(result.laps).toHaveLength(1);
  });

  it('14. is byte-deterministic for one seed and changes telemetry for another seed', () => {
    const { profile, runtime } = tmr();
    const firstSamples = multiLapSession(profile, 2, 116);
    const secondSamples = multiLapSession(profile, 2, 116);
    const differentSamples = multiLapSession(profile, 2, 117);
    expect(JSON.stringify(firstSamples)).toBe(JSON.stringify(secondSamples));
    expect(JSON.stringify(firstSamples)).not.toBe(JSON.stringify(differentSamples));
    expect(JSON.stringify(runSessionPipeline(runtime, firstSamples))).toBe(
      JSON.stringify(runSessionPipeline(runtime, secondSamples)),
    );
  });

  it('15. processes a roughly 400-sample five-lap session in under one second', () => {
    const { profile, runtime } = tmr();
    const samples = multiLapSession(profile, 5, 118);
    expect(samples.length).toBeGreaterThan(350);
    expect(samples.length).toBeLessThan(550);
    const started = performance.now();
    const result = runSessionPipeline(runtime, samples);
    const elapsedMs = performance.now() - started;
    expect(result.laps).toHaveLength(5);
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('grades deterministic 30-60 m accuracy samples as unreliable or invalid', () => {
    const { profile, runtime } = tmr();
    const result = runSessionPipeline(runtime, lowQualitySamplesLap(profile, 119));
    const counts = diagnostics<Record<string, number>>(result, 'qualityCounts');
    expect((counts.unreliable ?? 0) + (counts.invalid ?? 0)).toBeGreaterThan(0);
    expect(counts.good).toBe(0);
  });
});
