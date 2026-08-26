import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySample } from '@circuit/core';
import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { createTelemetryProvider } from '../../src/session/telemetryProvider';

/**
 * ENET telemetry addendum (P4e-T2, binding): `telemetryProvider.ts` chooses
 * engine + transport by `adapterType`. This file is the ENET-side companion
 * to `telemetryProvider.test.ts` (the pre-existing ELM327 suite, which stays
 * untouched -- proving the ELM327 path is byte-identical). Same mocking
 * strategy: `EnetTcpTransport` is mocked (always-failing `connect()`) so the
 * "real adapter" path is exercised deterministically without ever loading
 * `react-native-tcp-socket`; the simulated-transport tests use the REAL
 * `SimulatedEnetTransport` from `@circuit/core`.
 */
const tracker = vi.hoisted(() => ({ connectCalls: 0 }));

vi.mock('../../src/session/enetTcpTransport', () => ({
  EnetTcpTransport: class {
    async connect(): Promise<void> {
      tracker.connectCalls += 1;
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
    store.update({ telemetryEnabled: true, telemetrySimulate: true, adapterType: 'enet' });

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

  it('a channel spec the simulated ECU has no script for is marked UNSUPPORTED (NRC 0x11), without the session going "failed"', async () => {
    const store = new InMemorySettingsStore();
    store.update({
      telemetryEnabled: true,
      telemetrySimulate: true,
      adapterType: 'enet',
      // P4e-FIX1 (core, binding): `validateEnetChannelSpecs` now enforces
      // obd01 channel<->PID consistency (a bogus obd01 `requestHex` like the
      // old 'AA' here is now REJECTED at validation, never reaching the wire
      // at all) -- a `did`-mode spec has no such "correct DID" table to check
      // against (no public B58/DSC DID table exists), so it's the legitimate
      // way to reach the wire with a request the simulator has no script for.
      // 'F1A0' matches no entry in `DEFAULT_ENET_SCENARIO` -- `SimulatedEnetTransport`
      // answers any unscripted request with NRC 0x11 (serviceNotSupported),
      // exactly the wire behavior a real ECU would produce for a PID/DID it
      // doesn't support (addendum: "NRC 0x11/0x12/0x31 marks a channel
      // UNSUPPORTED, removes it from the poll plan, recorded in diagnostics").
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
    expect(diagnostics.lastNrcByChannel?.coolantC).toBe(0x11);
    // A definitive UNSUPPORTED determination is graceful, not a failure --
    // the session must stay 'polling' (only the tester-present exchange
    // continues once every configured channel has been marked unsupported).
    expect(states).not.toContain('failed');
    expect(provider.getDiagnostics().state).toBe('polling');

    await provider.stop();
  });
});
