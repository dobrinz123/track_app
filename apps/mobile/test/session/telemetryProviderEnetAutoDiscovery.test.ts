import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBinaryString, encodeFrame, HSFZ_CONTROL } from '@circuit/core';
import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { createTelemetryProvider } from '../../src/session/telemetryProvider';
import { createEnetAdapterReservation } from '../../src/session/enetAdapterReservation';
import type { NetworkInfo } from '../../src/session/networkInfo';

/**
 * ENET auto-discovery addendum (contracts.md, binding, Phase 4f):
 * `telemetryProvider.ts`'s own auto-connect behavior -- "on start, if no host
 * configured or the first connect fails, run discovery ONCE (bounded), apply
 * a level-2 hit and connect; otherwise 'failed' with diagnostics `discovery:
 * scanned N, none answered`. Never loops."
 *
 * A DEDICATED mock `EnetTcpTransport` (separate from `telemetryProviderEnet.test.ts`'s
 * own always-failing one) that scripts connect()/send() behavior PER host:port
 * pair -- this file's whole point is exercising `runDiscovery` actually
 * finding (or not finding) a level-2 hit, which the always-failing mock
 * cannot represent. `getNetworkInfo` is injected via `TelemetryProviderDeps`
 * (never the real `expo-network` dynamic import -- see that seam's own doc
 * comment in `telemetryProvider.ts`) so every test here stays on pure
 * microtask timing, no real timers or real module I/O involved.
 */
const tracker = vi.hoisted(() => ({
  /** `${host}:${port}` -> scripted behavior. Absent entries refuse the connect. */
  script: new Map<string, 'level2' | 'level1' | 'refuse'>(),
  connectedHostPorts: [] as string[],
}));

function key(host: string, port: number): string {
  return `${host}:${port}`;
}

vi.mock('../../src/session/enetTcpTransport', () => ({
  EnetTcpTransport: class {
    private readonly host: string;
    private readonly port: number;
    private dataListener: ((chunk: string) => void) | null = null;
    constructor(config: { host: string; port: number }) {
      this.host = config.host;
      this.port = config.port;
    }
    async connect(): Promise<void> {
      const behavior = tracker.script.get(key(this.host, this.port)) ?? 'refuse';
      tracker.connectedHostPorts.push(key(this.host, this.port));
      if (behavior === 'refuse') {
        throw new Error(`ENET adapter unreachable at ${this.host}:${this.port} (test double)`);
      }
    }
    send(): void {
      const behavior = tracker.script.get(key(this.host, this.port)) ?? 'refuse';
      if (behavior !== 'level2' || this.dataListener === null) return;
      // A minimal valid HSFZ acknowledge frame -- level-2 only requires ANY
      // valid frame (contracts.md addendum), same convention as
      // `simulatedEnetTransport.ts`'s own `SimulatedDiscoveryProbeTransport`.
      const reply = encodeFrame({ control: HSFZ_CONTROL.ACKNOWLEDGE, source: 0, target: 0, payload: new Uint8Array(0) });
      queueMicrotask(() => this.dataListener?.(bytesToBinaryString(reply)));
    }
    onData(cb: (chunk: string) => void): () => void {
      this.dataListener = cb;
      return () => {
        this.dataListener = null;
      };
    }
    onClose(): () => void {
      return () => undefined;
    }
    async close(): Promise<void> {}
  },
}));

async function flushMicrotasks(times = 40): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function monotonicCounter(): () => number {
  let t = 1_000;
  return () => {
    t += 1;
    return t;
  };
}

/** No phone IPv4 -- keeps `buildDiscoveryCandidates` down to just the configured host (if any) + the fixed MHD default, never the full /24 sweep, so these tests stay fast and deterministic. */
const NO_PHONE_INFO = async (): Promise<NetworkInfo | null> => null;

