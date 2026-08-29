import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnetSession, EnetState, TelemetrySample } from '@circuit/core';
import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { createTelemetryProvider } from '../../src/session/telemetryProvider';
import { createEnetAdapterReservation } from '../../src/session/enetAdapterReservation';

/**
 * ENET telemetry addendum (P4e-T2, binding): `telemetryProvider.ts` chooses
 * engine + transport by `adapterType`. This file is the ENET-side companion
 * to `telemetryProvider.test.ts` (the pre-existing ELM327 suite, which stays
 * untouched -- proving the ELM327 path is byte-identical). Same mocking
 * strategy: `EnetTcpTransport` is mocked (always-failing, or test-controlled
 * pending, `connect()`) so the "real adapter" path is exercised
 * deterministically without ever loading `react-native-tcp-socket`; the
 * simulated-transport tests use the REAL `SimulatedEnetTransport` from
 * `@circuit/core`.
 */
const tracker = vi.hoisted(() => ({
  connectCalls: 0,
  /** P4e-FIX2 L3 (stale-generation test): when true, `connect()` returns a promise this test controls instead of rejecting immediately -- mirrors `telemetryProvider.test.ts`'s own `holdConnect` seam for the ELM327 generation-race test. */
  holdConnect: false,
  pendingConnects: [] as Array<{ resolve: () => void; reject: (error: Error) => void }>,
}));

vi.mock('../../src/session/enetTcpTransport', () => ({
  EnetTcpTransport: class {
    async connect(): Promise<void> {
      tracker.connectCalls += 1;
      if (tracker.holdConnect) {
        return new Promise<void>((resolve, reject) => {
          tracker.pendingConnects.push({ resolve, reject });
        });
      }
      throw new Error('ENET adapter unreachable (test double)');
    }
    send(): void {}
    onData(): () => void {
      return () => undefined;
    }
    onClose(): () => void {
      return () => undefined;
    }
    async close(): Promise<void> {}
  },
}));

/**
 * P4e-FIX2 L3 (constructor-assertion test): wraps the REAL `createEnetSession`
 * so a test can assert it was (or was not) reached, mirroring
 * `telemetryProvider.test.ts`'s own `createElm327Session` spy.
 */
vi.mock('@circuit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@circuit/core')>();
  return { ...actual, createEnetSession: vi.fn(actual.createEnetSession) };
});
import { createEnetSession } from '@circuit/core';

async function flushMicrotasks(times = 15): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function monotonicCounter(): () => number {
  let t = 1_000;
  return () => {
    t += 1;
    return t;
  };
}

describe('telemetryProvider: adapterType "elm327" never constructs ENET machinery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.connectCalls = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('EnetTcpTransport.connect() is never called when adapterType is "elm327" (the default), even with telemetryEnabled', async () => {
    const store = new InMemorySettingsStore();
    // telemetrySimulate:false + isDev:true forces the REAL-adapter path for
    // whichever adapter type is selected -- if adapterType were ignored, this
    // would reach the mocked EnetTcpTransport above.
    store.update({ telemetryEnabled: true, telemetrySimulate: false });
    expect(store.getSettings().adapterType).toBe('elm327');

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    provider.start();
    await flushMicrotasks();

    expect(tracker.connectCalls).toBe(0);
    // The ELM327 path was reached instead (its own always-failing transport
    // isn't mocked in THIS file, so `createElm327Session` runs against
    // `TcpObdTransport`'s real lazy-load path against a nonexistent adapter;
    // it fails to reach 'polling' -- the point here is only that the ENET
    // mock was never touched).
    expect(provider.getDiagnostics().adapterType).toBe('elm327');

    await provider.stop();
  });
});

