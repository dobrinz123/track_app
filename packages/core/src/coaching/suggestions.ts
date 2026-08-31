import type { CornerEnvelope, DemonstratedEnvelope } from './envelope';
import type { LimitationCode, SessionInsights } from './sessionInsights';

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
  | 'nothing-demonstrated-later'
  /**
   * Ticket P5c-FIX1 E4 (safety contract rule 5): this corner's own evidence
   * did not survive an honesty gate — its channels did not cover it, or the
   * laps that would prove it could not be verified. Nothing is suggested on
   * evidence the engine itself does not trust.
   */
  | 'honesty-gate';

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
 * outing has not produced the evidence yet; `geometry-unvalidated` — the
 * circuit's own geometry has never been validated on track (MotorPark today),
 * so no corner reference point is trustworthy enough to advise on (safety
 * contract rule 5, ticket P5c-FIX1 E4); `open` — the engine ran.
 */
export type SuggestionGate =
  | 'disabled'
  | 'insufficient-clean-laps'
  | 'geometry-unvalidated'
  | 'open';

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
  /**
   * Ticket P5c-FIX1 E4 — safety contract rule 5, the FIRST gate after the
   * opt-in. `false` (the circuit's geometry has never been validated on track,
   * MotorPark today) produces NOTHING at all: not a pit suggestion, not a cue
   * update. Corner reference points derived from unvalidated geometry cannot
   * bound anything, so nothing may be said about them. Defaults to `true` only
   * because a caller that knows nothing about geometry is passing a synthetic
   * envelope; every real caller goes through {@link suggestionsFromInsights}.
   */
  geometryValidated?: boolean;
  /**
   * Corners whose own evidence failed an honesty gate — the channels did not
   * cover them, or the laps that would prove them could not be verified. They
   * get no suggestion and no cue update (ticket P5c-FIX1 E4).
   */
  blockedCornerIds?: readonly number[];
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
  // E4: the honesty gates come before the evidence, not after it. Unvalidated
  // geometry means every corner reference point is a guess, so there is
  // nothing here that may be suggested on -- not even for a corner whose own
  // laps look immaculate.
  if (input.geometryValidated === false) return empty('geometry-unvalidated', cleanLapCount);
  if (cleanLapCount < MIN_CLEAN_LAPS_FOR_SUGGESTIONS) {
    return empty('insufficient-clean-laps', cleanLapCount);
  }

  const cornersById = new Map<number, CornerEnvelope>(
    input.envelope.corners.map((corner) => [corner.cornerId, corner]),
  );
  const blocked = new Set(input.blockedCornerIds ?? []);
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
    if (blocked.has(cornerId)) {
      skipped.push({ cornerId, point: 'brake', reason: 'honesty-gate' });
      continue;
    }
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
    if (blocked.has(corner.cornerId)) continue;
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
    geometryValidated: insights.geometryValidated,
    blockedCornerIds: blockedCornersFromInsights(insights),
  });
}

/**
 * P4 (Codex P5c-REV1 finding 4, HIGH/PARTIAL across several reviews; closed
 * here). Every `LimitationCode` this honesty gate treats as BLOCKING is an
 * explicit member of this set, typed against the exact union the analysis
 * engine emits (`LimitationCode`, `sessionInsights.ts`) — never a loose
 * string compared ad hoc at each call site. A code added to `LimitationCode`
 * later without a decision here silently does NOT block anything (the safe
 * default), and `suggestionsHonesty.test.ts` enumerates every member of the
 * type so that omission is a visible, named gap in a test rather than
 * something only a future incident would surface.
 *
 *  - `CORNER_COVERAGE`: no lap produced a usable measurement in that corner —
 *    blocks the corner directly.
 *  - `UNVERIFIED_LAPS` / `GNSS_QUALITY`: the named LAPS could not be checked or
 *    were recorded through poor GNSS. A corner whose demonstrated envelope
 *    RESTS on one of those laps is bounded by evidence the engine itself will
 *    not vouch for, so it is blocked — corner by corner, not session-wide.
 */
export const BLOCKING_LIMITATION_CODES: ReadonlySet<LimitationCode> = new Set<LimitationCode>([
  'CORNER_COVERAGE',
  'UNVERIFIED_LAPS',
  'GNSS_QUALITY',
]);

/**
 * Ticket P5c-FIX1 E4 — the honesty gates the analysis already computed, read
 * as a suggestion gate instead of being discarded. See
 * {@link BLOCKING_LIMITATION_CODES} for which codes participate and why.
 */
