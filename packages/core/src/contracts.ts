// ---------- Geo & samples ----------
export interface LatLon { lat: number; lon: number }
export interface LocalPoint { e: number; n: number } // ENU meters from profile origin

export interface GeoProjection {
  readonly origin: LatLon;
  toLocal(p: LatLon): LocalPoint;
  toLatLon(p: LocalPoint): LatLon;
}

export type FixSource = 'gnss' | 'replay' | 'fused';

export interface LocationSample {
  tMono: number;            // monotonic ms
  tUtc?: number;            // wall-clock ms, metadata only
  lat: number; lon: number;
  accuracyM?: number;       // horizontal 1-sigma if known
  speedMps?: number;
  headingDeg?: number;      // course over ground, 0=N
  altitudeM?: number;
  source: FixSource;
}

export type QualityLevel = 'good' | 'degraded' | 'unreliable' | 'invalid';
export interface QualityAssessment {
  level: QualityLevel;
  reasons: string[];        // machine-readable codes, e.g. 'ACCURACY_ABOVE_20M'
}

export interface TelemetryQualityEvaluator {
  assess(sample: LocationSample, prev?: LocationSample): QualityAssessment;
}

// ---------- Circuit profile (schema-validated, versioned) ----------
export interface Gate {
  id: string;
  kind: 'startFinish' | 'sector' | 'pitEntry' | 'pitExit';
  a: LatLon; b: LatLon;      // directed segment: crossing is valid only when the
                             // motion crosses a->b's left-to-right normal (see geometry doc)
  sectorIndex?: number;      // for kind 'sector': the sector this gate STARTS
}

export interface CircuitProfile {
  schemaVersion: number;              // migrations required on change
  circuitId: string;                  // stable, e.g. 'transilvania-motor-ring'
  displayName: string;
  country: string; locality: string;
  layoutId: string; layoutVersion: number;
  source: { name: string; url?: string; license?: string; retrievedAt?: string };
  /**
   * How the geometry got here. `'ad-hoc'` (Phase 5d Test Loop mode) is
   * geometry LEARNED on device from one lap of driving -- never surveyed,
   * never validated on track. It is the value every honesty gate reads to
   * decide a circuit may be timed and analysed but never advised on
   * (`analysisAssembly`'s `geometryValidated`, which admits `'official'` only).
   */
  geometryStatus: 'official' | 'community-derived' | 'dev-only' | 'ad-hoc';
  sectorStatus: 'official' | 'app-defined';
  direction: 'clockwise' | 'counterclockwise';
  centerline: LatLon[];               // closed loop implied (last != first; wrap implicit)
  totalLengthM: number;               // must match cumulative centerline length ±0.5%
  startFinishGate: Gate;
  sectorGates: Gate[];                // ordered by track progress; includes startFinish as sector 0 start implicitly
  pitLane?: { polyline: LatLon[]; entryGate: Gate; exitGate: Gate };
  boundingRegion: { center: LatLon; radiusM: number };
  corridorWidthM: number;             // max lateral distance considered on-track
  alternateLayoutIds?: string[];
  createdAtUtc: string; updatedAtUtc: string;
  confidenceNotes?: string;
}
// Runtime companion (computed, not serialized): cumulative distances per vertex.

// ---------- Track matching ----------
export interface TrackMatch {
  tMono: number;
  distanceM: number;          // along centerline from start/finish
  progress: number;           // distanceM / totalLengthM in [0,1)
  unwrappedProgressM: number; // monotonic across laps
  lateralM: number;           // signed lateral offset from centerline
  confidence: number;         // [0,1]
  sectorIndex: number;
  quality: QualityAssessment;
  onPitLane: boolean;
}

export interface TrackMatcher {
  reset(): void;
  match(sample: LocationSample): TrackMatch | null; // null = rejected sample
}