describe('telemetryProvider: adapterType "enet" with the simulated transport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaches polling via SimulatedEnetTransport, delivers samples, and getDiagnostics() reports ENET-only fields', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true, adapterType: 'enet', enetHost: '192.168.4.20' });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const samples: TelemetrySample[] = [];
    const states: string[] = [];
    provider.onSample((s) => samples.push(s));
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    // ENET's own 'handshake' state is mapped to the shared 'initializing'
    // vocabulary (TelemetryStrip.tsx subscribes typed exactly `Elm327State`).
    expect(states).toContain('polling');
    expect(samples.length).toBeGreaterThan(0);

    const diagnostics = provider.getDiagnostics();
    expect(diagnostics.adapterType).toBe('enet');
    expect(diagnostics.enetTargetAddress).toBe(0x12);
    expect(diagnostics.supportedChannels).toBeDefined();
    expect(diagnostics.framesTx).toBeGreaterThan(0);
    expect(diagnostics.framesRx).toBeGreaterThan(0);

    await provider.stop();
    expect(provider.getDiagnostics().state).toBe('stopped');
  });

  it('adapterType "enet" with telemetryEnabled false is a no-op, same as ELM327', async () => {
    const store = new InMemorySettingsStore();
    store.update({ adapterType: 'enet' }); // telemetryEnabled stays false (default).
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(provider.getDiagnostics().state).toBe('idle');
  });

  it('a channel spec the simulated ECU has no script for is marked UNSUPPORTED (NRC 0x31), without the session going "failed"', async () => {
    const store = new InMemorySettingsStore();
    store.update({
      telemetryEnabled: true,
      telemetrySimulate: true,
      adapterType: 'enet',
      enetHost: '192.168.4.20', // E2E-a (binding): auto-discovery now runs under telemetrySimulate too when no host is configured -- an explicit host keeps this test on the pre-existing direct-connect path, unrelated to discovery.
      // P4e-FIX1 (core, binding): `validateEnetChannelSpecs` now enforces
      // obd01 channel<->PID consistency (a bogus obd01 `requestHex` like the
      // old 'AA' here is now REJECTED at validation, never reaching the wire
      // at all) -- a `did`-mode spec has no such "correct DID" table to check
      // against (no public B58/DSC DID table exists), so it's the legitimate
      // way to reach the wire with a request the simulator has no script for.
      // 'F1A0' matches no entry in `DEFAULT_ENET_SCENARIO` -- `SimulatedEnetTransport`
      // answers any unscripted DID (`mode: 'did'`) with NRC 0x31
      // (requestOutOfRange, the correct UDS NRC for an unknown identifier --
      // P4f-FIX2-core, binding: "0x11 would be wrong for a DID sweep"; the
      // unscripted OBD01 case is unchanged at 0x11), exactly the wire
      // behavior a real ECU would produce for a DID it doesn't support
      // (addendum: "NRC 0x11/0x12/0x31 marks a channel UNSUPPORTED, removes
      // it from the poll plan, recorded in diagnostics").
      enetChannelSpecsJson: JSON.stringify([
        {
          channel: 'coolantC',
          mode: 'did',
          requestHex: 'F1A0',
          decode: { byteOffset: 0, byteLength: 1, scale: 1, offset: -40 },
          provenance: 'test: deliberately unscripted DID',
        },
      ]),
    });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    const diagnostics = provider.getDiagnostics();
    expect(diagnostics.unsupportedChannels).toEqual(['coolantC']);
    expect(diagnostics.lastNrcByChannel?.coolantC).toBe(0x31);
    // A definitive UNSUPPORTED determination is graceful, not a failure --
    // the session must stay 'polling' (only the tester-present exchange
    // continues once every configured channel has been marked unsupported).
    expect(states).not.toContain('failed');
    expect(provider.getDiagnostics().state).toBe('polling');

    await provider.stop();
  });
});

/**
 * P4e-FIX2 M1 fix (binding, "poll plan, probe & robustness amendment"):
 * "ENET poll plan derives from the RESOLVED channel specs ... On the ENET
 * path transOilC is NOT gated by the ELM-era transOilPidHex." Before this
 * fix, `buildEnetConfig()` reused the fixed ELM327 `buildPollPlan`, which
 * has no `intakeC`/`engineLoadPct` entries at all and only adds `transOilC`
 * when `transOilPidHex` (an ELM-only field) is non-empty.
 */
