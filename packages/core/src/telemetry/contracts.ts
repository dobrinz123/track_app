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
  | 'brakeSwitch'  // brake pedal SWITCH, as a percentage so one consumer handles both brake
                   // channels: exactly 0 (released) or 100 (pressed). Ticket P4l-FIX1 F1
                   // (binding): no standard mode-01 PID exists -- it arrives ONLY from a
                   // Signal-Finder-confirmed per-vehicle binding (`vehicle_profile_bindings`,
                   // channel `brakeSwitch`), polled as that binding's own DID at that
                   // binding's own ECU address, and decoded by the binding's own rule
                   // ("anything off the recorded rest byte reads pressed").
  | 'brakePct'     // brake PRESSURE as 0..100%, same binding path as `brakeSwitch` above
                   // (`vehicle_profile_bindings` channel `brakePressure`), scaled from the
                   // finder's own observed min..max. A real analog: it always wins over a
                   // bare switch when the profile carries both.
  | 'latG' | 'longG'  // device accelerometer, NOT OBD; gravity isolated by low-pass,
                      // linear acceleration projected off gravity; portrait mount;
                      // unit g, recorded through the same TelemetrySample path
  | 'yawRateDps';    // device GYROSCOPE (expo-sensors `Gyroscope`), NOT OBD. Ticket P6a
                     // (binding): the rate the CAR rotates about its vertical axis,
                     // degrees per second, in the SAME sense as GNSS course over ground
                     // (compass convention -- a RIGHT turn is positive), so
                     // `coaching/cleanLap.ts`'s yaw check can compare it against the
                     // centreline heading it already falls back to. Read off the device
                     // Z axis under the same portrait/flat mount assumption `latG`/`longG`
                     // make (x lateral, y longitudinal, z vertical) and sign-flipped,
                     // because a gyroscope is right-handed about +z (counterclockwise
                     // positive) while a compass heading grows clockwise.
                     //
                     // Emitted ONLY while the `imuFusionEnabled` setting is on
                     // (`apps/mobile/src/session/gforceProvider.ts`): with the flag off the
                     // gyroscope is never subscribed to and no row of this channel is ever
                     // recorded, so every pre-P6a recording and every default install
                     // behaves exactly as before. `coaching/types.ts`'s `CoachingChannelId`
                     // already named it as a tier-2 channel "no shipped provider emits yet";
                     // this is that move, and the union alias simply collapses.

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
/**
 * Field revision 2 (2026-08-27, binding — Phase 4h): which standard PID
 * `accelPedalPct` is polled with -- '5A' ("Relative accelerator pedal
 * position", the primary source) or '49' (the fallback, used when the DME
 * answers NRC/unsupported for 0x5A). P4h-FIX1 H4 (after Codex P4h-REV1 HIGH):
 * carried per-session in `Elm327Config` below, never in process-global state.
 */
export type AccelPedalPidSource = '5A' | '49';

export interface Elm327Config {
  pollPlan: Array<{ channel: TelemetryChannelId; hz: number }>; // target rates; scheduler degrades gracefully
  customPids?: Array<{ channel: TelemetryChannelId; request: string }>; // raw hex sent verbatim
  initTimeoutMs: number;       // default 5000
  commandTimeoutMs: number;    // default 1500 per request
  maxConsecutiveErrors: number;// default 5 -> 'failed'
  /** P4h-FIX1 H4 (binding): the accelPedalPct PID this session polls/decodes, FROZEN for its whole lifetime. Default '5A'. */
  accelPedalPidSource?: AccelPedalPidSource;
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
