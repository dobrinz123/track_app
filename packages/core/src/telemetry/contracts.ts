// ---------- Channels ----------
export type TelemetryChannelId =
  | 'rpm'          // engine RPM            (PID 0x0C, (256A+B)/4)
  | 'speedKph'     // vehicle speed         (PID 0x0D, A)
  | 'throttlePct'  // throttle position     (PID 0x11, A*100/255)
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
