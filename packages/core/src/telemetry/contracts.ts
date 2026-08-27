// ---------- Channels ----------
export type TelemetryChannelId =
  | 'rpm'          // engine RPM            (PID 0x0C, (256A+B)/4)
  | 'speedKph'     // vehicle speed         (PID 0x0D, A)
  | 'throttlePct'  // throttle PLATE position (PID 0x11, A*100/255) -- idles at ~14-15% open, NOT the pedal
  | 'accelPedalPct' // accelerator PEDAL position D (PID 0x49, A*100/255, SAE J1979) --
                    // field revision (2026-08-27): the user-facing "how far is my foot down"
                    // channel; EMPIRICAL on the Supra -- idles at ~0% and rises with the pedal,
                    // unlike throttlePct above (the plate's own, engine-computed opening)
  | 'coolantC'     // coolant temperature   (PID 0x05, A-40)
  | 'intakeC'      // intake air temp       (PID 0x0F, A-40)
  | 'engineLoadPct' // calculated load      (PID 0x04, A*100/255)
  | 'engineOilC'   // engine oil temp, STANDARD PID 0x5C, A-40
  | 'transOilC'    // transmission oil temp — NO standard mode-01 PID exists;
                   // user-configurable custom PID, decoded as last data byte - 40;
                   // unset -> channel absent
  | 'latG' | 'longG'; // device accelerometer, NOT OBD; gravity isolated by low-pass,
                      // linear acceleration projected off gravity; portrait mount;
                      // unit g, recorded through the same TelemetrySample path

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
  customPids?: Array<{ channel: TelemetryChannelId; request: string }>; // raw hex sent verbatim
  initTimeoutMs: number;       // default 5000
  commandTimeoutMs: number;    // default 1500 per request
  maxConsecutiveErrors: number;// default 5 -> 'failed'
}
export interface Elm327Session {
  start(): void;               // runs init handshake then the polling loop
  stop(): Promise<void>;       // graceful: finishes in-flight command, closes transport
  onSample(cb: (s: TelemetrySample) => void): () => void;
  // An unconfigured transOilC poll entry is ignored and reported once as polling-state detail.
  onStateChange(cb: (st: Elm327State, detail?: string) => void): () => void;
  getDiagnostics(): { observedHzByChannel: Record<string, number>; errorCount: number; lastError?: string };
}

export const TELEMETRY_SCHEMA_VERSION = 1;

// ---------- Neutral session shape (Phase 4e / ENET addendum) ----------
// `Elm327Session`'s start/stop/onSample/onStateChange/getDiagnostics shape,
// generalized over the state-vocabulary type so a second transport engine
// (see `telemetry/enet/**`) can implement the identical surface with its own
// state union, without any change to `Elm327Session` itself (additive only).
// `Elm327Session` remains assignable to `TelemetrySession<Elm327State>` by
// structure; nothing above this comment changes.
export interface TelemetrySession<TState extends string = Elm327State> {
  start(): void;
  stop(): Promise<void>;
  onSample(cb: (s: TelemetrySample) => void): () => void;
  onStateChange(cb: (st: TState, detail?: string) => void): () => void;
  getDiagnostics(): { observedHzByChannel: Record<string, number>; errorCount: number; lastError?: string };
}
