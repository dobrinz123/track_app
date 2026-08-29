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
 * brake bit is still discoverable.
 *
 * P4l-FIX2 (Codex review P4l-REV1, findings 1, 2, 4, 6, 10) — four rules the
 * first cut got wrong, all of them cases where a DID that is NOT answering
 * the driver could still be ranked:
 *
 *  1. `baselineChanges` is a PER-DID rule, not a per-offset one. A block with
 *     a rolling counter byte next to a brake byte has a perfectly quiet
 *     winning offset; the DID as a whole is restless, so the whole DID is
 *     capped at `unrelated` ({@link SignalCandidateScore.didBaselineChanges},
 *     `verdictCapReason: 'response-baseline-changes'`). For analogs the
 *     per-DID count is noise-floor aware (a jittering LSB is not movement),
 *     which is why it is computed from the scored series rather than from raw
 *     hex equality — {@link SignalCandidateScore.responseBaselineChanges}
 *     keeps reporting the raw-hex view, and IS decisive for `boolean-edge`,
 *     where hex equality is the semantics.
 *  2. `analog-bipolar` means BOTH sides of rest (steering left AND right).
 *     A one-sided excursion is capped at `probable`, never `found`
 *     ({@link SignalCandidateScore.bipolarSides}).
 *  3. Edges are ORDERED TRANSITIONS, not mere presence: a rest->active
 *     transition must ARRIVE inside a (settle-shifted) press/hold window and
 *     an active->rest transition inside that repetition's release window.
 *     Every other in-window transition — a flip during the baseline or the
 *     hold, a second flip inside one window — is an EXTRA transition and is
 *     subtracted from the matched edges before the ratio is taken, which is
 *     what separates a brake switch from a DID that merely toggles at its own
 *     rhythm. (A transition whose ARRIVING sample lands in the window counts:
 *     that is how a press window that reads `[05, 05]` after a release window
 *     that read `[04, 04]` is credited — the driver pressed at the boundary.)
 *  4. The `< 2 samples per window` gate is applied to EVERY step of the
 *     timeline on its own (press and hold are separate windows), before any
 *     aggregation.
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

/** Why a DID's verdict was lowered below what its edge ratio alone would have given. */
export type SignalVerdictCapReason = 'response-baseline-changes' | 'one-sided-bipolar' | 'extra-transitions';

/** Which sides of rest an analog DID actually visited during the press windows. */
export type SignalBipolarSides = 'both' | 'positive' | 'negative' | 'none';

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
  /** Unsigned big-endian decode across every sample for 1–4 byte responses; for blocks, the SELECTED byte offset's own range. `null` only without a scored series. */
  min: number | null;
  max: number | null;
  sampleCount: number;
  /** Timeline steps (each press, hold, release and the baseline on their own) that held fewer than `minSamplesPerWindow` samples. */
  windowsBelowMinimum: number;
  /** Blocks only: the byte offset this score was computed on. `null` for a 1–4 byte response. */
  byteOffset: number | null;
  /** Analog shapes: the sign of the pressed-vs-rest mean shift (0 inside the noise floor). `null` for `boolean-edge`. */
  correlationSign: 1 | -1 | 0 | null;
  insufficientReason: SignalInsufficientReason | null;
  /**
   * P4l-FIX2 (finding 1): baseline samples at which ANY scored series of this
   * DID moved — the per-DID reading of item 3's "baselineChanges (must be 0)".
   * Optional only so existing callers' object literals keep compiling;
   * {@link scoreSignalCandidates} always sets it.
   */
  didBaselineChanges?: number;
  /** P4l-FIX2 (finding 10): in-window transitions that no expected edge accounts for (baseline/hold flips, second flips inside one window). Subtracted from `matchedEdges` before the ratio. */
  extraTransitions?: number;
  /** P4l-FIX2 (finding 2): which sides of rest the press windows visited. `null` for shapes other than `analog-bipolar`. */
  bipolarSides?: SignalBipolarSides | null;
  /** P4l-FIX2: why the verdict is lower than the edge ratio alone would give; `null` when nothing capped it. */
  verdictCapReason?: SignalVerdictCapReason | null;
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

/** One projected sample in tMs order, with the metronome step it is evidence for (`null` outside every evidence window). */
interface SeriesPoint {
  value: number;
  step: MetronomeStep | null;
}

