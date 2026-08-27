import {
  buildDiscoveryCandidates,
  createElm327Session,
  createEnetSession,
  createSimulatedDiscoveryProbeFactory,
  DEFAULT_ENET_CONFIG,
  ENET_DEFAULT_CHANNEL_RATES_HZ,
  runDiscovery,
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

/** User-facing diagnostics note (binding, P4e-FIX3 H2) when the ENET adapter is held by the dev DID-probe screen -- the MHD adapter accepts one ECU client at a time. */
export const ENET_ADAPTER_RESERVED_BY_PROBE_DETAIL = 'adapter reserved by probe';

/**
 * Telemetry addendum — channel revision (2026-08-11, binding) poll plan:
 * rpm 5Hz (record-only -- RPM left the strip, it's on the car's own dash),
 * speedKph 5Hz, throttlePct 5Hz, engineOilC 0.5Hz (standard PID 0x5C),
 * transOilC 0.5Hz ONLY when the user has configured a custom PID request
 * (`settings.transOilPidHex` -- empty means "not configured", the entry is
 * omitted entirely rather than relying on `@circuit/core`'s own "unconfigured
 * transOilC is silently ignored" fallback), coolantC 0.2Hz. Exported (pure,
 * no react-native import) so the exact plan built from a given settings value
 * can be pinned by a test.
 */
export function buildPollPlan(transOilPidHex: string): Array<{ channel: TelemetryChannelId; hz: number }> {
  const plan: Array<{ channel: TelemetryChannelId; hz: number }> = [
    { channel: 'rpm', hz: 5 },
    { channel: 'speedKph', hz: 5 },
    { channel: 'throttlePct', hz: 5 },
    { channel: 'engineOilC', hz: 0.5 },
  ];
  if (transOilPidHex.trim() !== '') {
    plan.push({ channel: 'transOilC', hz: 0.5 });
  }
  plan.push({ channel: 'coolantC', hz: 0.2 });
  return plan;
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
  | { id: number; kind: 'elm327'; session: Elm327Session; unsubscribeSample: () => void; unsubscribeState: () => void }
  | {
      id: number;
      kind: 'enet';
      session: EnetSession;
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

  /** Shared failure handling for a synchronous `launchSession()` throw, from EITHER `start()`'s own first attempt or the scheduled retry (P4e-FIX4, binding: "retry wraps launchSession() in try/catch"). Resets to a clean, non-running state and reports through the SAME `failed` channel a runtime session failure already uses. */
  function handleLaunchFailure(error: unknown): void {
    running = false;
    current = null;
    emitState('failed', errorMessage(error));
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
    const channelSpecs = resolveEnetChannelSpecs(settings.enetChannelSpecsJson);
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
    let phoneInfo: Awaited<ReturnType<typeof getNetworkInfo>> = null;
    try {
      phoneInfo = await readNetworkInfo();
    } catch {
      phoneInfo = null;
    }
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
      const config = buildEnetConfig();
      const next = createEnetSession(transport, config, monotonicNow);
      const gen: SessionGeneration = {
        id,
        kind: 'enet',
        session: next,
        enetToken: token,
        unsubscribeSample: next.onSample((sample) => {
          if (current?.id !== id) return;
          for (const listener of [...sampleListeners]) listener(sample);
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
    const result = await runTrackedAutoDiscovery();
    if (!running || current !== null) {
      enetAdapterReservation.release(token);
      return;
    }
    const hit = result.results.find((r) => r.level === 2);
    if (hit !== undefined) {
      settingsStore.update(applyDiscoveryResult(hit, new Date().toISOString()));
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
    const result = await runTrackedAutoDiscovery();
    if (!running || generationCounter !== id) {
      enetAdapterReservation.release(token);
      return;
    }
    const hit = result.results.find((r) => r.level === 2);
    if (hit !== undefined) {
      settingsStore.update(applyDiscoveryResult(hit, new Date().toISOString()));
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
    const transOilPidHex = settingsStore.getSettings().transOilPidHex;
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
      unsubscribeSample: next.onSample((sample) => {
        if (current?.id !== id) return;
        for (const listener of [...sampleListeners]) listener(sample);
      }),
      unsubscribeState: next.onStateChange((state, detail) => {
        if (current?.id !== id) return;
        emitState(state, detail);
        if (state === 'failed' && running) scheduleRetry(id);
      }),
    };
    current = gen;
    next.start();
  }

  function scheduleRetry(genId: number): void {
    if (retryTimer !== null || retriesUsed >= 1 || !running) return;
    retriesUsed += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!running) return;
      // Stale generation (e.g. a stop()/start() happened while this timer
      // was pending) -- the CURRENT generation's own lifecycle owns whatever
      // happens next, not this timer.
      if (current === null || current.id !== genId) return;
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

  return {
    start(): void {
      if (running) return;
      if (!settingsStore.getSettings().telemetryEnabled) return;
      running = true;
      retriesUsed = 0;
      // ENET auto-discovery addendum (binding): "runs discovery ONCE per
      // start" -- reset here (a fresh start()..stop() lifecycle), mirroring
      // `retriesUsed`'s own reset discipline (NOT reset in `stop()`).
      autoDiscoveryAttempted = false;

      // F2 fix (MED, binding): a synchronous throw while BUILDING the
      // session (transport construction, `createElm327Session`'s config
      // validation) must never leave this provider wedged `running=true`
      // with no active generation -- L3 (`elm327Session.ts`) now handles
      // customPids config problems as warnings, never throws, but this
      // catch stays as the provider's own defense-in-depth backstop
      // regardless of what a future config-validation change does.
      // P4e-FIX4 (binding): factored into the shared `handleLaunchFailure`
      // -- the retry timer callback needs the SAME reset now too.
      const attempt = (): void => {
        if (!running) return; // a stop() raced in while this attempt was queued behind `stopping` below.
        try {
          launchSession();
        } catch (error) {
          handleLaunchFailure(error);
        }
      };

      // P4e-FIX4 fix (binding, Codex P4e-REV4 HIGH finding -- "overlapping
      // provider generations bypass exclusivity"): if a `stop()` is still
      // tearing down the PREVIOUS generation (its own session.stop() +
      // reservation release + unsubscribe not yet settled), this start()
      // queues behind that -- `running=true` already guards a second
      // concurrent `start()` from queuing twice, and `attempt`'s own
      // `running` re-check handles a `stop()` that raced in during the
      // wait. ONLY the ENET path serializes this way: the reservation's
      // exclusivity is the ENTIRE reason this queuing exists, and only
      // `adapterType: 'enet'` ever touches it -- the ELM327 path's own
      // overlap behavior stays EXACTLY as it was before this ticket
      // (byte-identical, binding), a fresh generation immediately, even
      // while an earlier stop() is still tearing down. Nothing is awaited
      // when no stop() is in flight either way -- start() stays
      // synchronous-looking for every existing caller.
      if (stopping !== null && settingsStore.getSettings().adapterType === 'enet') {
        void stopping.then(attempt, attempt);
      } else {
        attempt();
      }
    },

    async stop(): Promise<void> {
      running = false;
      reservationBlockedDetail = undefined;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      // M1 fix (binding, sweep transport interface & lifecycle amendment):
      // "stop() aborts an in-flight discovery, awaits it, and releases the
      // provider token before returning" -- BEFORE the `current === null`
      // early return below, since during either auto-discovery phase
      // `current` IS `null` (no session has been built yet) and this used to
      // return immediately, leaving the scan (and its sockets, and the held
      // provider token) running for up to the full discovery budget.
      if (discoveryAbortSignal !== null) discoveryAbortSignal.aborted = true;
      if (discoveryInFlight !== null) await discoveryInFlight;
      // F3 fix: capture THIS call's generation locally, synchronously,
      // before awaiting anything -- a `start()` racing in during the
      // `await` below installs a DIFFERENT generation into `current`, whose
      // listeners this stop() must never touch.
      const gen = current;
      if (gen === null) return;

      // P4e-FIX5 fix (binding, Codex P4e-REV5 MED): the finally-based
      // cleanup below applies ONLY to ENET generations. ELM327 keeps its
      // ORIGINAL, pre-P4e-FIX4 semantics exactly (byte-identical, binding):
      // cleanup happens ONLY after the awaited `session.stop()` RESOLVES --
      // a rejection propagates immediately, leaving listener/diagnostics
      // state (and `current`) intact, precisely as this app has always
      // behaved for ELM327. `stopping`/the adapter reservation are ENET-only
      // concepts; nothing below applies (or is even touched) for ELM327.
      if (gen.kind !== 'enet') {
        await gen.session.stop();
        gen.unsubscribeSample();
        gen.unsubscribeState();
        if (current === gen) current = null;
        return;
      }

      // P4e-FIX4 fix (binding): tracked so a `start()` racing in WHILE this
      // stop() is still tearing down queues behind it instead of opening a
      // second ENET socket while the first is still closing (the review's
      // overlap scenario) -- see `stopping`'s own doc comment above.
      let resolveStopping: () => void = () => undefined;
      const stoppingPromise = new Promise<void>((resolve) => {
        resolveStopping = resolve;
      });
      stopping = stoppingPromise;

      try {
        try {
          await gen.session.stop();
        } finally {
          // P4e-FIX4 fix (binding): "stop() releases the claim in a finally
          // AFTER the old session's stop settles (rejection included)" --
          // released via THIS generation's OWN token, so a NEWER
          // generation's (different) token/claim is never touched even if
          // this stop() is slow. Cleanup below also lives in this
          // `finally` (previously only ran when `gen.session.stop()`
          // resolved, for ENET too) -- a rejection must not leave stale
          // listeners subscribed to a generation nothing else believes is
          // live any more.
          enetAdapterReservation.release(gen.enetToken);
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
        // still can never deadlock an ENET `start()` queued behind
        // `stopping`.
        if (stopping === stoppingPromise) stopping = null;
        resolveStopping();
      }
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
      const lastError = reservationBlockedDetail ?? autoDiscoveryFailureDetail ?? base.lastError;
      return {
        state: currentState,
        retriesUsed,
        observedHzByChannel: base.observedHzByChannel,
        errorCount: base.errorCount,
        ...(lastError === undefined ? {} : { lastError }),
        adapterType,
      };
    },
  };
}
