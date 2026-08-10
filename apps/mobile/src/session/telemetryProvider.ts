import {
  createElm327Session,
  SimulatedElm327Transport,
  type Elm327Config,
  type Elm327Session,
  type Elm327State,
  type ObdTransport,
  type TelemetryChannelId,
  type TelemetrySample,
} from '@circuit/core';
import type { SettingsStore } from './settingsStore';
import { TcpObdTransport } from './tcpObdTransport';

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
 * PID, so it's sent as a raw custom request (verbatim hex, decoded as the
 * last data byte minus 40 by `@circuit/core`) built from the user's
 * vehicle-specific `settings.transOilPidHex`. `undefined` (not an empty
 * array) when unconfigured, matching `Elm327Config.customPids`'s own optional
 * shape.
 */
export function buildCustomPids(
  transOilPidHex: string,
): Array<{ channel: TelemetryChannelId; request: string }> | undefined {
  const trimmed = transOilPidHex.trim();
  return trimmed === '' ? undefined : [{ channel: 'transOilC', request: trimmed }];
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

export interface TelemetryProviderDiagnostics {
  state: Elm327State;
  observedHzByChannel: Record<string, number>;
  errorCount: number;
  lastError?: string;
  /** 0 or 1 -- whether the single reconnect retry has been used for the current `start()`..`stop()` lifecycle. */
  retriesUsed: number;
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
interface SessionGeneration {
  id: number;
  session: Elm327Session;
  unsubscribeSample: () => void;
  unsubscribeState: () => void;
}

export function createTelemetryProvider(deps: TelemetryProviderDeps): TelemetryProvider {
  const { settingsStore, monotonicNow } = deps;
  // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
  const isDev = deps.isDev ?? (typeof __DEV__ !== 'undefined' ? __DEV__ : false);
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

  function buildTransport(): ObdTransport {
    const settings = settingsStore.getSettings();
    // F8 fix: a non-dev build ignores a persisted `telemetrySimulate=true`
    // entirely (never mutates the stored setting -- just ignores it here).
    if (settings.telemetrySimulate && isDev) {
      return new SimulatedElm327Transport({ monotonicNow });
    }
    return new TcpObdTransport({ host: settings.adapterHost, port: settings.adapterPort });
  }

  function emitState(state: Elm327State, detail?: string): void {
    currentState = state;
    for (const listener of [...stateListeners]) listener(state, detail);
  }

  function launchSession(): void {
    generationCounter += 1;
    const id = generationCounter;
    const transport = buildTransport();
    // Channel revision (binding): the poll plan (and whether transOilC's
    // custom PID is even sent) is read fresh from settings on every
    // `start()`, same freshness rule as `buildTransport()`'s own read above --
    // a `transOilPidHex` edit takes effect on the next session, matching
    // every other settings-gated telemetry field.
    const transOilPidHex = settingsStore.getSettings().transOilPidHex;
    const config: Elm327Config = {
      pollPlan: buildPollPlan(transOilPidHex),
      customPids: buildCustomPids(transOilPidHex),
      initTimeoutMs: INIT_TIMEOUT_MS,
      commandTimeoutMs: COMMAND_TIMEOUT_MS,
      maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
    };
    const next = createElm327Session(transport, config, monotonicNow);
    // F3 fix: every listener below checks `current?.id === id` before doing
    // anything -- once a NEWER generation has replaced `current` (a fresh
    // `start()`, or this generation's own `stop()`/retry teardown), a late
    // event from THIS (now-stale) session's transport/session is dropped
    // instead of forwarding a sample/state change for a session nothing
    // outside this closure should still believe is live.
    const gen: SessionGeneration = {
      id,
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
      launchSession();
    }, RETRY_DELAY_MS);
  }

  return {
    start(): void {
      if (running) return;
      if (!settingsStore.getSettings().telemetryEnabled) return;
      running = true;
      retriesUsed = 0;
      launchSession();
    },

    async stop(): Promise<void> {
      running = false;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      // F3 fix: capture THIS call's generation locally, synchronously,
      // before awaiting anything -- a `start()` racing in during the
      // `await` below installs a DIFFERENT generation into `current`, whose
      // listeners this stop() must never touch.
      const gen = current;
      if (gen === null) return;
      await gen.session.stop();
      gen.unsubscribeSample();
      gen.unsubscribeState();
      // Only clear the shared `current` pointer if it's STILL this
      // generation -- a racing `start()` already replaced it with its own,
      // which this (now-finished) stop() must leave alone.
      if (current === gen) current = null;
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
      const base = current?.session.getDiagnostics() ?? { observedHzByChannel: {}, errorCount: 0 };
      return {
        state: currentState,
        retriesUsed,
        observedHzByChannel: base.observedHzByChannel,
        errorCount: base.errorCount,
        ...(base.lastError === undefined ? {} : { lastError: base.lastError }),
      };
    },
  };
}
