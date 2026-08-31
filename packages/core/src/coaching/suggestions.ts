import type { CornerEnvelope, DemonstratedEnvelope } from './envelope';
import type { SessionInsights } from './sessionInsights';

/**
 * The bounded suggestion engine — `contracts.md` "Phase 5 REVISION 2" R2-3
 * (user-ratified) on top of the Phase 5 safety contract's rule 3.
 *
 * Two outputs, one rule:
 *
 *  - {@link SuggestionResult.cueUpdates} — the live brake/lift coaching cues
 *    MAY be moved between laps of the same outing, but only ever TO a value a
 *    clean lap of THAT outing already demonstrated, by at most
 *    {@link MAX_BRAKE_LATER_M}, and at most ONCE per corner per stint.
 *  - {@link SuggestionResult.pitSuggestions} — between stints the driver may be
 *    SHOWN what a clean lap of theirs already proved, capped by the same
 *    bounds. Nothing beyond the demonstrated envelope is ever generated: the
 *    ceiling of every suggestion is the driver's own best clean lap, so
 *    "brake later than you ever have" is impossible by construction.
 *
 * Everything here is pure and deterministic: same inputs, byte-identical
 * output, in ascending corner id. `enabled` is the whole stage's gate (the
 * app's `suggestionsEnabled` setting, default OFF) — `false` returns the empty
 * result, so nothing downstream can behave differently when the driver has not
 * opted in. Honesty gate: fewer than {@link MIN_CLEAN_LAPS_FOR_SUGGESTIONS}
 * clean laps, or a corner with no clean evidence, produces NOTHING rather than
 * a thin guess.
 */

/** Safety contract rule 3: the largest step a brake/lift cue may take, metres. */
export const MAX_BRAKE_LATER_M = 10;
/** Safety contract rule 3: the largest minimum-speed step, km/h. */
export const MAX_MIN_SPEED_GAIN_KPH = 3;
/** Honesty gate: clean laps of THIS outing required before anything is suggested. */
export const MIN_CLEAN_LAPS_FOR_SUGGESTIONS = 2;
/**
 * A cue is only moved when the driver has demonstrated a point at least this
 * much later, metres. Below it the "improvement" is inside the measurement's
 * own noise, and moving a cue by centimetres is churn, not coaching.
 */
export const MIN_CUE_MOVE_M = 1;
/** The same idea for a minimum-speed suggestion, km/h. */
export const MIN_SUGGESTION_SPEED_GAIN_KPH = 0.5;

/** Which of the two live coaching cue points a change is about. */
export type CuePoint = 'brake' | 'lift';

/** The cue set as it stands today, in metres BEFORE the corner entry. */
export interface ActiveCue {
  cornerId: number;
  /** Where the brake cue fires today, metres before the corner entry. */
  brakeStartM: number | null;
  /** Where the lift cue fires today, metres before the corner entry. */
  liftPointM?: number | null;
}

/** One bounded, evidence-backed move of one cue point. */
export interface CueUpdate {
  cornerId: number;
  point: CuePoint;
  /** Where the cue was, metres before the corner entry. */
  fromM: number;
  /** Where it moves to — never smaller than {@link demonstratedM}. */
  toM: number;
  /** `fromM - toM`: how much later the cue now fires. `(0, MAX_BRAKE_LATER_M]`. */
  movedLaterM: number;
  /** The latest point a clean lap of THIS outing actually demonstrated. */
  demonstratedM: number;
  /** The clean lap that demonstrated it — the evidence, always named. */
  evidenceLapNumber: number;
  /** Clean laps in the outing this was decided from. */
  cleanLapCount: number;
}

/** Why a corner's cue was left exactly where it was. */
export type SuggestionSkipReason =
  | 'no-cue'
  | 'insufficient-data'
  | 'already-updated-this-stint'
  | 'nothing-demonstrated-later';

export interface SuggestionSkip {
  cornerId: number;
  point: CuePoint;
  reason: SuggestionSkipReason;
}