// ---------- Crossing detection ----------
export interface CrossingEvent {
  gateId: string;
  kind: Gate['kind'];
  tCross: number;             // monotonic ms, interpolated between samples
  direction: 'forward' | 'reverse';
  confidence: number;
  lapDistanceM: number;
  /**
   * Ticket P9-FIX2. The crossing happened, but whether the car was in the pit
   * lane when it did is UNDECIDED. Set only by `CrossingDetector` and only on
   * timing gates (`startFinish`/`sector`).
   *
   * The pit lane at both shipped circuits runs within metres of the
   * centerline beside the start/finish line -- the OSM ways share junction
   * nodes -- so near the line the "is the car in the pits?" question is
   * decided from noisy proximity between two barely distinguishable
   * polylines. Two silent failures follow from answering it anyway: suppress
   * and a real lap disappears with nothing recorded; emit and a lap the car
   * never drove appears indistinguishable from a real one.
   *
   * So the detector answers it three ways, not two, and this flag is the
   * third: the boundary is EMITTED (a lap that exists can be reconciled
   * afterwards; a lap that was never emitted is gone) and marked, and
   * `LapTimingEngine` turns the mark into a `PIT_AMBIGUOUS` invalid reason on
   * both the lap this boundary closes and the lap it opens.
   *
   * Absent means "not ambiguous", so every producer that predates this field
   * keeps its exact meaning.
   */
  pitAmbiguous?: boolean;
}

export interface CrossingDetector {
  reset(): void;
  update(prev: TrackMatch | null, curr: TrackMatch, prevSample: LocationSample | null, currSample: LocationSample): CrossingEvent[];
}

// ---------- Calibration (Learn) ----------
export interface CalibrationDiagnostics {
  coverageFraction: number;        // fraction of centerline observed
  samplesAccepted: number; samplesRejected: number;
  rejectionReasons: Record<string, number>;
  meanLateralM: number; p95LateralM: number;
  estimatedBias: { e: number; n: number }; // bounded, session-scoped
  directionDetected: 'clockwise' | 'counterclockwise' | 'unknown';
  observedRateHz: number;
  /** Distance-along-centerline (m, from start/finish) where the longest post-bias-correction
   * uncovered stretch begins. 0 when there is no uncovered stretch (full coverage). Additive
   * (optional) field: only `CalibrationEngine.finish()` populates it -- other producers of a
   * `CalibrationDiagnostics` (synthetic/cancelled results, replay harness) are unaffected. */
  uncoveredGapStartM?: number;
  /** End of that stretch (m, from start/finish); clamped to totalLengthM, so a gap that spans
   * the start/finish line is reported as ending at the line rather than wrapping past it. */
  uncoveredGapEndM?: number;
  /**
   * Ticket P12 item B -- the TRUE length of that stretch, metres.
   *
   * Not derivable from the pair above: a gap that wraps past the start/finish
   * line has its `uncoveredGapEndM` CLAMPED to `totalLengthM`, so
   * `end - start` under-reports it, and the engine's own
   * `COVERAGE_GAP` threshold is judged against this length, not against the
   * clamped span. Exporting the clamped span as "the gap" was the difference
   * between a record that explains a refusal and one that contradicts it.
   *
   * Additive/optional on exactly the same terms as the two fields above: only
   * `CalibrationEngine.finish()` populates it.
   */
  uncoveredGapLengthM?: number;
}

export interface CalibrationResult {
  accepted: boolean;
  confidence: number;              // [0,1]
  failureReasons: string[];        // machine-readable when !accepted
  appliedBias: { e: number; n: number }; // zero when not supported by evidence
  diagnostics: CalibrationDiagnostics;
}

export interface CalibrationEngine {
  reset(): void;
  feed(sample: LocationSample): void;
  progress(): { coverageFraction: number; onTrack: boolean; qualityOk: boolean };
  finish(): CalibrationResult;
}

// ---------- Calibration attempt record (ticket P12 item B) ----------
/**
 * Ticket P12 item B (binding) -- EVERY CALIBRATION ATTEMPT LEAVES A RECORD.
 *
 * The owner has already lost a track day to a Learn lap that parked at ~83%
 * coverage and never produced a verdict at all. Nothing durable was written,
 * because until this existed the only thing that reached storage was an
 * ACCEPTED calibration's downstream effects: a stall wrote nothing, a
 * rejection wrote nothing beyond a provenance label, and a Cancel wrote
 * nothing and looked, afterwards, exactly like a calibration that was never
 * started.
 *
 * So a record is written when the Learn lap STARTS and rewritten as it
 * progresses and when it concludes, whatever the conclusion. Reading one back
 * afterwards -- off the device, from an export -- must be enough to say why it
 * did not calibrate.
 */
export const CALIBRATION_ATTEMPT_RECORD_VERSION = 1;

