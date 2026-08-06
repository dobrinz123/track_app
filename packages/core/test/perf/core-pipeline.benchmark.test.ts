import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { CircuitProfile, ReferenceLap, TrackMatch } from '../../src/contracts';
import { driveLap } from '../../src/fixtures';
import { TrackMatcher } from '../../src/matching';
import { loadProfileFromJson, type RuntimeProfile } from '../../src/profile';
import { LiveDeltaEngine } from '../../src/reference';
import { runSessionPipeline } from '../../src/replay';

const ASSET_URL = new URL('../../assets/circuits/transilvania-motor-ring.v1.json', import.meta.url);
const MATCH_SAMPLE_COUNT = 10_000;
const DELTA_OPERATION_COUNT = 100_000;
const SESSION_SAMPLE_COUNT = 3_600;

interface TmrFixture {
  profile: CircuitProfile;
  runtime: RuntimeProfile;
}

interface TimedRun {
  elapsedMs: number;
  checksum: number;
}

function tmr(): TmrFixture {
  const loaded = loadProfileFromJson(readFileSync(ASSET_URL, 'utf8'));
  if (!loaded.ok) throw new Error(loaded.errors.join(', '));
  return { profile: loaded.profile, runtime: loaded.runtime };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.POSITIVE_INFINITY;
}

function timeMatcher(
  runtime: RuntimeProfile,
  samples: ReturnType<typeof driveLap>,
  auditIntervalSamples: number,
): TimedRun {
  const matcher = new TrackMatcher(runtime, { auditIntervalSamples });
  let checksum = 0;
  const startedAt = performance.now();
  for (const sample of samples) checksum += matcher.match(sample)?.distanceM ?? 0;
  return { elapsedMs: performance.now() - startedAt, checksum };
}

function referenceLap(totalLengthM: number): ReferenceLap {
  const gridSpacingM = 10;
  const gridLength = Math.ceil(totalLengthM / gridSpacingM) + 1;
  const distanceGridM = Array.from({ length: gridLength }, (_, index) =>
    Math.min(index * gridSpacingM, totalLengthM),
  );
  const durationMs = 90_000;
  return {
    circuitId: 'transilvania-motor-ring',
    layoutId: 'full',
    layoutVersion: 1,
    userId: 'benchmark-driver',
    durationMs,
    sectorTimes: [{ sectorIndex: 0, durationMs, quality: 'good' }],
    recordedAtUtc: '2026-08-06T00:00:00.000Z',
    sessionId: 'benchmark-session',
    lapNumber: 1,
    distanceGridM,
    elapsedMsAtGrid: distanceGridM.map((distanceM) => (distanceM / totalLengthM) * durationMs),
    gnssQualitySummary: { level: 'good', reasons: [] },
    appVersion: 'benchmark',
    algorithmVersion: 1,
    profileSchemaVersion: 1,
  };
}

function deltaMatch(index: number, totalLengthM: number): TrackMatch {
  const unwrappedProgressM = index * 0.75;
  const distanceM = unwrappedProgressM % totalLengthM;
  return {
    tMono: index * 10,
    distanceM,
    progress: distanceM / totalLengthM,
    unwrappedProgressM,
    lateralM: 0,
    confidence: 1,
    sectorIndex: 0,
    quality: { level: 'good', reasons: [] },
    onPitLane: false,
  };
}

function matcherMutableState(matcher: TrackMatcher): Record<string, unknown> {
  const exposed = matcher as unknown as Record<string, unknown>;
  const immutableKeys = new Set([
    'profile',
    'totalLengthM',
    'startOffsetM',
    'centerlineSegments',
    'auditIntervalSamples',
    'config',
    'evaluator',
  ]);
  return Object.fromEntries(Object.entries(exposed).filter(([key]) => !immutableKeys.has(key)));
}