/** What a pit suggestion is about. */
export type PitSuggestionKind = 'brakeLater' | 'liftLater' | 'carryMoreMinSpeed';

/** The fixed order suggestions are emitted in within one corner. */
const PIT_SUGGESTION_ORDER: readonly PitSuggestionKind[] = Object.freeze([
  'brakeLater',
  'liftLater',
  'carryMoreMinSpeed',
] as const);

export interface PitSuggestion {
  cornerId: number;
  kind: PitSuggestionKind;
  /** `'m'` = metres before the corner entry (smaller is later); `'kph'` = km/h. */
  unit: 'm' | 'kph';
  /** What the driver typically does — the median of their own clean laps. */
  typicalValue: number;
  /** The best a clean lap of this outing demonstrated. The hard ceiling. */
  demonstratedValue: number;
  /** The capped target — never past {@link demonstratedValue}. */
  targetValue: number;
  /** `|targetValue - typicalValue|`, in {@link unit}. Always > 0. */
  deltaValue: number;
  /** The clean lap that demonstrated {@link demonstratedValue}. */
  evidenceLapNumber: number;
  cleanLapCount: number;
  /** Time lost in this corner, ms, when the caller supplied it. Ranking only. */
  timeLossMs: number | null;
}

/**
 * `disabled` — the driver has not opted in; `insufficient-clean-laps` — the
 * outing has not produced the evidence yet; `open` — the engine ran.
 */
export type SuggestionGate = 'disabled' | 'insufficient-clean-laps' | 'open';

export interface SuggestionResult {
  gate: SuggestionGate;
  cleanLapCount: number;
  /** Bounded cue moves, ascending by corner id. At most one per corner. */
  cueUpdates: CueUpdate[];
  /** Pit-only suggestions, ascending by corner id then {@link PIT_SUGGESTION_ORDER}. */
  pitSuggestions: PitSuggestion[];
  /** Every corner cue left alone, and why. Empty when the gate is closed. */
  skipped: SuggestionSkip[];
}

export interface SuggestionInput {
  /** The app's `suggestionsEnabled` setting. `false` -> the empty result. */
  enabled: boolean;
  /**
   * The demonstrated envelope of the CURRENT outing — the projection of its
   * clean laps' per-corner metrics (`buildDemonstratedEnvelope`). Nothing else
   * is ever used as a bound.
   */
  envelope: DemonstratedEnvelope;
  /** The cue set live today. A corner with no cue can still get a pit suggestion. */
  cues: readonly ActiveCue[];
  /** Corners whose cue already moved this stint — one change per corner per stint. */
  updatedCornerIds?: readonly number[];
  /** Per-corner time loss (ms) for ranking only; never used as a bound. */
  timeLossMsByCorner?: Readonly<Record<number, number | null>> | ReadonlyMap<number, number | null>;
}

const EMPTY: Omit<SuggestionResult, 'gate' | 'cleanLapCount'> = Object.freeze({
  cueUpdates: [],
  pitSuggestions: [],
  skipped: [],
});