interface SeriesScore {
  matchedEdges: number;
  extraTransitions: number;
  baselineChanges: number;
  /** Per baseline sample, in order: did THIS series move there? (OR-ed across offsets to get the per-DID count.) */
  baselineActive: boolean[];
  correlationSign: 1 | -1 | 0 | null;
  bipolarSides: SignalBipolarSides | null;
  byteOffset: number | null;
  verdict: SignalVerdict;
  /** The extra transitions alone lowered this series' verdict. */
  cappedByExtraTransitions: boolean;
}

type ScoringThresholds = Required<Omit<SignalScoringOptions, 'minSamplesPerWindow'>>;

/**
 * Scores ONE numeric series (a whole 1–4 byte response, or one byte offset of
 * a block) against the metronome, as ORDERED TRANSITIONS (see this module's
 * doc comment, P4l-FIX2 rule 3).
 */
function scoreSeries(
  points: readonly SeriesPoint[],
  shape: SignalExpectedShape,
  repetitions: readonly number[],
  expectedEdges: number,
  byteOffset: number | null,
  options: ScoringThresholds,
): SeriesScore {
  const boolean = shape === 'boolean-edge';
  const baselineValues = points.filter((p) => p.step?.kind === 'baseline').map((p) => p.value);
  const restValue = boolean ? modeOf(baselineValues) : meanOf(baselineValues);
  const noiseFloor = boolean
    ? 0
    : Math.max(options.analogMarginRawUnits, options.analogMarginMultiplier * spreadP90P10(baselineValues));

  /** "Away from rest" — the noise floor makes this a real excursion for analogs. */
  const active = (value: number): boolean =>
    boolean ? value !== restValue : Math.abs(value - (restValue as number)) > noiseFloor;

  const baselineActive = baselineValues.map(active);
  const baselineChanges = baselineActive.filter(Boolean).length;

  const pressValuesByRepetition = new Map<number, number[]>();
  const releaseValuesByRepetition = new Map<number, number[]>();
  for (const point of points) {
    const step = point.step;
    if (step === null) continue;
    if (step.kind === 'press' || step.kind === 'hold') {
      const list = pressValuesByRepetition.get(step.repetition) ?? [];
      list.push(point.value);
      pressValuesByRepetition.set(step.repetition, list);
    } else if (step.kind === 'release') {
      const list = releaseValuesByRepetition.get(step.repetition) ?? [];
      list.push(point.value);
      releaseValuesByRepetition.set(step.repetition, list);
    }
  }

  // Ordered transitions, attributed to the step the ARRIVING sample belongs to.
  interface Transition {
    step: MetronomeStep;
    up: boolean;
    value: number;
  }
  const transitions: Transition[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1] as SeriesPoint;
    const current = points[i] as SeriesPoint;
    const arrivedActive = active(current.value);
    if (arrivedActive === active(previous.value)) continue;
    if (current.step === null) continue; // landed outside every evidence window — unattributable, not evidence either way.
    transitions.push({ step: current.step, up: arrivedActive, value: current.value });
  }

  let matchedEdges = 0;
  for (const repetition of repetitions) {
    const pressUp = transitions.filter(
      (t) =>
        t.up &&
        t.step.repetition === repetition &&
        (t.step.kind === 'press' || t.step.kind === 'hold') &&
        // `analog-monotone` only ever counts an excursion in the POSITIVE
        // direction (a brake pressure that falls when pressed is not a brake
        // pressure).
        (shape !== 'analog-monotone' || t.value > (restValue as number)),
    );
    if (pressUp.length === 0) continue;
    matchedEdges += 1;
    const releaseDown = transitions.filter(
      (t) => !t.up && t.step.repetition === repetition && t.step.kind === 'release',
    );
    const releaseValues = releaseValuesByRepetition.get(repetition) ?? [];
    const lastRelease = releaseValues[releaseValues.length - 1];
    // A "change back" needs BOTH an observed active->rest transition inside
    // this release window and a window that actually ends at rest.
    if (releaseDown.length > 0 && lastRelease !== undefined && !active(lastRelease)) matchedEdges += 1;
  }
  // Every in-window transition that no matched edge accounts for is noise the
  // DID produced on its own schedule.
  const extraTransitions = Math.max(0, transitions.length - matchedEdges);

  const allPressValues = [...pressValuesByRepetition.values()].flat();
  let correlationSign: 1 | -1 | 0 | null = null;
  let bipolarSides: SignalBipolarSides | null = null;
  if (!boolean) {
    const shift = meanOf(allPressValues) - (restValue as number);
    correlationSign = Math.abs(shift) <= noiseFloor ? 0 : shift > 0 ? 1 : -1;
  }
  if (shape === 'analog-bipolar') {
    let positive = false;
    let negative = false;
    for (const value of allPressValues) {
      if (value - (restValue as number) > noiseFloor) positive = true;
      else if ((restValue as number) - value > noiseFloor) negative = true;
    }
    bipolarSides = positive && negative ? 'both' : positive ? 'positive' : negative ? 'negative' : 'none';
  }

  const verdictForEdges = (edges: number): SignalVerdict => {
    const ratio = expectedEdges > 0 ? edges / expectedEdges : 0;
    if (ratio >= options.foundEdgeRatio) return 'found';
    if (ratio >= options.probableEdgeRatio) return 'probable';
    return 'unrelated';
  };

  const directionOk = shape !== 'analog-monotone' || correlationSign === 1;
  const disqualified = baselineChanges > 0 || !directionOk;
  const netEdges = Math.max(0, matchedEdges - extraTransitions);
  const verdict = disqualified ? 'unrelated' : verdictForEdges(netEdges);
  const cappedByExtraTransitions =
    !disqualified && extraTransitions > 0 && verdictForEdges(matchedEdges) !== verdict;

  return {
    matchedEdges,
    extraTransitions,
    baselineChanges,
    baselineActive,
    correlationSign,
    bipolarSides,
    byteOffset,
    verdict,
    cappedByExtraTransitions,
  };
}