/**
 * How a Learn lap ended.
 *
 *  - `'accepted'`  -- the engine ACCEPTED the lap. (Including one the driver
 *                     force-finished that turned out to be good enough: that
 *                     is an ordinary accepted calibration and is never
 *                     labelled as anything else.)
 *  - `'rejected'`  -- the lap ran to the controller's completion threshold and
 *                     the engine then refused it. `failureReasons` says why.
 *  - `'stalled'`   -- the lap never reached that threshold. Either it is still
 *                     open / was abandoned (`concluded: false`, the record the
 *                     83% day would have left), or the driver force-finished it
 *                     below the threshold and the engine refused what it got.
 *  - `'cancelled'` -- the DRIVER pressed Cancel. Recorded as an outcome, never
 *                     as an absence: the owner was explicit that a cancel is a
 *                     failure and has to be visible as one.
 */
export type CalibrationAttemptOutcome = 'accepted' | 'rejected' | 'stalled' | 'cancelled';

/**
 * The numbers the verdict was judged against, as they stood for THIS attempt.
 * Recorded rather than assumed: a reader months later must not have to guess
 * which build's thresholds produced a refusal.
 */
export interface CalibrationThresholds {
  /** Lateral corridor accepted samples had to fall inside, metres. */
  corridorWidthM: number;
  /** Coverage bin width, metres -- the resolution every coverage figure here has. */
  coverageBinM: number;
  /** Coverage at which the CONTROLLER force-finishes the Learn lap on its own. */
  completeCoverageFraction: number;
  /** Coverage below which the ENGINE reports `INSUFFICIENT_COVERAGE`. */
  minCoverageFraction: number;
  /** Longest uncovered stretch the engine tolerates before `COVERAGE_GAP`, metres. */
  maxUncoveredGapM: number;
  /** Observed fix rate below which the engine reports `RATE_TOO_LOW`. */
  minObservedRateHz: number;
  /** Wide-corridor rejected fraction above which the engine reports `POOR_GNSS`. */
  maxRejectedFraction: number;
}

/** The longest stretch of centerline the Learn lap never observed. */
export interface CalibrationUncoveredGap {
  /** Distance along the centerline from start/finish where it begins, metres. */
  startM: number;
  /** Where it ends, metres; clamped to the lap length rather than wrapping past the line. */
  endM: number;
  /** Its true length, metres -- see {@link CalibrationDiagnostics.uncoveredGapLengthM}. */
  lengthM: number;
}

export interface CalibrationAttemptRecord {
  /** {@link CALIBRATION_ATTEMPT_RECORD_VERSION} at the time of writing. */
  schemaVersion: number;
  /** Stable for the life of one Learn lap; the row's primary key. A retry is a NEW attempt with a new id. */
  attemptId: string;
  /** The session the Learn lap belonged to. Always set: no session id, no attempt. */
  sessionId: string;
  circuitId: string;
  layoutId: string;
  layoutVersion: number;
  startedAtUtc: string;
  /** When this row was last written -- a provisional row is rewritten as coverage advances. */
  updatedAtUtc: string;
  /** When the attempt concluded; `null` while it has not. */
  endedAtUtc: string | null;
  /** How long the Learn lap ran, milliseconds, from the controller's monotonic clock. */
  durationMs: number;
  outcome: CalibrationAttemptOutcome;
  /** `false` for a provisional row written while the Learn lap was still running. An absent conclusion is stated, never implied. */
  concluded: boolean;
  /** Did the lap reach {@link CalibrationThresholds.completeCoverageFraction} on its own? */
  reachedCompletionThreshold: boolean;
  /** Did the driver force-finish it through the escape hatch? */
  forceFinished: boolean;
  /** The engine's own verdict, verbatim; `null` when it never produced one. */
  result: CalibrationResult | null;
  /**
   * Coverage reached, `[0,1]`. From `finish()`'s bias-corrected bitmap once
   * there is a verdict, and from the live `progress()` value before that --
   * {@link concluded} says which, so the two are never confused.
   */
  coverageFraction: number;
  /** The longest uncovered stretch; `null` when no verdict was ever computed (nothing measured it). */
  uncoveredGap: CalibrationUncoveredGap | null;
  /** Fixes the Learn lap was fed, however they were judged. */
  samplesFed: number;
  /** Of those, how many the engine accepted / rejected. `null` before a verdict: the engine reports them from `finish()`. */
  samplesAccepted: number | null;
  samplesRejected: number | null;
  /** Rejection codes and their counts, as the engine tallied them; `{}` before a verdict. */
  rejectionReasons: Record<string, number>;
  thresholds: CalibrationThresholds;
  /**
   * Why it ended this way, in plain sentences, each one derived from a number
   * in this same record. This is what makes the row readable without the
   * device -- and it is generated, never typed, so it can never disagree with
   * the figures beside it.
   */
  explanation: string[];
}

