import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySample } from '@circuit/core';
import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { createEnetAdapterReservation } from '../../src/session/enetAdapterReservation';
import type { VehicleProfileBinding } from '../../src/persistence/didSweepStore';

/**
 * Ticket P4l-FIX1 F1 (binding, the P4l worker's own concern 1): the provider
 * RESOLVED a field-confirmed brake binding but could not emit anything from
 * it, because `brakeSwitch`/`brakePct` were not `TelemetryChannelId` members
 * and therefore could never become a poll entry or a `TelemetrySample`.
 *
 * End-to-end proof, over a real HSFZ wire (the multi-ECU transport double the
 * Signal Finder suite already uses -- it answers as whichever ECU the request
 * was addressed to): a confirmed `brakeSwitch` binding at ECU 0x29 / DID
 * 0x500C, whose byte flips 0x04 -> 0x05 when the pedal goes down, reaches the
 * provider's sample stream as brakeSwitch 0 -> 100.
 *
 * `enetChannelSpecsJson: '[]'` (a deliberate, respected "zero configured
 * channels" -- see `resolveEnetChannelSpecs`) is used so the ONLY poll entry
 * in the plan is the one the BINDING produced: nothing else can be the source
 * of the samples asserted below.
 */

const state = vi.hoisted(() => ({
  instances: [] as Array<{ requests: Array<{ ecu: number; did: number; tMs: number }> }>,
  /** What the 0x29/0x500C DID answers (1 byte) and what the 0x29/0x500B DID answers (2 bytes). */
  brakeByte: 0x04,
  brakeWord: 0x0002,
  /** Ticket P4n N1: the 0x12/0x58B7 brake PRESSURE DID (u8, 0..64), a DIFFERENT ECU from the 0x29 switch. */
  pressureByte: 0x00,
}));

vi.mock('../../src/session/enetTcpTransport', async () => {
  const { MultiEcuFakeTransport } = await import('../support/signalFinderHarness');
  return {
    EnetTcpTransport: class extends MultiEcuFakeTransport {
      constructor() {
        super({
          answer: (ecu: number, did: number) => {
            if (ecu === 0x29) {
              if (did === 0x500c) return Uint8Array.from([state.brakeByte]);
              if (did === 0x500b) return Uint8Array.from([(state.brakeWord >> 8) & 0xff, state.brakeWord & 0xff]);
              return 'nrc';
            }
            if (ecu === 0x12 && did === 0x58b7) return Uint8Array.from([state.pressureByte]);
            return 'nrc';
          },
        });
        state.instances.push(this);
      }
    },
  };
});

import { createTelemetryProvider } from '../../src/session/telemetryProvider';