/**
 * Scores every DID in `samples` against `timeline`. One entry per distinct
 * `(ecu, did)`, sorted `found` → `probable` → `unrelated` → `insufficient`,
 * then by matched edges (descending), then by ECU/DID for determinism.
 */
export function scoreSignalCandidates(input: ScoreSignalCandidatesInput): SignalCandidateScore[] {
  const minSamplesPerWindow = input.options?.minSamplesPerWindow ?? DEFAULT_MIN_SAMPLES_PER_WINDOW;
  const thresholds: ScoringThresholds = {
    foundEdgeRatio: input.options?.foundEdgeRatio ?? DEFAULT_FOUND_RATIO,
    probableEdgeRatio: input.options?.probableEdgeRatio ?? DEFAULT_PROBABLE_RATIO,
    analogMarginRawUnits: input.options?.analogMarginRawUnits ?? DEFAULT_MARGIN_RAW_UNITS,
    analogMarginMultiplier: input.options?.analogMarginMultiplier ?? DEFAULT_MARGIN_MULTIPLIER,
  };
  const { timeline } = input;
  const repetitions = [...new Set(timeline.steps.filter((s) => s.repetition > 0).map((s) => s.repetition))];

  interface Entry {
    tMs: number;
    raw: Uint8Array;
    step: MetronomeStep | null;
  }
  interface Group {
    ecu: number;
    did: number;
    /** Every sample, in tMs order — the ordered-transition rule needs the sequence, not just the buckets. */
    entries: Entry[];
    /** How many samples each timeline step collected (the per-window sufficiency gate). */
    countByStep: Map<number, number>;
    length: number | null;
    lengthConsistent: boolean;
  }
  const groups = new Map<string, Group>();
  for (const sample of input.samples) {
    const key = `${sample.ecu}:${sample.did}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { ecu: sample.ecu, did: sample.did, entries: [], countByStep: new Map(), length: null, lengthConsistent: true };
      groups.set(key, group);
    }
    if (group.length === null) group.length = sample.raw.length;
    else if (group.length !== sample.raw.length) group.lengthConsistent = false;
    const step = metronomeStepForSample(timeline, sample.tMs);
    if (step !== null) group.countByStep.set(step.index, (group.countByStep.get(step.index) ?? 0) + 1);
    group.entries.push({ tMs: sample.tMs, raw: sample.raw, step });
  }

  const scores: SignalCandidateScore[] = [];
  for (const group of groups.values()) {
    group.entries.sort((a, b) => a.tMs - b.tMs);
    const raws = group.entries.map((e) => e.raw);
    const lastRawHex = bytesToHex(raws[raws.length - 1] ?? new Uint8Array());
    let min: number | null = null;
    let max: number | null = null;
    for (const raw of raws) {
      const decoded = decodeUnsigned(raw);
      if (decoded === null) continue;
      min = min === null ? decoded : Math.min(min, decoded);
      max = max === null ? decoded : Math.max(max, decoded);
    }

    // P4l-FIX2 (finding 6): EVERY step of the timeline is gated on its own —
    // press and hold are separate evidence windows, so a script that collects
    // nothing during the press but two samples during the hold is
    // undersampled, not "sufficient".
    let windowsBelowMinimum = 0;
    for (const step of timeline.steps) {
      if (step.durationMs <= 0) continue;
      if ((group.countByStep.get(step.index) ?? 0) < minSamplesPerWindow) windowsBelowMinimum += 1;
    }

    // Whole-response restlessness, at raw-hex level: did ANYTHING in this
    // response move while the driver was holding still?
    const baselineHexes = group.entries
      .filter((e) => e.step?.kind === 'baseline')
      .map((e) => bytesToHex(e.raw));
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
      sampleCount: raws.length,
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
        didBaselineChanges: responseBaselineChanges,
        extraTransitions: 0,
        bipolarSides: null,
        byteOffset: null,
        correlationSign: null,
        insufficientReason: 'length-inconsistent',
        verdictCapReason: null,
      });
      continue;
    }

    const length = group.length ?? 0;
    const seriesOffsets: (number | null)[] = length >= 1 && length <= 4 ? [null] : [];
    if (seriesOffsets.length === 0) for (let offset = 0; offset < length; offset += 1) seriesOffsets.push(offset);

    const seriesScores: SeriesScore[] = [];
    for (const offset of seriesOffsets) {
      const points: SeriesPoint[] = group.entries.map((entry) => ({
        value: offset === null ? decodeUnsigned(entry.raw) ?? 0 : entry.raw[offset] ?? 0,
        step: entry.step,
      }));
      seriesScores.push(
        scoreSeries(points, input.shape, repetitions, timeline.expectedEdges, offset, thresholds),
      );
    }

    // P4l-FIX2 (finding 1): item 3's "baselineChanges (must be 0)" is a
    // per-DID rule. A baseline sample counts as movement when ANY scored
    // series of this DID moved there -- so a block's rolling counter byte
    // disqualifies the whole DID even though the brake byte next to it is
    // perfectly quiet -- while the analog noise floor still keeps a jittering
    // LSB from disqualifying an otherwise clean analog.
    let didBaselineChanges = 0;
    const baselineSampleCount = baselineHexes.length;
    for (let i = 0; i < baselineSampleCount; i += 1) {
      if (seriesScores.some((series) => series.baselineActive[i] === true)) didBaselineChanges += 1;
    }
    // For `boolean-edge` the raw-hex view IS the semantics (no noise floor),
    // so a restless response disqualifies even if no single offset's mode says so.
    const restlessBaseline =
      didBaselineChanges > 0 || (input.shape === 'boolean-edge' && responseBaselineChanges > 0);

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

    if (best === null || raws.length === 0) {
      scores.push({
        ...base,
        verdict: 'insufficient',
        matchedEdges: 0,
        baselineChanges: responseBaselineChanges,
        didBaselineChanges,
        extraTransitions: 0,
        bipolarSides: null,
        byteOffset: null,
        correlationSign: null,
        insufficientReason: 'no-response',
        verdictCapReason: null,
      });
      continue;
    }

    // P4l-FIX2 (finding 4): a block reports the SELECTED offset's own range,
    // so the summary never carries a null min/max for a scored candidate.
    if (best.byteOffset !== null) {
      const offset = best.byteOffset;
      min = null;
      max = null;
      for (const raw of raws) {
        const value = raw[offset] ?? 0;
        min = min === null ? value : Math.min(min, value);
        max = max === null ? value : Math.max(max, value);
      }
    }

    let verdict = best.verdict;
    let verdictCapReason: SignalVerdictCapReason | null = best.cappedByExtraTransitions
      ? 'extra-transitions'
      : null;
    if (restlessBaseline && verdict !== 'unrelated') {
      verdict = 'unrelated';
      verdictCapReason = 'response-baseline-changes';
    }
    // P4l-FIX2 (finding 2): a bipolar target must have been seen on BOTH
    // sides of rest before it can be `found`.
    if (input.shape === 'analog-bipolar' && best.bipolarSides !== 'both' && verdict === 'found') {
      verdict = 'probable';
      verdictCapReason = 'one-sided-bipolar';
    }

    const insufficient = windowsBelowMinimum > 0;
    scores.push({
      ...base,
      min,
      max,
      verdict: insufficient ? 'insufficient' : verdict,
      matchedEdges: best.matchedEdges,
      baselineChanges: best.baselineChanges,
      didBaselineChanges,
      extraTransitions: best.extraTransitions,
      bipolarSides: best.bipolarSides,
      byteOffset: best.byteOffset,
      correlationSign: best.correlationSign,
      insufficientReason: insufficient ? 'undersampled' : null,
      verdictCapReason: insufficient ? null : verdictCapReason,
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
