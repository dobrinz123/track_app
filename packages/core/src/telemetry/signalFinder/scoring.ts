/**
 * Signal Finder — per-DID scoring (contracts.md "Signal Finder (Phase 4l,
 * 2026-08-29)", item 3, binding):
 *
 *   "Scoring is per DID: `matchedEdges / expectedEdges` (a change inside a
 *    press window and a change back inside the release window),
 *    `baselineChanges` (must be 0), and, for analogs, correlation sign.
 *    Verdicts: `found` (>= 4/5 edges, 0 baseline changes), `probable`
 *    (>= 3/5), `unrelated`. Insufficient samples (< 2 per window) ->
 *    `insufficient`, never ranked."
 *
 * "4/5 edges" is read as a RATIO of the expected edges (5 presses = 10
 * expected edges; 4 of 5 complete cycles = 8/10 = 0.8), so the same
 * thresholds hold for a 4-repetition steering script.
 *
 * Why `baselineChanges` disqualifies outright: the field's own counter DID
 * (0x29 0x5002, a 21-byte block whose byte 4 increments on every read) would
 * otherwise score edges purely by accident. A DID that moves while the driver
 * is holding still is not answering the driver.
 *
 * Blocks (>= 5 bytes) are scored PER BYTE OFFSET and reported by their best
 * offset — same discipline as `didObservationPhases.ts`'s
 * `computeDidBlockCandidateSummaries`, so a 12-byte struct with one live
 * brake bit is still discoverable. `baselineChanges` is nevertheless reported
 * at the WHOLE-RESPONSE level (did anything in this response move while the
 * driver held still?), which is what makes a counter block visibly restless
 * even when its own quiet offsets score nothing.
 *
 * Pure, deterministic — no I/O.
 */

import type { MetronomeStep, MetronomeTimeline } from './metronome';
import { metronomeStepForSample, DEFAULT_MIN_SAMPLES_PER_WINDOW } from './metronome';
import type { SignalExpectedShape } from './targets';

/** One correlated 0x62 response, timestamped relative to the metronome's own start. */
export interface SignalFinderSample {
  /** ECU (HSFZ target) address this response came from. */
  ecu: number;
  did: number;
  tMs: number;
  raw: Uint8Array;
}

export type SignalVerdict = 'found' | 'probable' | 'unrelated' | 'insufficient';

/** Why a DID could not be judged at all (never mixed in with the ranked verdicts). */
export type SignalInsufficientReason = 'undersampled' | 'length-inconsistent' | 'no-response';

export interface SignalCandidateScore {
  ecu: number;
  did: number;
  /** The response length every sample agreed on; `null` when they disagreed (or there were none). */
  length: number | null;
  lengthConsistent: boolean;
  verdict: SignalVerdict;
  matchedEdges: number;
  expectedEdges: number;
  /** Samples in the baseline window that moved on the SCORED series (noise-floor aware for analogs). Item 3: "must be 0" — anything above 0 caps the verdict at `unrelated`. */
  baselineChanges: number;
  /** Samples in the baseline window whose WHOLE response differs from the modal baseline response — a restless block (e.g. the field's counter DID 0x29 0x5002) shows here even when its own quiet byte offsets score nothing. */
  responseBaselineChanges: number;
  /** Hex of the modal baseline response (the rest level), `null` with no baseline evidence. */
  restValueHex: string | null;
  /** Hex of the most recent sample overall. */
  lastRawHex: string;
  /** Unsigned big-endian decode across every sample, for 1–4 byte responses; `null` for blocks. */
  min: number | null;
  max: number | null;
  sampleCount: number;
  /** Evidence windows (baseline + each press group + each release) that held fewer than `minSamplesPerWindow` samples. */
  windowsBelowMinimum: number;
  /** Blocks only: the byte offset this score was computed on. `null` for a 1–4 byte response. */
  byteOffset: number | null;
  /** Analog shapes: the sign of the pressed-vs-rest mean shift (0 inside the noise floor). `null` for `boolean-edge`. */
  correlationSign: 1 | -1 | 0 | null;
  insufficientReason: SignalInsufficientReason | null;
}

