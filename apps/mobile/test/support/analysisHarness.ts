import { driveLap, type LocationSample, type TelemetrySample } from '@circuit/core';
import { circuitCatalog, type BundledCircuit } from '../../src/session/circuitCatalog';
import type { AnalysisLapRecording } from '../../src/session/analysisAssembly';

/**
 * Shared rig for the Phase 5b (post-session analysis screen) tests: a
 * deterministic, kinematically plausible multi-lap recording on a REAL
 * bundled circuit, in exactly the shape the app stores one --
 * `LapRecord`-like lap rows, GNSS `LocationSample[]` per lap (what
 * `LocalSessionRepository.saveTelemetry` persists) and decoded OBD
 * `TelemetrySample[]` per lap (what `telemetry_samples` holds).
 *
 * Not a vitest file (no `.test.ts` suffix), so the runner's
 * `test/**\/*.test.ts` include skips it. Nothing here is circuit-specific:
 * every speed target comes from the catalog corners of whichever circuit is
 * passed in, so the SAME helper drives Transilvania Motor Ring and MotorPark.
 */

export const TMR_CIRCUIT_ID = 'transilvania-motor-ring';
export const MOTORPARK_CIRCUIT_ID = 'motorpark-romania';

export function bundled(circuitId: string): BundledCircuit {
  const entry = circuitCatalog.get(circuitId);
  if (entry === null) throw new Error(`analysisHarness: unknown circuit ${circuitId}`);
  return entry;
}

/** Every bundled circuit, so a test can assert "both circuits" without naming either. */
export function allBundledCircuits(): { circuitId: string; circuit: BundledCircuit }[] {
  return circuitCatalog.list().map((summary) => ({
    circuitId: summary.circuitId,
    circuit: bundled(summary.circuitId),
  }));
}

function modulo(value: number, modulus: number): number {
  const wrapped = value % modulus;
  return wrapped < 0 ? wrapped + modulus : wrapped;
}

export interface DriveOptions {
  laps?: number;
  sampleRateHz?: number;
  /** Per-lap multiplier on every catalog corner's advisory speed (index 0 = lap 1). */
  cornerSpeedScales?: readonly number[];
  /** Which decoded OBD channels the recording carries. */
  channels?: 'none' | 'pedal' | 'full';
  /** Metres of the previous lap kept as the approach to corner 1. */
  leadInM?: number;
  seed?: number;
  /** Marks these lap numbers invalid (a pit transit, say). */
  invalidLaps?: readonly number[];
}

export interface DrivenSession {
  sessionId: string;
  circuitId: string;
  recordings: AnalysisLapRecording[];
}

/**
 * One lap's GNSS trace, driven with a lead-in from the previous lap so the
 * approach window of the first corner is real data rather than a hole.
 */
function driveOneLap(
  circuit: BundledCircuit,
  lapIndex: number,
  options: Required<Pick<DriveOptions, 'sampleRateHz' | 'leadInM' | 'seed'>> & {
    scale: number;
    tStartMono: number;
  },
): LocationSample[] {
  const totalLengthM = circuit.profile.totalLengthM;
  const vMax = 55;
  const accelMps2 = 3;
  const brakeMps2 = 4;
  const speedAt = (distanceM: number): number => {
    const here = modulo(distanceM, totalLengthM);
    let speed = vMax;
    for (const corner of circuit.corners) {
      const target = Math.min(vMax, Math.max(11, (corner.advisorySpeedKph / 3.6) * options.scale));
      const toEntry = modulo(corner.entryDistanceM - here, totalLengthM);
      const fromExit = modulo(here - corner.exitDistanceM, totalLengthM);
      const inCorner =
        modulo(here - corner.entryDistanceM, totalLengthM) <=
        modulo(corner.exitDistanceM - corner.entryDistanceM, totalLengthM);
      if (inCorner) speed = Math.min(speed, target);
      speed = Math.min(speed, Math.sqrt(target * target + 2 * brakeMps2 * toEntry));
      speed = Math.min(speed, Math.sqrt(target * target + 2 * accelMps2 * fromExit));
    }
    return Math.max(10, Math.min(vMax, speed));
  };

  return driveLap(circuit.profile, {
    seed: options.seed + lapIndex,
    sampleRateHz: options.sampleRateHz,
    noiseSigmaM: 1.0,
    startDistanceM: -options.leadInM,
    endPaddingM: 0,
    lapCount: 1,
    tStartMono: options.tStartMono,
    speedMps: (context) => speedAt(context.distanceM),
  });
}