// ---------- Session state machine ----------
export type SessionState =
  | 'idle' | 'preflight' | 'awaitingCalibration' | 'calibrating' | 'calibrationReview'
  | 'armed' | 'outLap' | 'timing' | 'inPit' | 'paused' | 'sessionComplete' | 'error';

export type SessionEvent =
  | { type: 'START_PREFLIGHT' } | { type: 'PREFLIGHT_PASSED' } | { type: 'PREFLIGHT_FAILED'; reasons: string[] }
  | { type: 'CALIBRATION_STARTED' } | { type: 'CALIBRATION_FINISHED'; result: CalibrationResult }
  | { type: 'CALIBRATION_ACCEPTED' } | { type: 'CALIBRATION_REJECTED' }
  | { type: 'ARMED' } | { type: 'CROSSING'; event: CrossingEvent }
  | { type: 'PIT_ENTERED' } | { type: 'PIT_EXITED' }
  | { type: 'PAUSE' } | { type: 'RESUME'; gapMs: number }
  | { type: 'GNSS_LOST' } | { type: 'GNSS_RECOVERED' }
  | { type: 'END_SESSION' } | { type: 'FATAL'; message: string };

export interface SessionMachineSnapshot { state: SessionState; lapNumber: number; context: Record<string, unknown> }
export type SessionReducer = (s: SessionMachineSnapshot, e: SessionEvent) => SessionMachineSnapshot; // pure, deterministic

// ---------- Timing ----------
export interface SectorTime { sectorIndex: number; durationMs: number; quality: QualityLevel }
export interface LapRecord {
  lapNumber: number;
  tStart: number; tEnd: number;      // monotonic, interpolated crossing times
  durationMs: number;                 // tEnd - tStart, never negative
  sectorTimes: SectorTime[];          // complete & ordered for valid laps
  valid: boolean;
  invalidReasons: string[];           // e.g. 'PIT_TRANSIT', 'MISSED_SECTOR_GATE', 'SHORT_LAP', 'LOW_QUALITY'
  quality: QualityLevel;
}

// ---------- Human verdict on lap validity (ticket P12 item A) ----------
/**
 * Ticket P12 item A (binding) -- DID THE APP GET THIS LAP RIGHT?
 *
 * `LapRecord.valid` / `invalidReasons` are the app's own judgement, produced
 * by rules nobody has ever checked against a real circuit. Build 12 exists to
 * check them: the owner drives, and per lap says whether the app's verdict was
 * correct.
 *
 * Three-valued on purpose. `'unanswered'` is NOT `'disagreed'` and is not an
 * absent row either -- the export has to be able to say "he never got to lap
 * 7", because a lap nobody judged proves nothing about the rules and must
 * never be counted as agreement.
 */
export type LapVerdictAnswer = 'agreed' | 'disagreed' | 'unanswered';

export interface LapValidityVerdict {
  sessionId: string;
  lapNumber: number;
  /**
   * The app's verdict AS IT STOOD when the question was put to the owner --
   * snapshotted, not re-read. If a later build changes the rules, this row
   * still records which verdict was actually agreed or disagreed with.
   */
  appValid: boolean;
  appInvalidReasons: string[];
  /** The owner's verdict ON the app's verdict. */
  answer: LapVerdictAnswer;
  /** ISO-8601 UTC of the answer; `null` for `'unanswered'`, always set otherwise. */
  answeredAtUtc: string | null;
  /**
   * How many times the owner has answered this lap. `0` while unanswered, `1`
   * for a first answer, higher after a re-answer -- so a changed mind is
   * traceable rather than silently overwriting the earlier one.
   */
  answerRevision: number;
  /** Anything the owner typed alongside the answer. Absent when he typed nothing. */
  note?: string;
}