export interface SignalScoringOptions {
  /** Default 2 (item 3). */
  minSamplesPerWindow?: number;
  /** Default 0.8 — "found (>= 4/5 edges)". */
  foundEdgeRatio?: number;
  /** Default 0.6 — "probable (>= 3/5)". */
  probableEdgeRatio?: number;
  /** Analog noise floor, in raw units, applied even when the baseline is perfectly still. Default 3 (same floor as the P4j change rule). */
  analogMarginRawUnits?: number;
  /** Analog noise floor as a multiple of the baseline's own P90–P10 spread. Default 2 (same as the P4j change rule). */
  analogMarginMultiplier?: number;
}

export interface ScoreSignalCandidatesInput {
  samples: readonly SignalFinderSample[];
  timeline: MetronomeTimeline;
  shape: SignalExpectedShape;
  options?: SignalScoringOptions;
}

const DEFAULT_FOUND_RATIO = 0.8;
const DEFAULT_PROBABLE_RATIO = 0.6;
const DEFAULT_MARGIN_RAW_UNITS = 3;
const DEFAULT_MARGIN_MULTIPLIER = 2;

const VERDICT_ORDER: Readonly<Record<SignalVerdict, number>> = {
  found: 0,
  probable: 1,
  unrelated: 2,
  insufficient: 3,
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** Unsigned big-endian decode for 1–4 byte responses; `null` for anything wider (those are scored per byte offset instead). */
function decodeUnsigned(raw: Uint8Array): number | null {
  if (raw.length < 1 || raw.length > 4) return null;
  let value = 0;
  for (const byte of raw) value = value * 256 + byte;
  return value;
}

function meanOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function percentileOfSorted(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0] as number;
  const position = q * (sortedAsc.length - 1);
  const low = sortedAsc[Math.floor(position)] as number;
  const high = sortedAsc[Math.ceil(position)] as number;
  return low + (high - low) * (position - Math.floor(position));
}

/** The baseline's own noise floor: its P90–P10 spread (robust to one outlier in a short window, unlike max-min). */
function spreadP90P10(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return percentileOfSorted(sorted, 0.9) - percentileOfSorted(sorted, 0.1);
}

