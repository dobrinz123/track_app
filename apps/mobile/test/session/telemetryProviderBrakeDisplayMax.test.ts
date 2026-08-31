import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { createEnetAdapterReservation } from '../../src/session/enetAdapterReservation';
import type { VehicleProfileBinding } from '../../src/persistence/didSweepStore';

/**
 * Ticket P4p G4 (binding, field test 9): the monitor's `brakePct` row shows
 * "raw N / M", where M was the binding's STORED `observedMax`. A weak stored
 * max (the generic profile's 0x4002 evidence maxed at 155, the Supra's 0x58B7
 * evidence at 64) pins the percentage at 100 % the moment the car answers
 * anything above it, and the small line then reads "raw 131 / 64" -- a
 * comparison against a number the session has already disproved.
 *
 * The DISPLAY max now follows the session: it starts at the binding's own
 * observed max and rises whenever a live raw value exceeds it. The BINDING is
 * never rewritten -- this is a display rule, not a re-confirmation.
 */

const state = vi.hoisted(() => ({
  instances: [] as Array<{ requests: Array<{ ecu: number; did: number; tMs: number }> }>,
  pressureByte: 0x00,
}));

vi.mock('../../src/session/enetTcpTransport', async () => {
  const { MultiEcuFakeTransport } = await import('../support/signalFinderHarness');
  return {
    EnetTcpTransport: class extends MultiEcuFakeTransport {
      constructor() {
        super({
          answer: (ecu: number, did: number) =>
            ecu === 0x12 && did === 0x58b7 ? Uint8Array.from([state.pressureByte]) : 'nrc',
        });
        state.instances.push(this);
      }
    },
  };
});

import { createTelemetryProvider, nextBrakePctDisplayMax, formatBrakePctRawDisplay } from '../../src/session/telemetryProvider';

const PRESSURE_BINDING: VehicleProfileBinding = {
  profileId: 'toyota-supra-b58',
  channel: 'brakePressure',
  ecu: 0x12,
  did: 0x58b7,
  length: 1,
  decode: 'u8 hPa (as listed; coarse -- verify)',
  status: 'field-confirmed',
  evidenceJson: JSON.stringify({ restValueHex: '00', min: 0, max: 64, byteOffset: null }),
  updatedAtUtc: '2026-08-31T11:39:06.993Z',
};

function enetStore(): InMemorySettingsStore {
  const store = new InMemorySettingsStore();
  store.update({
    telemetryEnabled: true,
    telemetrySimulate: false,
    adapterType: 'enet',
    enetHost: '192.168.4.1',
    enetAutoDiscover: false,
    enetChannelSpecsJson: '[]',
  });
  return store;
}

async function waitFor(predicate: () => boolean, budgetMs = 4_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the expected condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('P4p G4 -- nextBrakePctDisplayMax (pure)', () => {
  it('starts at the binding s own observed max', () => {
    expect(nextBrakePctDisplayMax(null, 64, 12)).toBe(64);
  });

  it('rises to the session max as soon as a live value exceeds the stored one', () => {
    expect(nextBrakePctDisplayMax(64, 64, 131)).toBe(131);
    expect(nextBrakePctDisplayMax(131, 64, 155)).toBe(155);
  });

  it('never falls back down again within the session', () => {
    expect(nextBrakePctDisplayMax(155, 64, 20)).toBe(155);
  });

  it('stays null for a binding that carries no observed max at all (the row shows a bare "raw N")', () => {
    expect(nextBrakePctDisplayMax(null, null, 131)).toBeNull();
    expect(formatBrakePctRawDisplay({ raw: 131, observedMax: nextBrakePctDisplayMax(null, null, 131) })).toBe('raw 131');
  });
});

describe('P4p G4 -- the live monitor line follows the session max', () => {
  beforeEach(() => {
    state.instances.length = 0;
    state.pressureByte = 0x00;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a raw value above the stored max moves the displayed "/ M" instead of pinning the row at 100 %', async () => {
    const provider = createTelemetryProvider({
      settingsStore: enetStore(),
      monotonicNow: () => Date.now(),
      isDev: true,
      enetAdapterReservation: createEnetAdapterReservation(),
      readVehicleProfileBindings: () => [PRESSURE_BINDING],
    });
    provider.start();

    await waitFor(() => provider.getDiagnostics().brakePctRaw !== undefined);
    expect(provider.getDiagnostics().brakePctRaw).toMatchObject({ raw: 0, observedMax: 64 });

    state.pressureByte = 131;
    await waitFor(() => (provider.getDiagnostics().brakePctRaw?.raw ?? 0) === 131);
    expect(provider.getDiagnostics().brakePctRaw).toMatchObject({ raw: 131, observedMax: 131 });
    expect(formatBrakePctRawDisplay(provider.getDiagnostics().brakePctRaw)).toBe('raw 131 / 131');

    state.pressureByte = 20;
    await waitFor(() => (provider.getDiagnostics().brakePctRaw?.raw ?? 0) === 20);
    expect(provider.getDiagnostics().brakePctRaw).toMatchObject({ raw: 20, observedMax: 131 });

    await provider.stop();
  }, 20_000);
});
