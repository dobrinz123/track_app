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
  geometryStatus: 'official' | 'community-derived' | 'dev-only';
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
export interface SessionSummary { sessionId: string; circuitId: string; layoutId: string; layoutVersion: number; startedAtUtc: string; laps: LapRecord[]; userId: string }
export interface LocalSessionRepository {
  saveCheckpoint(sessionId: string, snapshot: SessionMachineSnapshot, laps: LapRecord[]): Promise<void>;
  loadCheckpoint(sessionId: string): Promise<{ snapshot: SessionMachineSnapshot; laps: LapRecord[] } | null>;
  saveSession(s: SessionSummary): Promise<void>;
  listSessions(userId: string, circuitId: string): Promise<SessionSummary[]>;
  saveTelemetry(sessionId: string, lapNumber: number, samples: LocationSample[]): Promise<void>;
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
  advisorySpeedKph: number;   // sqrt(latG*g*minRadius), config latG default 0.85 — ADVISORY
}
export const CORNER_ANALYSIS_VERSION = 1; // bump on algorithm change