function empty(gate: SuggestionGate, cleanLapCount: number): SuggestionResult {
  return { gate, cleanLapCount, ...EMPTY, cueUpdates: [], pitSuggestions: [], skipped: [] };
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readTimeLoss(
  source: SuggestionInput['timeLossMsByCorner'],
  cornerId: number,
): number | null {
  if (source === undefined) return null;
  const asMap = source as ReadonlyMap<number, number | null>;
  const value =
    typeof asMap.get === 'function'
      ? asMap.get(cornerId)
      : (source as Readonly<Record<number, number | null>>)[cornerId];
  return finite(value) ? value : null;
}

/** Has this corner enough clean evidence of its own to bound anything? */
function cornerHasEvidence(corner: CornerEnvelope): boolean {
  return corner.evidenceLapIds.length >= MIN_CLEAN_LAPS_FOR_SUGGESTIONS;
}

/** The demonstrated LATEST value of one cue point, with the lap that proves it. */
function demonstratedPoint(
  corner: CornerEnvelope,
  point: CuePoint,
): { valueM: number; lapNumber: number } | null {
  const valueM = point === 'brake' ? corner.latestBrakeStartM : corner.latestLiftM;
  const lapNumber =
    point === 'brake' ? corner.latestBrakeStartLapNumber : corner.latestLiftLapNumber;
  if (!finite(valueM) || !finite(lapNumber)) return null;
  return { valueM, lapNumber };
}

/**
 * One bounded distance move: from `currentM` metres before the corner toward
 * `demonstratedM`, never past it, never by more than {@link MAX_BRAKE_LATER_M}.
 */
function boundedLater(currentM: number, demonstratedM: number): number | null {
  if (demonstratedM > currentM - MIN_CUE_MOVE_M) return null;
  return Math.max(demonstratedM, currentM - MAX_BRAKE_LATER_M);
}

function distanceSuggestion(
  cornerId: number,
  kind: Extract<PitSuggestionKind, 'brakeLater' | 'liftLater'>,
  typicalValue: number | null,
  demonstrated: { valueM: number; lapNumber: number } | null,
  cleanLapCount: number,
  timeLossMs: number | null,
): PitSuggestion | null {
  if (!finite(typicalValue) || demonstrated === null) return null;
  const targetValue = boundedLater(typicalValue, demonstrated.valueM);
  if (targetValue === null) return null;
  return {
    cornerId,
    kind,
    unit: 'm',
    typicalValue,
    demonstratedValue: demonstrated.valueM,
    targetValue,
    deltaValue: typicalValue - targetValue,
    evidenceLapNumber: demonstrated.lapNumber,
    cleanLapCount,
    timeLossMs,
  };
}

function minSpeedSuggestion(
  corner: CornerEnvelope,
  cleanLapCount: number,
  timeLossMs: number | null,
): PitSuggestion | null {
  const typicalValue = corner.medianMinSpeedKph;
  const demonstratedValue = corner.highestMinSpeedKph;
  const evidenceLapNumber = corner.highestMinSpeedLapNumber;
  if (!finite(typicalValue) || !finite(demonstratedValue) || !finite(evidenceLapNumber)) return null;
  if (demonstratedValue < typicalValue + MIN_SUGGESTION_SPEED_GAIN_KPH) return null;
  const targetValue = Math.min(demonstratedValue, typicalValue + MAX_MIN_SPEED_GAIN_KPH);
  return {
    cornerId: corner.cornerId,
    kind: 'carryMoreMinSpeed',
    unit: 'kph',
    typicalValue,
    demonstratedValue,
    targetValue,
    deltaValue: targetValue - typicalValue,
    evidenceLapNumber,
    cleanLapCount,
    timeLossMs,
  };
}

/**
 * The whole engine. Deterministic, side-effect free, and bounded by the
 * driver's own demonstrated envelope in every branch.
 */
export function computeSuggestions(input: SuggestionInput): SuggestionResult {
  const cleanLapCount = input.envelope.cleanLapCount;
  // The opt-in gate comes FIRST: with suggestions off, this function is
  // indistinguishable from not existing (ticket P5c-B D5).
  if (!input.enabled) return empty('disabled', cleanLapCount);
  if (cleanLapCount < MIN_CLEAN_LAPS_FOR_SUGGESTIONS) {
    return empty('insufficient-clean-laps', cleanLapCount);
  }

  const cornersById = new Map<number, CornerEnvelope>(
    input.envelope.corners.map((corner) => [corner.cornerId, corner]),
  );
  const alreadyUpdated = new Set(input.updatedCornerIds ?? []);
  const cueByCorner = new Map<number, ActiveCue>();
  for (const cue of input.cues) {
    // Ascending id below, so a duplicate entry can never make the result
    // depend on the caller's array order; first one wins, deterministically.
    if (!cueByCorner.has(cue.cornerId)) cueByCorner.set(cue.cornerId, cue);
  }

  // --- cue updates ---------------------------------------------------------
  const cueUpdates: CueUpdate[] = [];
  const skipped: SuggestionSkip[] = [];
  for (const cornerId of [...cueByCorner.keys()].sort((a, b) => a - b)) {
    const cue = cueByCorner.get(cornerId) as ActiveCue;
    const corner = cornersById.get(cornerId);
    if (corner === undefined || !cornerHasEvidence(corner)) {
      skipped.push({ cornerId, point: 'brake', reason: 'insufficient-data' });
      continue;
    }
    if (alreadyUpdated.has(cornerId)) {
      skipped.push({ cornerId, point: 'brake', reason: 'already-updated-this-stint' });
      continue;
    }
    // R2-3: at most ONE change per corner per stint. The brake cue is the one
    // the dashboard/voice actually calls out, so it is considered first and a
    // move there consumes this corner's single allowance.
    let moved = false;
    for (const point of ['brake', 'lift'] as const) {
      if (moved) break;
      const currentM = point === 'brake' ? cue.brakeStartM : (cue.liftPointM ?? null);
      if (!finite(currentM)) {
        skipped.push({ cornerId, point, reason: 'no-cue' });
        continue;
      }
      const demonstrated = demonstratedPoint(corner, point);
      if (demonstrated === null) {
        skipped.push({ cornerId, point, reason: 'insufficient-data' });
        continue;
      }
      const toM = boundedLater(currentM, demonstrated.valueM);
      if (toM === null) {
        skipped.push({ cornerId, point, reason: 'nothing-demonstrated-later' });
        continue;
      }
      cueUpdates.push({
        cornerId,
        point,
        fromM: currentM,
        toM,
        movedLaterM: currentM - toM,
        demonstratedM: demonstrated.valueM,
        evidenceLapNumber: demonstrated.lapNumber,
        cleanLapCount,
      });
      moved = true;
    }
  }

  // --- pit suggestions -----------------------------------------------------
  const pitSuggestions: PitSuggestion[] = [];
  for (const corner of [...input.envelope.corners].sort((a, b) => a.cornerId - b.cornerId)) {
    if (!cornerHasEvidence(corner)) continue;
    const timeLossMs = readTimeLoss(input.timeLossMsByCorner, corner.cornerId);
    const byKind = new Map<PitSuggestionKind, PitSuggestion | null>([
      [
        'brakeLater',
        distanceSuggestion(
          corner.cornerId,
          'brakeLater',
          corner.medianBrakeStartM,
          demonstratedPoint(corner, 'brake'),
          cleanLapCount,
          timeLossMs,
        ),
      ],
      [
        'liftLater',
        distanceSuggestion(
          corner.cornerId,
          'liftLater',
          corner.medianLiftM,
          demonstratedPoint(corner, 'lift'),
          cleanLapCount,
          timeLossMs,
        ),
      ],
      ['carryMoreMinSpeed', minSpeedSuggestion(corner, cleanLapCount, timeLossMs)],
    ]);
    for (const kind of PIT_SUGGESTION_ORDER) {
      const suggestion = byKind.get(kind);
      if (suggestion != null) pitSuggestions.push(suggestion);
    }
  }

  return { gate: 'open', cleanLapCount, cueUpdates, pitSuggestions, skipped };
}

/**
 * The same engine, fed straight from a finished `analyzeSession` pass: the
 * envelope and the per-corner time loss come from the insights, so a caller
 * that already ran the analysis does not restate either.
 */
export function suggestionsFromInsights(
  insights: SessionInsights,
  cues: readonly ActiveCue[],
  options: { enabled: boolean; updatedCornerIds?: readonly number[] },
): SuggestionResult {
  const timeLossMsByCorner = new Map<number, number | null>(
    insights.corners.map((corner) => [corner.cornerId, corner.timeLoss?.deltaMs ?? null]),
  );
  return computeSuggestions({
    enabled: options.enabled,
    envelope: insights.envelope,
    cues,
    ...(options.updatedCornerIds === undefined
      ? {}
      : { updatedCornerIds: options.updatedCornerIds }),
    timeLossMsByCorner,
  });
}