describe('telemetryProvider: ENET auto-discovery -- no host configured (addendum, binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.script = new Map();
    tracker.connectedHostPorts = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs discovery immediately, applies the level-2 hit (host/port + provenance persisted), and connects', async () => {
    tracker.script.set('192.168.4.1:6801', 'level2');
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet' }); // enetHost stays '' (default), enetAutoDiscover stays true (default).

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      getNetworkInfo: NO_PHONE_INFO,
    });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();

    expect(states).toContain('connecting');
    expect(tracker.connectedHostPorts).toContain('192.168.4.1:6801');
    expect(store.getSettings().enetHost).toBe('192.168.4.1');
    expect(store.getSettings().enetPort).toBe(6801);
    expect(store.getSettings().enetHostProvenance).toMatch(/^discovered /);
    expect(provider.getDiagnostics().adapterType).toBe('enet');

    await provider.stop();
  });

  it('no level-2 hit anywhere -> "failed" with "discovery: scanned N, none answered", and never loops (no further attempt on more time)', async () => {
    // No entry in `tracker.script` at all -- every candidate refuses.
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet' });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      getNetworkInfo: NO_PHONE_INFO,
    });
    const states: string[] = [];
    const details: Array<string | undefined> = [];
    provider.onStateChange((s, d) => {
      states.push(s);
      details.push(d);
    });

    provider.start();
    await flushMicrotasks();

    expect(states.at(-1)).toBe('failed');
    expect(details.at(-1)).toMatch(/^discovery: scanned \d+, none answered$/);
    expect(store.getSettings().enetHost).toBe(''); // never applied -- no hit.
    expect(provider.getDiagnostics().lastError).toMatch(/^discovery: scanned \d+, none answered$/);

    // Never loops: advancing well past the reconnect delay triggers nothing further.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(states.at(-1)).toBe('failed');

    await provider.stop();
  });

  it('a level-1-only hit (connects, but no valid HSFZ frame) does NOT get auto-applied -- still "none answered"', async () => {
    tracker.script.set('192.168.4.1:6801', 'level1');
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet' });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      getNetworkInfo: NO_PHONE_INFO,
    });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await vi.advanceTimersByTimeAsync(1_000); // level-1's own replyTimeoutMs (500ms default) must elapse with no reply.
    await flushMicrotasks();

    expect(states.at(-1)).toBe('failed');
    expect(store.getSettings().enetHost).toBe('');

    await provider.stop();
  });

  it('enetAutoDiscover:false skips discovery entirely -- dials the (empty) host directly and just fails, no discovery probe ever opened', async () => {
    tracker.script.set('192.168.4.1:6801', 'level2'); // would be found if discovery ran -- it must not.
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet', enetAutoDiscover: false });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      getNetworkInfo: NO_PHONE_INFO,
    });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();

    expect(tracker.connectedHostPorts).toEqual([':6801']); // dialed the empty configured host directly, not the MHD candidate.
    expect(states.at(-1)).toBe('failed');
    expect(store.getSettings().enetHost).toBe('');

    await provider.stop();
  });

  it("wires the phone's own subnet into the candidate list (buildDiscoveryCandidates' phone-.1/. /24 sweep, via getNetworkInfo) -- a hit there is found and applied even though the MHD default refuses", async () => {
    tracker.script.set('10.0.0.1:6801', 'level2'); // the phone subnet's own gateway/.1 candidate.
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet' });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      getNetworkInfo: async () => ({ ipv4: '10.0.0.7' }), // puts the phone's /24 subnet into play (no explicit mask -> /24 assumed).
    });

    provider.start();
    await flushMicrotasks(400); // the full /24 sweep (~254 candidates) needs many more microtask rounds than the single-candidate tests above.

    expect(store.getSettings().enetHost).toBe('10.0.0.1');
    expect(store.getSettings().enetPort).toBe(6801);

    await provider.stop();
  }, 20_000);

  it('reservation refused: the provider never even attempts discovery when the probe/sweep already holds the adapter reservation at start()', async () => {
    tracker.script.set('192.168.4.1:6801', 'level2'); // would be found if discovery ran -- it must not, since the reservation is refused before any probing.
    const reservation = createEnetAdapterReservation();
    const probeToken = reservation.tryAcquire('probe');
    expect(probeToken).not.toBeNull();

    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet' }); // enetAutoDiscover stays true (default) -- proves the reservation check still comes first.

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      getNetworkInfo: NO_PHONE_INFO,
      enetAdapterReservation: reservation,
    });

    provider.start();
    await flushMicrotasks();

    expect(tracker.connectedHostPorts).toEqual([]); // no discovery probe ever opened.
    expect(provider.getDiagnostics().state).toBe('idle');
    expect(provider.getDiagnostics().lastError).toBe('adapter reserved by probe');
    expect(store.getSettings().enetHost).toBe('');

    reservation.release(probeToken!);
    await provider.stop();
  });

  it('telemetrySimulate:true skips discovery entirely (nothing to discover for the simulated transport) -- reaches polling via SimulatedEnetTransport as before', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: true, adapterType: 'enet' });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      getNetworkInfo: NO_PHONE_INFO,
    });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();

    expect(states).toContain('polling');
    expect(tracker.connectedHostPorts).toEqual([]); // the mocked real EnetTcpTransport was never touched at all.

    await provider.stop();
  });
});