describe('telemetryProvider: M1 fix -- ENET poll plan derives from resolved specs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('intakeC, engineLoadPct, and transOilC are all polled (each reaches the wire, proven by NRC 0x11) despite transOilPidHex being unset', async () => {
    const store = new InMemorySettingsStore();
    store.update({
      telemetryEnabled: true,
      telemetrySimulate: true,
      adapterType: 'enet',
      enetHost: '192.168.4.20', // E2E-a (binding): keeps this test on the pre-existing direct-connect path, unrelated to auto-discovery.
      transOilPidHex: '', // explicit: the ELM-era field stays UNSET -- must not matter on the ENET path.
      enetChannelSpecsJson: JSON.stringify([
        { channel: 'intakeC', mode: 'obd01', requestHex: '0F', provenance: 'standard PID' },
        { channel: 'engineLoadPct', mode: 'obd01', requestHex: '04', provenance: 'standard PID' },
        {
          channel: 'transOilC',
          mode: 'did',
          requestHex: 'F1A1',
          decode: { byteOffset: 0, byteLength: 1, scale: 1, offset: -40 },
          provenance: 'test: unscripted DID -- proves transOilC is polled without transOilPidHex',
        },
      ]),
    });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    await flushMicrotasks();

    // None of these three channels has a `DEFAULT_ENET_SCENARIO` script, so
    // each one being polled AT ALL resolves to NRC 0x11 (serviceNotSupported)
    // and lands in `unsupportedChannels` -- BEFORE this fix, none of them
    // would ever have been queried (intakeC/engineLoadPct were absent from
    // the fixed ELM327 poll plan; transOilC was gated on the empty
    // `transOilPidHex`), so this set would have stayed empty instead.
    const diagnostics = provider.getDiagnostics();
    expect(diagnostics.unsupportedChannels).toEqual(
      expect.arrayContaining(['intakeC', 'engineLoadPct', 'transOilC']),
    );

    await provider.stop();
  });
});

describe('telemetryProvider: ENET reconnect policy (real-adapter path, mocked EnetTcpTransport)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.connectCalls = 0;
    tracker.holdConnect = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reaches 'failed', retries exactly ONCE after 3s, then stays failed (no further retries) -- SAME policy as ELM327", async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet', enetAutoDiscover: false });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(1);
    expect(states.at(-1)).toBe('failed');

    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(2);
    expect(states.at(-1)).toBe('failed');

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(2);

    await provider.stop();
  });
});

/**
 * P4e-FIX4 fix (binding, Codex P4e-REV4 HIGH finding -- "overlapping
 * provider generations bypass exclusivity"): a `start()` racing in while an
 * earlier `stop()` is still tearing down used to get its OWN fresh
 * generation immediately, opening a SECOND ENET socket while the first was
 * still closing (`enetAdapterReservation.tryAcquire('provider')` treated
 * this as a harmless same-owner reacquire). This test previously observed
 * (and asserted as correct) exactly that -- TWO pending connections. That
 * behavior is now FORBIDDEN: `start()` queues behind the in-flight `stop()`
 * (tracked via `stopping`) instead, so this test is rewritten to assert the
 * new, serialized behavior: exactly ONE ENET socket exists at a time, and
 * the reservation is held by generation 2 only AFTER generation 1's own
 * `stop()` has fully settled.
 */
describe('telemetryProvider: ENET stop()/start() overlap is now serialized (P4e-FIX4, binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.connectCalls = 0;
    tracker.holdConnect = true;
    tracker.pendingConnects = [];
  });
  afterEach(() => {
    tracker.holdConnect = false;
    vi.useRealTimers();
  });

  it("the review's overlap scenario: stop() then immediate start() -- exactly ONE ENET socket exists at a time; the reservation is held by generation 2 only after the old stop() settles", async () => {
    const reservation = createEnetAdapterReservation();
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet', enetAutoDiscover: false });
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      enetAdapterReservation: reservation,
    });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    // Generation 1: connect() held pending ('connecting').
    provider.start();
    await flushMicrotasks();
    expect(tracker.pendingConnects).toHaveLength(1);
    const gen1Connect = tracker.pendingConnects[0]!;
    expect(reservation.holder()).toBe('provider');

    const stopPromise = provider.stop();
    await flushMicrotasks();

    // A start() while that stop() is still tearing down must NOT open a
    // second socket -- it queues behind the in-flight stop() instead.
    provider.start();
    await flushMicrotasks();
    expect(tracker.pendingConnects).toHaveLength(1); // still just gen1 -- no overlap.

    // Settling gen1's connect() (stopRequested already true) lets its own
    // session resolve down to 'stopped' -- which is what unblocks stop().
    gen1Connect.reject(new Error('gen1 connect aborted'));
    await stopPromise;
    await flushMicrotasks();

    // The reservation is released as gen1's stop() settles, and ONLY THEN
    // does the queued start() proceed -- opening gen2's own socket and
    // re-acquiring the reservation, never before.
    expect(tracker.pendingConnects).toHaveLength(2);
    const gen2Connect = tracker.pendingConnects[1]!;
    expect(reservation.holder()).toBe('provider'); // held by generation 2 now.
    expect(states).toEqual(['idle', 'connecting', 'stopped', 'connecting']);

    // Generation 2 is alive and keeps forwarding its OWN events.
    gen2Connect.reject(new Error('gen2 connect also fails'));
    await flushMicrotasks();

    expect(states).toEqual(['idle', 'connecting', 'stopped', 'connecting', 'failed']);
    expect(provider.getDiagnostics().state).toBe('failed');

    await provider.stop();
  });
});

