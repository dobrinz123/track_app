# Module Contracts (canonical)

Authored by the lead architect. These TypeScript declarations are the **binding interface contracts** between work packages. The scaffold work package materializes them verbatim into `packages/core/src/contracts.ts` (split into files is permitted; shapes and names are not negotiable without a ledger-logged decision).

Conventions:
- All times in **monotonic milliseconds** (`tMono`) unless suffixed `Utc`. Wall-clock is metadata only, never used for durations.
- Distances in meters. Progress is normalized `[0,1)` around the lap; `unwrappedProgressM` grows monotonically across laps.
- Delta sign convention: **negative = faster than reference, positive = slower**.
- No React/React Native/Expo imports anywhere in `packages/core`.

```ts
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
```

## PB replacement rules (binding)

A candidate lap replaces the stored reference lap only if **all** hold: same `circuitId/layoutId/layoutVersion`; `valid === true`; quality `good` or `degraded` (never `unreliable`); not a pit-transit lap; complete ordered sector times; `durationMs < current PB durationMs` (or no PB exists); full telemetry present. Replacement is atomic (write-new-then-swap). Provenance fields are mandatory.

## Gate crossing semantics (binding)

A crossing exists when the segment `prevPos -> currPos` (local ENU) strictly intersects gate segment `a->b`, computed by segment–segment intersection; `tCross` is linearly interpolated between `prev.tMono` and `curr.tMono` by intersection parameter. Direction is the sign of the cross product of the gate vector and the motion vector; only `forward` crossings count for timing. Debounce: after a counted crossing of a gate, ignore further crossings of the same gate until `minRearmDistanceM` (default 50 m) of additional unwrapped progress.

## Coaching addendum (2026-08-10, binding — Phase 3)

All advisory. Severity/speeds are derived estimates, never presented as official or as safety guidance; UI copy must say "advisory".

```ts
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

// ---------- Braking zones ----------
export interface BrakingZone {
  cornerId: number;
  brakeStartDistanceM: number; // lap distance where braking should begin
  source: 'reference' | 'physics'; // PB-telemetry-derived vs decel-model fallback
  entrySpeedKph: number;       // observed (reference) or advisory (physics)
  apexSpeedKph: number;
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
  configure(corners: Corner[], zones: BrakingZone[]): void;
  onMatch(match: TrackMatch, speedMps: number | undefined): CoachCue | null;
  reset(): void;               // per-lap rearm at S/F crossing
}
// Semantics: look-ahead = max(minLeadM, leadSeconds*speed) (defaults 80 m, 3.0 s);
// one BRAKE + one CORNER_AHEAD max per corner per lap (debounced, rearm on S/F);
// null when match quality worse than 'degraded' or confidence < 0.4 — never guess.
```

## Telemetry addendum (2026-08-10, binding — Phase 4 / P4a)

Vehicle telemetry over a LOCAL socket only (adapter is a WiFi AP; zero internet at runtime).
STRICTLY READ-ONLY on the vehicle bus: OBD mode 01 (live data) requests only — never mode 04
(clear DTCs), never mode 08 (actuation), never raw CAN writes. Advisory-only labeling applies.

