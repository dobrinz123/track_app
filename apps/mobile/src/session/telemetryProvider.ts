import {
  ACCEL_PEDAL_FALLBACK_ENET_SPEC,
  buildDiscoveryCandidates,
  createElm327Session,
  createEnetSession,
  createSimulatedDiscoveryProbeFactory,
  DEFAULT_ENET_CONFIG,
  ENET_DEFAULT_CHANNEL_RATES_HZ,
  runDiscovery,
  setAccelPedalPidSource,
  SimulatedElm327Transport,
  SimulatedEnetTransport,
  type DiscoveryAbortSignal,
  type Elm327Config,
  type Elm327Session,
  type Elm327State,
  type EnetChannelSpec,
  type EnetConfig,
  type EnetSession,
  type EnetState,
  type ObdTransport,
  type RunDiscoveryResult,
  type TelemetryChannelId,
  type TelemetrySample,
} from '@circuit/core';
import type { AdapterType, SettingsStore } from './settingsStore';
import { TcpObdTransport } from './tcpObdTransport';
import { EnetTcpTransport } from './enetTcpTransport';
import { CUSTOM_PID_VALIDATION_ERROR, isAllowedCustomPidRequest } from './customPidValidation';
import { applyDiscoveryResult, resolveEnetChannelSpecs } from './enetSettingsValidation';
import { getNetworkInfo } from './networkInfo';
import {
  enetAdapterReservation as sharedEnetAdapterReservation,
  type EnetAdapterReservation,
  type EnetAdapterToken,
} from './enetAdapterReservation';
import {
  INITIAL_PEDAL_OFFSET_LEARNER,
  normalizeAccelPedalPct,
  registerPedalOffsetSample,
  type PedalOffsetLearner,
} from './pedalNormalization';

/** User-facing diagnostics note (binding, P4e-FIX3 H2) when the ENET adapter is held by the dev DID-probe screen -- the MHD adapter accepts one ECU client at a time. */
export const ENET_ADAPTER_RESERVED_BY_PROBE_DETAIL = 'adapter reserved by probe';

/**
 * Telemetry addendum — channel revision (2026-08-11, binding) poll plan,
 * extended by the field revision (2026-08-27, binding): rpm 5Hz (record-only
 * -- RPM left the strip, it's on the car's own dash), speedKph 5Hz,
 * throttlePct 5Hz (the throttle PLATE, PID 0x11), accelPedalPct 5Hz (the
 * accelerator PEDAL, PID 0x49 -- the field test found the plate idles at
 * ~14-15% with no pedal input, so the pedal channel is the user-facing one),
 * engineOilC 0.5Hz (standard PID 0x5C), transOilC 0.5Hz ONLY when the user
 * has configured a custom PID request (`settings.transOilPidHex` -- empty
 * means "not configured", the entry is omitted entirely rather than relying
 * on `@circuit/core`'s own "unconfigured transOilC is silently ignored"
 * fallback), coolantC 0.2Hz. Exported (pure, no react-native import) so the
 * exact plan built from a given settings value can be pinned by a test.
 */
export function buildPollPlan(transOilPidHex: string): Array<{ channel: TelemetryChannelId; hz: number }> {
  const plan: Array<{ channel: TelemetryChannelId; hz: number }> = [
    { channel: 'rpm', hz: 5 },
    { channel: 'speedKph', hz: 5 },
    { channel: 'throttlePct', hz: 5 },
    { channel: 'accelPedalPct', hz: 5 },
    { channel: 'engineOilC', hz: 0.5 },
  ];
  if (transOilPidHex.trim() !== '') {
    plan.push({ channel: 'transOilC', hz: 0.5 });
  }
  plan.push({ channel: 'coolantC', hz: 0.2 });
  return plan;
}

export interface GForceRowSummary {
  hz: number;
  running: boolean;
}

/**
 * Field revision (2026-08-27, binding): "the telemetry monitor shows
 * latG/longG (phone accelerometer) whenever the G provider is running, with
 * their observed rate." `GForceProvider` (`gforceProvider.ts`) exposes no
 * running-state getter -- by design, it only ever emits samples while it
 * runs -- so "running" is inferred here from LIVE sample arrival: a channel
 * reads as running exactly while a sample has landed within the last
 * `staleMs` (generous slack over the ~25Hz/40ms update interval for a real
 * device's jitter/backgrounding). Pure (no react-native import) so it can be
 * unit-tested directly; `TelemetryScreen.tsx` keeps a small rolling
 * timestamp buffer per channel and calls this on every render tick.
 * `sampleTimesMs` is that channel's recent monotonic sample timestamps,
 * oldest first.
 */
export function summarizeGForceSamples(
  sampleTimesMs: readonly number[],
  nowMs: number,
  windowMs = 1_000,
  staleMs = 1_500,
): GForceRowSummary {
  const lastAt = sampleTimesMs.length > 0 ? sampleTimesMs[sampleTimesMs.length - 1] : undefined;
  if (lastAt === undefined || nowMs - lastAt > staleMs) return { hz: 0, running: false };
  const recentCount = sampleTimesMs.filter((t) => nowMs - t <= windowMs).length;
  return { hz: recentCount / (windowMs / 1_000), running: true };
}

/**
 * Field revision (2026-08-27, binding, "adapter-type switch" fix): the
 * settings this provider actually launched the CURRENT generation from --
 * `adapterType` plus whichever host/port pair that type uses. `start()`
 * refuses to no-op past a stuck/failed generation whose fingerprint no
 * longer matches CURRENT settings (root cause of the driveway-test switch
 * bug: `start()` was a plain `if (running) return`, so switching adapterType
 * while a dead ELM327 generation was still "running" left `start()` doing
 * nothing at all).
 */
export interface ConfigFingerprint {
  adapterType: AdapterType;
  host: string;
  port: number;
  /**
   * P4g-FIX1 (binding, M1): included because it selects the TRANSPORT, not
   * just the endpoint -- a real vs. simulated transport for the SAME
   * host/port previously compared equal, so toggling simulation while a
   * generation was connecting/polling and calling `start()` was a silent
   * no-op instead of relaunching from the current effective settings.
   */
  telemetrySimulate: boolean;
}

export function currentConfigFingerprint(settings: {
  adapterType: AdapterType;
  adapterHost: string;
  adapterPort: number;
  enetHost: string;
  enetPort: number;
  telemetrySimulate: boolean;
}): ConfigFingerprint {
  return settings.adapterType === 'enet'
    ? { adapterType: 'enet', host: settings.enetHost, port: settings.enetPort, telemetrySimulate: settings.telemetrySimulate }
    : { adapterType: 'elm327', host: settings.adapterHost, port: settings.adapterPort, telemetrySimulate: settings.telemetrySimulate };
}

export function fingerprintsEqual(a: ConfigFingerprint, b: ConfigFingerprint): boolean {
  return (
    a.adapterType === b.adapterType &&
    a.host === b.host &&
    a.port === b.port &&
    a.telemetrySimulate === b.telemetrySimulate
  );
}

/**
 * Telemetry addendum — channel revision: `transOilC` has no standard mode-01
 * PID, so it's normalized (outer whitespace trimmed) then sent as a raw
 * custom request verbatim -- internal spacing/casing untouched, decoded as
 * the last data byte minus 40 by `@circuit/core` -- built from the user's
 * vehicle-specific `settings.transOilPidHex`. `undefined` (not an empty
 * array) when unconfigured, matching `Elm327Config.customPids`'s own optional
 * shape.
 *
 * F1 HIGH fix (L2, binding): re-validates the trimmed value against the SAME
 * read-service whitelist L1 (`SettingsScreen.tsx`'s `parseHexPidDraft`)
 * already enforced on entry, via the shared `customPidValidation.ts`
 * module -- a value that fails (e.g. persisted from before this rule
 * existed, or written by any future non-UI caller of
 * `settingsStore.update`) is dropped with a `console.warn` and `undefined`
 * is returned, exactly like "unconfigured". `buildPollPlan` above still adds
 * the `transOilC` poll entry whenever the raw text is merely non-empty
 * (unchanged) -- `@circuit/core` already handles a poll entry with no
 * matching custom request as a harmless, once-warned no-op (see
 * `elm327Session.ts`'s own "ignored unconfigured transOilC" path), so this
 * dropped-but-non-empty case degrades the same way.
 */
export function buildCustomPids(
  transOilPidHex: string,
): Array<{ channel: TelemetryChannelId; request: string }> | undefined {
  const trimmed = transOilPidHex.trim();
  if (trimmed === '') return undefined;
  if (!isAllowedCustomPidRequest(trimmed)) {
    console.warn(
      `[telemetryProvider] Dropping persisted transOilPidHex "${trimmed}": ${CUSTOM_PID_VALIDATION_ERROR}`,
    );
    return undefined;
  }
  return [{ channel: 'transOilC', request: trimmed }];
}

/** `error instanceof Error ? error.message : String(error)` -- F2 fix's `start()` catch uses this to report a synchronous construction failure through the same `failed(detail)` channel a runtime session failure already uses. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const INIT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 1_500;
const MAX_CONSECUTIVE_ERRORS = 5;

/** Reconnect policy (binding, kept simple): on 'failed', exactly ONE retry after this delay, then stay failed until the next `start()` (a fresh session). */
const RETRY_DELAY_MS = 3_000;

export interface TelemetryProviderDeps {
  settingsStore: SettingsStore;
  /** SAME injected monotonic clock the session already uses (never `Date.now()`) -- stamps every `TelemetrySample.tMonoMs` via `@circuit/core`'s `Elm327Session`. */
  monotonicNow: () => number;
  /**
   * F8 fix (WPT3, binding): gates `settings.telemetrySimulate` -- a release
   * build must never silently record simulated vehicle data because a
   * setting persisted from a dev build happened to still be `true` on disk
   * (the toggle itself is already `__DEV__`-hidden in `SettingsScreen`, but
   * the PROVIDER honored the persisted value unconditionally). Test-only
   * injection seam; defaults to the real React Native `__DEV__` global
   * (`composition.ts` wires that same real value in explicitly). Never
   * mutates the persisted setting -- a non-dev build just ignores it.
   */
  isDev?: boolean;
  /**
   * P4e-FIX3 H2 (binding): the single-client ENET adapter reservation shared
   * with the dev DID-probe screen. Test-only injection seam (mirrors
   * `isDev` above) -- a test constructs its OWN fresh
   * `createEnetAdapterReservation()` instance so multiple `it()` blocks in
   * one file never leak reservation state into each other; production
   * omits this and gets the real shared singleton
   * (`enetAdapterReservation`, `./enetAdapterReservation`), the SAME
   * instance `DidProbeScreen.tsx` imports directly.
   */
  enetAdapterReservation?: EnetAdapterReservation;
  /**
   * ENET auto-discovery addendum (binding, Phase 4f): test-only injection
   * seam (mirrors `isDev`/`enetAdapterReservation` above) for the phone
   * network read the auto-discovery preamble/continuation uses to build
   * discovery candidates. Production omits this and gets the real
   * `getNetworkInfo` (`./networkInfo`, a lazy `expo-network` import).
   * Overriding it in tests avoids ever touching the real dynamic import --
   * which, loaded cold under `vi.useFakeTimers()` combined with a
   * pure-microtask flush (this suite's own convention), resolves via real
   * Node module-loading I/O that such a flush never yields to, stalling the
   * whole auto-discovery chain indefinitely rather than merely resolving
   * slowly.
   */
  getNetworkInfo?: () => Promise<import('./networkInfo').NetworkInfo | null>;
}

