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
 * Fraction of a LAP's projected samples a decoded channel must EXCEED before
 * the analysis is allowed to treat it as a channel of that lap. Half: a channel
 * polled at 1 Hz against a 5-10 Hz GNSS stream still covers essentially every
 * sample (values are carried at most one second by `joinTelemetryChannels`), so
 * anything at or below this is a handful of rows, not a signal -- and the exact
 * percentage is reported either way.
 *
 * Ticket P5b-FIX1 C2 (binding, Codex P5b-REV1 finding 2): the gate is applied
 * PER LAP, not over the session, and the boundary is conservative -- EXACTLY
 * half is not enough. A channel that covered lap 1 and not lap 2 must not enter
 * lap 2's metrics, because the estimators would then silently mix a measured
 * lap with a fallback-estimated one and the comparison between them would be
 * between two different measurements.
 */
export const ANALYSIS_MIN_CHANNEL_COVERAGE = 0.5;

export interface AnalysisChannelCoverage {
  channel: CoachingChannelId;
  /** Fraction of the session's projected samples that carry this channel, 0..1. */
  fraction: number;
  /** How many samples carried it. */
  sampleCount: number;
}

/** One analysed lap's own channel coverage, and what that lap therefore lost. */
export interface AnalysisLapChannelCoverage {
  lapNumber: number;
  coverage: AnalysisChannelCoverage[];
  /** Channels stripped from THIS lap's samples, in `ANALYSIS_CHANNELS` order. */
  excluded: CoachingChannelId[];
}

/**
 * A channel the session carried somewhere but that at least one ANALYSED lap
 * lacked. The session-wide `fraction`/`sampleCount` stay (that is what the
 * screen quotes), plus the laps it could not be used on.
 */
export interface AnalysisExcludedChannel extends AnalysisChannelCoverage {
  /** Analysed laps this channel was stripped from, ascending. */
  excludedLapNumbers: number[];
  /** How many laps were analysed at all -- so "some" and "all" stay different statements. */
  analysedLapCount: number;
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
  /** Every decoded channel the recording carried, with its session-wide coverage. */
  coverage: AnalysisChannelCoverage[];
  /** Per analysed lap: that lap's own coverage, and what it lost (P5b-FIX1 C2). */
  perLapCoverage: AnalysisLapChannelCoverage[];
  /** Channels at or below {@link ANALYSIS_MIN_CHANNEL_COVERAGE} on at least one analysed lap. */
  lowCoverageChannels: AnalysisExcludedChannel[];
  /** The decoded channels handed to the engine on at least one lap, in `ANALYSIS_CHANNELS` order. */
  usedChannels: CoachingChannelId[];
  /** Laps that carried no analysable trace, with why. */
  skippedLaps: SkippedLap[];
  /** Total projected samples across the kept laps (what the coverage fractions are over). */
  sampleCount: number;
}

/**
 * How many samples carried each decoded channel, over some set of samples.
 * Kept separate from the fractions so the SESSION's coverage can be summed out
 * of the per-lap counts instead of re-walking every sample of every lap
 * (ticket P5-FIX2 W2: the final pass is chunked lap by lap).
 */
interface ChannelCounts {
  total: number;
  counts: Map<CoachingChannelId, number>;
}

function countChannels(samples: readonly CornerLapSample[]): ChannelCounts {
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
  return { total: samples.length, counts };
}

