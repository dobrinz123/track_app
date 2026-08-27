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

### Multi-circuit selection — recovery amendment (2026-08-26, binding, after Codex CN-REV2)
`@circuit/core` writes the `sessions` row only at `endSession()`, so a crashed in-progress
session is never discoverable through `listSessions`. The recovery rule is therefore:
- `onSessionStarted` persists `activeSessionId` AND `activeSessionCircuitId` (the circuit of the
  controller that started the session) in ONE SQLite transaction. Both are cleared together on
  session end, discard, vanished-checkpoint cleanup and delete-all. `resumeRecovery()` reasserts
  both after resuming.
- Bootstrap recovery resolves the circuit in this order: persisted `activeSessionCircuitId` →
  `listSessions` scan across the bundled catalog → the persisted selection (with a warning). A
  circuit id that is not bundled discards the checkpoint with a warning.
- `selectCircuit()` awaits bootstrap (`ready()`), is serialized (concurrent calls apply in order,
  last one wins for settings AND history store), and is REFUSED — returns `{ ok: false,
  reason: 'SESSION_ACTIVE' }`, changes nothing — while the active controller is in
  `outLap`/`timing`/`inPit`/`paused`.
- Every controller-consuming entry point (preflight gate, recovery resume) first awaits any
  in-flight rebuild (`rebuildInFlight`) before evaluating state.
- DevReplay selects the scenario's circuit (through `selectCircuit`) before starting the replay,
  so calibration map, history and detail screens agree with the replay controller.
- The gate compares the built controller's circuit against the RESOLVED selection (unknown ids
  resolve to the default), never against the raw setting.
- UI copy: the word "official" may appear only inside a negation ("not an official …"); no
  render branch may ever display "Official" as a status.

### Multi-circuit selection — lifecycle lock amendment (2026-08-26, binding, after Codex CN-REV3)
Three separate serialization mechanisms (`selectionChain`, `rebuildInFlight`, `withDevReplayLock`)
left ordering holes. Replaced by ONE ordering boundary:
- `lifecycleLock` — a single async mutex in `composition.ts`. Every operation that reads or
  replaces the production controller runs ENTIRELY inside it: `selectCircuit`, every production
  rebuild (terminal-state, circuit-change, coaching-settings), the preflight gate INCLUDING the
  forward of START_PREFLIGHT to the controller it just validated, `resumeRecovery`/`discardRecovery`
  from checkpoint read to reassert, `deleteAllStoredUserData`, and the whole DevReplay sequence
  (restore → select → start) plus DevReplay cleanup/restore.
- Recovery circuit wins: `PendingRecovery` carries `circuitId`. `resumeRecovery()` switches the
  selection to that circuit (inside the lock), rebuilds for it if needed, restores the checkpoint
  into that controller, and reasserts `activeSessionId` + `activeSessionCircuitId` with the
  recovery's circuit — never the current selection.
- Delete-all: the telemetry-samples deletion + verify-empty runs regardless of per-circuit
  outcomes; aggregate `ok` = every circuit ok AND telemetry ok.
- DevReplay: the screen owns a run generation; a scenario whose generation is stale by the time
  it would install a replay or navigate aborts without side effects. Unmount cleanup runs under
  the same lock, after any in-flight scenario.
- Status labels never render the bare word "official" for any schema-permitted status value:
  `official` maps to the neutral label "source-declared" (it is still not verified by the app).

### Multi-circuit selection — facade boundary amendment (2026-08-26, binding, after Codex CN-REV4)
- Every facade command that can move the controller — `beginCalibration`, `startSession`,
  `endSession`, recovery resume/discard — runs INSIDE `lifecycleLock` (the wrapper acquires it
  around the inner call, including the provider start/stop awaits). A selection queued behind a
  start therefore observes a non-idle controller and is refused; a delete-all queued behind an
  `endSession` observes its persistence completed.
- `SessionController.start()` re-checks `disposed` after every await and aborts without
  subscribing, starting a session, or persisting if the controller was disposed meanwhile
  (`@circuit/core`, minimal change, pinned by a test).
- Delete-all: refused with `SESSION_ACTIVE` while the controller is mid-session; otherwise, inside
  the lock, it clears pending recovery, disposes the production controller and installs a fresh
  idle one BEFORE deleting, so no terminal controller can later re-persist a session/checkpoint.