/** The most frequent value, ties broken by first appearance (deterministic). */
function modeOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = values[0] as number;
  let bestCount = 0;
  for (const value of values) {
    const count = counts.get(value) ?? 0;
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

interface WindowedValues {
  baseline: number[];
  /** Press + hold values, keyed by repetition. */
  pressByRepetition: Map<number, number[]>;
  releaseByRepetition: Map<number, number[]>;
}

interface SeriesScore {
  matchedEdges: number;
  baselineChanges: number;
  correlationSign: 1 | -1 | 0 | null;
  byteOffset: number | null;
  verdict: SignalVerdict;
}

/** Scores ONE numeric series (a whole 1–4 byte response, or one byte offset of a block) against the metronome. */
function scoreSeries(
  windows: WindowedValues,
  shape: SignalExpectedShape,
  expectedEdges: number,
  byteOffset: number | null,
  options: Required<Omit<SignalScoringOptions, 'minSamplesPerWindow'>>,
): SeriesScore {
  const boolean = shape === 'boolean-edge';
  const restValue = boolean ? modeOf(windows.baseline) : meanOf(windows.baseline);
  const noiseFloor = boolean
    ? 0
    : Math.max(options.analogMarginRawUnits, options.analogMarginMultiplier * spreadP90P10(windows.baseline));

  const changed = (value: number): boolean =>
    boolean ? value !== restValue : Math.abs(value - (restValue as number)) > noiseFloor;
  /** `analog-monotone` only ever counts a change in the POSITIVE direction (a brake pressure that falls when pressed is not a brake pressure). */
  const changedInExpectedDirection = (value: number): boolean =>
    changed(value) && (shape !== 'analog-monotone' || value > (restValue as number));

  const baselineChanges = windows.baseline.filter(changed).length;

  let matchedEdges = 0;
  const allPressValues: number[] = [];
  for (const [repetition, pressValues] of windows.pressByRepetition) {
    allPressValues.push(...pressValues);
    const pressMatched = pressValues.some(changedInExpectedDirection);
    if (pressMatched) matchedEdges += 1;
    const releaseValues = windows.releaseByRepetition.get(repetition) ?? [];
    const lastRelease = releaseValues[releaseValues.length - 1];
    // A "change back" only counts if the value actually LEFT the rest level
    // in this repetition's press window first -- otherwise a DID that never
    // moves at all would score every release edge for free.
    if (pressMatched && lastRelease !== undefined && !changed(lastRelease)) matchedEdges += 1;
  }

  let correlationSign: 1 | -1 | 0 | null = null;
  if (!boolean) {
    const shift = meanOf(allPressValues) - (restValue as number);
    correlationSign = Math.abs(shift) <= noiseFloor ? 0 : shift > 0 ? 1 : -1;
  }

  const ratio = expectedEdges > 0 ? matchedEdges / expectedEdges : 0;
  const directionOk = shape !== 'analog-monotone' || correlationSign === 1;
  let verdict: SignalVerdict;
  if (baselineChanges > 0 || !directionOk) {
    verdict = 'unrelated';
  } else if (ratio >= options.foundEdgeRatio) {
    verdict = 'found';
  } else if (ratio >= options.probableEdgeRatio) {
    verdict = 'probable';
  } else {
    verdict = 'unrelated';
  }

  return { matchedEdges, baselineChanges, correlationSign, byteOffset, verdict };
}

/**
 * Scores every DID in `samples` against `timeline`. One entry per distinct
 * `(ecu, did)`, sorted `found` → `probable` → `unrelated` → `insufficient`,
 * then by matched edges (descending), then by ECU/DID for determinism.
 */
export function scoreSignalCandidates(input: ScoreSignalCandidatesInput): SignalCandidateScore[] {
  const minSamplesPerWindow = input.options?.minSamplesPerWindow ?? DEFAULT_MIN_SAMPLES_PER_WINDOW;
  const thresholds = {
    foundEdgeRatio: input.options?.foundEdgeRatio ?? DEFAULT_FOUND_RATIO,
    probableEdgeRatio: input.options?.probableEdgeRatio ?? DEFAULT_PROBABLE_RATIO,
    analogMarginRawUnits: input.options?.analogMarginRawUnits ?? DEFAULT_MARGIN_RAW_UNITS,
    analogMarginMultiplier: input.options?.analogMarginMultiplier ?? DEFAULT_MARGIN_MULTIPLIER,
  };
  const { timeline } = input;
  const repetitions = [...new Set(timeline.steps.filter((s) => s.repetition > 0).map((s) => s.repetition))];

  interface Group {
    ecu: number;
    did: number;
    raws: Uint8Array[];
    /** Evidence raws per step index. */
    byStep: Map<number, Uint8Array[]>;
    length: number | null;
    lengthConsistent: boolean;
  }
  const groups = new Map<string, Group>();
  for (const sample of input.samples) {
    const key = `${sample.ecu}:${sample.did}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { ecu: sample.ecu, did: sample.did, raws: [], byStep: new Map(), length: null, lengthConsistent: true };
      groups.set(key, group);
    }
    group.raws.push(sample.raw);
    if (group.length === null) group.length = sample.raw.length;
    else if (group.length !== sample.raw.length) group.lengthConsistent = false;
    const step = metronomeStepForSample(timeline, sample.tMs);
    if (step !== null) {
      const list = group.byStep.get(step.index) ?? [];
      list.push(sample.raw);
      group.byStep.set(step.index, list);
    }
  }

  const scores: SignalCandidateScore[] = [];
  for (const group of groups.values()) {
    const lastRawHex = bytesToHex(group.raws[group.raws.length - 1] ?? new Uint8Array());
    let min: number | null = null;
    let max: number | null = null;
    for (const raw of group.raws) {
      const decoded = decodeUnsigned(raw);
      if (decoded === null) continue;
      min = min === null ? decoded : Math.min(min, decoded);
      max = max === null ? decoded : Math.max(max, decoded);
    }

    const rawsOfKind = (kind: MetronomeStep['kind'], repetition: number): Uint8Array[] => {
      const out: Uint8Array[] = [];
      for (const step of timeline.steps) {
        if (step.kind !== kind || step.repetition !== repetition) continue;
        out.push(...(group.byStep.get(step.index) ?? []));
      }
      return out;
    };
    const baselineRaws = rawsOfKind('baseline', 0);
    const pressRawsByRepetition = new Map<number, Uint8Array[]>();
    const releaseRawsByRepetition = new Map<number, Uint8Array[]>();
    for (const repetition of repetitions) {
      pressRawsByRepetition.set(repetition, [...rawsOfKind('press', repetition), ...rawsOfKind('hold', repetition)]);
      releaseRawsByRepetition.set(repetition, rawsOfKind('release', repetition));
    }

    let windowsBelowMinimum = baselineRaws.length < minSamplesPerWindow ? 1 : 0;
    for (const repetition of repetitions) {
      if ((pressRawsByRepetition.get(repetition) ?? []).length < minSamplesPerWindow) windowsBelowMinimum += 1;
      if ((releaseRawsByRepetition.get(repetition) ?? []).length < minSamplesPerWindow) windowsBelowMinimum += 1;
    }

    // `baselineChanges` at the WHOLE-RESPONSE level: did ANYTHING in this
    // response move while the driver was holding still? (A block's own quiet
    // byte offsets must not make a restless counter look calm.)
    const baselineHexes = baselineRaws.map(bytesToHex);
    const restHexCounts = new Map<string, number>();
    for (const hex of baselineHexes) restHexCounts.set(hex, (restHexCounts.get(hex) ?? 0) + 1);
    let restValueHex: string | null = null;
    let restHexCount = 0;
    for (const hex of baselineHexes) {
      const count = restHexCounts.get(hex) ?? 0;
      if (count > restHexCount) {
        restValueHex = hex;
        restHexCount = count;
      }
    }
    const responseBaselineChanges = baselineHexes.filter((hex) => hex !== restValueHex).length;

    const base = {
      ecu: group.ecu,
      did: group.did,
      length: group.length,
      lengthConsistent: group.lengthConsistent,
      expectedEdges: timeline.expectedEdges,
      restValueHex,
      lastRawHex,
      min,
      max,
      sampleCount: group.raws.length,
      windowsBelowMinimum,
      responseBaselineChanges,
    };

    if (!group.lengthConsistent) {
      // A DID whose responses disagree on their own length supports no
      // comparison of any kind -- reported, never split into two candidates.
      scores.push({
        ...base,
        length: null,
        verdict: 'insufficient',
        matchedEdges: 0,
        baselineChanges: responseBaselineChanges,
        byteOffset: null,
        correlationSign: null,
        insufficientReason: 'length-inconsistent',
      });
      continue;
    }

    const length = group.length ?? 0;
    const seriesOffsets: (number | null)[] = length >= 1 && length <= 4 ? [null] : [];
    if (seriesOffsets.length === 0) for (let offset = 0; offset < length; offset += 1) seriesOffsets.push(offset);

    const seriesScores: SeriesScore[] = [];
    for (const offset of seriesOffsets) {
      const project = (raws: readonly Uint8Array[]): number[] =>
        offset === null
          ? raws.map((raw) => decodeUnsigned(raw) ?? 0)
          : raws.map((raw) => raw[offset] ?? 0);
      const windows: WindowedValues = {
        baseline: project(baselineRaws),
        pressByRepetition: new Map([...pressRawsByRepetition].map(([r, raws]) => [r, project(raws)])),
        releaseByRepetition: new Map([...releaseRawsByRepetition].map(([r, raws]) => [r, project(raws)])),
      };
      seriesScores.push(scoreSeries(windows, input.shape, timeline.expectedEdges, offset, thresholds));
    }

    // The DID is reported by its STRONGEST offset (a block's one live brake
    // bit is what matters), ties broken by more matched edges, then fewer
    // baseline changes, then the lower offset -- fully deterministic.
    const best =
      [...seriesScores].sort(
        (a, b) =>
          VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
          b.matchedEdges - a.matchedEdges ||
          a.baselineChanges - b.baselineChanges ||
          (a.byteOffset ?? -1) - (b.byteOffset ?? -1),
      )[0] ?? null;

    if (best === null || group.raws.length === 0) {
      scores.push({
        ...base,
        verdict: 'insufficient',
        matchedEdges: 0,
        baselineChanges: responseBaselineChanges,
        byteOffset: null,
        correlationSign: null,
        insufficientReason: 'no-response',
      });
      continue;
    }

    const insufficient = windowsBelowMinimum > 0;
    scores.push({
      ...base,
      verdict: insufficient ? 'insufficient' : best.verdict,
      matchedEdges: best.matchedEdges,
      baselineChanges: best.baselineChanges,
      byteOffset: best.byteOffset,
      correlationSign: best.correlationSign,
      insufficientReason: insufficient ? 'undersampled' : null,
    });
  }

  return scores.sort(
    (a, b) =>
      VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict] ||
      b.matchedEdges - a.matchedEdges ||
      a.ecu - b.ecu ||
      a.did - b.did,
  );
}