/** Only channels that actually appear, in `ANALYSIS_CHANNELS` order (byte-stable). */
function coverageFromCounts(counted: ChannelCounts): AnalysisChannelCoverage[] {
  const out: AnalysisChannelCoverage[] = [];
  for (const channel of ANALYSIS_CHANNELS) {
    const sampleCount = counted.counts.get(channel) ?? 0;
    if (sampleCount === 0) continue;
    out.push({
      channel,
      fraction: counted.total > 0 ? sampleCount / counted.total : 0,
      sampleCount,
    });
  }
  return out;
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
  return coverageFromCounts(countChannels(samples));
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

/**
 * Channels whose coverage over `samples` is at or below `minCoverage` -- the
 * conservative boundary of P5b-FIX1 C2: exactly half is NOT enough. Exported so
 * the boundary itself is testable without driving a whole session.
 */
export function excludedChannelsForSamples(
  samples: readonly CornerLapSample[],
  minCoverage: number = ANALYSIS_MIN_CHANNEL_COVERAGE,
): CoachingChannelId[] {
  return channelCoverage(samples)
    .filter((entry) => entry.fraction <= minCoverage)
    .map((entry) => entry.channel);
}

export interface AssembleOptions {
  /** How old a decoded value may be and still attach to a GNSS sample. Default 1000 ms. */
  maxChannelStalenessMs?: number;
  /** Minimum coverage a decoded channel needs. Default {@link ANALYSIS_MIN_CHANNEL_COVERAGE}. */
  minChannelCoverage?: number;
}

interface JoinedLap {
  lap: ClassifiableLap;
  samples: CornerLapSample[];
  sectorTimes?: readonly { sectorIndex: number; durationMs: number }[];
}

/** The per-lap half of the pass: project one stored lap, join its channels. */
function projectRecording(
  circuit: BundledCircuit,
  recording: AnalysisLapRecording,
  options: AssembleOptions,
): { joined: JoinedLap } | { skipped: SkippedLap } {
  if (recording.locationSamples.length === 0) {
    return { skipped: { lapNumber: recording.lap.lapNumber, reason: 'no-samples' } };
  }
  const projected = projectLapSamples(circuit.runtime, recording.locationSamples);
  if (projected.samples.length === 0) {
    return { skipped: { lapNumber: recording.lap.lapNumber, reason: 'unprojectable' } };
  }
  const withChannels =
    recording.telemetry.length === 0
      ? projected.samples
      : joinTelemetryChannels(projected.samples, recording.telemetry, {
          maxStalenessMs: options.maxChannelStalenessMs ?? 1_000,
        });
  return {
    joined: {
      lap: recording.lap,
      samples: withChannels,
      ...(recording.sectorTimes === undefined ? {} : { sectorTimes: recording.sectorTimes }),
    },
  };
}

/**
 * Which part of the pass a yield falls in (ticket P5-FIX2 W2, Codex P5-REV
 * finding 14). `project` is the per-lap projection half; `coverage` and `strip`
 * are the per-lap steps of the FINAL assembly, which used to be one synchronous
 * block; `analyze` brackets the engine call.
 */
export type AnalysisPassPhase = 'project' | 'coverage' | 'strip' | 'analyze';

/** Hands the JS thread back at a named chunk boundary of the pass. */
export type AnalysisPassYield = (phase: AnalysisPassPhase) => Promise<void>;

/**
 * The session half of the assembly, broken into the steps that GROW with the
 * session: one per lap to count its channels, one per lap to apply the coverage
 * gate (C2), one per lap to strip what the gate excluded, and a cheap tail.
 *
 * Written once, driven twice -- straight through by
 * {@link assembleSessionAnalysis} and with a yield between the steps by
 * {@link assembleSessionAnalysisChunked} -- so the synchronous and chunked
 * paths cannot drift apart (they are asserted equal in the tests).
 */
function createAssemblyPass(
  circuit: BundledCircuit,
  joined: readonly JoinedLap[],
  skippedLaps: SkippedLap[],
  options: AssembleOptions,
) {
  const minCoverage = options.minChannelCoverage ?? ANALYSIS_MIN_CHANNEL_COVERAGE;
  const lapCounts: ChannelCounts[] = [];
  const session: ChannelCounts = { total: 0, counts: new Map<CoachingChannelId, number>() };
  let coverage: AnalysisChannelCoverage[] = [];
  const perLapCoverage: AnalysisLapChannelCoverage[] = [];
  const excludedOn = new Map<CoachingChannelId, number[]>();
  const perLapDrops: ReadonlySet<CoachingChannelId>[] = [];
  const laps: SessionLapInput[] = [];

  return {
    lapCount: joined.length,

    /** Step 1, per lap: what this lap carried, summed into the session's totals. */
    countLap(index: number): void {
      const entry = joined[index];
      if (entry === undefined) return;
      const counted = countChannels(entry.samples);
      lapCounts[index] = counted;
      session.total += counted.total;
      for (const [channel, count] of counted.counts) {
        session.counts.set(channel, (session.counts.get(channel) ?? 0) + count);
      }
    },

    /** Between the halves: the session-wide coverage the gate compares against. */
    sealCoverage(): void {
      coverage = coverageFromCounts(session);
    },

    /**
     * Step 2, per lap: the gate. A channel enters a lap's inputs only if it
     * covered THAT lap; `excludedOn` then names, per channel, the laps that
     * lacked it -- which is exactly what the report has to state.
     */
    gateLap(index: number): void {
      const entry = joined[index];
      if (entry === undefined) return;
      const lapCoverage = coverageFromCounts(
        lapCounts[index] ?? { total: 0, counts: new Map<CoachingChannelId, number>() },
      );
      const excluded: CoachingChannelId[] = [];
      for (const row of coverage) {
        // A channel the session carried but this lap did not is coverage 0 here.
        const lapFraction = lapCoverage.find((it) => it.channel === row.channel)?.fraction ?? 0;
        if (lapFraction > minCoverage) continue;
        excluded.push(row.channel);
        const excludedLaps = excludedOn.get(row.channel) ?? [];
        excludedLaps.push(entry.lap.lapNumber);
        excludedOn.set(row.channel, excludedLaps);
      }
      perLapDrops[index] = new Set(excluded);
      perLapCoverage.push({ lapNumber: entry.lap.lapNumber, coverage: lapCoverage, excluded });
    },

    /** Step 3, per lap: the engine input, with this lap's excluded channels removed. */
    stripLap(index: number): void {
      const entry = joined[index];
      if (entry === undefined) return;
      laps.push({
        lap: entry.lap,
        samples: stripChannels(entry.samples, perLapDrops[index] ?? new Set()),
        ...(entry.sectorTimes === undefined ? {} : { sectorTimes: entry.sectorTimes }),
      });
    },

    /** The tail: session-wide facts, all of them O(channels). */
    finish(): AssembledAnalysis {
      const lowCoverageChannels: AnalysisExcludedChannel[] = coverage
        .filter((entry) => (excludedOn.get(entry.channel)?.length ?? 0) > 0)
        .map((entry) => ({
          ...entry,
          excludedLapNumbers: [...(excludedOn.get(entry.channel) ?? [])].sort((a, b) => a - b),
          analysedLapCount: joined.length,
        }));
      const usedChannels = coverage
        .filter((entry) => (excludedOn.get(entry.channel)?.length ?? 0) < joined.length)
        .map((entry) => entry.channel);

      const context: SessionAnalysisContext = {
        totalLengthM: polylineLength(circuit.runtime.centerline),
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
        perLapCoverage,
        lowCoverageChannels,
        usedChannels,
        skippedLaps,
        sampleCount: session.total,
      };
    },
  };
}

/** The final pass, straight through. */
function finishAssembly(
  circuit: BundledCircuit,
  joined: readonly JoinedLap[],
  skippedLaps: SkippedLap[],
  options: AssembleOptions,
): AssembledAnalysis {
  const pass = createAssemblyPass(circuit, joined, skippedLaps, options);
  for (let index = 0; index < pass.lapCount; index += 1) pass.countLap(index);
  pass.sealCoverage();
  for (let index = 0; index < pass.lapCount; index += 1) pass.gateLap(index);
  for (let index = 0; index < pass.lapCount; index += 1) pass.stripLap(index);
  return pass.finish();
}

/** The SAME final pass, handing the thread back between laps (P5-FIX2 W2). */
async function finishAssemblyChunked(
  circuit: BundledCircuit,
  joined: readonly JoinedLap[],
  skippedLaps: SkippedLap[],
  options: AssembleOptions,
  yieldToUi: AnalysisPassYield,
): Promise<AssembledAnalysis> {
  const pass = createAssemblyPass(circuit, joined, skippedLaps, options);
  for (let index = 0; index < pass.lapCount; index += 1) {
    await yieldToUi('coverage');
    pass.countLap(index);
  }
  pass.sealCoverage();
  for (let index = 0; index < pass.lapCount; index += 1) pass.gateLap(index);
  for (let index = 0; index < pass.lapCount; index += 1) {
    await yieldToUi('strip');
    pass.stripLap(index);
  }
  return pass.finish();
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
  const skippedLaps: SkippedLap[] = [];
  const joined: JoinedLap[] = [];
  for (const recording of ordered(recordings)) {
    const result = projectRecording(circuit, recording, options);
    if ('skipped' in result) skippedLaps.push(result.skipped);
    else joined.push(result.joined);
  }
  return finishAssembly(circuit, joined, skippedLaps, options);
}

/**
 * The SAME assembly, one lap at a time, handing the JS thread back between
 * laps (ticket P5b-FIX1 C5, Codex P5b-REV1 finding 5): a single yield before
 * the pass only paints the spinner -- a twenty-lap projection then still froze
 * the UI for the whole run.
 *
 * Ticket P5-FIX2 W2 (Codex P5-REV finding 14) extends that through the FINAL
 * pass: the per-lap coverage gate and the per-lap channel stripping yield per
 * lap too, so a long session no longer freezes the screen after the projection
 * half is done.
 */
export async function assembleSessionAnalysisChunked(
  circuit: BundledCircuit,
  recordings: readonly AnalysisLapRecording[],
  options: AssembleOptions = {},
  yieldToUi: AnalysisPassYield = async () => undefined,
): Promise<AssembledAnalysis> {
  const skippedLaps: SkippedLap[] = [];
  const joined: JoinedLap[] = [];
  for (const recording of ordered(recordings)) {
    await yieldToUi('project');
    const result = projectRecording(circuit, recording, options);
    if ('skipped' in result) skippedLaps.push(result.skipped);
    else joined.push(result.joined);
  }
  return finishAssemblyChunked(circuit, joined, skippedLaps, options, yieldToUi);
}

/** Stored laps in lap order -- the order every downstream list is reported in. */
function ordered(recordings: readonly AnalysisLapRecording[]): AnalysisLapRecording[] {
  return [...recordings].sort((a, b) => a.lap.lapNumber - b.lap.lapNumber);
}

/** Runs the deterministic engine over an assembled session. Pure. */
export function runSessionAnalysis(assembled: AssembledAnalysis): SessionInsights {
  return analyzeSession(assembled.laps, assembled.corners, assembled.context);
}

/**
 * The engine call at the end of the chunked pass, with a yield on either side
 * of it (ticket P5-FIX2 W2): the last frame of the spinner is painted before
 * the engine runs, and the thread is handed back the moment it returns rather
 * than at the end of whatever the caller does next.
 *
 * `analyzeSession` itself stays ONE synchronous unit, deliberately. Its
 * rankings are session-global -- the ranked consistency basis is chosen across
 * ALL corners (`sessionInsights.ts`) and decides each corner's `comparable`
 * flag -- so splitting the call by corner slices and merging the pieces would
 * produce different findings, and splitting it by lap would break the reference
 * lap and the demonstrated envelope. Chunking INSIDE the engine is a change to
 * `packages/core`, not to its call site.
 */
export async function runSessionAnalysisChunked(
  assembled: AssembledAnalysis,
  yieldToUi: AnalysisPassYield = async () => undefined,
): Promise<SessionInsights> {
  await yieldToUi('analyze');
  const insights = runSessionAnalysis(assembled);
  await yieldToUi('analyze');
  return insights;
}