- The app-background checkpoint hook checkpoints only a controller that is mid-session
  (`outLap`/`timing`/`inPit`/`paused`) — never idle, `sessionComplete` or `error`.
- DevReplay: a cancelled run has NO side effects — cancellation is checked before restore, before
  the selection write and before install; `CANCELLED` means settings/history/controller untouched.
- Recovery whose circuit is not bundled is discarded (both keys cleared, banner cleared) — no
  fallback to the selection.

### Multi-circuit selection — closing amendment (2026-08-26, binding, after Codex CN-REV5)
- Queued `endSession()`: the wrapper re-invokes the idempotent telemetry shutdown INSIDE the lock,
  immediately before the inner end, so telemetry started by a preceding locked section can never
  outlive the session end (F2 guarantee holds even when the command queued).
- `SessionController.start()` aborted by disposal never stops the shared provider (ownership is
  not knowable in core); it only skips subscribing/starting/persisting. A running provider is
  stopped by the controller that legitimately ends its session.
- Delete-all while a DevReplay controller is active (any non-idle replay state) is refused with
  `{ ok: false, reason: 'DEV_REPLAY_ACTIVE' }` — durability over convenience on the dev path.
- DevReplay cancellation is honored only BEFORE the selection write. Once the selection write has
  begun, the run completes the selection consistently (settings + history + controller agree),
  then skips install and navigation and returns `CANCELLED`. There is no rollback.

### Multi-circuit selection — provider ownership amendment (2026-08-26, binding, user finding)
- The composition layer owns the GNSS provider singleton. After ANY production rebuild inside
  `lifecycleLock` (terminal-state, circuit-change, coaching, delete-all), the freshly installed
  controller is idle by construction, so the rebuild routine stops the GNSS provider (idempotent,
  failures logged, never thrown). A controller that later starts a session restarts it through
  `ensureProviderRunning()` as before. Consequence: no session-less GNSS watcher can outlive a
  rebuild — the "orphaned provider" residual is closed at the owner, not in core.

## ENET telemetry addendum (2026-08-27, binding — Phase 4e, MHD WiFi Adapter)

Second OBD transport next to ELM327: BMW ENET = HSFZ framing over TCP carrying UDS PDUs.
Facts verified from primary sources (scapy `hsfz.py`, dissec.to HSFZ write-up — see
`.foreman/scratch/enet-protocol-research.md`); everything marked EMPIRICAL is configurable and
must be confirmed in the car.

```ts
// Settings (apps/mobile): adapterType 'elm327' | 'enet' (default 'elm327' — existing behavior
// byte-identical); enetHost (string, adapter IP from its web UI), enetPort (default 6801),
// enetTesterAddress (default 0xF4, EMPIRICAL alt 0xF1), enetTargetAddress (default 0x12 = DME,
// EMPIRICAL), enetChannelSpecs (JSON list, see below), telemetrySimulate applies to both types.

// HSFZ frame (verified): [len u32 BE = payload bytes incl. src+tgt][control u16 BE][src u8][tgt u8][UDS PDU]
// control words: 0x0001 diagnostic req/res, 0x0002 acknowledge (adapter echoes the request head),
// 0x0010 terminal15, 0x0011 vehicle ident, 0x0012 alive check, 0x0013 status, 0x0040-0x0045 error
// frames (tester addr / control word / format / dest addr / too large / app not ready), 0x00FF OOM.
// TCP 6801 (verified). UDP 6811 discovery (verified) — NOT used in v1 (no UDP dep).

// UDS client (packages/core, pure): ReadDataByIdentifier 0x22 (+0x62), OBD legacy service 0x01
// wrapped as a UDS PDU to the target (+0x41) — EMPIRICAL whether the DME answers it over ENET,
// TesterPresent 0x3E 0x80 every 2 s while polling (interval configurable), negative response 0x7F
// with NRC; 0x78 responsePending extends the wait; NRC 0x11/0x12/0x31 on a channel marks it
// UNSUPPORTED and removes it from the poll plan (recorded in diagnostics, never retried in-session).
// Alive check (0x0012) from the adapter is answered with an alive-check frame carrying the tester
// address (EMPIRICAL — recorded in diagnostics either way).

// READ-ONLY WHITELIST (hard, enforced in the core codec before framing, same model as
// customPidValidation): request SIDs allowed = {0x01, 0x22, 0x3E}. No 0x10 DiagnosticSessionControl,
// no 0x27, 0x2E, 0x31, 0x34-0x37, 0x3D, 0x85 — ever. Target address is a free byte (DSC/EGS later).

export interface EnetChannelSpec {
  channel: TelemetryChannelId;           // rpm | speedKph | throttlePct | coolantC | engineOilC | ... (no latG/longG)
  mode: 'obd01' | 'did';                 // obd01: PID via service 0x01 (decoded by pidCodec); did: 0x22 DID
  requestHex: string;                    // obd01: 2 hex chars PID; did: 4 hex chars DID
  targetAddress?: number;                // default = enetTargetAddress
  decode?: { byteOffset: number; byteLength: 1 | 2; signed?: boolean; scale: number; offset: number }; // did only
  provenance: string;                    // REQUIRED for did specs: where the DID/decode came from
}
// Built-in default specs: obd01 for rpm 0C, speedKph 0D, throttlePct 11, coolantC 05, engineOilC 5C
// (all EMPIRICAL on the A90). DID specs default to NONE — no public B58/DSC DID table exists.

// Poll plan: same channel rates as the ELM path (rpm/speed/throttle 5 Hz, temps 0.2-0.5 Hz);
// scheduler = weighted round-robin as in Elm327SessionEngine; one request in flight at a time.
// Samples flow through the SAME TelemetrySample/recorder path (tMonoMs, retention cap 200k).
// Diagnostics: per-channel supported/unsupported + last NRC, frames tx/rx, ack latency p50/p95,
// last raw frame hex (for the dev DID-probe screen).
// Single-client rule (MHD): documented in settings copy — the MHD app must be closed.
// Dev-only "DID probe" screen: send one 0x22 DID (or 0x01 PID) to a target, show raw response hex —
// the empirical tool for discovering B58/DSC identifiers; whitelist applies there too.
// Simulator: SimulatedEnetTransport = scripted ECU over HSFZ (acks, responses, alive checks, NRC,
// disconnect and TCP fragmentation injection) — the hardware-free proof for tests and preview E2E.
```