export interface LapTimingEngine {
  reset(): void;
  onCrossing(e: CrossingEvent, currentQuality: QualityLevel, inPit: boolean): LapRecord | null; // returns a lap when one completes
  currentLap(): { lapNumber: number; elapsedMs: (nowMono: number) => number; sectorIndex: number } | null;
  /**
   * Ticket P16 C3 -- ON THE CONTRACT, BECAUSE THE INVALIDATION DEPENDS ON IT.
   *
   * Adds `reason` to the IN-PROGRESS lap's `invalidReasons`, so the
   * {@link LapRecord} eventually returned by `onCrossing` is marked invalid.
   * A no-op when no lap is in progress: a reason with no lap to attach to is
   * dropped, never carried forward onto the next lap, which would blame a lap
   * for something that happened before it started.
   *
   * This was previously absent from this interface while being the ONLY route
   * by which `PAUSE_GAP`, `PIT_TRANSIT` and gap-derived `LOW_QUALITY` ever
   * reach a lap -- `SessionPipelineCore.invalidateActiveLap` calls it from the
   * state machine's `pendingInvalidReasons`, and nothing else sets those
   * three. A second engine written faithfully to the published interface
   * would therefore have compiled, run, and silently produced VALID laps for
   * a paused session, a pit transit and a GNSS dropout alike. The contract now
   * says what an engine has to provide, so that silence is not reachable.
   *
   * Reasons are the free-form codes of {@link LapRecord.invalidReasons};
   * marking the same reason twice on one lap must not duplicate it.
   */
  markInvalid(reason: string): void;
}

// ---------- Reference lap & live delta ----------
export interface ReferenceLap {
  circuitId: string; layoutId: string; layoutVersion: number; userId: string;
  durationMs: number; sectorTimes: SectorTime[];
  recordedAtUtc: string; sessionId: string; lapNumber: number;
  distanceGridM: number[];            // stable resample grid
  elapsedMsAtGrid: number[];          // reference elapsed time per grid point
  gnssQualitySummary: QualityAssessment;
  appVersion: string; algorithmVersion: number; profileSchemaVersion: number;
  device?: string;
}

export interface DeltaUpdate {
  deltaMs: number;                    // negative = faster
  confidence: number;
  display: 'faster' | 'slower' | 'neutral'; // neutral when low confidence
  estimatedLapMs?: number;            // clearly an estimate
}

export interface LiveDeltaEngine {
  setReference(ref: ReferenceLap | null): void;
  onMatch(match: TrackMatch, lapElapsedMs: number): DeltaUpdate;
  reset(): void;
}

// ---------- Persistence (implemented in app via SQLite; in-memory impl for tests) ----------
/**
 * Ticket P10A H6 — how this session's matching was calibrated, as a DURABLE
 * fact stored beside the session itself.
 *
 * Deliberately three-valued. The previous design carried one boolean in a
 * side log (`apps/mobile/src/persistence/sqlSettingsStore.ts`'s
 * `unvalidated-matching-sessions` row), which conflated "we know this ran on
 * accepted calibration" with "we could not read the label" — a failed label
 * write, a read error, or the log's own eviction all reported `false`, i.e.
 * CALIBRATED, about a session nobody had vouched for.
 *
 *  - `'validated'`   — the calibration engine ACCEPTED this session's Learn lap.
 *  - `'unvalidated'` — the engine REJECTED it and the driver went out anyway
 *                      (`SessionController.proceedWithoutValidatedCalibration`).
 *  - `'unknown'`     — nobody can say. A session recorded before the outcome
 *                      was decided (the record is written at RECORDING START,
 *                      see `SessionController.start`), a recovery resume whose
 *                      prior status could not be read, or a legacy row that
 *                      predates this field.
 *
 * The binding rule for every reader: `'unknown'` is never rendered, exported
 * or summarised as calibrated.
 */
export type SessionCalibrationStatus = 'validated' | 'unvalidated' | 'unknown';

