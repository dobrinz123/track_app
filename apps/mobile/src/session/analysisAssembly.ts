import {
  ANALYSIS_CHANNELS,
  analyzeSession,
  joinTelemetryChannels,
  polylineLength,
  projectLapSamples,
  type ClassifiableLap,
  type CoachingChannelId,
  type Corner,
  type CornerLapSample,
  type LocationSample,
  type SessionAnalysisContext,
  type SessionInsights,
  type SessionLapInput,
  type TelemetrySample,
} from '@circuit/core';

import type { BundledCircuit } from './circuitCatalog';

/**
 * Ticket P5b B2 (binding, `docs/architecture/analysis-engine.md` §1-§2 and
 * contracts.md's "Phase 5 REVISION"): turns what the app ACTUALLY stored for a
 * finished session -- the timing engine's lap rows, the GNSS `LocationSample`s
 * `LocalSessionRepository.saveTelemetry` persisted per lap, and the decoded OBD
 * rows `telemetry_samples` holds -- into the deterministic analysis engine's
 * inputs, and nothing more.
 *
 * The division of labour is the ticket's own: this module ASSEMBLES, the
 * engine DECIDES. Nothing here classifies a lap, scores consistency, judges
 * GNSS quality or writes a sentence; `analyzeSession` does all of that. The
 * two judgements this module does make are both about the RECORDING rather
 * than the driving, and both are reported rather than hidden:
 *
 *  - a lap with no usable GNSS trace is skipped (with its reason), because an
 *    analysis of zero samples is not an analysis;
 *  - a decoded channel that covers less than {@link ANALYSIS_MIN_CHANNEL_COVERAGE}
 *    of the session's samples is removed from the samples and listed in
 *    `lowCoverageChannels` WITH its percentage -- "the brake channel appeared
 *    on 3 % of this session" is a fact the report can state, whereas letting
 *    the engine treat those few samples as a session-wide channel would not be.
 *
 * A channel is NEVER declared `unsupported`: a recording can prove that this
 * session did not carry a channel, never that the car cannot produce one.
 *
 * Circuit-agnostic by construction (contracts.md item 8): every geometry input
 * -- centreline, corners, length, layout, whether the geometry is
 * field-validated -- comes from the `BundledCircuit` the caller resolved out of
 * the catalog, so Transilvania Motor Ring and MotorPark run the same code.
 *
 * Pure TypeScript: no `react-native`, no `expo`, no I/O, so vitest imports it
 * directly (the house rule the screens follow -- logic in a testable module,
 * the `.tsx` stays thin).
 */

/** One stored lap of a finished session, exactly as persistence hands it over. */
export interface AnalysisLapRecording {
  /** The timing engine's lap record (a `LapRecord` satisfies `ClassifiableLap`). */
  lap: ClassifiableLap;
  /** The lap's GNSS trace (`LocalSessionRepository.loadTelemetry`). */
  locationSamples: readonly LocationSample[];
  /** The lap's decoded OBD channel rows (`telemetry_samples`). */
  telemetry: readonly TelemetrySample[];
  /** Sector times from the timing engine, when the lap record carries them. */
  sectorTimes?: readonly { sectorIndex: number; durationMs: number }[];
}

/**
 * Fraction of a session's projected samples a decoded channel must appear on
 * before the analysis is allowed to treat it as a channel of that session.
 * Half: a channel polled at 1 Hz against a 5-10 Hz GNSS stream still covers
 * essentially every sample (values are carried at most one second by
 * `joinTelemetryChannels`), so anything below this is a handful of rows, not a
 * signal -- and the exact percentage is reported either way.
 */
export const ANALYSIS_MIN_CHANNEL_COVERAGE = 0.5;

export interface AnalysisChannelCoverage {
  channel: CoachingChannelId;
  /** Fraction of the session's projected samples that carry this channel, 0..1. */
  fraction: number;
  /** How many samples carried it. */
  sampleCount: number;
}

export interface SkippedLap {
  lapNumber: number;
  /** `no-samples`: nothing was stored. `unprojectable`: nothing matched the circuit. */
  reason: 'no-samples' | 'unprojectable';
}

export interface AssembledAnalysis {
  laps: SessionLapInput[];
  corners: readonly Corner[];
  context: SessionAnalysisContext;
  /** Every decoded channel the recording carried, with its coverage. */
  coverage: AnalysisChannelCoverage[];
  /** Channels present but below {@link ANALYSIS_MIN_CHANNEL_COVERAGE} -- removed, and reported. */
  lowCoverageChannels: AnalysisChannelCoverage[];
  /** The decoded channels actually handed to the engine, in `ANALYSIS_CHANNELS` order. */
  usedChannels: CoachingChannelId[];
  /** Laps that carried no analysable trace, with why. */
  skippedLaps: SkippedLap[];
  /** Total projected samples across the kept laps (what the coverage fractions are over). */
  sampleCount: number;
}

/**
 * Per-channel coverage over already-projected samples: the fraction of samples
 * carrying a finite value for it. Only channels that actually appear are
 * returned, in `ANALYSIS_CHANNELS` order, so the result is byte-stable.
 *
 * GNSS speed (`CornerLapSample.speedKph`) is deliberately NOT counted here:
 * this measures the DECODED OBD channels a session carried, and the GNSS
 * backbone is not one of them.
 */
