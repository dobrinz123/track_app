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
 *     where hex equality is the semantics. P4l-FIX4 (N1) narrows the noise
 *     floor to the SCORED byte alone: every other byte of the same response
 *     is compared exactly, for every shape, so a counter advancing by one
 *     per read can no longer hide inside the analog floor.
 *  2. `analog-bipolar` means BOTH sides of rest (steering left AND right).
 *     A one-sided excursion is `unrelated` -- P4l-FIX4 (N2); FIX2 only
 *     demoted it to `probable`, which is still a ranked verdict
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
export type SignalVerdictCapReason =
  | 'response-baseline-changes'
  | 'one-sided-bipolar'
  | 'extra-transitions'
  /** P4m (item 11): the DID answered the WHOLE script with one identical response — it did not answer the driver. */
  | 'never-moved'
  /**
   * Ticket P4o O2 (binding, field test 8): an `analog-monotone`/`analog-bipolar`
   * target's scored series took on <= 2 distinct values (after its own noise
   * floor) for the WHOLE run — switch-like, not analog. Field test 8: the
   * generic profile's brakePressure find scored DME 0x12 0x4002 `found`
   * (0x83 rest / 0x9B pressed, nothing in between) and let the user confirm
   * it over the real, GRADED 0x58B7 (26–64, many intermediate levels). Never
   * `found`, capped at `probable`; a DECLARED or evidence-detected flag
   * (`SignalCandidateScore.flagBit` / a catalog `boolean-edge` hypothesis) is
   * a different signal and is exempt.
   */
  | 'two-level';

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
  /**
   * P4m (contracts.md item 11, binding): this verdict rests on SPARSE but
   * consistent evidence — every press and every release window held at least
   * one sample, but some held fewer than `minSamplesPerWindow`. The screen
   * and the export say "found (sparse)", so the user can tell "seen 3x in
   * every window" from "seen once in every window, every time".
   */
  sparse?: boolean;
  /**
   * P4m (item 11 / field test 5): the DID's two levels differ in exactly ONE
   * bit (DME 0x4007: `0x9001` at rest, `0x9000` while the accelerator is
   * pressed) — a FLAG inside a word, not an analog reading, so the
   * `analog-monotone` direction rule does not apply to it. The bit's index
   * (0 = LSB), or `null` when the series is not a two-level single-bit flag.
   */
  flagBit?: number | null;
  /**
   * P4m (item 11): edges counted by WINDOW AGREEMENT — a press window that
   * holds an actuated sample, a release window that holds a rest sample —
   * rather than by observed transitions. This is what a one-sample-per-window
   * series can still prove; {@link SignalCandidateScore.matchedEdges} stays
   * the transition-based count.
   */
  windowMatchedEdges?: number;
  /**
   * Ticket P4n-FIX1 R5 (binding): for a boolean/flag DID (`flagBit` set, or
   * the target's own `expectedShape` is `boolean-edge`) — the WHOLE-RESPONSE
   * hex of a sample actually observed "active" (a press/hold-window sample
   * whose scored series differed from the rest level) during THIS session,
   * in the SAME whole-response representation `restValueHex` already uses.
   * The modal (most frequent) such hex, so one stray misread does not decide
   * it. `undefined` for an analog DID (no single "active level" to name --
   * only a direction), and for a boolean/flag DID with no rest level to
   * compare against or no active sample ever observed.
   */
  activeValueHex?: string;
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
  /**
   * P4m-FIX1 X6 (Codex P4m-REV1 finding 7): `(ecu, did)` pairs the TARGET
   * CATALOG declares to be a boolean flag inside a word — `targets.ts`'s
   * `SignalTargetHypothesis.expectedShape: 'boolean-edge'` (DME 0x4007 is the
   * field's own case). Reason (a) of the flag exception below; everything
   * else must earn it from the evidence, reason (b). Data, never a constant
   * in this module.
   */
  declaredFlagDids?: readonly { ecu: number; did: number }[];
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

/**
 * P4m (item 11): the index of the ONE bit that separates a two-level series,
 * or `null` when the series has any other number of levels or its two levels
 * differ in more than one bit. Values are unsigned 32-bit at most
 * ({@link decodeUnsigned}'s own range), so `>>> 0` keeps the XOR unsigned.
 */