export interface SessionSummary {
  sessionId: string;
  circuitId: string;
  layoutId: string;
  layoutVersion: number;
  startedAtUtc: string;
  laps: LapRecord[];
  userId: string;
  /**
   * Ticket P16 C1 -- LAP ROWS THAT EXIST AND COULD NOT BE DECODED.
   *
   * A store reads laps row by row, and one unparseable payload must cost that
   * row rather than the session or the whole list. But a session that quietly
   * comes back with four laps instead of five has still told the reader
   * something false, so the skip is COUNTED here, the same way
   * {@link StoredRecordRead.unreadableCount} does for the list reads.
   *
   * ABSENT means every lap row of this session read cleanly (never written as
   * `0`, so a healthy summary round-trips through save/list unchanged), and
   * absent is also what a store that cannot tell reports -- which is why no
   * reader may take absence as proof of completeness. Present with `n > 0`
   * means `laps` is SHORT by `n`: a report showing this session must say the
   * lap list FAILED, not that the driver did fewer laps. It is never set by a
   * writer; `saveSession` ignores it.
   */
  unreadableLapCount?: number;
  /**
   * Ticket P10A H6. Optional so a row written by an older build still reads
   * back — and a missing value means {@link SessionCalibrationStatus}'s
   * `'unknown'`, never `'validated'`.
   */
  calibrationStatus?: SessionCalibrationStatus;
  /**
   * Ticket P10A H3 — whether the raw GNSS trace of this session is COMPLETE.
   *
   * `unwrittenSampleCount` is the number of captured fixes the controller
   * never got onto disk (every retry exhausted); `failedWriteCount` is how
   * many individual write attempts failed, including ones a retry later
   * rescued. A session with `unwrittenSampleCount > 0` has a SHORT trace and
   * must say so wherever it is shown or exported: a silent partial trace is
   * indistinguishable from a complete one, which is the failure mode this
   * whole area exists to remove.
   */
  trace?: {
    unwrittenSampleCount: number;
    failedWriteCount: number;
    /**
     * Ticket P14 H3 (Codex P13 round) -- WAS THIS RECORDING EVER FINISHED?
     *
     * `unwrittenSampleCount: 0` on its own says only "nothing had failed to
     * write as of the last time this row was rewritten". While a session is
     * still recording there are captured fixes in the pending buffer that
     * have not been counted yet, so a zero there is a RUNNING figure. Read as
     * a final account it produces the sentence the reviewer caught -- "complete
     * (no captured fix went unwritten)" -- for a session a crash truncated.
     *
     * `true` ONLY after `endSession()` has drained the trace and written the
     * final row. `false` while recording, and absent for a session written
     * before this was tracked (which a reader must treat as UNKNOWN, never as
     * finalised).
     */
    recordingFinalized?: boolean;
  };
}

/**
 * Ticket P14 H5 (Codex P13 round) -- WHAT A LIST READ COULD *NOT* READ.
 *
 * A stored payload that will not parse is skipped rather than made fatal (one
 * corrupt answer must not cost the rest of a session's answers), but the
 * skipping has to be VISIBLE. Returned by the `*WithDiagnostics` reads below
 * so a caller can say "this section FAILED" instead of "this section is
 * empty" -- the difference between "we could not look" and "we looked and
 * there was nothing", which is the distinction every report in this app now
 * turns on.
 */