/**
 * Decoded OBD channels derived from the SAME drive (the speed derivative), so
 * they are consistent with the GNSS trace instead of invented next to it.
 */
function deriveChannels(
  samples: readonly LocationSample[],
  mode: 'pedal' | 'full',
): TelemetrySample[] {
  const out: TelemetrySample[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const next = samples[index + 1];
    if (sample === undefined) continue;
    let accelMps2 = 0;
    if (next !== undefined) {
      const dtSeconds = (next.tMono - sample.tMono) / 1_000;
      if (dtSeconds > 0) accelMps2 = ((next.speedMps ?? 0) - (sample.speedMps ?? 0)) / dtSeconds;
    }
    const pedalPct = accelMps2 > 0.1 ? Math.min(100, 30 + accelMps2 * 25) : 0;
    out.push({ channel: 'accelPedalPct', value: pedalPct, tMonoMs: sample.tMono });
    if (mode === 'full') {
      out.push({
        channel: 'brakeSwitch',
        value: accelMps2 < -0.5 ? 100 : 0,
        tMonoMs: sample.tMono,
      });
      out.push({
        channel: 'rpm',
        value: 1_500 + (sample.speedMps ?? 0) * 90,
        tMonoMs: sample.tMono,
      });
    }
  }
  return out;
}

/** A whole stored session on `circuit`, ready to be handed to the assembly module. */
export function driveSession(circuit: BundledCircuit, options: DriveOptions = {}): DrivenSession {
  const laps = options.laps ?? 4;
  const sampleRateHz = options.sampleRateHz ?? 5;
  const leadInM = options.leadInM ?? 460;
  const seed = options.seed ?? 4_201;
  const scales = options.cornerSpeedScales ?? [1, 0.94, 0.98, 0.9];
  const channels = options.channels ?? 'pedal';
  const invalid = new Set(options.invalidLaps ?? []);

  const recordings: AnalysisLapRecording[] = [];
  let tStartMono = 0;
  for (let lapIndex = 0; lapIndex < laps; lapIndex += 1) {
    const scale = scales[lapIndex % scales.length] ?? 1;
    const locationSamples = driveOneLap(circuit, lapIndex, {
      sampleRateHz,
      leadInM,
      seed,
      scale,
      tStartMono,
    });
    const first = locationSamples[0];
    const last = locationSamples[locationSamples.length - 1];
    const durationMs = first === undefined || last === undefined ? 0 : last.tMono - first.tMono;
    tStartMono = (last?.tMono ?? tStartMono) + 1_000;
    const lapNumber = lapIndex + 1;
    recordings.push({
      lap: {
        lapNumber,
        durationMs,
        valid: !invalid.has(lapNumber),
        invalidReasons: invalid.has(lapNumber) ? ['PIT_TRANSIT'] : [],
        quality: 'good',
      },
      locationSamples,
      telemetry: channels === 'none' ? [] : deriveChannels(locationSamples, channels),
    });
  }

  return { sessionId: `session-${circuit.profile.circuitId}`, circuitId: circuit.profile.circuitId, recordings };
}

/**
 * The same bundled circuit, with its geometry marked as FIELD-VALIDATED
 * (ticket P5c-FIX1 E4).
 *
 * The honesty gate the suggestion engine now enforces keys on
 * `profile.geometryStatus === 'official'`, and TODAY both bundled assets are
 * `community-derived` — so on the shipped catalog the trackday stage suggests
 * nothing at all, on either circuit. That is the contract (safety rule 5:
 * "an unvalidated circuit geometry -> observations without suggestions"), and
 * it is pinned by its own tests.
 *
 * The mechanisms BEHIND that gate — the bounded move, the sealed evidence, the
 * boundary-only apply — still have to be exercised, so the tests that are about
 * those use this variant: a circuit whose geometry someone has validated. It
 * changes one catalog field and nothing else.
 */
export function withValidatedGeometry(circuit: BundledCircuit): BundledCircuit {
  return { ...circuit, profile: { ...circuit.profile, geometryStatus: 'official' } };
}