function singleBitFlag(values: readonly number[]): number | null {
  const distinct = new Set(values);
  if (distinct.size !== 2) return null;
  const [a, b] = [...distinct] as [number, number];
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a > 0xffffffff || b > 0xffffffff) return null;
  const xor = (a ^ b) >>> 0;
  if (xor === 0 || ((xor & (xor - 1)) >>> 0) !== 0) return null;
  return Math.round(Math.log2(xor));
}

/**
 * Ticket P4n-FIX1 R5 (binding, Codex re-review MEDIUM): the confirm path used
 * to INFER a binding's active level from `min`/`max` after the fact, which
 * cannot prove a two-level series (a wider excursion looks identical) and
 * has no answer at all for a block series (`min`/`max` there is a single
 * BYTE's range, not a whole response). The scorer already knows exactly
 * which samples were "active" -- this returns the modal WHOLE-RESPONSE hex
 * (the SAME representation `restValueHex` uses) among the press/hold-window
 * samples that read away from `restScalar` at `byteOffset` (`null` = the
 * whole response is the series). `undefined` when there is no rest level to
 * compare against, or no such sample was ever observed.
 */
function deriveActiveValueHex(
  entries: readonly { raw: Uint8Array; step: MetronomeStep | null }[],
  byteOffset: number | null,
  restScalar: number | null,
): string | undefined {
  if (restScalar === null) return undefined;
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.step === null || (entry.step.kind !== 'press' && entry.step.kind !== 'hold')) continue;
    const value = byteOffset === null ? decodeUnsigned(entry.raw) : (entry.raw[byteOffset] ?? null);
    if (value === null || value === restScalar) continue;
    const hex = bytesToHex(entry.raw);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  let bestHex: string | undefined;
  let bestCount = 0;
  for (const [hex, count] of counts) {
    if (count > bestCount) {
      bestHex = hex;
      bestCount = count;
    }
  }
  return bestHex;
}

/**
 * Ticket P4o O2 (binding): the number of distinct LEVELS `values` visits,
 * merging any two values whose gap is <= `floor` into the same level
 * (single-linkage over the distinct values, ascending) -- the same noise
 * floor `scoreSeries` already uses to decide "away from rest" for an analog
 * series. A graded reading (field: DME 0x58B7, 26–64 with many intermediate
 * values inside the press windows) resolves to several levels; a switch
 * dressed up as an analog reading (field: DME 0x4002, 0x83 rest / 0x9B
 * pressed, nothing between) resolves to exactly 2.
 */