describe('telemetryProvider: ENET auto-discovery -- configured host, first connect fails (addendum, binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.script = new Map();
    tracker.connectedHostPorts = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the configured host is dialed FIRST; only on ITS failure does discovery run, finds a level-2 hit elsewhere (the MHD default), applies and connects', async () => {
    // The discoverable adapter is the fixed MHD default host, NOT the
    // configured one -- proves the applied host really came from discovery,
    // not from the (failing) configured value.
    tracker.script.set('192.168.4.1:6801', 'level2');
    const store = new InMemorySettingsStore();
    store.update({
      telemetryEnabled: true,
      telemetrySimulate: false,
      adapterType: 'enet',
      enetHost: '10.0.0.5', // configured, but nothing answers there.
    });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      getNetworkInfo: NO_PHONE_INFO,
    });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();

    // First attempt dialed the CONFIGURED host directly (no discovery yet).
    expect(tracker.connectedHostPorts[0]).toBe('10.0.0.5:6801');
    expect(store.getSettings().enetHost).toBe('192.168.4.1');
    expect(store.getSettings().enetPort).toBe(6801);
    expect(store.getSettings().enetHostProvenance).toMatch(/^discovered /);
    expect(states).toContain('failed'); // the configured host's own failure, en route to the discovery detour.
    expect(states.at(-1)).not.toBe('failed'); // the discovery detour's own connect succeeded afterward.

    await provider.stop();
  });

  it('configured host fails, discovery finds nothing -> "failed" with the discovery detail, and stays failed (never loops, no further retry)', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet', enetHost: '10.0.0.5' });

    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: monotonicCounter(),
      isDev: true,
      getNetworkInfo: NO_PHONE_INFO,
    });
    const states: string[] = [];
    const details: Array<string | undefined> = [];
    provider.onStateChange((s, d) => {
      states.push(s);
      details.push(d);
    });

    provider.start();
    await flushMicrotasks();

    expect(states.at(-1)).toBe('failed');
    expect(details.at(-1)).toMatch(/^discovery: scanned \d+, none answered$/);
    expect(store.getSettings().enetHost).toBe('10.0.0.5'); // untouched -- no hit to apply.

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(states.at(-1)).toBe('failed'); // never loops.

    await provider.stop();
  });

  it('enetAutoDiscover:false keeps the pre-addendum plain single-retry policy exactly (one retry after 3s, then stays failed)', async () => {
    const store = new InMemorySettingsStore();
    store.update({
      telemetryEnabled: true,
      telemetrySimulate: false,
      adapterType: 'enet',
      enetHost: '10.0.0.5',
      enetAutoDiscover: false,
    });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true, getNetworkInfo: NO_PHONE_INFO });
    const states: string[] = [];
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    expect(tracker.connectedHostPorts).toEqual(['10.0.0.5:6801']);
    expect(states.at(-1)).toBe('failed');

    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();
    expect(tracker.connectedHostPorts).toEqual(['10.0.0.5:6801', '10.0.0.5:6801']); // the plain reconnect retry, same host -- no discovery involved.
    expect(states.at(-1)).toBe('failed');

    await provider.stop();
  });
});

describe('telemetryProvider: ENET auto-discovery -- "runs discovery ONCE per start" bound (addendum, binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.script = new Map();
    tracker.connectedHostPorts = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a fresh start()..stop()..start() cycle gets its OWN new discovery attempt (the once-per-start bound resets on stop()+start(), not merely elapsed time)', async () => {
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false, adapterType: 'enet' });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true, getNetworkInfo: NO_PHONE_INFO });

    provider.start();
    await flushMicrotasks();
    expect(provider.getDiagnostics().state).toBe('failed'); // no hit scripted yet.
    await provider.stop();

    tracker.connectedHostPorts = [];
    tracker.script.set('192.168.4.1:6801', 'level2'); // now discoverable.
    provider.start();
    await flushMicrotasks();

    expect(store.getSettings().enetHost).toBe('192.168.4.1'); // this SECOND start()'s own fresh discovery attempt found it.

    await provider.stop();
  });
});

describe('telemetryProvider: adapterType "elm327" never runs ENET discovery (offline mandate, binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    tracker.script = new Map();
    tracker.connectedHostPorts = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the mocked EnetTcpTransport (which discovery would use) is never touched when adapterType is "elm327"', async () => {
    tracker.script.set('192.168.4.1:6801', 'level2');
    const store = new InMemorySettingsStore();
    store.update({ telemetryEnabled: true, telemetrySimulate: false }); // adapterType defaults to 'elm327'.

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true, getNetworkInfo: NO_PHONE_INFO });
    provider.start();
    await flushMicrotasks();

    expect(tracker.connectedHostPorts).toEqual([]);
    expect(provider.getDiagnostics().adapterType).toBe('elm327');

    await provider.stop();
  });
});