```ts
// ---------- Channels ----------
export type TelemetryChannelId =
  | 'rpm'          // engine RPM            (PID 0x0C, (256A+B)/4)
  | 'speedKph'     // vehicle speed         (PID 0x0D, A)
  | 'throttlePct'  // throttle position     (PID 0x11, A*100/255)
  | 'coolantC'     // coolant temperature   (PID 0x05, A-40)
  | 'intakeC'      // intake air temp       (PID 0x0F, A-40)
  | 'engineLoadPct'; // calculated load     (PID 0x04, A*100/255)

export interface TelemetrySample {
  channel: TelemetryChannelId;
  value: number;               // decoded, in the channel's unit above
  tMonoMs: number;             // SAME monotonic clock as LocationSample — injected, never Date.now()
}

// ---------- Transport (pure interface; mobile provides TCP impl) ----------
export interface ObdTransport {
  connect(): Promise<void>;    // rejects on failure; no auto-retry inside
  send(line: string): void;    // one command, no trailing CR (session adds it)
  onData(cb: (chunk: string) => void): () => void; // raw chunks, may split/merge arbitrarily
  onClose(cb: (err?: Error) => void): () => void;
  close(): Promise<void>;
}

// ---------- ELM327 session (pure TS, @circuit/core) ----------
export type Elm327State = 'idle' | 'connecting' | 'initializing' | 'polling' | 'stopped' | 'failed';
export interface Elm327Config {
  pollPlan: Array<{ channel: TelemetryChannelId; hz: number }>; // target rates; scheduler degrades gracefully
  initTimeoutMs: number;       // default 5000
  commandTimeoutMs: number;    // default 1500 per request
  maxConsecutiveErrors: number;// default 5 -> 'failed'
}
export interface Elm327Session {
  start(): void;               // runs init handshake then the polling loop
  stop(): Promise<void>;       // graceful: finishes in-flight command, closes transport
  onSample(cb: (s: TelemetrySample) => void): () => void;
  onStateChange(cb: (st: Elm327State, detail?: string) => void): () => void;
  getDiagnostics(): { observedHzByChannel: Record<string, number>; errorCount: number; lastError?: string };
}
// Semantics (binding):
// - Init sequence: ATZ, ATE0, ATL0, ATS0, ATSP0 (auto protocol) — each awaited to '>' prompt.
// - Exactly ONE in-flight command at a time; responses are '>'-terminated; parser must tolerate
//   chunk splits at ANY byte boundary and echo-on adapters (strip echo defensively even after ATE0).
// - 'NO DATA' / 'STOPPED' / '?' / 'CAN ERROR' count as channel errors, not fatal until
//   maxConsecutiveErrors; 'UNABLE TO CONNECT' during init -> 'failed'.
// - Scheduler: weighted round-robin honoring pollPlan hz ratios; never busy-waits; a slow adapter
//   lowers all rates proportionally (observed rates exposed via getDiagnostics).
// - Timestamps: tMonoMs stamped at RESPONSE arrival using the injected monotonic clock.

// ---------- Simulated adapter (dev/test — packages/core, deterministic) ----------
// SimulatedElm327Transport implements ObdTransport over a scripted vehicle model
// (rpm/speed/throttle as functions of scenario time). Deterministic given (scenario, seed);
// supports fault injection: chunk fragmentation, NO DATA, disconnect mid-command, garbage bytes.

// ---------- Recording (mobile, SQLite) ----------
// Table telemetry_samples(session_id, lap_number NULLABLE, t_mono_ms, channel, value)
// - Batched inserts (>=25 samples or 1s, whichever first); flushed on lap crossing and endSession
//   through the SAME flush path as lap persistence (Promise.all discipline).
// - RETENTION CAP (binding, M2 lineage): at most 200_000 telemetry rows per session; when hit,
//   recording stops with a diagnostics flag (never crashes, never evicts older rows mid-session).
// - Telemetry NEVER gates lap timing: a dead adapter must not delay or invalidate any lap.
export const TELEMETRY_SCHEMA_VERSION = 1;
```

### Telemetry addendum — P4b amendments (binding)

- Session-complete barrier (mobile): the facade layer holds the `sessionComplete`
  state emission until the telemetry shutdown/final-flush promise settles, capped
  at 2000 ms (a hung adapter socket must never delay Results by more than that).
  Telemetry rejection never blocks or fails the emission — barrier is allSettled.
- Recorded-telemetry read API (mobile): readLapTelemetry(db, sessionId, lapNumber)
  returns rows ordered by t_mono_ms; UI aggregates into fixed-count buckets
  (default 80) by averaging per bucket. Charts render ONLY when rows exist; their
  absence changes nothing else on the screen.