const BRAKE_BINDING: VehicleProfileBinding = {
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

/** Ticket P4n N1 (field test 7, 2026-08-30): the user's OWN confirmed brakePressure binding, on the DME (0x12) -- a DIFFERENT ECU from the 0x29 switch above. */
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

describe('P4l-FIX1 F1: a confirmed brake binding becomes a real ENET poll entry and emits samples', () => {
  beforeEach(() => {
    state.instances.length = 0;
    state.brakeByte = 0x04;
    state.brakeWord = 0x0002;
    state.pressureByte = 0x00;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('polls 0x29/0x500C and emits brakeSwitch 0 then 100 as the byte flips 04 -> 05', async () => {
    const store = enetStore();
    const samples: TelemetrySample[] = [];
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: () => Date.now(),
      isDev: true,
      enetAdapterReservation: createEnetAdapterReservation(),
      readVehicleProfileBindings: () => [BRAKE_BINDING],
    });
    provider.onSample((sample) => samples.push(sample));
    provider.start();

    await waitFor(() => samples.some((sample) => sample.channel === 'brakeSwitch'));
    expect(samples.every((sample) => sample.channel === 'brakeSwitch')).toBe(true);
    expect(samples[0]?.value).toBe(0);

    state.brakeByte = 0x05;
    await waitFor(() => samples.some((sample) => sample.channel === 'brakeSwitch' && sample.value === 100));

    const values = samples.filter((sample) => sample.channel === 'brakeSwitch').map((sample) => sample.value);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(100);
    expect(new Set(values)).toEqual(new Set([0, 100]));

    // The request really went to the BRAKE ECU, not the DME target address in settings.
    const requests = state.instances[0]?.requests ?? [];
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.ecu === 0x29 && request.did === 0x500c)).toBe(true);
    expect(store.getSettings().enetTargetAddress).toBe(0x12);

    // The channel is reported as a supported ENET channel, like any other.
    expect(provider.getDiagnostics().supportedChannels).toContain('brakeSwitch');

    await provider.stop();
  }, 15_000);

  /**
   * Ticket P4l-FIX1 H4 (binding, Codex review finding): the SAME end-to-end
   * path over the 2-byte 0x29/0x500B series from field test 4. Before the
   * fix the decoder read byte 0 only, so 0x0002 -> 0x0006 was invisible: the
   * channel would have polled happily and emitted a flat 0 forever.
   */
  it('polls 0x29/0x500B (2-byte) and emits brakeSwitch 0 then 100 as the word flips 0002 -> 0006', async () => {
    const store = enetStore();
    const samples: TelemetrySample[] = [];
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: () => Date.now(),
      isDev: true,
      enetAdapterReservation: createEnetAdapterReservation(),
      readVehicleProfileBindings: () => [
        {
          ...BRAKE_BINDING,
          did: 0x500b,
          length: 2,
          evidenceJson: JSON.stringify({ restValueHex: '0002', min: 2, max: 6, byteOffset: null }),
        },
      ],
    });
    provider.onSample((sample) => samples.push(sample));
    provider.start();

    await waitFor(() => samples.length > 0);
    expect(samples[0]?.channel).toBe('brakeSwitch');
    expect(samples[0]?.value).toBe(0);

    state.brakeWord = 0x0006;
    await waitFor(() => samples.some((sample) => sample.value === 100));

    const requests = state.instances[0]?.requests ?? [];
    expect(requests.every((request) => request.ecu === 0x29 && request.did === 0x500b)).toBe(true);
    expect(provider.getDiagnostics().errorCount).toBe(0);

    await provider.stop();
  }, 15_000);

  /**
   * Ticket P4n N1 (binding, field test 7 2026-08-30): "the user confirmed
   * brakeSwitch = 0x29/0x500C and brakePressure = 0x12/0x58B7 ... the
   * Telemetry monitor shows brakeSwitch 100/0 but never the pressure" -- the
   * OLD single-binding resolution (preference pressure > switch) would have
   * dropped the switch entirely the moment pressure was ALSO confirmed. Both
   * are now their own poll entry, on their own ECU, over the SAME socket.
   */
  it('BOTH bindings present: polls both ECUs and emits both brakeSwitch AND brakePct samples', async () => {
    const store = enetStore();
    const samples: TelemetrySample[] = [];
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: () => Date.now(),
      isDev: true,
      enetAdapterReservation: createEnetAdapterReservation(),
      readVehicleProfileBindings: () => [BRAKE_BINDING, PRESSURE_BINDING],
    });
    provider.onSample((sample) => samples.push(sample));
    provider.start();

    await waitFor(() => samples.some((sample) => sample.channel === 'brakeSwitch'));
    await waitFor(() => samples.some((sample) => sample.channel === 'brakePct'));

    expect(samples.find((sample) => sample.channel === 'brakeSwitch')?.value).toBe(0);
    expect(samples.find((sample) => sample.channel === 'brakePct')?.value).toBe(0);

    state.brakeByte = 0x05; // switch pressed
    state.pressureByte = 32; // half of the observed 0..64 range
    await waitFor(() => samples.some((sample) => sample.channel === 'brakeSwitch' && sample.value === 100));
    await waitFor(() => samples.some((sample) => sample.channel === 'brakePct' && sample.value === 50));

    // Each request really went to ITS OWN ECU -- never the other's.
    const requests = state.instances[0]?.requests ?? [];
    expect(requests.some((r) => r.ecu === 0x29 && r.did === 0x500c)).toBe(true);
    expect(requests.some((r) => r.ecu === 0x12 && r.did === 0x58b7)).toBe(true);
    expect(store.getSettings().enetTargetAddress).toBe(0x12);

    const diag = provider.getDiagnostics();
    expect(diag.supportedChannels).toContain('brakeSwitch');
    expect(diag.supportedChannels).toContain('brakePct');

    await provider.stop();
  }, 15_000);

  it('emits nothing brake-shaped when the binding is only a hypothesis (never field-confirmed)', async () => {
    const store = enetStore();
    const samples: TelemetrySample[] = [];
    const provider = createTelemetryProvider({
      settingsStore: store,
      monotonicNow: () => Date.now(),
      isDev: true,
      enetAdapterReservation: createEnetAdapterReservation(),
      readVehicleProfileBindings: () => [{ ...BRAKE_BINDING, status: 'hypothesis' }],
    });
    provider.onSample((sample) => samples.push(sample));
    provider.start();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(samples).toEqual([]);
    expect(state.instances[0]?.requests ?? []).toEqual([]);

    await provider.stop();
  }, 15_000);
});