export interface StoredRecordRead<T> {
  /** Everything that parsed, in the same order the plain read returns. */
  records: T[];
  /** Rows that exist in storage and could not be decoded. `0` means the read is COMPLETE. */
  unreadableCount: number;
}
export interface LocalSessionRepository {
  saveCheckpoint(sessionId: string, snapshot: SessionMachineSnapshot, laps: LapRecord[]): Promise<void>;
  loadCheckpoint(sessionId: string): Promise<{ snapshot: SessionMachineSnapshot; laps: LapRecord[] } | null>;
  saveSession(s: SessionSummary): Promise<void>;
  listSessions(userId: string, circuitId: string): Promise<SessionSummary[]>;
  saveTelemetry(sessionId: string, lapNumber: number, samples: LocationSample[]): Promise<void>;
  /**
   * Ticket P10A H4 — several telemetry rows of ONE session written ATOMICALLY.
   *
   * Exists because a completed lap's persistence is two logically inseparable
   * edits to the same table: the lap's own row is written, and the unclaimed
   * chunk rows that already hold those same fixes are rewritten without them
   * (`SessionController`'s reclaim). Done as separate writes, a failure or a
   * process death between them leaves the SAME fixes in both places, and the
   * raw export then reports one drive twice. All-or-nothing here makes that
   * state unreachable rather than merely unlikely.
   *
   * Semantics per entry are exactly {@link LocalSessionRepository.saveTelemetry}'s
   * (replace, not append); an empty `samples` array empties that row.
   */
  saveTelemetryBatch(
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
  ): Promise<void>;
  /**
   * Ticket P10B H4-B — {@link LocalSessionRepository.saveTelemetryBatch} AND
   * the recovery checkpoint, committed as ONE unit.
   *
   * Optional, because not every store can offer it. A repository that does
   * implement it promises full atomicity: after a failure, neither the
   * telemetry rows nor the checkpoint changed. `SessionController` uses it
   * when present, and otherwise falls back to writing the checkpoint FIRST
   * and the telemetry batch second — the safe order, because a checkpoint
   * that names a lap whose telemetry never landed merely reserves that lap
   * number (the fixes are still in their unclaimed chunk rows), whereas the
   * reverse leaves a committed lap row that the next run's lap numbering
   * overwrites. The reviewer measured that overwrite at 93 lost fixes.
   *
   * Ticket P11C — THE CHECKPOINT HALF IS MONOTONIC, AND ATOMICALLY SO.
   * An implementer MUST replace the stored checkpoint only when `checkpoint`
   * supersedes it — `checkpoint.laps.length` strictly greater than the
   * stored checkpoint's (a missing or undecodable stored checkpoint is
   * always superseded) — and MUST make that comparison inside the same
   * transaction as the write, never as a read followed by a separate write.
   * The `entries` are written unconditionally regardless.
   *
   * This exists because `SessionController` RETRIES a failed lap commit with
   * the checkpoint it captured at the time: without the rule, a lap-1 retry
   * landing after lap 2 committed rolls the stored checkpoint back to
   * `[1]`, and the next launch re-makes the completed lap 2 as a
   * zero-duration `RECOVERY` lap. `checkpointSupersedes` in
   * `persistence/checkpointCodec` is the shared predicate; both first-party
   * repositories use it.
   */
  saveLapCommit?(
    sessionId: string,
    entries: readonly { lapNumber: number; samples: LocationSample[] }[],
    checkpoint: { snapshot: SessionMachineSnapshot; laps: LapRecord[] },
  ): Promise<void>;
  loadTelemetry(sessionId: string, lapNumber: number): Promise<LocationSample[]>;
  /**
   * Ticket P12 item A -- the owner's verdict on ONE lap, stored by
   * `(sessionId, lapNumber)`; a second write for the same pair REPLACES, the
   * same "atomic replace" semantics every other write here has.
   *
   * Optional only so a store that cannot offer it (a test double, the web
   * preview's stand-in) still satisfies the interface. Both first-party
   * repositories implement it, and a reader that finds it absent must say the
   * verdicts are UNAVAILABLE -- never that there were none. `'unanswered'` and
   * "we could not ask the store" are different facts and this contract keeps
   * them apart.
   */
  saveLapValidityVerdict?(verdict: LapValidityVerdict): Promise<void>;
  /** Every stored verdict of one session, ascending by lap number. Laps with no row are simply absent -- see {@link mergeLapValidityVerdicts} for turning that into `'unanswered'`. */
  listLapValidityVerdicts?(sessionId: string): Promise<LapValidityVerdict[]>;
  /**
   * Ticket P14 H5: the same read, plus how many stored rows could NOT be
   * decoded. Optional on the same terms as the plain read; a caller that
   * finds it absent knows only that it cannot tell an unreadable row from an
   * absent one, which is itself a fact worth reporting.
   */
  listLapValidityVerdictsWithDiagnostics?(sessionId: string): Promise<StoredRecordRead<LapValidityVerdict>>;
  /**
   * Ticket P12 item B -- one calibration attempt's record, stored by
   * `attemptId`; a second write for the same id REPLACES (that is how a
   * provisional row becomes a concluded one). Optional on exactly the same
   * terms as the two verdict methods above.
   */
  saveCalibrationAttempt?(record: CalibrationAttemptRecord): Promise<void>;
  /** Every calibration attempt recorded for one session, oldest first. */
  listCalibrationAttempts?(sessionId: string): Promise<CalibrationAttemptRecord[]>;
  /** Ticket P14 H5: as above, plus the count of stored attempt rows that could not be decoded. */
  listCalibrationAttemptsWithDiagnostics?(
    sessionId: string,
  ): Promise<StoredRecordRead<CalibrationAttemptRecord>>;
  getReferenceLap(userId: string, circuitId: string, layoutId: string, layoutVersion: number): Promise<ReferenceLap | null>;
  putReferenceLap(ref: ReferenceLap): Promise<void>;   // atomic replace; caller enforces PB rules
  deleteUserData(userId: string): Promise<void>;
}