- Dashboard telemetry strip (H1 fix, binding — SUPERSEDES the original "fixed
  slot" phrasing): contributes ZERO normal-flow height on the dashboard — no
  reserved row, no container gap. It renders as an absolutely-positioned
  overlay pinned to the top of the delta zone (the flex-growing region around
  the live delta figure), and renders NOTHING at all — no styled card, no
  accessibility node — unless telemetryEnabled AND the provider state is
  'polling'; shows at most rpm, throttlePct, coolantC (coolant tinted amber
  >= 98 C, red >= 105 C) while visible. It must never occlude or reflow
  timing elements, and when hidden the dashboard layout is byte-identical to
  before this addendum.

### Telemetry addendum — channel revision (2026-08-11, binding)

User-driven revision: oil temperatures outrank coolant for display; RPM stays
recorded but leaves the strip (it is on the car's own dash); G-forces recorded
for analysis, not displayed live.

```ts
export type TelemetryChannelId =
  | 'rpm' | 'speedKph' | 'throttlePct' | 'coolantC' | 'intakeC' | 'engineLoadPct'
  | 'engineOilC'   // engine oil temp, STANDARD PID 0x5C, A-40
  | 'transOilC'    // transmission oil temp — NO standard mode-01 PID exists.
                   // Implemented as a user-configurable CUSTOM PID (settings:
                   // hex request string, vehicle-specific, e.g. a mode-22 DID;
                   // decode = last data byte - 40). Unset -> channel absent.
                   // The P4c ESP32 CAN device will provide this natively.
  | 'latG' | 'longG'; // device accelerometer (expo-sensors), NOT OBD:
                   // gravity isolated via low-pass (alpha 0.8), linear accel
                   // projected off the gravity vector; portrait mount assumed
                   // (documented limitation until P4c IMU). Unit: g. ~25 Hz,
                   // recorded through the SAME TelemetrySample/recorder path.

// Poll plan defaults (revised): rpm 5 Hz (record-only), speedKph 5, throttlePct 5,
// engineOilC 0.5, transOilC 0.5 (only when configured), coolantC 0.2.
// Strip display (revised): THR | ENG OIL | TRANS OIL — third slot falls back to
// COOLANT when transOilC is not configured. RPM and G never on the strip.
// Tint thresholds (named constants): engineOilC amber >= 120, red >= 130;
// transOilC amber >= 110, red >= 125; coolantC keeps 98/105.
// Lap-detail charts (revised order): speedKph, rpm, throttlePct, latG, longG,
// engineOilC, transOilC — each renders only when rows exist (unchanged rule).
```

## Multi-circuit selection addendum (2026-08-26, binding — Circuit N+1 campaign)

Until this addendum every production `SessionController`, the session-history
store, the delete-all flow, coaching corners, the calibration track map and the
circuit/PB screens hardcoded Transilvania Motor Ring. With a second bundled
circuit (MotorPark România, `motorpark-romania`) the app has ONE selected circuit:

- `AppSettings.selectedCircuitId: string` (default `'transilvania-motor-ring'`),
  persisted like every other setting. An id that is not in the bundled catalog
  resolves to the default with a `console.warn` — never a crash, never a fetch.
- The bundled catalog entry is the unit of truth: `{ profile, runtime, corners }`
  per circuit. `corners = analyzeCorners(runtime)`; an observed-speeds overlay
  is applied ONLY when that circuit ships one (TMR today). Circuits without an
  overlay get model-derived advisories only (playbook §2 step 4).
- `createProductionController()` reads the selected circuit at build time. The
  preflight gate rebuilds the controller when it is terminal (existing C1 rule)
  OR when its circuit differs from the selection and it is `idle`. A controller
  is never rebuilt mid-session (`outLap`/`timing`/`inPit`/`paused`): selection
  changes while a session is running are not reachable from the UI and, if
  they ever were, must be refused, not applied.
- `SqlSessionHistoryStore` is per (circuit, layout); selecting a circuit rebuilds
  and refreshes it so History/PB always show the selected circuit. PB reference
  laps stay keyed by `circuitId/layoutId/layoutVersion` (unchanged PB rules).
- Recovery: the checkpoint's circuit is resolved by looking the active session
  id up in `listSessions(userId, circuitId)` across the bundled catalog; the
  selection is switched to that circuit BEFORE the controller resumes. A
  checkpoint whose circuit is not bundled is discarded with a warning.
- Delete-all data spans EVERY bundled circuit (per-circuit `deleteAllUserData`
  with its verify-empty check, results aggregated) plus telemetry samples.
- Navigation: `CircuitDetail: { circuitId }`; the detail screen renders from the
  catalog profile (name, locality, country, length, layout, direction,
  geometry/sector status, provenance + ODbL attribution from `source`), never
  from a per-circuit constant. Nothing is ever labeled "official".
- Circuit-independent surfaces (dashboard, voice, telemetry, track-map
  renderer) stay circuit-independent; only their inputs come from the selection.