export function channelCoverage(
  samples: readonly CornerLapSample[],
): AnalysisChannelCoverage[] {
  const counts = new Map<CoachingChannelId, number>();
  for (const sample of samples) {
    const channels = sample.channels;
    if (channels === undefined) continue;
    for (const channel of ANALYSIS_CHANNELS) {
      if (Number.isFinite(channels[channel])) {
        counts.set(channel, (counts.get(channel) ?? 0) + 1);
      }
    }
  }
  const total = samples.length;
  const out: AnalysisChannelCoverage[] = [];
  for (const channel of ANALYSIS_CHANNELS) {
    const sampleCount = counts.get(channel) ?? 0;
    if (sampleCount === 0) continue;
    out.push({ channel, fraction: total > 0 ? sampleCount / total : 0, sampleCount });
  }
  return out;
}

/** Removes the named channels from every sample (never mutates the input). */
function stripChannels(
  samples: readonly CornerLapSample[],
  drop: ReadonlySet<CoachingChannelId>,
): CornerLapSample[] {
  if (drop.size === 0) return [...samples];
  return samples.map((sample) => {
    const channels = sample.channels;
    if (channels === undefined) return sample;
    const kept: Partial<Record<CoachingChannelId, number>> = {};
    let removed = false;
    for (const channel of ANALYSIS_CHANNELS) {
      const value = channels[channel];
      if (!Number.isFinite(value)) continue;
      if (drop.has(channel)) removed = true;
      else kept[channel] = value;
    }
    if (!removed) return sample;
    return Object.keys(kept).length === 0
      ? { ...sample, channels: undefined }
      : { ...sample, channels: kept };
  });
}

export interface AssembleOptions {
  /** How old a decoded value may be and still attach to a GNSS sample. Default 1000 ms. */
  maxChannelStalenessMs?: number;
  /** Minimum coverage a decoded channel needs. Default {@link ANALYSIS_MIN_CHANNEL_COVERAGE}. */
  minChannelCoverage?: number;
}

/**
 * Builds the engine input for one finished session on one catalog circuit.
 * Deterministic and side-effect free.
 */
export function assembleSessionAnalysis(
  circuit: BundledCircuit,
  recordings: readonly AnalysisLapRecording[],
  options: AssembleOptions = {},
): AssembledAnalysis {
  const totalLengthM = polylineLength(circuit.runtime.centerline);
  const minCoverage = options.minChannelCoverage ?? ANALYSIS_MIN_CHANNEL_COVERAGE;

  const skippedLaps: SkippedLap[] = [];
  const joined: { lap: ClassifiableLap; samples: CornerLapSample[]; sectorTimes?: readonly { sectorIndex: number; durationMs: number }[] }[] = [];

  for (const recording of [...recordings].sort((a, b) => a.lap.lapNumber - b.lap.lapNumber)) {
    if (recording.locationSamples.length === 0) {
      skippedLaps.push({ lapNumber: recording.lap.lapNumber, reason: 'no-samples' });
      continue;
    }
    const projected = projectLapSamples(circuit.runtime, recording.locationSamples);
    if (projected.samples.length === 0) {
      skippedLaps.push({ lapNumber: recording.lap.lapNumber, reason: 'unprojectable' });
      continue;
    }
    const withChannels =
      recording.telemetry.length === 0
        ? projected.samples
        : joinTelemetryChannels(projected.samples, recording.telemetry, {
            maxStalenessMs: options.maxChannelStalenessMs ?? 1_000,
          });
    joined.push({
      lap: recording.lap,
      samples: withChannels,
      ...(recording.sectorTimes === undefined ? {} : { sectorTimes: recording.sectorTimes }),
    });
  }

  const allSamples = joined.flatMap((entry) => entry.samples);
  const coverage = channelCoverage(allSamples);
  const lowCoverageChannels = coverage.filter((entry) => entry.fraction < minCoverage);
  const drop = new Set(lowCoverageChannels.map((entry) => entry.channel));
  const usedChannels = coverage
    .filter((entry) => !drop.has(entry.channel))
    .map((entry) => entry.channel);

  const laps: SessionLapInput[] = joined.map((entry) => ({
    lap: entry.lap,
    samples: stripChannels(entry.samples, drop),
    ...(entry.sectorTimes === undefined ? {} : { sectorTimes: entry.sectorTimes }),
  }));

  const context: SessionAnalysisContext = {
    totalLengthM,
    circuitId: circuit.profile.circuitId,
    circuitName: circuit.profile.displayName,
    layoutId: circuit.profile.layoutId,
    // A recording proves what this session carried, never what the car can
    // produce -- so nothing is ever declared unsupported here.
    unsupportedChannels: [],
    // Data, not a per-circuit constant: `geometryStatus` is the catalog's own
    // statement about whether the geometry has been validated on track.
    geometryValidated: circuit.profile.geometryStatus === 'official',
  };

  return {
    laps,
    corners: circuit.corners,
    context,
    coverage,
    lowCoverageChannels,
    usedChannels,
    skippedLaps,
    sampleCount: allSamples.length,
  };
}

/** Runs the deterministic engine over an assembled session. Pure. */
export function runSessionAnalysis(assembled: AssembledAnalysis): SessionInsights {
  return analyzeSession(assembled.laps, assembled.corners, assembled.context);
}
