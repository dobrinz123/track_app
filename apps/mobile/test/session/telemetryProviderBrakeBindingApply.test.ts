import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySample } from '@circuit/core';
import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { createEnetAdapterReservation } from '../../src/session/enetAdapterReservation';
import type { VehicleProfileBinding } from '../../src/persistence/didSweepStore';

/**
 * Ticket P4n N3 (binding, field test 7 2026-08-30): "when the Signal Finder
 * confirms a binding while a telemetry session is running, the provider must
 * pick it up: either restart the ENET poll plan in place ... or ... show a
 * one-line hint". `@circuit/core`'s `EnetConfig` is fixed at
 * `createEnetSession()` construction (no live-rebuild hook), so the provider
 * takes the hint path: `getDiagnostics().brakeBindingsChangedSincePoll`
 * flips true the moment the profile registry's bindings differ from what
 * THIS session's poll plan was actually built from -- exactly what happens
 * when `composition.ts`'s `refreshVehicleProfileBindingsCache()` (which
 * `SignalFinderScreen.tsx`'s `handleConfirm` calls) runs mid-session.
 */

const state = vi.hoisted(() => ({ instances: [] as unknown[] }));

vi.mock('../../src/session/enetTcpTransport', async () => {
  const { MultiEcuFakeTransport } = await import('../support/signalFinderHarness');
  return {
    EnetTcpTransport: class extends MultiEcuFakeTransport {
      constructor() {
        super({
          answer: (ecu: number, did: number) => {
            if (ecu === 0x29 && did === 0x500c) return Uint8Array.from([0x04]);
            return 'nrc';
          },
        });
        state.instances.push(this);
      }
    },
  };
});

import { createTelemetryProvider } from '../../src/session/telemetryProvider';

const SWITCH_BINDING: VehicleProfileBinding = {
  profileId: 'toyota-supra-b58',
  channel: 'brakeSwitch',
  ecu: 0x29,
  did: 0x500c,
  length: 1,
  decode: 'bit0 (0x04 released -> 0x05 pressed)',
  status: 'field-confirmed',
  evidenceJson: JSON.stringify({ restValueHex: '04', min: 4, max: 5, byteOffset: 0 }),
  updatedAtUtc: '2026-08-29T18:12:00.000Z',
};

const PRESSURE_BINDING: VehicleProfileBinding = {
  profileId: 'toyota-supra-b58',
  channel: 'brakePressure',
  ecu: 0x12,
  did: 0x58b7,
  length: 1,
  decode: 'u8, 0 at rest, up to 64 with a firm press',
  status: 'field-confirmed',
  evidenceJson: JSON.stringify({ restValueHex: '00', min: 0, max: 64, byteOffset: null }),
  updatedAtUtc: '2026-08-30T13:10:00.000Z',
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

describe('P4n N3: a binding confirmed mid-session sets the "restart to apply" hint', () => {
  beforeEach(() => {
    state.instances.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('brakeBindingsChangedSincePoll is false while nothing changed, true once a NEW binding is confirmed mid-session', async () => {
    const store = enetStore();
    // Mutable, like `composition.ts`'s own `vehicleProfileBindingsCache` --
    // starts with just the switch (what THIS session's poll plan is built
    // from), later gains the pressure binding (simulating a confirm +
    // `refreshVehicleProfileBindingsCache()` while still running).
    let bindings: VehicleProfileBinding[] = [SWITCH_BINDING];
    const samples: TelemetrySample[] = [];
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: () => Date.now(),
      isDev: true,
      enetAdapterReservation: createEnetAdapterReservation(),
      readVehicleProfileBindings: () => bindings,
    });
    provider.onSample((sample) => samples.push(sample));
    provider.start();

    await waitFor(() => samples.some((sample) => sample.channel === 'brakeSwitch'));
    expect(provider.getDiagnostics().brakeBindingsChangedSincePoll).toBe(false);

    // The confirm + cache refresh -- the registry now carries BOTH bindings,
    // but this ALREADY-RUNNING session's poll plan was built before it.
    bindings = [SWITCH_BINDING, PRESSURE_BINDING];
    expect(provider.getDiagnostics().brakeBindingsChangedSincePoll).toBe(true);
    // The poll plan itself did not change -- no brakePct sample ever arrives
    // on THIS generation, confirming the hint is standing in for a real
    // live rebuild, not papering over one that already happened.
    expect(samples.some((sample) => sample.channel === 'brakePct')).toBe(false);

    await provider.stop();
  }, 15_000);
});