export function blockedCornersFromInsights(insights: SessionInsights): number[] {
  const blocked = new Set<number>();
  const untrustedLaps = new Set<number>();
  for (const limitation of insights.limitations) {
    if (!BLOCKING_LIMITATION_CODES.has(limitation.code)) continue;
    if (limitation.code === 'CORNER_COVERAGE') {
      for (const cornerId of limitation.cornerIds ?? []) blocked.add(cornerId);
      continue;
    }
    // The remaining blocking codes (`UNVERIFIED_LAPS`, `GNSS_QUALITY`) name
    // LAPS, not corners directly -- resolved to corners below.
    for (const lapNumber of limitation.lapNumbers ?? []) untrustedLaps.add(lapNumber);
  }
  if (untrustedLaps.size > 0) {
    for (const corner of insights.envelope.corners) {
      if (corner.evidenceLapIds.some((lapNumber) => untrustedLaps.has(lapNumber))) {
        blocked.add(corner.cornerId);
      }
    }
  }
  return [...blocked].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Sealed evidence (ticket P5c-FIX1 E2)
// ---------------------------------------------------------------------------

/**
 * ONE corner's demonstrated bound, as the analysis measured it. The cue source
 * recomputes its clamp from THESE numbers; the numbers a {@link CueUpdate}
 * carries about itself are never trusted (Codex P5c-REV1 finding 2).
 */
export interface CueEvidenceEntry {
  cornerId: number;
  point: CuePoint;
  /** The latest point a clean lap of THIS outing demonstrated, metres before entry. */
  demonstratedM: number;
  evidenceLapNumber: number;
  cleanLapCount: number;
}

/**
 * The evidence one analysis pass produced, sealed to the outing, the cue
 * source's own generation and the stint it was computed in. `checksum` is a
 * plain integrity seal over exactly those fields: it makes a truncated, mutated
 * or half-copied evidence set detectable at the point of use, and pins the
 * evidence to the context it was computed for. It is not a secret and does not
 * pretend to be one — the real defence is that the cue source recomputes every
 * bound from `entries` rather than from the update.
 */
export interface CueUpdateEvidence {
  sessionId: string;
  /** The cue source's generation (a new/restored session mints a new one). */
  generation: number;
  /** The stint the evidence was computed in — a pit exit starts the next. */
  stintIndex: number;
  entries: CueEvidenceEntry[];
  checksum: string;
}

/** Canonical, order-independent serialisation — the only thing hashed. */
function canonicalEvidence(input: Omit<CueUpdateEvidence, 'checksum'>): string {
  const entries = [...input.entries]
    .map(
      (entry) =>
        `${entry.cornerId}|${entry.point}|${entry.demonstratedM}|${entry.evidenceLapNumber}|${entry.cleanLapCount}`,
    )
    .sort();
  return [input.sessionId, input.generation, input.stintIndex, ...entries].join('\n');
}

/** FNV-1a, 32-bit, as lower-case hex. Deterministic and dependency-free. */
export function cueEvidenceChecksum(input: Omit<CueUpdateEvidence, 'checksum'>): string {
  const text = canonicalEvidence(input);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Seals an evidence set so the cue source can detect a mutated/stale one.
 *
 * M14 (document only, Codex P5c-REV2 finding 14, MEDIUM): the FNV-1a checksum
 * this produces is SAME-PROCESS INTEGRITY, not authenticity. It is not keyed,
 * not secret, and anyone holding this module can recompute it over entries of
 * their own choosing -- it proves an evidence set was not truncated, reordered
 * or partially edited AFTER it was sealed, in THIS process, nothing more. It
 * is not, and is not meant to be, a defence against a caller in the SAME
 * process fabricating evidence from nothing and sealing it correctly; the
 * real defence against that is architectural, not cryptographic --
 * `SessionController` only ever calls this from evidence it derived itself
 * (`cueEvidenceFromInsights`, fed by the deterministic analysis engine), and
 * every bound `applyCueUpdates` accepts is re-derived from the sealed
 * `entries` at apply time rather than trusted from the caller's own numbers.
 * Keeping evidence creation a controller-owned capability (never exposed to a
 * caller as "seal whatever you like") is what actually keeps this honest;
 * this checksum only catches accidental corruption in transit.
 */
export function sealCueEvidence(input: Omit<CueUpdateEvidence, 'checksum'>): CueUpdateEvidence {
  return { ...input, entries: [...input.entries], checksum: cueEvidenceChecksum(input) };
}

/** True when `evidence` still hashes to its own checksum. */
export function verifyCueEvidence(evidence: CueUpdateEvidence): boolean {
  const { checksum, ...rest } = evidence;
  return cueEvidenceChecksum(rest) === checksum;
}

/**
 * The evidence of one finished analysis pass: every corner's demonstrated
 * latest brake point AND latest lift point, so the cue source can validate a
 * spoken "Lift." against the LIFT envelope rather than the braking one
 * (ticket P5c-FIX1 E3, Codex P5c-REV1 finding 3).
 */
export function cueEvidenceFromInsights(
  insights: SessionInsights,
  context: { sessionId: string; generation: number; stintIndex: number },
): CueUpdateEvidence {
  const entries: CueEvidenceEntry[] = [];
  const cleanLapCount = insights.envelope.cleanLapCount;
  // E4 again, at the layer that actually moves a cue: unvalidated geometry
  // seals an EMPTY evidence set, so even a caller that skipped
  // `computeSuggestions` entirely has nothing the cue source will accept.
  const blocked = new Set(
    insights.geometryValidated
      ? blockedCornersFromInsights(insights)
      : insights.envelope.corners.map((corner) => corner.cornerId),
  );
  for (const corner of [...insights.envelope.corners].sort((a, b) => a.cornerId - b.cornerId)) {
    if (blocked.has(corner.cornerId)) continue;
    if (!cornerHasEvidence(corner)) continue;
    for (const point of ['brake', 'lift'] as const) {
      const demonstrated = demonstratedPoint(corner, point);
      if (demonstrated === null) continue;
      entries.push({
        cornerId: corner.cornerId,
        point,
        demonstratedM: demonstrated.valueM,
        evidenceLapNumber: demonstrated.lapNumber,
        cleanLapCount,
      });
    }
  }
  return sealCueEvidence({ ...context, entries });
}