### ENET addendum — framing & correlation amendment (2026-08-27, binding, after Codex P4e-REV1)
- HSFZ payload layout is CONTROL-SPECIFIC (per the cited scapy reference): 0x0001/0x0002 = [src][tgt][UDS PDU];
  0x0012 alive check = either the short addressed form [src][tgt] or a long identification-string form
  (payload is opaque bytes; the reply to a short alive check is the short form with the tester address —
  EMPIRICAL either way, recorded raw in diagnostics); 0x0040–0x0045 error frames carry [expected][received]
  bytes (no src/tgt); 0x0011 vehicle-ident and 0x0013 status carry opaque payloads. The parser exposes a
  discriminated union by control word and never fabricates src/tgt for non-diagnostic frames.
- Length bound: the wire field is u32; the app accepts at most 4096 payload bytes (any diagnostic PDU we
  send/expect is far below); a larger or < 2 length is a FATAL framing error → the transport is closed and
  the session reconnects (a corrupted length has no in-stream resync point; TCP chunk boundaries are meaningless).
- Response correlation: a diagnostic response is matched to the in-flight request by (target/source address
  swapped, response SID = request SID + 0x40 or 0x7F with the request SID echoed, identifier echo — PID or DID).
  Unmatched responses (late, other SID/identifier, TesterPresent negatives) are counted in diagnostics and do
  NOT clear the in-flight slot or mark channels unsupported. Negative responses count against a channel only
  when the echoed request SID and identifier match it.
- Spec validation (runtime JSON): obd01 requestHex must be a PID whose decoder exists for THAT channel
  (channel↔PID consistency table); did decode requires integer byteOffset ≥ 0, byteLength ∈ {1,2}, finite
  scale/offset; decoded values must be finite or the sample is dropped and counted as a decode error.
- TesterPresent interval is clamped to ≥ 500 ms and never issued back-to-back ahead of channel polling
  more than once per interval; ACK latency is attributed only to a frame whose echoed head matches.

### ENET addendum — poll plan, probe & robustness amendment (2026-08-27, binding, after Codex P4e-REV2)
- Correlation completeness: a diagnostic payload from the correct addresses that does not parse as a UDS
  response is counted (`malformedResponses`) and leaves the in-flight slot untouched (timeout or the real
  response resolves it); any diagnostic response while no request is in flight increments `unmatchedResponses`.