// ---------------------------------------------------------------------------
// Dashboard telemetry strip (Telemetry addendum — channel revision, binding):
// "visible ONLY while telemetryEnabled AND the provider state is 'polling';
// slots THR | ENG OIL | TRANS OIL -- third slot falls back to COOLANT when
// transOilC is not configured. RPM and G never on the strip." Kept here (a
// plain-TS module with no react-native import, so it stays cheaply
// unit-testable, house rule) rather than in `TelemetryStrip.tsx` itself,
// which stays thin/untested.
// ---------------------------------------------------------------------------

export type TelemetryStripTint = 'normal' | 'amber' | 'red';
/** @deprecated kept as an alias -- `telemetryStripCoolantTint`'s original return type name, still exported for anything importing it by this name. */
export type TelemetryStripCoolantTint = TelemetryStripTint;

function tintFor(value: number | null, amberAt: number, redAt: number): TelemetryStripTint {
  if (value === null) return 'normal';
  if (value >= redAt) return 'red';
  if (value >= amberAt) return 'amber';
  return 'normal';
}

/** Coolant tint thresholds (named constants, binding: "coolant tinted amber >= 98 C, red >= 105 C"). */
export const TELEMETRY_STRIP_COOLANT_AMBER_C = 98;
export const TELEMETRY_STRIP_COOLANT_RED_C = 105;

/** Engine oil tint thresholds (channel revision, binding: "engineOilC amber >= 120, red >= 130"). */
export const TELEMETRY_STRIP_ENGINE_OIL_AMBER_C = 120;
export const TELEMETRY_STRIP_ENGINE_OIL_RED_C = 130;

/** Transmission oil tint thresholds (channel revision, binding: "transOilC amber >= 110, red >= 125"). */
export const TELEMETRY_STRIP_TRANS_OIL_AMBER_C = 110;
export const TELEMETRY_STRIP_TRANS_OIL_RED_C = 125;

/** `null` (no coolant sample yet) reads as `'normal'` -- the strip's own placeholder dash, not an alarm color. */
export function telemetryStripCoolantTint(coolantC: number | null): TelemetryStripTint {
  return tintFor(coolantC, TELEMETRY_STRIP_COOLANT_AMBER_C, TELEMETRY_STRIP_COOLANT_RED_C);
}

/** `null` (no engine oil sample yet) reads as `'normal'`, same placeholder-not-alarm rule as coolant. */
export function telemetryStripEngineOilTint(engineOilC: number | null): TelemetryStripTint {
  return tintFor(engineOilC, TELEMETRY_STRIP_ENGINE_OIL_AMBER_C, TELEMETRY_STRIP_ENGINE_OIL_RED_C);
}

/** `null` (no trans oil sample yet, or the channel isn't configured) reads as `'normal'`. */
export function telemetryStripTransOilTint(transOilC: number | null): TelemetryStripTint {
  return tintFor(transOilC, TELEMETRY_STRIP_TRANS_OIL_AMBER_C, TELEMETRY_STRIP_TRANS_OIL_RED_C);
}

export type TelemetryStripThirdSlot = 'transOil' | 'coolant';

/** Binding: "third slot falls back to COOLANT when transOilC is not configured" -- purely a settings check (`transOilPidHex`), independent of whether a transOilC sample has actually arrived yet. */
export function telemetryStripThirdSlot(transOilPidHex: string): TelemetryStripThirdSlot {
  return transOilPidHex.trim() === '' ? 'coolant' : 'transOil';
}

/** Binding visibility rule: "visible ONLY while telemetryEnabled AND the provider state is 'polling'". */
export function isTelemetryStripVisible(telemetryEnabled: boolean, providerState: Elm327State): boolean {
  return telemetryEnabled && providerState === 'polling';
}

/**
 * ENET telemetry addendum (binding): the ENET engine's own state vocabulary
 * (`idle|connecting|handshake|polling|stopped|failed`) is reused for the
 * shared monitor/strip via this mapping rather than widening `onStateChange`'s
 * public callback type -- `TelemetryStrip.tsx` (out of this ticket's scope)
 * subscribes with a state setter typed exactly `Elm327State`, so every
 * consumer of `TelemetryProvider.onStateChange` keeps seeing that SAME
 * vocabulary regardless of which adapter is active. `'handshake'` (the
 * transient state right after `connect()` succeeds, before the first poll
 * exchange) maps to `'initializing'`, ELM327's own closest analog -- both
 * mean "connected, not yet proven to be exchanging data".
 */
const ENET_STATE_TO_PROVIDER_STATE: Readonly<Record<EnetState, Elm327State>> = {
  idle: 'idle',
  connecting: 'connecting',
  handshake: 'initializing',
  polling: 'polling',
  stopped: 'stopped',
  failed: 'failed',
};

export interface TelemetryProviderDiagnostics {
  state: Elm327State;
  observedHzByChannel: Record<string, number>;
  errorCount: number;
  lastError?: string;
  /** 0 or 1 -- whether the single reconnect retry has been used for the current `start()`..`stop()` lifecycle. */
  retriesUsed: number;
  /** ENET telemetry addendum: which adapter this provider is currently configured for -- always known (read from settings), regardless of whether a session has been built yet. */
  adapterType: AdapterType;
  /** ENET-only (present once an ENET session has been built): the UDS target address the current/last ENET session sent requests to. */
  enetTargetAddress?: number;
  /** ENET-only: channels currently in the active poll rotation. */
  supportedChannels?: TelemetryChannelId[];
  /** ENET-only: channels permanently removed after an UNSUPPORTED NRC (never retried in-session). */
  unsupportedChannels?: TelemetryChannelId[];
  /** ENET-only: last NRC observed per channel (unsupported or otherwise). */
  lastNrcByChannel?: Record<string, number>;
  /** ENET-only: total HSFZ frames sent. */
  framesTx?: number;
  /** ENET-only: total HSFZ frames received. */
  framesRx?: number;
  /** ENET-only: request acknowledge latency, p50 (ms). */
  ackLatencyMsP50?: number;
  /** ENET-only: request acknowledge latency, p95 (ms). */
  ackLatencyMsP95?: number;
  /** ENET-only: hex dump of the most recently received HSFZ frame (the dev DID-probe screen's own tool, also surfaced here for the monitor). */
  lastRawFrameHex?: string;
  /**
   * Field revision 2 (2026-08-27, binding — Phase 4h): which PID source
   * `accelPedalPct` is CURRENTLY built from -- `'5A'` (primary,
   * "Relative accelerator pedal position", 0 at rest) or `'49-normalized'`
   * (fallback, rest-offset normalized -- the DME answered NRC/unsupported
   * for 0x5A). Always present (both ELM327 and ENET): `'5A'` before any
   * generation has ever launched, or before the fallback has ever
   * triggered.
   */
  pedalSource: '5A' | '49-normalized';
}

/**
 * Session-scoped OBD telemetry provider (Telemetry addendum P4a). Wraps
 * `@circuit/core`'s `createElm327Session` with the transport choice
 * (`TcpObdTransport` over a real WiFi adapter, or `SimulatedElm327Transport`
 * for dev/testing) and the binding reconnect policy. Reads
 * `settingsStore.getSettings()` fresh on every `start()` -- a toggle flip
 * takes effect on the next start, matching every other settings-gated
 * feature in this app (`voiceCoach.ts`, coaching).
 *
 * MUST NOT interact with lap timing in any way: this module never touches
 * `SessionFacade`/`SessionController` -- `composition.ts` is the only place
 * that correlates its samples with a session, and only in the OUTBOUND
 * direction (telemetry samples -> recorder), never the reverse. A
 * dead/absent adapter therefore can never delay or invalidate a lap; it can
 * only ever leave this provider in `'failed'`.
 */
export interface TelemetryProvider {
  /** No-op if `settings.telemetryEnabled` is false, or if already running. */
  start(): void;
  /** Tears down the active session (if any) and cancels any pending reconnect retry. Idempotent. */
  stop(): Promise<void>;
  onSample(cb: (s: TelemetrySample) => void): () => void;
  onStateChange(cb: (state: Elm327State, detail?: string) => void): () => void;
  getDiagnostics(): TelemetryProviderDiagnostics;
}

/**
 * One `start()`..`stop()` (or `start()`..retry) lifecycle's session plus the
 * listener unsubscribes THAT session's `onSample`/`onStateChange` calls
 * returned -- captured here, not in shared module-level fields, so `stop()`
 * (F3 fix, WPT3) can detach exactly the generation it was called for even if
 * a NEW `start()` races in and installs a fresh generation while the old
 * one's `session.stop()` is still pending.
 */
type SessionGeneration =
  | {
      id: number;
      kind: 'elm327';
      session: Elm327Session;
      /** Field revision (2026-08-27, binding): THIS generation's own transport, closed via `closeGenTransportQuietly` whenever ITS OWN teardown runs (the 'failed' handler, or `doStop()`) -- generation-scoped by construction, so a STALE generation's transport is closed EXACTLY once, regardless of whether a newer generation has since replaced `current` (the single shared `activeTransport` field this replaces was NOT generation-scoped, and could otherwise close a NEWER generation's transport, or -- for a generation superseded while its own graceful `session.stop()` is still hanging on a never-settling `connect()` -- never close it at all). */
      transport: ObdTransport;
      unsubscribeSample: () => void;
      unsubscribeState: () => void;
    }
  | {
      id: number;
      kind: 'enet';
      session: EnetSession;
      transport: ObdTransport;
      /** P4e-FIX4 (binding): THIS generation's own adapter-reservation token -- released only by/for this exact generation, never by owner-kind alone (a stale token from an earlier generation must never release a newer one's claim). */
      enetToken: EnetAdapterToken;
      unsubscribeSample: () => void;
      unsubscribeState: () => void;
    };

