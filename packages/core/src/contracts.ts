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

export interface LapTimingEngine {
  reset(): void;
  onCrossing(e: CrossingEvent, currentQuality: QualityLevel, inPit: boolean): LapRecord | null; // returns a lap when one completes
  currentLap(): { lapNumber: number; elapsedMs: (nowMono: number) => number; sectorIndex: number } | null;
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
  trace?: { unwrittenSampleCount: number; failedWriteCount: number };
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