- ENET poll plan derives from the RESOLVED channel specs: every spec's channel is polled at the rate table
  (rpm/speed/throttle 5 Hz, coolant 0.2 Hz, oil temps 0.5 Hz, intake/load 1 Hz, unknown 1 Hz). On the ENET
  path `transOilC` is NOT gated by the ELM-era `transOilPidHex`.
- Channel-spec JSON from settings is untrusted: every array member is structurally validated (object;
  channel ∈ TelemetryChannelId minus latG/longG; mode; requestHex string; optional targetAddress 0–255;
  decode object shape; provenance string) BEFORE any core call; failures are surfaced as errors in the UI and
  the provider/monitor fall back to the built-in defaults — nothing throws on blur or render.
- DID probe (dev): allowed ONLY when `telemetryEnabled && adapterType === 'enet'` and the telemetry provider
  is `idle`/`stopped`/`failed` (never while connecting/polling) — the MHD adapter accepts one ECU client;
  the probe shows a "stop telemetry first" message otherwise; it uses the simulated transport when
  `telemetrySimulate` is on; responses are correlated (swapped addresses, SID+0x40/0x7F echo, identifier
  echo) and unmatched frames are logged as UNMATCHED, never as OK.
- `EnetTcpTransport` is one-shot: remote close/error sets `closed`, drops the socket, rejects later `send()`
  and a second `connect()`; connect timeout is tested.
- Persisted settings are repaired on hydration: adapterType ∉ enum → 'elm327'; enetPort ∉ 1–65535 →
  6801; tester/target ∉ 0–255 → defaults; specs JSON unparsable → ''.
- New settings rows must not overflow at 360pt/1.3×: labels shrink/wrap; inputs keep a minimum width.

## ENET auto-discovery & DID sweep addendum (2026-08-27, binding — Phase 4f)

Goal: after the user joins the adapter's WiFi (iOS cannot do that for a sideloaded app), the app finds the
adapter, connects, and helps discover identifiers — no manual IP/port/DID typing in the common case.

- **Discovery (core, pure orchestrator + injected transport factory/clock)**: candidates in this order —
  the configured host (if any), `192.168.4.1` (MHD web UI address), the phone subnet's `.1`, then every
  host of the phone's /24 (skipping the phone itself). Ports tried per host: configured port, then 6801.
  Per candidate: TCP connect with a short timeout (default 300 ms) → **level 1**; then send ONE
  whitelisted TesterPresent (0x3E 0x80 to the configured target) and accept any valid HSFZ frame
  (ACK 0x0002, diagnostic, alive-check, or a decodable error frame) within 500 ms → **level 2**.
  Concurrency ≤ 16 sockets, total budget ≤ 8 s, deterministic ordering of results (level desc, then
  candidate order). The result never auto-changes settings unless the user tapped "Find adapter" or
  auto-connect is on; when applied, host/port are persisted with provenance `discovered <date>`.
- **Auto-connect**: when telemetry is enabled with adapterType 'enet' and the provider cannot connect to
  the configured host (or none is configured), it runs discovery ONCE per start (bounded as above) and,
  on a level-2 hit, applies it and connects. Never loops; failure surfaces in diagnostics.
- **Network awareness**: the app reads its own IPv4/subnet (`expo-network`, SDK-matched) and shows it on
  the telemetry screen with a plain hint ("join the adapter's WiFi MHD_XXXX first") when no adapter answers.
- **DID sweep (dev-only, core planner + mobile screen)**: iterates a configurable DID range (default
  0x0000–0xFFFF, resumable, pause/stop) sending ONE 0x22 request at a time through the same whitelisted
  codec and session rules (TesterPresent cadence, 0x78 handling); records every positive 0x62 response
  (DID, raw bytes, length) and NRC classes for the rest; adaptive pacing from measured round-trip.
  Exclusive with the provider through the adapter reservation. Progress persists in memory for the run.
- **Heuristics (core, pure)**: for responders sampled repeatedly (re-poll the responder set at ~1 Hz
  for the observation window) classify candidates by signal shape: temperature-like (slow monotonic
  drift, plausible range under u8−40 / u16÷10 decodes), speed-like (correlates with GNSS speed when
  available), pedal-like (fast bimodal steps), steering-like (zero-centred sign changes). Output is a
  ranked suggestion list with confidence and the decode used; the user confirms with one tap, which
  writes an `EnetChannelSpec` with provenance `in-car sweep <date>, DID <hex>, decode <…>` into the
  channel specs. No suggestion is ever applied without confirmation.