describe('core pipeline performance guards', () => {
  it('sustains 5,000 TMR matches/s and is at least 3x faster than forced full search', () => {
    const { profile, runtime } = tmr();
    expect(runtime.centerline).toHaveLength(150);
    const samples = driveLap(profile, {
      seed: 8_001,
      sampleRateHz: 125,
      noiseSigmaM: 0,
      accuracyM: 3,
    }).slice(0, MATCH_SAMPLE_COUNT) as ReturnType<typeof driveLap>;
    expect(samples).toHaveLength(MATCH_SAMPLE_COUNT);

    // Warm both paths before timing so compilation does not inflate either mode.
    timeMatcher(runtime, samples.slice(0, 1_000) as ReturnType<typeof driveLap>, 25);
    timeMatcher(runtime, samples.slice(0, 1_000) as ReturnType<typeof driveLap>, 1);

    const optimizedRuns: TimedRun[] = [];
    const forcedFullRuns: TimedRun[] = [];
    for (let round = 0; round < 5; round += 1) {
      if (round % 2 === 0) {
        forcedFullRuns.push(timeMatcher(runtime, samples, 1));
        optimizedRuns.push(timeMatcher(runtime, samples, 25));
      } else {
        optimizedRuns.push(timeMatcher(runtime, samples, 25));
        forcedFullRuns.push(timeMatcher(runtime, samples, 1));
      }
    }

    const optimizedMs = median(optimizedRuns.map((run) => run.elapsedMs));
    const forcedFullMs = median(forcedFullRuns.map((run) => run.elapsedMs));
    const optimizedMatchesPerSecond = MATCH_SAMPLE_COUNT / (optimizedMs / 1_000);
    const improvement = forcedFullMs / optimizedMs;
    expect(optimizedRuns[0]?.checksum).toBeCloseTo(forcedFullRuns[0]?.checksum ?? 0, 6);
    console.info(
      `[perf] matcher optimized=${optimizedMatchesPerSecond.toFixed(0)} matches/s ` +
        `(${optimizedMs.toFixed(2)} ms), forced-full=${(
          MATCH_SAMPLE_COUNT /
          (forcedFullMs / 1_000)
        ).toFixed(
          0,
        )} matches/s (${forcedFullMs.toFixed(2)} ms), improvement=${improvement.toFixed(2)}x`,
    );

    expect(optimizedMatchesPerSecond).toBeGreaterThanOrEqual(5_000);
    expect(improvement).toBeGreaterThanOrEqual(3);
  });

  it('sustains 20,000 LiveDeltaEngine onMatch operations/s', () => {
    const { profile } = tmr();
    const totalLengthM = profile.totalLengthM;
    const reference = referenceLap(totalLengthM);
    const warmEngine = new LiveDeltaEngine();
    warmEngine.setReference(reference);
    for (let index = 0; index < 5_000; index += 1) {
      warmEngine.onMatch(deltaMatch(index, totalLengthM), index * 18);
    }

    const engine = new LiveDeltaEngine();
    engine.setReference(reference);
    let checksum = 0;
    const startedAt = performance.now();
    for (let index = 0; index < DELTA_OPERATION_COUNT; index += 1) {
      checksum += engine.onMatch(deltaMatch(index, totalLengthM), index * 18).deltaMs;
    }
    const elapsedMs = performance.now() - startedAt;
    const operationsPerSecond = DELTA_OPERATION_COUNT / (elapsedMs / 1_000);
    console.info(
      `[perf] delta=${operationsPerSecond.toFixed(0)} ops/s (${elapsedMs.toFixed(2)} ms for ` +
        `${DELTA_OPERATION_COUNT} operations)`,
    );

    expect(Number.isFinite(checksum)).toBe(true);
    expect(operationsPerSecond).toBeGreaterThanOrEqual(20_000);
  });

  it('keeps a 3,600-sample pipeline result below 5 MB and matcher state constant-size', () => {
    const { profile, runtime } = tmr();
    const generated = driveLap(profile, {
      seed: 8_002,
      sampleRateHz: 10,
      lapCount: 5,
      noiseSigmaM: 0,
      accuracyM: 3,
    });
    const samples = generated.slice(0, SESSION_SAMPLE_COUNT);
    expect(samples).toHaveLength(SESSION_SAMPLE_COUNT);

    const result = runSessionPipeline(runtime, samples);
    const resultBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    const matcher = new TrackMatcher(runtime);
    matcher.match(samples[0]!);
    const initialStateBytes = new TextEncoder().encode(
      JSON.stringify(matcherMutableState(matcher)),
    ).byteLength;
    for (let index = 1; index < samples.length; index += 1) matcher.match(samples[index]!);
    const finalState = matcherMutableState(matcher);
    const finalStateBytes = new TextEncoder().encode(JSON.stringify(finalState)).byteLength;
    console.info(
      `[perf] memory result=${(resultBytes / 1024 / 1024).toFixed(2)} MB, ` +
        `matcher-state=${initialStateBytes}->${finalStateBytes} bytes after ` +
        `${SESSION_SAMPLE_COUNT} samples`,
    );

    expect(resultBytes).toBeLessThan(5 * 1024 * 1024);
    expect(finalStateBytes).toBeLessThanOrEqual(initialStateBytes + 512);
    expect(Object.values(finalState).some((value) => Array.isArray(value))).toBe(false);
  });
});