/**
 * L3 (binding): "ENET->Elm327State mapping cannot mislabel 'failed'/'stopped'"
 * (Codex P4e-REV2 Part B item 2). A graceful `stop()` must always end in
 * `'stopped'`, never `'failed'`; a connection failure must always end in
 * `'failed'`, never `'stopped'` -- checked as two DISTINCT scenarios so a
 * mapping bug that swapped the two (or collapsed both onto one label) would
 * be caught.
 */
describe('telemetryProvider: ENET state mapping cannot mislabel stopped/failed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.connectCalls = 0;
    tracker.holdConnect = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a graceful stop() (simulated transport, reaches 'polling' first) ends in 'stopped', never 'failed'", async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true, adapterType: 'enet', enetHost: '192.168.4.20' });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(states).toContain('polling');

    await provider.stop();
    expect(states.at(-1)).toBe('stopped');
    expect(states).not.toContain('failed');
  });

  it("a failing real-adapter connect() ends in 'failed', never 'stopped'", async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet', enetAutoDiscover: false });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    expect(states.at(-1)).toBe('failed');
    expect(states).not.toContain('stopped');

    await provider.stop();
  });
});

/**
 * L3 (binding): "constructor assertion for elm327 path" -- a DIRECT spy on
 * `createEnetSession` itself (not just its transport), proving the ENET
 * ENGINE is never constructed under `adapterType: 'elm327'`, and IS
 * constructed under `adapterType: 'enet'`.
 */
describe('telemetryProvider: createEnetSession constructor assertion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(createEnetSession).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('createEnetSession is NEVER called when adapterType is "elm327" (the default)', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true }); // adapterType defaults to 'elm327'.
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(createEnetSession).not.toHaveBeenCalled();

    await provider.stop();
  });

  it('createEnetSession IS called exactly once when adapterType is "enet"', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true, adapterType: 'enet', enetHost: '192.168.4.20' });
    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });

    provider.start();
    await flushMicrotasks();

    expect(createEnetSession).toHaveBeenCalledTimes(1);

    await provider.stop();
  });
});

/**
 * P4e-FIX3 H2 (binding, "poll plan, probe & robustness amendment", Codex
 * P4e-REV3): the single-client ENET adapter reservation shared with the dev
 * DID-probe screen. Every test here injects its OWN fresh
 * `createEnetAdapterReservation()` instance (never the real shared
 * singleton) so these tests can drive the reservation directly, standing in
 * for the probe screen without needing to render it.
 */