// ---------- Providers (dependency inversion) ----------
export interface LocationProvider {
  start(): Promise<void>; stop(): Promise<void>;
  subscribe(cb: (s: LocationSample) => void): () => void;
}
export interface MonotonicClock { now(): number }

// ---------- Replay / pipeline ----------
export interface SessionPipelineResult {
  laps: LapRecord[];
  finalState: SessionState;
  crossings: CrossingEvent[];
  calibration?: CalibrationResult;
  deltas: DeltaUpdate[];
  diagnostics: Record<string, unknown>;
}
// ReplayHarness streams a fixture's LocationSamples through the PRODUCTION pipeline
// (quality -> matcher -> crossings -> state machine -> timing -> delta) and returns SessionPipelineResult.

// ---------- Corner analysis (deterministic, derived from RuntimeProfile) ----------
export type CornerSeverity = 1 | 2 | 3 | 4 | 5 | 6; // 1=kink … 6=hairpin
export interface Corner {
  id: number;                 // 1-based, travel order from S/F
  entryDistanceM: number;     // lap distance where sustained curvature begins
  apexDistanceM: number;      // max-curvature point
  exitDistanceM: number;
  lengthM: number;
  minRadiusM: number;
  totalAngleDeg: number;
  direction: 'left' | 'right';
  severity: CornerSeverity;   // bucketed by minRadiusM (config table)
  advisorySpeedKph: number;   // angle-aware sqrt(latG*g*minRadius) — ADVISORY
  speedSource?: 'model' | 'observed';
}
/**
 * Bump on algorithm change. 3 (M-direction-split fix): `analyzeCorners` now
 * splits a run when signed curvature crosses zero and stays opposite-signed
 * for a SUSTAINED span (> `gapToleranceM`) -- previously a run was collected
 * purely by curvature MAGNITUDE, so a touching left/right chicane with no
 * real gap between the two bends stayed one corner, taking whichever apex
 * had the larger magnitude as "the" direction and suppressing the other.
 * This changed the checked-in Transilvania Motor Ring's analyzed corner set
 * (9 -> 12; three previously-merged corners, each with an implausible
 * ~180-degree `totalAngleDeg`, correctly split into their two real bends --
 * see `packages/core/test/corners/analyzeCorners.test.ts`'s TMR regression
 * pin) -- the version bump exists so any consumer keying persisted/cached
 * data off it (the observed-speeds overlay asset's own `analysisVersion`,
 * `loadObservedSpeedsFromJson`) notices and revalidates instead of silently
 * misapplying stale corner-id-keyed data to the new geometry.
 */
export const CORNER_ANALYSIS_VERSION = 3;

// ---------- Braking zones ----------
export interface BrakingZone {
  cornerId: number;
  brakeStartDistanceM: number; // lap distance where braking should begin
  source: 'reference' | 'physics'; // PB-telemetry-derived vs decel-model fallback
  entrySpeedKph: number;       // observed (reference) or estimated approach (physics)
  apexSpeedKph: number;
  /** False when the available straight was clamped to zero; emit corner-ahead instead. */
  brakeCueAvailable?: boolean;
}

// ---------- Coach engine ----------
export interface CoachCue {
  kind: 'BRAKE' | 'CORNER_AHEAD';
  cornerId: number;
  severity: CornerSeverity;
  direction: 'left' | 'right';
  distanceToTargetM: number;   // to brakeStart (BRAKE) or entry (CORNER_AHEAD)
  advisorySpeedKph: number;
  confidence: number;          // min(match confidence, zone-source confidence)
}

export interface CoachEngine {
  /**
   * `options.preserveEmitted` (default `false`): when `true`, this corner's
   * per-lap "already driven past" completion memory is carried over across
   * the reconfigure instead of being wiped -- used by a mid-lap braking-zone
   * refresh (a new PB reference landing), so a corner already completed
   * earlier in the SAME lap cannot become a fresh candidate again just
   * because its zone geometry changed.
   */
  configure(corners: Corner[], zones: BrakingZone[], options?: { preserveEmitted?: boolean }): void;
  onMatch(match: TrackMatch, speedMps: number | undefined): CoachCue | null;
  reset(): void;
}