- Whitelist {0x01, 0x22, 0x3E} is untouched; discovery and sweep cannot send anything else. All new
  network activity is confined to telemetry-enabled + adapterType 'enet' (discovery) or the dev sweep.

### P4f addendum — hard bounds & sweep boundary amendment (2026-08-27, binding, after Codex P4f-REV1)
- Discovery hard bounds: concurrency = min(configured, 16) enforced; at budget expiry or abort, no new probe
  starts AND every active transport is closed immediately (close raced against a 200 ms timeout so a hanging
  close cannot block); the run returns `truncated: true` with only completed results; abort is checked
  synchronously before any send. Level 2 counts only ACK / diagnostic / alive-check / decodable error frames
  ('other' controls stay level 1). Candidates: IPs canonicalized (trim, octet range 0–255, no leading zeros
  ambiguity) and compared canonically; the phone's /24 is always enumerated regardless of the reported mask.
- Sweep boundary: `runDidSweep` builds each 0x22 request itself through `assertAllowedRequest` and takes a
  low-level `sendRequest(pdu) → Promise<Uint8Array | 'timeout'>`; every response is parsed with the real UDS
  parser and correlated (0x62 + echoed DID → stripped payload; 0x7F with requestSid 0x22 → NRC; anything
  else → `unmatched`, no credit); 0x78 extends the wait (bounded, default 5 extensions); a per-request
  timeout (default 1000 ms) lives in the runner. Pause is re-checked after every wait; the cursor advances
  only after a result; results accumulate across resumes (the runner accepts and returns an accumulator).
  Priority ranges are validated (finite integers) and clipped to the plan range; pacing is clamped to
  5–2000 ms and non-finite values fall back to defaults.
- Heuristics use time: temperature = slow monotonic drift over ≥ 30 s (|slope| ≤ 2 °C/s, monotonic ratio ≥ 0.8);
  pedal = fast steps (≤ 2 s) between two plateaus; speed = correlation AND scale fit (least-squares gain
  within ±25 % of 1 after decode; confidence scaled by residual); steering = zero crossings counted with
  `prev ≤ 0 < curr` semantics and contributing to confidence; contradictory evidence lowers confidence.
  `enetSpecsFromSuggestion` validates through `validateEnetChannelSpecs` and rejects forbidden channels,
  out-of-range DIDs and empty dates.

### P4f addendum — sweep transport interface & lifecycle amendment (2026-08-27, binding, after Codex P4f-REV2)
- Discovery: `budgetMs = min(configured, 8000)`; `concurrency` sanitized (non-finite or < 1 → 16, capped at 16).
- Sweep low-level interface replaces `sendRequest(pdu)`:
  `{ send(pdu): Promise<void>; nextResponse(timeoutMs): Promise<Uint8Array | 'timeout'>; keepAlive(pdu): Promise<void> }`.
  The runner sends the 0x22 PDU once, then awaits `nextResponse`; on NRC 0x78 it awaits again WITHOUT re-sending
  (bounded extensions); an unmatched response (wrong SID/DID) is counted and the runner keeps awaiting within the
  remaining timeout (bounded count); the runner issues TesterPresent via `keepAlive` every 2 s (built through the
  whitelist). Synchronous throws from any interface call are contained (counted as errors, sweep continues or
  stops per `maxConsecutiveErrors`). The mobile implementation of `nextResponse` returns any diagnostic PDU from
  the target with swapped addresses — correlation by SID/identifier is the runner's job.
- Sweep lifecycle (mobile controller owns the transport): acquire the `'sweep'` reservation → open a FRESH
  transport → run → close the transport → release the reservation (release strictly after close, on every
  path incl. stop/throw). Start is refused unless the controller is idle/complete; observation from a paused
  sweep reuses the held claim (no second acquire). Observation polls responders round-robin targeting ~1 Hz per
  responder (degraded cadence reported when N×RTT > 1 s); GNSS speed context is passed when the app has a live
  speed source, else omitted and stated in the UI.
- Provider auto-discovery is abortable: `stop()` aborts an in-flight discovery, awaits it, and releases the
  provider token before returning.
- Under `telemetrySimulate` (dev) discovery (Find adapter and auto-connect) uses the simulated probe factory
  so the preview demonstrates the full flow.
- Sweep progress text and any long monospace value shrinks/wraps at 360pt/1.3×.