describe('telemetryProvider: ENET adapter reservation (P4e-FIX3 H2, binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.connectCalls = 0;
    tracker.holdConnect = false;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The review's EXACT race (P4e-REV3, Part B H2 residual): "provider enters
   * 'failed' and schedules its retry; the probe is allowed in ('failed' is
   * one of the gating's own allowed states) and acquires the adapter; the
   * provider's own scheduled retry fires moments later and opens a SECOND
   * client on the same adapter." The reservation closes this window: the
   * provider releases on 'failed', the probe acquires, and the retry's
   * re-check of the SAME reservation refuses to open a socket.
   */
  it("the review's exact race: provider fails and releases -> probe acquires -> the scheduled retry does NOT open a socket", async () => {
    const reservation = createEnetAdapterReservation();
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet', enetAutoDiscover: false });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      enetAdapterReservation: reservation,
    });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(1);
    expect(states.at(-1)).toBe('failed');
    // Provider released the reservation as soon as it reached 'failed'.
    expect(reservation.holder()).toBeNull();

    // The probe now acquires it -- standing in for the user pressing Send
    // on the dev screen while the provider sits in 'failed'.
    const probeToken = reservation.tryAcquire('probe');
    expect(probeToken).not.toBeNull();

    // The scheduled retry fires 3s later.
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    // The provider did NOT open a second socket -- connectCalls unchanged --
    // and stays 'idle' with the reservation-blocked diagnostics note.
    expect(tracker.connectCalls).toBe(1);
    expect(provider.getDiagnostics().state).toBe('idle');
    expect(provider.getDiagnostics().lastError).toBe('adapter reserved by probe');

    // No further attempt either, even given more time (the one retry budget
    // is spent; nothing re-triggers launchSession() again on its own).
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(tracker.connectCalls).toBe(1);

    reservation.release(probeToken!);
    await provider.stop();
  });

  it('the provider does not open a socket at all when the probe already holds the reservation at start()', async () => {
    const reservation = createEnetAdapterReservation();
    const probeToken = reservation.tryAcquire('probe');
    expect(probeToken).not.toBeNull();

    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet', enetAutoDiscover: false });
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      enetAdapterReservation: reservation,
    });

    provider.start();
    await flushMicrotasks();

    expect(tracker.connectCalls).toBe(0);
    expect(provider.getDiagnostics().state).toBe('idle');
    expect(provider.getDiagnostics().lastError).toBe('adapter reserved by probe');

    reservation.release(probeToken!);
    await provider.stop();
  });

  it('"probe refused while provider polling": tryAcquire(\'probe\') fails while the provider holds the reservation', async () => {
    const reservation = createEnetAdapterReservation();
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true, adapterType: 'enet', enetHost: '192.168.4.20' });
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      enetAdapterReservation: reservation,
    });

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(provider.getDiagnostics().state).toBe('polling');
    expect(reservation.holder()).toBe('provider');

    expect(reservation.tryAcquire('probe')).toBeNull();

    await provider.stop();
  });

  it('release on stop(): a polling ENET session releases the reservation when stop() is called', async () => {
    const reservation = createEnetAdapterReservation();
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true, adapterType: 'enet', enetHost: '192.168.4.20' });
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      enetAdapterReservation: reservation,
    });

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(reservation.holder()).toBe('provider');

    await provider.stop();
    expect(reservation.holder()).toBeNull();
  });

  it('release on failed: a provider that reaches "failed" WITHOUT ever calling stop() still releases the reservation', async () => {
    const reservation = createEnetAdapterReservation();
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet', enetAutoDiscover: false });
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      enetAdapterReservation: reservation,
    });

    provider.start();
    await flushMicrotasks();
    expect(provider.getDiagnostics().state).toBe('failed');
    expect(reservation.holder()).toBeNull();

    await provider.stop();
  });

  it('the ELM327 path never touches the reservation at all (harmless: nothing acquires it, nothing releases another owner\'s hold)', async () => {
    const reservation = createEnetAdapterReservation();
    reservation.tryAcquire('probe'); // pre-held by the probe.

    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true }); // adapterType defaults to 'elm327'.
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      enetAdapterReservation: reservation,
    });

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    // The ELM327 path reaches 'polling' via its own SimulatedElm327Transport,
    // completely independent of the reservation -- the probe's hold is
    // untouched throughout.
    expect(provider.getDiagnostics().state).toBe('polling');
    expect(reservation.holder()).toBe('probe');

    await provider.stop();
    expect(reservation.holder()).toBe('probe'); // still untouched after stop().
  });
});