function countDistinctLevels(values: readonly number[], floor: number): number {
  const distinctSorted = [...new Set(values)].sort((a, b) => a - b);
  if (distinctSorted.length === 0) return 0;
  let levels = 1;
  for (let i = 1; i < distinctSorted.length; i += 1) {
    if ((distinctSorted[i] as number) - (distinctSorted[i - 1] as number) > floor) levels += 1;
  }
  return levels;
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
  /** Per baseline sample, in order: did THIS series move there? (noise-floor aware; used for the SCORED series). */
  baselineActive: boolean[];
  /**
   * P4l-FIX4 (N1): the same question asked EXACTLY -- did this byte differ
   * from its own modal baseline value, no noise floor? Used for every series
   * the verdict is NOT about, so a rolling counter byte sitting next to the
   * scored byte is restlessness whatever the shape.
   */
  baselineActiveStrict: boolean[];
  correlationSign: 1 | -1 | 0 | null;
  bipolarSides: SignalBipolarSides | null;
  byteOffset: number | null;
  verdict: SignalVerdict;
  /** The extra transitions alone lowered this series' verdict. */
  cappedByExtraTransitions: boolean;
  /** P4m (item 11): edges proved by WINDOW AGREEMENT rather than by observed transitions. */
  windowMatchedEdges: number;
  /** P4m (item 11): the single bit that separates this series' two levels, or `null` when it is not a two-level flag. */
  flagBit: number | null;
  /** P4m (item 11): everything the sparse-but-consistent rule can decide from THIS series alone (window coverage is a per-DID fact, applied by the caller). */
  sparseConsistent: boolean;
  /**
   * Ticket P4n-FIX1 R5 (binding): whether THIS series was read as boolean/flag
   * (`shape === 'boolean-edge'` or a detected `flagBit`) -- the DID-level loop
   * only derives {@link SignalCandidateScore.activeValueHex} for such a
   * series, never for a plain analog reading (which has no single "active
   * level", only a direction).
   */
  booleanLike: boolean;
  /**
   * Ticket P4o O2 (binding): for a NON-boolean series (`!booleanLike`), does
   * its whole run collapse to <= 2 distinct levels once values within the
   * series' own noise floor are merged? Always `false` for a boolean/flag
   * series (the two-level cap is about an analog reading that turns out to
   * be switch-like, not about a switch itself).
   */
  twoLevel: boolean;
  /**
   * Ticket P4n-FIX1 R5 (binding): the exact rest level THIS series compared
   * every sample against (`modeOf` for boolean/flag, `meanOf` for analog) --
   * exposed so the DID-level loop can classify a press/hold sample as
   * "active" using the SAME criterion the series itself used, rather than
   * re-deriving (and potentially disagreeing with) it. `null` only when there
   * was no baseline evidence at all for a boolean/flag series.
   */
  restScalar: number | null;
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
  /**
   * P4m-FIX1 X6: may this series' two levels be read as a FLAG (and so escape
   * the analog direction rule)? Decided per DID by the caller — the catalog
   * declared it, or every action window held >= 2 AGREEING samples.
   */
  flagExceptionAllowed: boolean,
): SeriesScore {
  const baselineValues = points.filter((p) => p.step?.kind === 'baseline').map((p) => p.value);
  // P4m (item 11, field test 5): a series that only ever takes TWO values
  // differing in exactly ONE bit is a FLAG inside a word (DME 0x4007:
  // 0x9001 at rest, 0x9000 while the accelerator is pressed), not an analog
  // reading. Two consequences, both narrow: the analog noise floor must not
  // swallow its 1-LSB step, and the `analog-monotone` direction rule does
  // not apply to it (a flag that CLEARS when actuated is just as much an
  // answer as one that sets). Anything that moves by more than one bit
  // (e.g. 0x0150 -> 0x0000) keeps the analog rules in full.
  //
  // P4m-FIX1 X6 (Codex P4m-REV1 finding 7): the XOR SHAPE ALONE is not enough
  // to earn that waiver -- an LSB counter or a jittering bit, caught once per
  // window, has exactly the same shape. The exception now needs an
  // independent reason (catalog declaration, or >= 2 agreeing samples in
  // every action window), which the caller passes in.
  const flagBit = flagExceptionAllowed ? singleBitFlag(points.map((p) => p.value)) : null;
  const boolean = shape === 'boolean-edge' || flagBit !== null;
  const restValue = boolean ? modeOf(baselineValues) : meanOf(baselineValues);
  const noiseFloor = boolean
    ? 0
    : Math.max(options.analogMarginRawUnits, options.analogMarginMultiplier * spreadP90P10(baselineValues));
  // P4o O2: computed over the WHOLE run (every point, every window), using
  // the same noise floor the active()/direction logic below already uses --
  // this is a fact about the series, independent of the metronome timing.
  const twoLevel = !boolean && countDistinctLevels(points.map((p) => p.value), noiseFloor) <= 2;

  /** "Away from rest" — the noise floor makes this a real excursion for analogs. */
  const active = (value: number): boolean =>
    boolean ? value !== restValue : Math.abs(value - (restValue as number)) > noiseFloor;

  const baselineActive = baselineValues.map(active);
  const baselineChanges = baselineActive.filter(Boolean).length;
  // P4l-FIX4 (N1): the noise-floor-free view of the same window. `modeOf`
  // (not the mean) is the rest level here -- an exact comparison needs an
  // exact reference.
  const strictRest = modeOf(baselineValues);
  const baselineActiveStrict = baselineValues.map((value) => value !== strictRest);

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
        // pressure) -- unless the series is a single-bit FLAG, which has no
        // magnitude and therefore no direction to be wrong about (P4m: DME
        // 0x4007 CLEARS bit 0 while the accelerator is pressed).
        (shape !== 'analog-monotone' || flagBit !== null || t.value > (restValue as number)),
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

  // P4m (item 11, binding): "A DID whose every press window and every release
  // window contains >= 1 sample, whose matched edges >= 80 % of expected,
  // with 0 extra transitions and 0 baseline changes, is `found` (flagged
  // `sparse`)". At one sample per window a TRANSITION is often unobservable
  // (the sample before it belongs to the previous window), but AGREEMENT
  // still is: the press window read the actuated level, the release window
  // read the rest level. That is what the field's own 0x4002 run proves ten
  // times over -- and what build 5 threw away as `insufficient`.
  const directionOk = shape !== 'analog-monotone' || flagBit !== null || correlationSign === 1;
  let windowMatchedEdges = 0;
  for (const repetition of repetitions) {
    const pressValues = pressValuesByRepetition.get(repetition) ?? [];
    const releaseValues = releaseValuesByRepetition.get(repetition) ?? [];
    const pressedSeen = pressValues.some(
      (value) =>
        active(value) &&
        // Same direction discipline as the transition rule: a monotone target
        // only ever counts an excursion AWAY FROM rest in the positive
        // direction (a flag has no direction to speak of).
        (shape !== 'analog-monotone' || flagBit !== null || value > (restValue as number)),
    );
    if (pressedSeen) windowMatchedEdges += 1;
    // A release window is credited when it read the rest level at all -- the
    // driver's foot comes off inside the window, so the first sample of it
    // may still be actuated.
    if (releaseValues.some((value) => !active(value))) windowMatchedEdges += 1;
  }

  const verdictForEdges = (edges: number): SignalVerdict => {
    const ratio = expectedEdges > 0 ? edges / expectedEdges : 0;
    if (ratio >= options.foundEdgeRatio) return 'found';
    if (ratio >= options.probableEdgeRatio) return 'probable';
    return 'unrelated';
  };

  const disqualified = baselineChanges > 0 || !directionOk;
  const netEdges = Math.max(0, matchedEdges - extraTransitions);
  const verdict = disqualified ? 'unrelated' : verdictForEdges(netEdges);
  const cappedByExtraTransitions =
    !disqualified && extraTransitions > 0 && verdictForEdges(matchedEdges) !== verdict;

  // Everything item 11's rule can decide from THIS series: the DID-level
  // window coverage (every press/release window actually sampled) is added by
  // the caller, which is the only place that knows the whole response.
  const sparseConsistent =
    !disqualified &&
    extraTransitions === 0 &&
    baselineChanges === 0 &&
    expectedEdges > 0 &&
    windowMatchedEdges / expectedEdges >= options.foundEdgeRatio;

  return {
    matchedEdges,
    extraTransitions,
    baselineChanges,
    baselineActive,
    baselineActiveStrict,
    correlationSign,
    bipolarSides,
    byteOffset,
    verdict,
    cappedByExtraTransitions,
    windowMatchedEdges,
    flagBit,
    sparseConsistent,
    booleanLike: boolean,
    twoLevel,
    restScalar: restValue,
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
    // P4m (item 11/12): the coverage facts the new sufficiency rule is stated
    // in -- "some window has 0 samples", "< 2 samples per window on average",
    // and "every press window and every release window contains >= 1 sample".
    let windowCount = 0;
    let emptyWindows = 0;
    let inWindowSamples = 0;
    let baselineCovered = false;
    let pressCovered = false;
    let everyActionWindowCovered = true;
    for (const step of timeline.steps) {
      if (step.durationMs <= 0) continue;
      const count = group.countByStep.get(step.index) ?? 0;
      windowCount += 1;
      inWindowSamples += count;
      if (count < minSamplesPerWindow) windowsBelowMinimum += 1;
      if (count === 0) emptyWindows += 1;
      if (step.kind === 'baseline') {
        if (count > 0) baselineCovered = true;
      } else {
        if (count === 0) everyActionWindowCovered = false;
        if (count > 0 && (step.kind === 'press' || step.kind === 'hold')) pressCovered = true;
      }
    }
    const averagePerWindow = windowCount > 0 ? inWindowSamples / windowCount : 0;
    const undersampled = emptyWindows > 0 || averagePerWindow < minSamplesPerWindow;
    /**
     * A DID that answered the WHOLE script with one identical response did
     * not answer the driver -- that is knowledge, not a sampling failure.
     *
     * P4m-FIX1 X7 (Codex P4m-REV1 finding 8): "whole script" is now taken
     * literally. The old rule accepted the baseline plus ONE press window, so
     * a DID whose later presses were never sampled at all was reported as
     * `unrelated` -- a claim about the driver's action that the data did not
     * support. `never-moved` now needs exactly the coverage the sparse
     * `found` rule needs (item 11): the baseline sampled, and EVERY press and
     * release window sampled at least once. Anything thinner is
     * `insufficient`.
     */
    const neverMoved =
      raws.length >= 2 &&
      baselineCovered &&
      pressCovered &&
      everyActionWindowCovered &&
      raws.every((raw) => bytesToHex(raw) === bytesToHex(raws[0] as Uint8Array));

    /**
     * P4m (item 11, binding): "A DID whose every press window and every
     * release window contains >= 1 sample, whose matched edges >= 80 % of
     * expected, with 0 extra transitions and 0 baseline changes, is `found`
     * (flagged `sparse`)" — the per-series half is {@link SeriesScore.sparseConsistent};
     * the rest is this DID's own window coverage. Applied ONLY where the
     * evidence really is sparse: a fully-sampled run keeps the strict
     * ordered-transition rule, under which a DID that answered 3 of 5
     * presses is `probable`, not `found`.
     */
    const sparseFoundFor = (series: SeriesScore): boolean =>
      series.sparseConsistent &&
      baselineCovered &&
      everyActionWindowCovered &&
      windowsBelowMinimum > 0 &&
      // Sparseness is a reason to read thin evidence carefully, never a
      // reason to drop a shape requirement: a bipolar target must still have
      // been seen on BOTH sides of rest (P4l-FIX4 N2).
      (input.shape !== 'analog-bipolar' || series.bipolarSides === 'both');

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

    /**
     * P4m-FIX1 X6 (binding): the two independent reasons a two-level series
     * may be read as a FLAG rather than as an analog reading.
     *
     *  (a) the catalog DECLARED this (ecu, did) a boolean flag inside a word
     *      (`declaredFlagDids`, from the target's own hypothesis data), or
     *  (b) the evidence is dense AND self-consistent: every press/hold and
     *      release window held at least `minSamplesPerWindow` samples that
     *      AGREE with each other. That is precisely what an LSB counter or a
     *      jittering bit cannot do -- and it is why "sparse + flag" is no
     *      longer a combination that can reach `found`.
     *
     * A `boolean-edge` TARGET waives nothing (the series is already read as a
     * switch), so it keeps reporting its flag bit.
     */
    const declaredFlag = (input.declaredFlagDids ?? []).some(
      (ref) => ref.ecu === group.ecu && ref.did === group.did,
    );
    let denseAgreement = true;
    for (const step of timeline.steps) {
      if (step.durationMs <= 0 || step.kind === 'baseline') continue;
      const inStep = group.entries.filter((entry) => entry.step?.index === step.index);
      if (inStep.length < minSamplesPerWindow) {
        denseAgreement = false;
        break;
      }
      const first = bytesToHex(inStep[0]!.raw);
      if (inStep.some((entry) => bytesToHex(entry.raw) !== first)) {
        denseAgreement = false;
        break;
      }
    }
    const flagExceptionAllowed = input.shape === 'boolean-edge' || declaredFlag || denseAgreement;

    const seriesScores: SeriesScore[] = [];
    for (const offset of seriesOffsets) {
      const points: SeriesPoint[] = group.entries.map((entry) => ({
        value: offset === null ? decodeUnsigned(entry.raw) ?? 0 : entry.raw[offset] ?? 0,
        step: entry.step,
      }));
      seriesScores.push(
        scoreSeries(points, input.shape, repetitions, timeline.expectedEdges, offset, thresholds, flagExceptionAllowed),
      );
    }

    // The DID is reported by its STRONGEST offset (a block's one live brake
    // bit is what matters), ties broken by more matched edges, then fewer
    // baseline changes, then the lower offset -- fully deterministic.
    // P4m: a series the sparse rule can carry ranks as `found` for the
    // purpose of CHOOSING the offset -- otherwise a block's one sparse-but-
    // consistent byte would lose the tie to a byte that merely scored more
    // transitions.
    const effectiveRank = (series: SeriesScore): number => VERDICT_ORDER[sparseFoundFor(series) ? 'found' : series.verdict];
    const best =
      [...seriesScores].sort(
        (a, b) =>
          effectiveRank(a) - effectiveRank(b) ||
          b.matchedEdges - a.matchedEdges ||
          a.baselineChanges - b.baselineChanges ||
          (a.byteOffset ?? -1) - (b.byteOffset ?? -1),
      )[0] ?? null;

    // P4l-FIX2 (finding 1) as corrected by P4l-FIX4 (N1): item 3's
    // "baselineChanges (must be 0)" is a per-DID rule, and the analog noise
    // floor is a statement about the SCORED series only.
    //
    // The scored byte is the one the verdict is about, so its own jitter is
    // judged with the noise floor (a wobbling LSB is not the driver). Every
    // OTHER byte of the same response is judged EXACTLY: a rolling counter
    // advancing by one per read used to slip through both gates at once --
    // inside the >= 3-unit analog floor on its own offset, and never seen at
    // the whole-response level because that view was consulted for
    // `boolean-edge` alone. Whatever the shape, a response that moves while
    // the driver is holding still is not answering the driver.
    let didBaselineChanges = 0;
    const baselineSampleCount = baselineHexes.length;
    for (let i = 0; i < baselineSampleCount; i += 1) {
      const restless = seriesScores.some((series) =>
        series === best ? series.baselineActive[i] === true : series.baselineActiveStrict[i] === true,
      );
      if (restless) didBaselineChanges += 1;
    }
    // For `boolean-edge` the raw-hex view IS the semantics (no noise floor),
    // so a restless response disqualifies even if no single offset's mode says so.
    const restlessBaseline =
      didBaselineChanges > 0 || (input.shape === 'boolean-edge' && responseBaselineChanges > 0);

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
    if (neverMoved) {
      verdict = 'unrelated';
      verdictCapReason = 'never-moved';
    }
    // P4l-FIX2 (finding 2) as corrected by P4l-FIX4 (N2): a bipolar target
    // must have been seen on BOTH sides of rest before it can be RANKED at
    // all. One-sided evidence is not a weaker steering angle -- a channel
    // that only ever leaves rest upwards is a different signal, and calling
    // it `probable` invited exactly the wrong binding to be confirmed.
    if (
      input.shape === 'analog-bipolar' &&
      best.bipolarSides !== 'both' &&
      (verdict === 'found' || verdict === 'probable')
    ) {
      verdict = 'unrelated';
      verdictCapReason = 'one-sided-bipolar';
    }

    // P4m (contracts.md item 11, binding), in strict order:
    //
    //  1. A DISQUALIFYING fact (a restless baseline, or a response that never
    //     moved at all) is decisive however sparse the sampling was -- we
    //     know enough to reject the DID, and "insufficient" would be a less
    //     honest answer, not a more careful one.
    //  2. "Sparse-but-consistent = found": every press AND every release
    //     window sampled at least once, >= 80 % window agreement, 0 extra
    //     transitions, 0 baseline changes. THIS is what field test 5's own
    //     data proves for DME 0x4002 and 0x4007, and what build 5 discarded.
    //  3. Only then does the sufficiency gate speak: "`insufficient` only
    //     when some window has 0 samples or the whole DID has < 2 samples per
    //     window on average" (item 11) -- no longer "< 2 in ANY window".
    const disqualified = restlessBaseline || neverMoved;
    const sparseFound = !disqualified && sparseFoundFor(best);
    const insufficient = !disqualified && !sparseFound && undersampled;
    let finalVerdict: SignalVerdict = insufficient ? 'insufficient' : sparseFound ? 'found' : verdict;
    let finalCapReason: SignalVerdictCapReason | null = insufficient || finalVerdict === 'found' ? null : verdictCapReason;
    // P4o O2 (binding): a `found` verdict for an analog target resting on a
    // <= 2-level series is switch-like, not analog -- never `found`, however
    // it got there (ordered transitions or the sparse window-agreement rule).
    // A declared/detected flag (`best.booleanLike`) is a different signal and
    // is exempt (that IS a switch, read as one).
    const twoLevelAnalog =
      (input.shape === 'analog-monotone' || input.shape === 'analog-bipolar') && !best.booleanLike && best.twoLevel;
    if (twoLevelAnalog && finalVerdict === 'found') {
      finalVerdict = 'probable';
      finalCapReason = 'two-level';
    }
    scores.push({
      ...base,
      min,
      max,
      verdict: finalVerdict,
      matchedEdges: best.matchedEdges,
      baselineChanges: best.baselineChanges,
      didBaselineChanges,
      extraTransitions: best.extraTransitions,
      bipolarSides: best.bipolarSides,
      byteOffset: best.byteOffset,
      correlationSign: best.correlationSign,
      windowMatchedEdges: best.windowMatchedEdges,
      flagBit: best.flagBit,
      // The flag is about the EVIDENCE, not the verdict: a `found` DID whose
      // windows were thin says so on screen ("found (sparse)").
      sparse: finalVerdict === 'found' && windowsBelowMinimum > 0,
      insufficientReason: insufficient ? 'undersampled' : null,
      verdictCapReason: finalCapReason,
      // Ticket P4n-FIX1 R5 (binding): only for a boolean/flag series -- an
      // analog reading has no single "active level" to name.
      activeValueHex: best.booleanLike ? deriveActiveValueHex(group.entries, best.byteOffset, best.restScalar) : undefined,
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
