import {
  createElm327Session,
  SimulatedElm327Transport,
  type Elm327Session,
  type Elm327State,
  type ObdTransport,
  type TelemetrySample,
} from '@circuit/core';
import type { SettingsStore } from './settingsStore';
import { TcpObdTransport } from './tcpObdTransport';

/** Telemetry addendum's example poll plan (docs/architecture/contracts.md): rpm 10Hz, speedKph 5Hz, throttlePct 5Hz, coolantC 0.5Hz. */
const POLL_PLAN = [
  { channel: 'rpm', hz: 10 },
  { channel: 'speedKph', hz: 5 },
  { channel: 'throttlePct', hz: 5 },
  { channel: 'coolantC', hz: 0.5 },
] as const;

const INIT_TIMEOUT_MS = 5_000;
const COMMAND_TIMEOUT_MS = 1_500;
const MAX_CONSECUTIVE_ERRORS = 5;

/** Reconnect policy (binding, kept simple): on 'failed', exactly ONE retry after this delay, then stay failed until the next `start()` (a fresh session). */
const RETRY_DELAY_MS = 3_000;

export interface TelemetryProviderDeps {
  settingsStore: SettingsStore;
  /** SAME injected monotonic clock the session already uses (never `Date.now()`) -- stamps every `TelemetrySample.tMonoMs` via `@circuit/core`'s `Elm327Session`. */
  monotonicNow: () => number;
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

export function createTelemetryProvider(deps: TelemetryProviderDeps): TelemetryProvider {
  const { settingsStore, monotonicNow } = deps;
  const sampleListeners = new Set<(s: TelemetrySample) => void>();
  const stateListeners = new Set<(state: Elm327State, detail?: string) => void>();

  let session: Elm327Session | null = null;
  let currentState: Elm327State = 'idle';
  let unsubscribeSample: (() => void) | null = null;
  let unsubscribeState: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retriesUsed = 0;
  let running = false;

  function buildTransport(): ObdTransport {
    const settings = settingsStore.getSettings();
    if (settings.telemetrySimulate) {
      return new SimulatedElm327Transport({ monotonicNow });
    }
    return new TcpObdTransport({ host: settings.adapterHost, port: settings.adapterPort });
  }

  function emitState(state: Elm327State, detail?: string): void {
    currentState = state;
    for (const listener of [...stateListeners]) listener(state, detail);
  }

  function detachListeners(): void {
    unsubscribeSample?.();
    unsubscribeState?.();
    unsubscribeSample = null;
    unsubscribeState = null;
  }

  function launchSession(): void {
    const transport = buildTransport();
    const next = createElm327Session(
      transport,
      {
        pollPlan: POLL_PLAN.map((entry) => ({ ...entry })),
        initTimeoutMs: INIT_TIMEOUT_MS,
        commandTimeoutMs: COMMAND_TIMEOUT_MS,
        maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
      },
      monotonicNow,
    );
    session = next;
    unsubscribeSample = next.onSample((sample) => {
      for (const listener of [...sampleListeners]) listener(sample);
    });
    unsubscribeState = next.onStateChange((state, detail) => {
      emitState(state, detail);
      if (state === 'failed' && running) scheduleRetry();
    });
    next.start();
  }

  function scheduleRetry(): void {
    if (retryTimer !== null || retriesUsed >= 1 || !running) return;
    retriesUsed += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!running) return;
      detachListeners();
      session = null;
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
      const active = session;
      session = null;
      if (active !== null) await active.stop();
      detachListeners();
    },

    onSample(cb) {
      sampleListeners.add(cb);
      return () => sampleListeners.delete(cb);
    },

    onStateChange(cb) {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },

    getDiagnostics(): TelemetryProviderDiagnostics {
      const base = session?.getDiagnostics() ?? { observedHzByChannel: {}, errorCount: 0 };
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