export function createTelemetryProvider(deps: TelemetryProviderDeps): TelemetryProvider {
  const { settingsStore, monotonicNow } = deps;
  // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
  const isDev = deps.isDev ?? (typeof __DEV__ !== 'undefined' ? __DEV__ : false);
  const enetAdapterReservation = deps.enetAdapterReservation ?? sharedEnetAdapterReservation;
  const readNetworkInfo = deps.getNetworkInfo ?? getNetworkInfo;
  const sampleListeners = new Set<(s: TelemetrySample) => void>();
  const stateListeners = new Set<(state: Elm327State, detail?: string) => void>();

  /**
   * F3 fix: the currently-active generation, or `null` between sessions.
   * `stop()` captures its OWN local reference to this before awaiting
   * anything -- see `stop()`'s own comment.
   */
  let current: SessionGeneration | null = null;
  let currentState: Elm327State = 'idle';
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retriesUsed = 0;
  let running = false;
  let generationCounter = 0;
  /** P4e-FIX3 H2: set when `launchSession()`'s ENET branch was blocked by the adapter reservation (the probe holds it) -- surfaced via `getDiagnostics()` even though `current` stays `null` (no active generation to read diagnostics FROM). Cleared as soon as a session is actually launched. */
  let reservationBlockedDetail: string | undefined;
  /**
   * ENET auto-discovery addendum (binding, Phase 4f): mirrors
   * `reservationBlockedDetail` above, for the "discovery ran but found no
   * level-2 hit" terminal detail (`discovery: scanned N, none answered`) --
   * surfaced via `getDiagnostics()` even though `current` stays `null` (no
   * session was ever built). Reset alongside `reservationBlockedDetail` at
   * the top of every fresh `launchSession()` attempt.
   */
  let autoDiscoveryFailureDetail: string | undefined;
  /**
   * ENET auto-discovery addendum (binding): "runs discovery ONCE per start"
   * -- bounded per `start()`..`stop()` lifecycle, NOT per `launchSession()`
   * call (which the scheduled retry also invokes), so a start() that already
   * spent its one discovery attempt (whether it found a hit or not) never
   * runs a second one on any later failure within the SAME lifecycle. Reset
   * only in `start()`, mirroring `retriesUsed`'s own reset discipline.
   */
  let autoDiscoveryAttempted = false;
  /**
   * M1 (binding, sweep transport interface & lifecycle amendment): "provider
   * auto-discovery is abortable -- `stop()` aborts an in-flight discovery,
   * awaits it, and releases the provider token before returning." Set for
   * the DURATION of a `runAutoDiscovery()` call from EITHER the no-host
   * preamble or the on-failure continuation; `stop()` flips `.aborted` (the
   * SAME `DiscoveryAbortSignal` `runDiscovery` itself polls) and awaits
   * `discoveryInFlight` so no socket outlives the `stop()` call, and a
   * following `start()` is never refused by a stale claim.
   */
  let discoveryAbortSignal: { aborted: boolean } | null = null;
  let discoveryInFlight: Promise<void> | null = null;
  /**
   * M1 fix (binding, "observation runner & lifecycle race amendment", after
   * Codex P4f-REV3 MEDIUM): "the network-info read is raced against the
   * abort signal and a 1500ms timeout -- `stop()` cannot wait on it
   * indefinitely." Set (and cleared) by `readNetworkInfoRaced()` below for
   * the duration of one `readNetworkInfo()` call; `stop()` invokes it
   * (alongside flipping `discoveryAbortSignal.aborted`) so a never-settling
   * read can never block `stop()` -- or the whole auto-discovery attempt --
   * past that point.
   */
  let networkInfoAbortNotify: (() => void) | null = null;
  /**
   * P4e-FIX4 fix (binding, Codex P4e-REV4 HIGH finding -- "overlapping
   * provider generations bypass exclusivity"): while a `stop()` is tearing
   * down the current generation, this is the promise that resolves once
   * that teardown (session stop + reservation release + listener
   * unsubscribe) has fully settled -- NEVER rejects itself (mirrors
   * `lifecycleLock.ts`'s own "tail" convention: callers only need to know
   * WHEN it settled, not whether the underlying `stop()` call threw).
   * `start()` awaits this FIRST when one is in flight, so a fresh generation
   * is never launched (and never opens a second ENET socket) while the
   * previous one is still closing -- the review's exact overlap scenario.
   */
  let stopping: Promise<void> | null = null;
  /**
   * P4g-FIX1 (binding, H1): while a `start()` call is queued behind an
   * in-flight `stopping` (or otherwise not-yet-launched), this is the
   * promise other CONCURRENT `start()` calls coalesce behind instead of
   * queuing a SECOND, redundant launch attempt -- e.g. a rapid double-tap
   * on Start, or a Start issued while a settings-change-triggered teardown
   * is still resolving. `null` once the queued attempt has actually run
   * (whether it launched successfully or failed).
   */
  let starting: Promise<void> | null = null;
  /**
   * Field revision (2026-08-27, binding): the RAW transport the current
   * generation is built on -- tracked here (not just inside the session)
   * so the 'failed' handlers below can close it EXPLICITLY, defense-in-depth
   * against a session/transport whose own async-init failure path leaves the
   * underlying socket open (scout finding: `tcpObdTransport.ts`'s `connect()`
   * rejects on a socket 'error'/premature 'close' without ever calling
   * `socket.destroy()`). Never rejects when closed via `closeActiveTransportQuietly`.
   */
  let activeTransport: ObdTransport | null = null;
  /** The config fingerprint the ACTIVE generation (`current`) was actually launched from -- set at the top of every `launchSession()` call, read by `start()`'s re-entry check and `scheduleRetry`'s fire-time abort check. `null` when no generation has ever launched (fresh provider, or after a full `stop()`). */
  let activeFingerprint: ConfigFingerprint | null = null;
  /** Surfaced via `getDiagnostics()`'s `lastError` chain when the settings-change watcher (below) stops a live generation -- cleared at the top of every fresh `launchSession()`, same reset discipline as `reservationBlockedDetail`/`autoDiscoveryFailureDetail`. */
  let settingsChangedDetail: string | undefined;
  /**
   * Field revision (2026-08-27, binding): true for the DURATION of the
   * provider's OWN `settingsStore.update(applyDiscoveryResult(...))` call
   * (auto-discovery persisting the host/port it just found) -- the
   * settings-change watcher below still updates its own fingerprint
   * bookkeeping through this, but never treats it as a USER-initiated
   * config change (never stops the generation that just discovered its own
   * host/port -- discovery applying its own result is not "switching
   * adapters", it's this SAME generation completing its own connect).
   */
  let applyingDiscoveryResultUpdate = false;
  /**
   * Field revision 2 (2026-08-27, binding — Phase 4h, pedal PID fallback):
   * which `accelPedalPct` source THIS `start()`..`stop()` lifecycle is
   * currently using -- surfaced verbatim via `getDiagnostics().pedalSource`.
   * Reset to `'5A'` in `launchFresh()` (a genuinely fresh Start always tries
   * the primary source again); UNCHANGED across `triggerPedalFallback`'s own
   * internal teardown-and-relaunch (the fallback, once triggered, sticks
   * for the rest of this lifecycle -- see `pedalFallbackAttempted` below).
   */
  let pedalSource: '5A' | '49-normalized' = '5A';
  /**
   * "runs the fallback check ONCE per start() lifecycle" -- mirrors
   * `autoDiscoveryAttempted`'s own reset discipline (reset ONLY in
   * `launchFresh()`, never per-generation), so a generation that itself
   * fails/retries for an UNRELATED reason after already falling back never
   * re-attempts 0x5A (which just proved unsupported) or re-triggers a
   * second fallback relaunch.
   */
  let pedalFallbackAttempted = false;
  /** Learned 0x49 rest offset for the CURRENT (post-fallback) generation -- re-learned per session per contracts.md ("re-learned per session"), so reset both in `launchFresh()` and inside `triggerPedalFallback()` (a fresh generation, even mid-lifecycle). */
  let pedalOffsetLearner: PedalOffsetLearner = INITIAL_PEDAL_OFFSET_LEARNER;
  /** Whether ANY `accelPedalPct` sample has arrived for the CURRENT generation -- reset at the top of every `launchSession()` call (per-generation, unlike the lifecycle-scoped fields above). Read by the ELM327-only fallback-check timer below: no sample within the grace window is treated as "0x5A unsupported" (ELM327 has no structured per-channel NRC diagnostics, unlike ENET's `unsupportedChannels`). */
  let pedalSampleSeenThisGeneration = false;
  /** The most recently observed `speedKph` sample's value, across whichever generation is current -- feeds the "at rest" gate for `registerPedalOffsetSample` (`pedalNormalization.ts`). Not reset per-generation: a fresh generation's own first speedKph sample overwrites it within one poll tick regardless. */
  let latestSpeedKph: number | undefined;
  /** ELM327-only one-shot timer (see `pedalSampleSeenThisGeneration`'s doc comment) -- started when an ELM327 generation reaches 'polling' while still on the primary (0x5A) source; cancelled in `doStop()` alongside `retryTimer` so a stale generation's check can never fire after teardown. */
  let pedalFallbackCheckTimer: ReturnType<typeof setTimeout> | null = null;
  /** Grace window (ms) an ELM327 generation is given, after reaching 'polling' on the primary (0x5A) source, before an ABSENT `accelPedalPct` sample is treated as "DME answered NO DATA" and the fallback triggers. Comfortably under the poll plan's own 5Hz cadence for this channel (several polls' worth of margin against ordinary jitter), and short enough that a genuinely unsupported PID is caught quickly rather than being silently mistaken for "still connecting". */
  const PEDAL_FALLBACK_CHECK_DELAY_MS = 8_000;

  /** Wraps a discovery-result `settingsStore.update()` so the settings-change watcher (below) can tell it apart from a user-initiated Settings-screen edit. */
  function applyDiscoverySettingsUpdate(patch: Parameters<SettingsStore['update']>[0]): void {
    applyingDiscoveryResultUpdate = true;
    try {
      settingsStore.update(patch);
    } finally {
      applyingDiscoveryResultUpdate = false;
    }
  }

  /** Closes `transport` best-effort -- a sync throw OR a rejection is swallowed; this is defensive cleanup, never the generation's own graceful stop. */
  function closeTransportQuietly(transport: ObdTransport): void {
    try {
      void Promise.resolve(transport.close()).catch(() => undefined);
    } catch {
      // A close() failure (sync throw or rejection) must never propagate.
    }
  }

  /** For the narrow window BEFORE a `SessionGeneration` object exists yet (between `buildTransport()` and successfully constructing the session) -- once a generation is installed, ITS OWN `gen.transport` (below) is what every later close goes through, generation-scoped, never this shared field. */
  function closeActiveTransportQuietly(): void {
    const transport = activeTransport;
    activeTransport = null;
    if (transport !== null) closeTransportQuietly(transport);
  }

  /** Field revision (2026-08-27, binding): closes EXACTLY this generation's own transport -- generation-scoped by construction (no shared-field race), so a stale generation whose graceful `session.stop()` is still hanging on a never-settling `connect()` (the driveway-test "socket left open" scenario) still gets its OWN transport force-closed, and a newer generation's transport is never touched by an older one's delayed teardown. */
  function closeGenTransportQuietly(gen: SessionGeneration): void {
    closeTransportQuietly(gen.transport);
  }

  function waitMs(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs)));
  }

  /** Scout finding (`tcpObdTransport.ts:96-114`): an async connect() failure can leave the socket referenced with nothing having explicitly closed it -- and the session's OWN graceful `stop()` (which awaits its in-flight `run()`) can hang indefinitely if THAT run() is itself stuck awaiting a `connect()` that never settles (the exact "socket left open" driveway-test scenario). Races `gen.session.stop()` against a 200ms timeout (mirrors the sweep controller's own close-race pattern, `didSweepController.ts`) -- whichever settles first wins; if the timeout wins, `gen`'s OWN transport is force-closed directly (generation-scoped, never touches a newer generation's own transport) and this returns anyway, without waiting further for the graceful stop (which may still finish later, on its own, forwarding nothing further once superseded). A normal, already-fast resolve/reject from `gen.session.stop()` is unaffected -- it wins the race well within 200ms. */
  const SESSION_STOP_RACE_MS = 200;
  async function stopGenSessionWithTransportRace(gen: SessionGeneration): Promise<void> {
    await Promise.race([gen.session.stop(), waitMs(SESSION_STOP_RACE_MS).then(() => closeGenTransportQuietly(gen))]);
  }

  /** Shared failure handling for a synchronous `launchSession()` throw, from EITHER `start()`'s own first attempt or the scheduled retry (P4e-FIX4, binding: "retry wraps launchSession() in try/catch"). Resets to a clean, non-running state and reports through the SAME `failed` channel a runtime session failure already uses. */
  function handleLaunchFailure(error: unknown): void {
    closeActiveTransportQuietly();
    running = false;
    current = null;
    emitState('failed', errorMessage(error));
  }

  /**
   * Field revision 2 (2026-08-27, binding — Phase 4h, pedal PID fallback):
   * "if the DME answers NRC/unsupported for 0x5A, fall back to 0x49." Both
   * detection paths (ENET's structured `unsupportedChannels` diagnostics,
   * ELM327's grace-window timer) call this exactly once per `start()`
   * lifecycle (`pedalFallbackAttempted` guards re-entry). Switches the
   * module-level source, resets the offset learner for the FRESH session
   * about to launch, then reuses the FULL `doStop()` teardown protocol
   * (unified `stopping` promise, generation-scoped transport close,
   * reservation release) before relaunching -- calling `launchSession()`
   * directly (NOT `launchFresh()`) so `pedalSource`/`pedalFallbackAttempted`
   * survive this internal relaunch even though it's mid-lifecycle.
   */
  function triggerPedalFallback(): void {
    if (pedalFallbackAttempted) return;
    pedalFallbackAttempted = true;
    pedalSource = '49-normalized';
    pedalOffsetLearner = INITIAL_PEDAL_OFFSET_LEARNER;
    // Read by the ELM327 branch's NEXT `createElm327Session` construction
    // (`encodeMode01Request`/`decodeMode01Response` inside it) -- a no-op
    // for ENET, whose fallback instead comes from swapping in
    // `ACCEL_PEDAL_FALLBACK_ENET_SPEC` at `buildEnetConfig()` time, below.
    setAccelPedalPidSource('49');
    if (pedalFallbackCheckTimer !== null) {
      clearTimeout(pedalFallbackCheckTimer);
      pedalFallbackCheckTimer = null;
    }
    // `doStop()` always sets `running = false` at its own top (regardless
    // of WHY it was called), so `running` alone cannot tell "an UNRELATED
    // stop() also happened concurrently" apart from "nothing else
    // intervened" -- mirrors `scheduleRetry`'s own discipline instead:
    // capture the fingerprint THIS generation was launched from, and only
    // relaunch if it's unchanged by the time this internal teardown
    // settles (an actual settings change in that window means the watcher
    // already owns whatever comes next).
    const fingerprintAtTrigger = activeFingerprint;
    const relaunch = (): void => {
      if (
        fingerprintAtTrigger !== null &&
        !fingerprintsEqual(fingerprintAtTrigger, currentConfigFingerprint(settingsStore.getSettings()))
      ) {
        return;
      }
      // Unconditional, same as `launchFresh()`'s own `running = true` --
      // this internal relaunch is not gated behind the (already-cleared-by-
      // doStop) `running` flag.
      running = true;
      try {
        launchSession();
      } catch (error) {
        handleLaunchFailure(error);
      }
    };
    void doStop().then(relaunch, relaunch);
  }

  /**
   * Shared sample-forwarding path for BOTH generation kinds (ELM327's branch
   * in `launchSession()`, ENET's in `buildAndStartEnetSession`) -- tracks
   * the latest `speedKph` (the offset learner's "at rest" gate) and, for
   * `accelPedalPct` specifically, marks a sample as seen for THIS generation
   * (the ELM327 fallback-check timer's own signal) and applies the
   * rest-offset normalization when `pedalSource` is the fallback. Callers
   * still do their OWN `current?.id === id` staleness check before calling
   * this -- it forwards unconditionally once called.
   */
  function forwardTelemetrySample(sample: TelemetrySample): void {
    if (sample.channel === 'speedKph') latestSpeedKph = sample.value;
    if (sample.channel === 'accelPedalPct') {
      pedalSampleSeenThisGeneration = true;
      if (pedalSource === '49-normalized') {
        pedalOffsetLearner = registerPedalOffsetSample(pedalOffsetLearner, sample.value, latestSpeedKph, sample.tMonoMs);
        const offset = pedalOffsetLearner.minRestValue ?? 0;
        const normalized = normalizeAccelPedalPct(sample.value, offset);
        const normalizedSample: TelemetrySample = { ...sample, value: normalized };
        for (const listener of [...sampleListeners]) listener(normalizedSample);
        return;
      }
    }
    for (const listener of [...sampleListeners]) listener(sample);
  }

  function buildTransport(): ObdTransport {
    const settings = settingsStore.getSettings();
    // F8 fix: a non-dev build ignores a persisted `telemetrySimulate=true`
    // entirely (never mutates the stored setting -- just ignores it here).
    // ENET telemetry addendum: `telemetrySimulate` applies to BOTH adapter
    // types -- the branch below only decides which SIMULATED (or real)
    // transport to build, never whether simulation itself is honored.
    if (settings.adapterType === 'enet') {
      if (settings.telemetrySimulate && isDev) {
        return new SimulatedEnetTransport({
          monotonicNow,
          testerAddress: settings.enetTesterAddress,
          targetAddress: settings.enetTargetAddress,
        });
      }
      return new EnetTcpTransport({ host: settings.enetHost, port: settings.enetPort });
    }
    if (settings.telemetrySimulate && isDev) {
      return new SimulatedElm327Transport({ monotonicNow });
    }
    return new TcpObdTransport({ host: settings.adapterHost, port: settings.adapterPort });
  }

  /**
   * P4e-FIX2 (binding, "poll plan, probe & robustness amendment", supersedes
   * the original "poll plan reused" design): the ENET poll plan is derived
   * from the RESOLVED channel specs themselves (built-in defaults, or the
   * user's validated `did`/`obd01` specs) -- one poll entry per spec channel,
   * at the binding rate table (`ENET_DEFAULT_CHANNEL_RATES_HZ`, `@circuit/core`
   * -- rpm/speed/throttle 5 Hz, coolant 0.2 Hz, oil temps 0.5 Hz, intake/load
   * 1 Hz, unknown channel 1 Hz). This REPLACES reusing the fixed ELM327
   * `buildPollPlan` for ENET: that plan silently dropped `intakeC`/
   * `engineLoadPct` entirely (never in its fixed 5-channel list) and gated
   * `transOilC` on the unrelated ELM-era `transOilPidHex` setting -- on the
   * ENET path `transOilC` is polled whenever the resolved specs include it,
   * full stop.
   */
  const ENET_UNKNOWN_CHANNEL_RATE_HZ = 1;

  function buildEnetPollPlan(
    channelSpecs: readonly EnetChannelSpec[],
  ): Array<{ channel: TelemetryChannelId; hz: number }> {
    return channelSpecs.map((spec) => ({
      channel: spec.channel,
      hz: ENET_DEFAULT_CHANNEL_RATES_HZ[spec.channel] ?? ENET_UNKNOWN_CHANNEL_RATE_HZ,
    }));
  }

  /**
   * ENET telemetry addendum: builds the ENET engine's config from settings --
   * channel specs (parsed/validated JSON, or the built-in defaults --
   * `resolveEnetChannelSpecs`), the poll plan derived from those SAME resolved
   * specs (`buildEnetPollPlan`, above), tester/target addresses from settings,
   * and the addendum's default tester-present interval/command-timeout/error-budget
   * (`DEFAULT_ENET_CONFIG`, `COMMAND_TIMEOUT_MS`/`MAX_CONSECUTIVE_ERRORS`
   * shared with the ELM327 config below).
   */
  function buildEnetConfig(): EnetConfig {
    const settings = settingsStore.getSettings();
    let channelSpecs = resolveEnetChannelSpecs(settings.enetChannelSpecsJson);
    // Field revision 2 (binding, pedal PID fallback): once the fallback has
    // triggered for this lifecycle, EVERY subsequent ENET (re)launch --
    // including this one -- swaps the fallback (0x49) spec in for whatever
    // `accelPedalPct` spec the settings resolved to (built-in default, or a
    // user `did`/`obd01` override) -- the primary 0x5A source already
    // proved NRC'd/unsupported, so there is no reason to poll it again.
    if (pedalSource === '49-normalized') {
      channelSpecs = [...channelSpecs.filter((spec) => spec.channel !== 'accelPedalPct'), ACCEL_PEDAL_FALLBACK_ENET_SPEC];
    }
    return {
      channelSpecs,
      pollPlan: buildEnetPollPlan(channelSpecs),
      testerAddress: settings.enetTesterAddress,
      targetAddress: settings.enetTargetAddress,
      testerPresentIntervalMs: DEFAULT_ENET_CONFIG.testerPresentIntervalMs,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
      maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
      attemptObd01: DEFAULT_ENET_CONFIG.attemptObd01,
    };
  }

  function emitState(state: Elm327State, detail?: string): void {
    currentState = state;
    for (const listener of [...stateListeners]) listener(state, detail);
  }

  /**
   * ENET auto-discovery addendum (binding): discovery only ever makes sense
   * against the REAL adapter over the REAL local network -- `SimulatedEnetTransport`
   * doesn't use `enetHost`/`enetPort` at all, so running discovery ahead of it
   * (or after its own -- never-failing-to-connect -- "handshake") would be
   * pure overhead with nothing to discover. Mirrors `buildTransport()`'s own
   * `telemetrySimulate && isDev` branch exactly, so the two can never disagree
   * about which case is "the real adapter".
   */
  function usingRealEnetAdapter(): boolean {
    return !(settingsStore.getSettings().telemetrySimulate && isDev);
  }

  /** `discovery: scanned N, none answered` -- the exact diagnostics detail the ticket's binding text names for "auto-discovery ran, found no level-2 hit". */
  function discoveryNoneAnsweredDetail(result: RunDiscoveryResult): string {
    return `discovery: scanned ${result.scanned}, none answered`;
  }

  /**
   * E2E-a (binding, sweep transport interface & lifecycle amendment): "under
   * `telemetrySimulate` (dev) discovery ... uses the simulated probe factory
   * so the preview demonstrates the full flow" -- scripts the MHD default
   * host as a level-2 hit (the same fixed address `buildDiscoveryCandidates`
   * always tries), everything else refused, so a dev running the preview
   * with no real adapter still sees discovery succeed end to end.
   */
  function buildProbeFactory(): (host: string, port: number) => ObdTransport {
    const settings = settingsStore.getSettings();
    if (settings.telemetrySimulate && isDev) {
      return createSimulatedDiscoveryProbeFactory({
        script: [{ host: '192.168.4.1', behavior: 'level2' }],
        defaultBehavior: 'refuse',
      });
    }
    return (host, port) => new EnetTcpTransport({ host, port, connectTimeoutMs: 300 });
  }

  /** M1 (binding): "the network-info read is raced against ... a 1500ms timeout." */
  const NETWORK_INFO_TIMEOUT_MS = 1500;

  /**
   * M1 fix (binding, after Codex P4f-REV3 MEDIUM): races `readNetworkInfo()`
   * against a 1500ms timeout AND `stop()`'s abort -- `stop()` invokes
   * `networkInfoAbortNotify()` (if one is armed) the SAME moment it flips
   * `discoveryAbortSignal.aborted`, so a read that never settles can never
   * block `stop()` (or the whole auto-discovery attempt) past that point.
   * Never rejects -- resolves `null` on timeout, abort, or the read itself
   * throwing/rejecting (an unreadable network info is already treated as
   * "unknown" by every caller of `runAutoDiscovery`).
   */
  function readNetworkInfoRaced(): Promise<Awaited<ReturnType<typeof getNetworkInfo>>> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: Awaited<ReturnType<typeof getNetworkInfo>>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        if (networkInfoAbortNotify === finishAborted) networkInfoAbortNotify = null;
        resolve(value);
      };
      const finishAborted = (): void => finish(null);
      networkInfoAbortNotify = finishAborted;
      const timeoutTimer = setTimeout(() => finish(null), NETWORK_INFO_TIMEOUT_MS);
      let readPromise: ReturnType<typeof getNetworkInfo>;
      try {
        readPromise = readNetworkInfo();
      } catch {
        finish(null);
        return;
      }
      readPromise.then(finish).catch(() => finish(null));
    });
  }

  /**
   * Runs `@circuit/core`'s `runDiscovery` against the phone's own subnet plus
   * whatever host is currently configured (addendum: "candidates in this
   * order -- the configured host (if any), 192.168.4.1, the phone subnet's
   * .1, then every host of the phone's /24"), using a REAL `EnetTcpTransport`
   * probe factory (or the simulated one under `telemetrySimulate`, E2E-a
   * above) with the addendum's tight default timeouts (300 ms connect / 500 ms
   * reply / 8 s total budget -- all `runDiscovery`'s own defaults, left
   * unspecified here). Never throws -- a `getNetworkInfo()` or
   * `runDiscovery()` failure is treated as "found nothing" (an empty result),
   * matching this module's existing "never let telemetry startup throw"
   * discipline. `signal` (M1, binding: "provider auto-discovery is
   * abortable") is forwarded to `runDiscovery` so `stop()` can cut a scan
   * short.
   */
  async function runAutoDiscovery(signal: DiscoveryAbortSignal): Promise<RunDiscoveryResult> {
    const settings = settingsStore.getSettings();
    const phoneInfo = await readNetworkInfoRaced();
    if (signal.aborted) return { results: [], scanned: 0, elapsedMs: 0, truncated: true };
    const candidates = buildDiscoveryCandidates({
      configuredHost: settings.enetHost.trim() === '' ? undefined : settings.enetHost,
      configuredPort: settings.enetPort,
      phoneIpv4: phoneInfo?.ipv4,
      subnetMask: phoneInfo?.subnetMask,
    });
    try {
      return await runDiscovery({
        candidates,
        probe: buildProbeFactory(),
        clock: { now: monotonicNow },
        testerAddress: settings.enetTesterAddress,
        targetAddress: settings.enetTargetAddress,
        signal,
      });
    } catch {
      return { results: [], scanned: 0, elapsedMs: 0, truncated: false };
    }
  }

  /**
   * Builds the transport/config/session for generation `id` and wires it up
   * -- extracted from `launchSession()`'s own ENET branch (P4e-FIX4 shape
   * unchanged) so both the SYNCHRONOUS immediate-connect path and the
   * auto-discovery ASYNC continuation below share the exact same
   * construction/wiring code. `token` is this generation's own adapter
   * reservation, already held by the caller -- released here (and rethrown)
   * on any construction failure.
   */
  function buildAndStartEnetSession(id: number, token: EnetAdapterToken): void {
    try {
      const transport = buildTransport();
      activeTransport = transport;
      const config = buildEnetConfig();
      const next = createEnetSession(transport, config, monotonicNow);
      const gen: SessionGeneration = {
        id,
        kind: 'enet',
        session: next,
        transport,
        enetToken: token,
        unsubscribeSample: next.onSample((sample) => {
          if (current?.id !== id) return;
          forwardTelemetrySample(sample);
          // Field revision 2 (binding, pedal PID fallback): ENET has
          // STRUCTURED per-channel diagnostics (`unsupportedChannels`) --
          // once the DME NRCs the primary 0x5A request, the engine marks
          // the channel unsupported and never polls it again, so THIS
          // check (not a grace-window timer, unlike ELM327 below) is the
          // reliable, immediate signal. Cheap enough to run on every
          // sample tick; guarded so it only ever fires once per lifecycle.
          if (pedalSource === '5A' && !pedalFallbackAttempted && next.getDiagnostics().unsupportedChannels.includes('accelPedalPct')) {
            triggerPedalFallback();
          }
        }),
        unsubscribeState: next.onStateChange((state, detail) => {
          if (current?.id !== id) return;
          const mapped = ENET_STATE_TO_PROVIDER_STATE[state];
          emitState(mapped, detail);
          if (mapped === 'failed') {
            // A failed session no longer legitimately holds the adapter
            // (its transport already closed) -- release so the probe, or
            // a future fresh start()/retry, can acquire it.
            enetAdapterReservation.release(token);
            // Field revision (2026-08-27, binding): explicit close, defense-
            // in-depth (scout finding: an async connect() failure can leave
            // the socket referenced with nothing having explicitly closed
            // it) -- generation-scoped (`gen`, not a shared field), same
            // `current?.id === id` guard above confirms `current === gen`
            // here, so this can only ever be THIS generation's own transport.
            closeGenTransportQuietly(gen);
            if (running) {
              // ENET auto-discovery addendum (binding): "if ... the first
              // connect fails, run discovery ONCE (bounded)" -- ONLY when
              // auto-discovery is on, only against the real adapter, and
              // only once per start() lifecycle; every other case (already
              // attempted this start(), simulated transport, or the setting
              // turned off) keeps the pre-addendum plain single-retry policy
              // exactly as it was.
              if (
                settingsStore.getSettings().adapterType === 'enet' &&
                settingsStore.getSettings().enetAutoDiscover &&
                usingRealEnetAdapter() &&
                !autoDiscoveryAttempted
              ) {
                autoDiscoveryAttempted = true;
                retriesUsed += 1; // the one auto-discovery attempt spends the SAME retry budget the plain reconnect would have.
                void runAutoDiscoveryOnFailure(id);
              } else {
                scheduleRetry(id);
              }
            }
          }
        }),
      };
      current = gen;
      next.start();
    } catch (error) {
      enetAdapterReservation.release(token);
      current = null;
      throw error;
    }
  }

  /**
   * M1 (binding): wraps `runAutoDiscovery` with the abort/in-flight
   * bookkeeping `stop()` needs -- see `discoveryAbortSignal`/`discoveryInFlight`'s
   * own doc comments above. Both auto-discovery call sites (no-host preamble,
   * on-failure continuation) go through this, never `runAutoDiscovery`
   * directly, so `stop()` can always find (and abort) whichever one is live.
   */
  function runTrackedAutoDiscovery(): Promise<RunDiscoveryResult> {
    const signal: { aborted: boolean } = { aborted: false };
    discoveryAbortSignal = signal;
    const resultPromise = runAutoDiscovery(signal);
    const settledPromise = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    discoveryInFlight = settledPromise;
    void settledPromise.finally(() => {
      if (discoveryAbortSignal === signal) discoveryAbortSignal = null;
      if (discoveryInFlight === settledPromise) discoveryInFlight = null;
    });
    return resultPromise;
  }

  /**
   * The "host configured, first connect failed" auto-discovery continuation
   * (addendum). Runs AFTER the failed generation has already released its
   * token (`buildAndStartEnetSession`'s own `onStateChange` handler, just
   * above) -- re-acquires a fresh one to run the discovery probes under, same
   * as the provider's own normal acquire. A level-2 hit is applied
   * (persisted, with provenance) and connected immediately; no hit (or the
   * reservation being unavailable to re-acquire) surfaces as 'failed' with
   * the discovery diagnostics detail, and schedules NOTHING further --
   * "never loops".
   */
  async function runAutoDiscoveryOnFailure(id: number): Promise<void> {
    if (!running || current === null || current.id !== id) return; // a fresh start()/stop() already superseded this generation.
    // Mirrors `scheduleRetry`'s own timer-callback cleanup: detach the failed
    // generation's listeners and clear `current` BEFORE running discovery, so
    // a late event from it can never forward, and `runAutoDiscoveryThenConnect`'s
    // eventual `buildAndStartEnetSession` call installs a genuinely fresh one.
    current.unsubscribeSample();
    current.unsubscribeState();
    current = null;
    const token = enetAdapterReservation.tryAcquire('provider');
    if (token === null) {
      autoDiscoveryFailureDetail = ENET_ADAPTER_RESERVED_BY_PROBE_DETAIL;
      emitState('idle', ENET_ADAPTER_RESERVED_BY_PROBE_DETAIL);
      return;
    }
    // P4g-FIX1 (binding, H2): captured BEFORE the scan so a settings change
    // mid-discovery (adapterType switch, or a host/port/simulate edit) can be
    // detected once the scan resolves -- `current` stays `null` for this
    // whole window (by design, above), so the settings watcher cannot rely
    // on generation state alone to know a discovery is in flight for THIS
    // fingerprint; this capture/compare is the belt to the watcher's own
    // abort-on-change braces.
    const fingerprintAtDiscoveryStart = currentConfigFingerprint(settingsStore.getSettings());
    const result = await runTrackedAutoDiscovery();
    if (!running || current !== null) {
      enetAdapterReservation.release(token);
      return;
    }
    if (!fingerprintsEqual(fingerprintAtDiscoveryStart, currentConfigFingerprint(settingsStore.getSettings()))) {
      // The user changed adapterType/host/port/simulate WHILE this scan was
      // running -- discard: no persist, no session built from a stale hit,
      // release the reservation this (now-superseded) scan was holding.
      enetAdapterReservation.release(token);
      return;
    }
    const hit = result.results.find((r) => r.level === 2);
    if (hit !== undefined) {
      applyDiscoverySettingsUpdate(applyDiscoveryResult(hit, new Date().toISOString()));
      activeFingerprint = currentConfigFingerprint(settingsStore.getSettings()); // keep in sync with what THIS generation actually ended up using, post-discovery.
      lastKnownFingerprint = activeFingerprint; // same for the watcher's own baseline (belt-and-braces -- applyingDiscoveryResultUpdate above already covers this specific update).
      // Same "a synchronous construction throw must never escape an async
      // continuation uncaught" rule as `runAutoDiscoveryThenConnect` below --
      // there is no synchronous caller-side try/catch for this path (unlike
      // `start()`'s own `attempt()`), so it is handled here explicitly.
      try {
        buildAndStartEnetSession(id, token);
      } catch (error) {
        handleLaunchFailure(error);
      }
      return;
    }
    enetAdapterReservation.release(token);
    autoDiscoveryFailureDetail = discoveryNoneAnsweredDetail(result);
    emitState('failed', autoDiscoveryFailureDetail);
  }

  /**
   * The "no host configured at all" auto-discovery preamble (addendum: "run
   * discovery ONCE ... immediately when no host is configured"). Holds the
   * SAME token `launchSession()` already acquired for generation `id`
   * throughout the probe phase (nobody else may open a competing ENET client
   * while the provider itself is scanning for one to use) -- released only if
   * discovery finds no level-2 hit, or if a `stop()`/fresh `start()` races in
   * before it resolves.
   */
  async function runAutoDiscoveryThenConnect(id: number, token: EnetAdapterToken): Promise<void> {
    // P4g-FIX1 (binding, H2): see the matching comment in
    // `runAutoDiscoveryOnFailure` -- same capture/compare discipline; this
    // path's `!running || generationCounter !== id` check alone does NOT
    // catch a bare settings edit that never called stop()/start() (that
    // never advances `generationCounter`), so a stale hit could otherwise
    // still be persisted/used.
    const fingerprintAtDiscoveryStart = currentConfigFingerprint(settingsStore.getSettings());
    const result = await runTrackedAutoDiscovery();
    if (!running || generationCounter !== id) {
      enetAdapterReservation.release(token);
      return;
    }
    if (!fingerprintsEqual(fingerprintAtDiscoveryStart, currentConfigFingerprint(settingsStore.getSettings()))) {
      enetAdapterReservation.release(token);
      return;
    }
    const hit = result.results.find((r) => r.level === 2);
    if (hit !== undefined) {
      applyDiscoverySettingsUpdate(applyDiscoveryResult(hit, new Date().toISOString()));
      activeFingerprint = currentConfigFingerprint(settingsStore.getSettings()); // keep in sync with what THIS generation actually ended up using, post-discovery.
      lastKnownFingerprint = activeFingerprint; // same for the watcher's own baseline (belt-and-braces -- applyingDiscoveryResultUpdate above already covers this specific update).
      try {
        buildAndStartEnetSession(id, token);
      } catch (error) {
        handleLaunchFailure(error);
      }
      return;
    }
    enetAdapterReservation.release(token);
    autoDiscoveryFailureDetail = discoveryNoneAnsweredDetail(result);
    emitState('failed', autoDiscoveryFailureDetail);
  }

  function launchSession(): void {
    generationCounter += 1;
    const id = generationCounter;
    reservationBlockedDetail = undefined; // reset -- re-set below only if THIS attempt is blocked.
    autoDiscoveryFailureDetail = undefined; // reset -- re-set below only if THIS attempt's own discovery finds nothing.
    settingsChangedDetail = undefined; // reset -- a fresh launch supersedes whatever stopped the previous generation.
    // Field revision 2 (binding, pedal PID fallback): per-GENERATION (unlike
    // `pedalSource`/`pedalFallbackAttempted`, which are lifecycle-scoped) --
    // this FRESH generation has not seen a sample yet, whichever source it
    // ends up polling.
    pedalSampleSeenThisGeneration = false;
    // Field revision (2026-08-27, binding): the fingerprint THIS launch is
    // actually built from -- `start()`'s re-entry check and `scheduleRetry`'s
    // fire-time abort check both compare against this.
    activeFingerprint = currentConfigFingerprint(settingsStore.getSettings());
    // F3 fix: every listener below checks `current?.id === id` before doing
    // anything -- once a NEWER generation has replaced `current` (a fresh
    // `start()`, or this generation's own `stop()`/retry teardown), a late
    // event from THIS (now-stale) session's transport/session is dropped
    // instead of forwarding a sample/state change for a session nothing
    // outside this closure should still believe is live.
    if (settingsStore.getSettings().adapterType === 'enet') {
      // P4e-FIX3 H2 fix (binding): acquired BEFORE building any transport --
      // the MHD adapter accepts one ECU client at a time, and the dev
      // DID-probe screen (`DidProbeScreen.tsx`) shares this SAME reservation.
      // P4e-FIX4 (binding): `tryAcquire` returns a token (or `null`) -- NO
      // same-owner reacquire, so an overlapping second provider generation
      // can never ALSO believe it holds the adapter. A blocked acquire
      // never opens a socket: no generation is installed, the provider
      // stays 'idle' with a diagnostics note, and (when this call came from
      // the scheduled retry) no further retry is scheduled -- the one retry
      // budget is already spent either way.
      const token = enetAdapterReservation.tryAcquire('provider');
      if (token === null) {
        current = null;
        reservationBlockedDetail = ENET_ADAPTER_RESERVED_BY_PROBE_DETAIL;
        emitState('idle', ENET_ADAPTER_RESERVED_BY_PROBE_DETAIL);
        return;
      }
      // ENET telemetry addendum: a completely separate branch from the
      // ELM327 path below -- nothing here is reachable unless
      // `adapterType === 'enet'`, so the ELM327 path's own behavior (and the
      // tests pinning it) is untouched by this addition.
      //
      // ENET auto-discovery addendum (binding): "run discovery ONCE ...
      // immediately when no host is configured" -- checked here, BEFORE ever
      // building a transport (a real `EnetTcpTransport` against host `''`
      // would just fail instantly and pointlessly). Gated on `enetAutoDiscover`
      // only -- E2E-a (binding, sweep transport interface & lifecycle
      // amendment): "Find adapter + auto-connect use
      // createSimulatedDiscoveryProbeFactory under telemetrySimulate (dev) so
      // the preview shows a level-2 hit" -- this runs under simulate mode too
      // (via `runAutoDiscovery()`'s own `buildProbeFactory()` branch), NOT
      // gated on `usingRealEnetAdapter()` the way the on-failure continuation
      // still is (that path is moot under simulate anyway: `SimulatedEnetTransport`
      // never fails to connect, so it's simply never reached there).
      const settingsNow = settingsStore.getSettings();
      if (settingsNow.enetHost.trim() === '' && settingsNow.enetAutoDiscover && !autoDiscoveryAttempted) {
        autoDiscoveryAttempted = true;
        retriesUsed += 1; // spends the one retry/attempt budget, same accounting as the on-failure continuation.
        emitState('connecting');
        void runAutoDiscoveryThenConnect(id, token);
        return;
      }
      buildAndStartEnetSession(id, token);
      return;
    }

    // Channel revision (binding): the poll plan (and whether transOilC's
    // custom PID is even sent) is read fresh from settings on every
    // `start()`, same freshness rule as `buildTransport()`'s own read above --
    // a `transOilPidHex` edit takes effect on the next session, matching
    // every other settings-gated telemetry field.
    const transport = buildTransport();
    activeTransport = transport;
    const transOilPidHex = settingsStore.getSettings().transOilPidHex;
    // Field revision 2 (binding, pedal PID fallback): read by
    // `createElm327Session` below (via `pidCodec.ts`'s
    // `encodeMode01Request`/`decodeMode01Response`, both consulted at
    // session construction) -- ELM327 has no runtime PID-switch mechanism of
    // its own, so this must be set BEFORE constructing a session that
    // should poll the fallback.
    setAccelPedalPidSource(pedalSource === '49-normalized' ? '49' : '5A');
    const config: Elm327Config = {
      pollPlan: buildPollPlan(transOilPidHex),
      customPids: buildCustomPids(transOilPidHex),
      initTimeoutMs: INIT_TIMEOUT_MS,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
      maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
    };
    const next = createElm327Session(transport, config, monotonicNow);
    const gen: SessionGeneration = {
      id,
      kind: 'elm327',
      session: next,
      transport,
      unsubscribeSample: next.onSample((sample) => {
        if (current?.id !== id) return;
        forwardTelemetrySample(sample);
      }),
      unsubscribeState: next.onStateChange((state, detail) => {
        if (current?.id !== id) return;
        emitState(state, detail);
        if (state === 'polling' && pedalSource === '5A' && !pedalFallbackAttempted) {
          // Field revision 2 (binding, pedal PID fallback): ELM327 has no
          // structured per-channel diagnostics (unlike ENET's
          // `unsupportedChannels`) -- a grace-window timer is the only
          // available signal that the primary (0x5A) source is unsupported
          // ("DME answers NO DATA", per contracts.md). `pedalSampleSeenThisGeneration`
          // was already reset for this generation at the top of `launchSession()`.
          pedalFallbackCheckTimer = setTimeout(() => {
            pedalFallbackCheckTimer = null;
            if (current?.id !== id) return; // stale -- a newer generation (or no generation) now owns this decision.
            if (pedalSampleSeenThisGeneration) return; // 0x5A IS answering -- nothing to do.
            triggerPedalFallback();
          }, PEDAL_FALLBACK_CHECK_DELAY_MS);
        }
        if (state === 'failed') {
          // Field revision (2026-08-27, binding): explicit close, defense-in-
          // depth against `tcpObdTransport.ts`'s own async-init-failure path
          // possibly leaving the socket open (scout finding) -- never rely
          // SOLELY on the core session having already closed it.
          // Generation-scoped (`gen`, not a shared field) -- the SAME
          // `current?.id === id` check above confirms `current === gen`
          // here, so this can only ever be THIS generation's own transport.
          closeGenTransportQuietly(gen);
          if (running) scheduleRetry(id);
        }
      }),
    };
    current = gen;
    next.start();
  }

  function scheduleRetry(genId: number): void {
    if (retryTimer !== null || retriesUsed >= 1 || !running) return;
    retriesUsed += 1;
    // Field revision (2026-08-27, binding): captured at SCHEDULE time --
    // compared against CURRENT settings when the timer actually fires, so a
    // retry never resurrects the OLD adapterType/host/port after the user
    // changed settings while it was pending (the settings-change watcher,
    // below, normally stops the generation outright before this timer would
    // even fire -- this is the defense-in-depth backstop for that race).
    const fingerprintAtSchedule = activeFingerprint;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!running) return;
      // Stale generation (e.g. a stop()/start() happened while this timer
      // was pending) -- the CURRENT generation's own lifecycle owns whatever
      // happens next, not this timer.
      if (current === null || current.id !== genId) return;
      if (
        fingerprintAtSchedule !== null &&
        !fingerprintsEqual(fingerprintAtSchedule, currentConfigFingerprint(settingsStore.getSettings()))
      ) {
        return; // settings changed while this retry was pending -- abort; the settings watcher (or a fresh start()) owns what happens next.
      }
      current.unsubscribeSample();
      current.unsubscribeState();
      current = null;
      // P4e-FIX4 fix (binding): the retry timer callback is the ONE
      // `launchSession()` call site that previously had NO try/catch at
      // all -- a synchronous construction throw here would have been an
      // unhandled exception inside a `setTimeout` callback. Routed through
      // the SAME `handleLaunchFailure` `start()`'s own catch uses, so both
      // call sites reset to one consistent 'failed' state (the token itself
      // is already released INSIDE `launchSession()`'s own try/catch before
      // this one ever sees the error).
      try {
        launchSession();
      } catch (error) {
        handleLaunchFailure(error);
      }
    }, RETRY_DELAY_MS);
  }

  /**
   * Field revision (2026-08-27, binding): `stop()`'s own full teardown,
   * extracted to a standalone function so `start()`'s re-entry check (below)
   * can reuse it VERBATIM before relaunching -- cancels the retry timer,
   * aborts discovery, closes the transport (via the generation's own
   * graceful `session.stop()`), releases the reservation, and clears
   * `running`/`current`. Exactly `stop()`'s previous body; the public
   * `stop()` method below is now a thin call to this.
   *
   * BEHAVIOR NOTE (binding, P4g-FIX1 H1 unification -- contracts.md tracks
   * this too): on a REJECTING ELM327 `session.stop()`, cleanup (listener
   * unsubscribe, `current` cleared) now happens regardless -- it is NO
   * LONGER byte-identical to the pre-P4e-FIX4 behavior that deliberately
   * left listeners subscribed and `current` attached on a rejection (see the
   * git-historical "P4e-FIX5" test, since REPLACED). The rejection itself
   * still propagates unchanged to `doStop()`'s own caller; only the cleanup
   * that used to be skipped on that path now always runs, matching ENET's
   * long-standing behavior. This is a deliberate consequence of unifying
   * teardown across both adapter kinds, not a regression.
   */
  async function doStop(): Promise<void> {
    running = false;
    reservationBlockedDetail = undefined;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    // Field revision 2 (binding, pedal PID fallback): cancels the ELM327
    // fallback-check timer, same reset discipline as `retryTimer` above --
    // a stale timer would be self-guarded by its own `current?.id !== id`
    // check regardless, but clearing it here (like `retryTimer`) means a
    // fully-stopped provider never has anything pending at all.
    if (pedalFallbackCheckTimer !== null) {
      clearTimeout(pedalFallbackCheckTimer);
      pedalFallbackCheckTimer = null;
    }
      // M1 fix (binding, sweep transport interface & lifecycle amendment):
      // "stop() aborts an in-flight discovery, awaits it, and releases the
      // provider token before returning" -- BEFORE the `current === null`
      // early return below, since during either auto-discovery phase
      // `current` IS `null` (no session has been built yet) and this used to
      // return immediately, leaving the scan (and its sockets, and the held
      // provider token) running for up to the full discovery budget.
      if (discoveryAbortSignal !== null) discoveryAbortSignal.aborted = true;
      // M1 fix (binding, after Codex P4f-REV3 MEDIUM): a never-settling
      // `readNetworkInfo()` read must never leave `stop()` (or the
      // `discoveryInFlight` it awaits next) hanging -- see
      // `readNetworkInfoRaced()`'s own doc comment.
      if (networkInfoAbortNotify !== null) networkInfoAbortNotify();
      if (discoveryInFlight !== null) await discoveryInFlight;
      // F3 fix: capture THIS call's generation locally, synchronously,
      // before awaiting anything -- a `start()` racing in during the
      // `await` below installs a DIFFERENT generation into `current`, whose
      // listeners this stop() must never touch.
      const gen = current;
      if (gen === null) return;

      // P4g-FIX1 (binding, H1 -- Codex P4g-REV1 HIGH "ELM teardown is not
      // serialized with the next ENET Start"): EVERY generation, ELM327 AND
      // ENET alike, now gets the SAME `stopping` promise and the SAME
      // unconditional (`finally`-based) cleanup. The PRIOR asymmetry -- only
      // ENET ever set `stopping`, and ELM327's cleanup ran only when
      // `session.stop()` RESOLVED (skipped entirely on rejection, "byte-
      // identical to pre-P4e-FIX4") -- meant an ELM327 generation stuck in
      // `connect()` never signalled ANYTHING to a subsequent `start()`: the
      // old socket was not guaranteed closed before a new (e.g. ENET)
      // transport connected. Unifying means `start()` can always await
      // `stopping` regardless of which kind is tearing down, and a rejecting
      // `session.stop()` (either kind) still runs cleanup -- it no longer
      // leaves stale listeners/`current` behind, though the rejection itself
      // still propagates to this call's own caller (see the outer `finally`
      // below).
      let resolveStopping: () => void = () => undefined;
      const stoppingPromise = new Promise<void>((resolve) => {
        resolveStopping = resolve;
      });
      stopping = stoppingPromise;

      try {
        try {
          // Field revision (2026-08-27, binding): races the graceful stop
          // against a 200ms transport-close timeout -- see
          // `stopGenSessionWithTransportRace`'s own doc comment. A normal,
          // fast resolve/reject is unaffected; a HUNG stop (stuck
          // `connect()`, the driveway-test scenario) still gets `gen`'s OWN
          // transport force-closed, generation-scoped -- never a shared
          // field that could otherwise close a NEWER generation's transport
          // instead.
          await stopGenSessionWithTransportRace(gen);
        } finally {
          // P4e-FIX4 fix (binding): "stop() releases the claim in a finally
          // AFTER the old session's stop settles (rejection included)" --
          // released via THIS generation's OWN token, so a NEWER
          // generation's (different) token/claim is never touched even if
          // this stop() is slow. ELM327 holds no reservation at all.
          if (gen.kind === 'enet') enetAdapterReservation.release(gen.enetToken);
          gen.unsubscribeSample();
          gen.unsubscribeState();
          // Only clear the shared `current` pointer if it's STILL this
          // generation -- a racing `start()` already replaced it with its
          // own, which this (now-finished) stop() must leave alone.
          if (current === gen) current = null;
        }
      } finally {
        // P4e-FIX5 fix (binding, Codex P4e-REV5 HIGH): NESTED in its own
        // `finally` so `resolveStopping()` runs regardless of whether the
        // inner `release`/unsubscribe block itself threw -- the
        // reservation module's own `notify()` can no longer throw (its own
        // FIX5 fix), but this nesting means a FUTURE change on either side
        // still can never deadlock a `start()` queued behind `stopping`.
        if (stopping === stoppingPromise) stopping = null;
        resolveStopping();
      }
  }

  /**
   * Field revision (2026-08-27, binding, "adapter-type switch" fix):
   * "settings subscription: adapterType/host/port change while a generation
   * exists -> stop it (state 'stopped', diagnostics 'settings changed')" --
   * subscribed ONCE for this provider's whole lifetime (a singleton, exactly
   * like the provider itself), so a settings change is acted on immediately
   * rather than waiting for the user to notice a stuck monitor and tap Start
   * (which `start()`'s own fingerprint check, above, also now handles as a
   * backup). `settingsStore.subscribe` fires on EVERY `update()` -- an
   * unrelated field (e.g. `units`) or a change while nothing is live
   * (`current === null`) is a no-op.
   */
  let lastKnownFingerprint: ConfigFingerprint = currentConfigFingerprint(settingsStore.getSettings());
  settingsStore.subscribe((settings) => {
    const fingerprint = currentConfigFingerprint(settings);
    if (fingerprintsEqual(fingerprint, lastKnownFingerprint)) return;
    lastKnownFingerprint = fingerprint;
    // Field revision (2026-08-27, binding): the fingerprint bookkeeping above
    // still updates even for the provider's OWN discovery-result update (so
    // a LATER genuine user change is compared against the right baseline),
    // but stopping the generation is skipped for it -- discovery applying
    // its own just-found host/port is this SAME generation completing its
    // own connect, never a user-initiated adapter switch.
    if (applyingDiscoveryResultUpdate) return;

    // P4g-FIX1 (binding, H2 -- Codex P4g-REV1 HIGH "settings changes during
    // auto-discovery are ignored"): PRIOR code early-returned right here on
    // `current === null`, which is true for the ENTIRE duration of EITHER
    // auto-discovery phase (no-host preamble, on-failure continuation --
    // both deliberately null `current` before scanning) -- so a user
    // switching adapterType, or editing the host, while a scan was in
    // flight was silently ignored: the scan could still persist its hit
    // over the user's edit and build a session from stale settings. Now:
    // abort any in-flight discovery FIRST, regardless of `current` --
    // `runAutoDiscoveryOnFailure`/`runAutoDiscoveryThenConnect` each also
    // compare the fingerprint captured at scan START against the one at
    // scan COMPLETION and discard (no persist, no session, reservation
    // released) on a mismatch, so this abort is a fast-path, not the only
    // guard.
    if (discoveryAbortSignal !== null) discoveryAbortSignal.aborted = true;
    if (networkInfoAbortNotify !== null) networkInfoAbortNotify();
    const discoveryToAwait = discoveryInFlight;

    const stopLiveGeneration = async (): Promise<void> => {
      // Ensures the aborted scan (and the reservation/probe socket it was
      // holding) has genuinely unwound before this handler considers itself
      // done -- mirrors `doStop()`'s own discovery-abort-then-await
      // discipline.
      if (discoveryToAwait !== null) await discoveryToAwait;
      if (current === null) return; // nothing live to stop -- the next start() will simply use the new settings.
      settingsChangedDetail = 'settings changed';
      // P4g-FIX2 (binding, H1 residual -- Codex P4g-REV2 PARTIAL): captured
      // HERE, synchronously, before awaiting `doStop()` -- `generationCounter`
      // is bumped by EVERY `launchSession()` call, including a queued Start's
      // launch that lands in the "no host configured" discovery preamble
      // (which deliberately leaves `current === null` for the whole scan).
      // The prior guard (`current === null` alone, after the await) missed
      // EXACTLY that case: a queued ENET Start with an empty host can enter
      // discovery while this `doStop()` is still tearing down the OLD ELM
      // generation, and `current` stays `null` throughout that scan -- so a
      // bare `current === null` check after the await still (wrongly) saw
      // "nothing live" and emitted a stale 'stopped' over the newer,
      // in-flight discovery. Comparing `generationCounter` catches this: any
      // fresh launch attempt (discovery or not) bumps it, so this stale
      // continuation is suppressed even while `current` is still `null`.
      const generationCounterBeforeStop = generationCounter;
      await doStop();
      // P4g-FIX1 (binding, H1): guard this stale continuation by generation
      // -- if a NEWER generation (or a newer launch ATTEMPT, discovery
      // included) was installed/started while `doStop()` was tearing down
      // (e.g. a queued `start()` that was waiting on `stopping`, which
      // resolves and relaunches BEFORE this `await doStop()` itself
      // settles -- see `stopping`'s resolution ordering), emitting 'stopped'
      // here would incorrectly overwrite that newer attempt's own live
      // state.
      if (current === null && generationCounter === generationCounterBeforeStop) {
        emitState('stopped', 'settings changed');
      }
    };
    void stopLiveGeneration();
  });

  // F2 fix (MED, binding): a synchronous throw while BUILDING the session
  // (transport construction, `createElm327Session`'s config validation) must
  // never leave this provider wedged `running=true` with no active
  // generation -- L3 (`elm327Session.ts`) now handles customPids config
  // problems as warnings, never throws, but this catch stays as the
  // provider's own defense-in-depth backstop regardless of what a future
  // config-validation change does. P4e-FIX4 (binding): factored into the
  // shared `handleLaunchFailure` -- the retry timer callback needs the SAME
  // reset now too.
  function launchFresh(): void {
    running = true;
    retriesUsed = 0;
    // ENET auto-discovery addendum (binding): "runs discovery ONCE per
    // start" -- reset here (a fresh start()..stop() lifecycle), mirroring
    // `retriesUsed`'s own reset discipline (NOT reset in `stop()`).
    autoDiscoveryAttempted = false;
    // Field revision 2 (binding, pedal PID fallback): a genuinely FRESH
    // Start always tries the primary (0x5A) source again, same reset
    // discipline as `autoDiscoveryAttempted` above -- NOT reset by
    // `triggerPedalFallback()`'s own internal (mid-lifecycle) relaunch.
    pedalSource = '5A';
    pedalFallbackAttempted = false;
    pedalOffsetLearner = INITIAL_PEDAL_OFFSET_LEARNER;
    try {
      launchSession();
    } catch (error) {
      handleLaunchFailure(error);
    }
  }

  return {
    start(): void {
      if (!settingsStore.getSettings().telemetryEnabled) return;

      // P4g-FIX1 (binding, H1 -- Codex P4g-REV1 HIGH "rapid/double Start can
      // queue or create multiple launches"): coalesce ANY concurrent
      // `start()` call into the ONE already in flight -- whether it's
      // queued behind a teardown's `stopping`, or behind another queued
      // start. Placed FIRST so it catches every re-entrant shape below,
      // not just the "already running" one.
      if (starting !== null) return;

      const fingerprint = currentConfigFingerprint(settingsStore.getSettings());

      if (running) {
        // Field revision (2026-08-27, binding, "adapter-type switch" fix):
        // the driveway-test bug -- this used to be a PLAIN `if (running)
        // return`, so a dead/stuck generation (a permanently 'failed' ELM327
        // session with no retries left, or one built from settings the user
        // has since changed) made every subsequent Start tap a silent no-op,
        // even across an adapterType switch. Only a generation that is
        // BOTH non-terminal AND still matches CURRENT settings stays a
        // true no-op (unchanged behavior); anything else tears down fully
        // (cancel retry timer, abort discovery, close the transport, release
        // the reservation, running=false -- `doStop()`, reused verbatim)
        // THEN launches fresh from CURRENT settings.
        const generationIsTerminal = current === null || currentState === 'failed' || currentState === 'stopped';
        const fingerprintChanged = activeFingerprint !== null && !fingerprintsEqual(activeFingerprint, fingerprint);
        if (!generationIsTerminal && !fingerprintChanged) return;
        // P4g-FIX2 (binding, H1 -- Codex P4g-REV2 HIGH "starting never
        // clears"): `starting` must hold THIS SAME promise object `p` --
        // assigning it the RESULT of `.finally()` (a distinct, newly
        // constructed promise) instead made `starting === p` permanently
        // false inside the finally callback below, so `starting` never
        // cleared and every Start after the first queued launch was a
        // silent no-op forever, even long after the launch had settled.
        const p = doStop().then(launchFresh, launchFresh);
        starting = p;
        void p.finally(() => {
          if (starting === p) starting = null;
        });
        return;
      }

      // P4g-FIX1 (binding, H1 -- Codex P4g-REV1 HIGH "ELM teardown is not
      // serialized with the next ENET Start"): even when NOT currently
      // `running` (e.g. a settings-change watcher just began tearing down
      // the previous generation, clearing `running` before this `start()`
      // is called), a teardown from EITHER adapter kind may still be
      // in-flight (`stopping`, now set unconditionally by `doStop()` -- see
      // its own comment) -- wait for it so the OLD transport is guaranteed
      // closed before a NEW one connects, regardless of destination adapter
      // type (previously this queuing only ever applied when switching TO
      // enet, which combined with `stopping` only ever being set by ENET's
      // own teardown, meant an ELM-stuck-in-connect generation followed by
      // switching to ENET and pressing Start did not wait for anything).
      if (stopping !== null) {
        // P4g-FIX2 (binding, H1 -- Codex P4g-REV2 HIGH "starting never
        // clears"): same identity fix as the `running` branch above --
        // `starting` holds `p` itself, not `.finally()`'s own distinct
        // returned promise.
        const p = stopping.then(launchFresh, launchFresh);
        starting = p;
        void p.finally(() => {
          if (starting === p) starting = null;
        });
        return;
      }
      launchFresh();
    },

    stop(): Promise<void> {
      return doStop();
    },

    onSample(cb) {
      sampleListeners.add(cb);
      return () => sampleListeners.delete(cb);
    },

    onStateChange(cb) {
      stateListeners.add(cb);
      // F10 fix (WPT3): replay the current state synchronously on subscribe
      // -- mirrors `SessionFacade.subscribe()`'s own semantics elsewhere in
      // this app. Previously a screen that mounted AFTER telemetry had
      // already started (or changed state) saw no event until the NEXT
      // transition, showing a stale/default state indefinitely.
      cb(currentState);
      return () => stateListeners.delete(cb);
    },

    getDiagnostics(): TelemetryProviderDiagnostics {
      const adapterType = settingsStore.getSettings().adapterType;
      // ENET telemetry addendum: the richer per-channel/frame/latency
      // diagnostics the monitor screen shows are ENET-only -- narrowed here
      // by `current.kind`, never surfaced (or even computed) on the ELM327
      // path below, which keeps returning EXACTLY the same shape it always
      // has.
      if (current !== null && current.kind === 'enet') {
        const diag = current.session.getDiagnostics();
        return {
          state: currentState,
          retriesUsed,
          observedHzByChannel: diag.observedHzByChannel,
          errorCount: diag.errorCount,
          ...(diag.lastError === undefined ? {} : { lastError: diag.lastError }),
          adapterType,
          enetTargetAddress: settingsStore.getSettings().enetTargetAddress,
          supportedChannels: diag.supportedChannels,
          unsupportedChannels: diag.unsupportedChannels,
          lastNrcByChannel: diag.lastNrcByChannel,
          framesTx: diag.framesTx,
          framesRx: diag.framesRx,
          ...(diag.ackLatencyMsP50 === undefined ? {} : { ackLatencyMsP50: diag.ackLatencyMsP50 }),
          ...(diag.ackLatencyMsP95 === undefined ? {} : { ackLatencyMsP95: diag.ackLatencyMsP95 }),
          ...(diag.lastRawFrameHex === undefined ? {} : { lastRawFrameHex: diag.lastRawFrameHex }),
          pedalSource,
        };
      }
      const base = current?.session.getDiagnostics() ?? { observedHzByChannel: {}, errorCount: 0 };
      // P4e-FIX3 H2 (binding): "diagnostics note 'adapter reserved by
      // probe'" -- surfaced here even with `current === null` (no active
      // generation exists to read a `lastError` FROM in that case).
      // `reservationBlockedDetail` is only ever set for the ENET path, so
      // this never applies to (or changes) the ELM327 diagnostics shape.
      // ENET auto-discovery addendum (binding): mirrors `reservationBlockedDetail`
      // above -- "discovery: scanned N, none answered" also has no live
      // generation to read a `lastError` FROM.
      const lastError = reservationBlockedDetail ?? autoDiscoveryFailureDetail ?? settingsChangedDetail ?? base.lastError;
      return {
        state: currentState,
        retriesUsed,
        observedHzByChannel: base.observedHzByChannel,
        errorCount: base.errorCount,
        ...(lastError === undefined ? {} : { lastError }),
        adapterType,
        pedalSource,
      };
    },
  };
}