/** A minimal hand-built `EnetSession` double whose `stop()` this test controls directly (the real `EnetSessionEngine` essentially never rejects its own `stop()`, since it catches transport-close failures internally) -- lets a test prove the reservation is released even when the underlying session's `stop()` rejects. */
function makeControllableEnetSession(config: { stopResult: () => Promise<void> }): EnetSession {
  const stateListeners = new Set<(state: EnetState, detail?: string) => void>();
  return {
    start(): void {
      queueMicrotask(() => {
        for (const listener of [...stateListeners]) listener('polling');
      });
    },
    stop(): Promise<void> {
      return config.stopResult();
    },
    onSample(): () => void {
      return () => undefined;
    },
    onStateChange(cb: (state: EnetState, detail?: string) => void): () => void {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    getDiagnostics() {
      return {
        observedHzByChannel: {},
        errorCount: 0,
        supportedChannels: [],
        unsupportedChannels: [],
        lastNrcByChannel: {},
        framesTx: 0,
        framesRx: 0,
        aliveChecksAnswered: 0,
        unmatchedResponses: 0,
        malformedResponses: 0,
        decodeErrors: 0,
        degradedChannels: [],
        channelWarnings: [],
        effectiveHzByChannel: {},
      };
    },
  };
}

/**
 * P4e-FIX4 fix (binding, Codex P4e-REV4 HIGH finding -- "provider exception
 * paths leak the claim"): a synchronous construction/start() throw, or a
 * rejecting `session.stop()`, or a retry's own construction throw, must
 * ALWAYS release whatever token this attempt held -- otherwise the
 * reservation is stuck forever and every future probe/provider attempt is
 * refused with no live generation left to ever release it.
 */
describe('telemetryProvider: ENET exception paths release the reservation (P4e-FIX4, binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.connectCalls = 0;
    tracker.holdConnect = false;
    vi.mocked(createEnetSession).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a synchronous construction throw (createEnetSession) releases the reservation and reports "failed", without throwing OUT of start()', async () => {
    const reservation = createEnetAdapterReservation();
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true, adapterType: 'enet', enetHost: '192.168.4.20' });
    vi.mocked(createEnetSession).mockImplementationOnce(() => {
      throw new Error('boom: synchronous ENET construction failure (test double)');
    });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      enetAdapterReservation: reservation,
    });
    const states: string[] = [];
    const details: Array<string | undefined> = [];
    provider.onStateChange((s, d) => {
      states.push(s);
      details.push(d);
    });

    expect(() => provider.start()).not.toThrow();
    await flushMicrotasks();

    expect(reservation.holder()).toBeNull();
    expect(states.at(-1)).toBe('failed');
    expect(details.at(-1)).toContain('boom: synchronous ENET construction failure');
    expect(provider.getDiagnostics().state).toBe('failed');

    // Not wedged: a fresh start() (now reaching the real, non-throwing
    // implementation) proceeds normally instead of being swallowed by a
    // stale `if (running) return;` guard, and successfully re-acquires.
    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    expect(provider.getDiagnostics().state).toBe('polling');
    expect(reservation.holder()).toBe('provider');

    await provider.stop();
  });

  it('gen.session.stop() rejecting still releases the reservation (finally) -- provider.stop() itself still propagates the rejection', async () => {
    const reservation = createEnetAdapterReservation();
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true, adapterType: 'enet', enetHost: '192.168.4.20' });
    const stopError = new Error('stop failed (test double)');
    vi.mocked(createEnetSession).mockImplementationOnce(() =>
      makeControllableEnetSession({ stopResult: () => Promise.reject(stopError) }),
    );

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      enetAdapterReservation: reservation,
    });

    provider.start();
    await flushMicrotasks();
    expect(reservation.holder()).toBe('provider');

    await expect(provider.stop()).rejects.toThrow('stop failed');
    expect(reservation.holder()).toBeNull();
  });

  it('a retry launch that throws (createEnetSession fails on the retry\'s own attempt) releases the reservation and reports "failed"', async () => {
    const reservation = createEnetAdapterReservation();
    const store = new InMemorySettingsStore();
    // telemetrySimulate:false -> the mocked (always-failing-to-connect)
    // EnetTcpTransport from the top of this file, so the FIRST attempt
    // reaches 'failed' and schedules the one retry on its own.
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet', enetAutoDiscover: false });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      enetAdapterReservation: reservation,
    });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    expect(states.at(-1)).toBe('failed');
    expect(reservation.holder()).toBeNull(); // released on 'failed', BEFORE the retry even fires.

    // The scheduled retry's OWN createEnetSession call throws synchronously.
    vi.mocked(createEnetSession).mockImplementationOnce(() => {
      throw new Error('boom: retry construction failure (test double)');
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();

    expect(reservation.holder()).toBeNull();
    expect(states.at(-1)).toBe('failed');
    expect(provider.getDiagnostics().state).toBe('failed');

    await provider.stop();
  });
});
