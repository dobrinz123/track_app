import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetrySample } from '@circuit/core';
import { InMemorySettingsStore } from '../../src/session/settingsStore';
import { createTelemetryProvider } from '../../src/session/telemetryProvider';

/**
 * P4h-FIX1 M1 (after Codex P4h-REV1 MEDIUM, `telemetryProvider.ts:910-922`):
 * "ENET fallback detection runs only from another telemetry sample callback.
 * With a valid ENET configuration containing only `accelPedalPct`, 0x5A
 * becomes unsupported and emits no pedal sample; no later callback occurs to
 * inspect `unsupportedChannels`, so 0x49 fallback never triggers. There is no
 * provider-level ENET fallback test."
 *
 * The simulated ECU here answers 0x5A with NRC 0x11 (unsupported) and 0x49
 * normally -- `ACCEL_PEDAL_FALLBACK_ENET_SCRIPT`, the scenario `@circuit/core`
 * ships for exactly this case. `SimulatedEnetTransport` is wrapped so the
 * PROVIDER's own `buildTransport()` (which passes no scenario) gets it.
 */
vi.mock('@circuit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@circuit/core')>();
  const scenario = [
    ...actual.DEFAULT_ENET_SCENARIO.filter((script) => script.requestHex !== '5A'),
    ...actual.ACCEL_PEDAL_FALLBACK_ENET_SCRIPT,
  ];
  class ScriptedSimulatedEnetTransport extends actual.SimulatedEnetTransport {
    constructor(config: ConstructorParameters<typeof actual.SimulatedEnetTransport>[0]) {
      super({ ...config, scenario });
    }
  }
  return { ...actual, SimulatedEnetTransport: ScriptedSimulatedEnetTransport };
});

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function monotonicCounter(): () => number {
  let t = 1_000;
  return () => {
    t += 1;
    return t;
  };
}

describe('telemetryProvider (ENET): accelPedalPct 0x5A unsupported -> 0x49 fallback (P4h-FIX1 M1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('falls back even when accelPedalPct is the ONLY configured channel (no other sample callback ever fires)', async () => {
    const store = new InMemorySettingsStore();
    store.update({
      telemetryEnabled: true,
      telemetrySimulate: true,
      adapterType: 'enet',
      enetHost: '192.168.4.20', // explicit host -> the direct-connect path, no auto-discovery.
      // The review's exact configuration: ONE channel, the pedal.
      enetChannelSpecsJson: JSON.stringify([
        { channel: 'accelPedalPct', mode: 'obd01', requestHex: '5A', provenance: 'primary source (Field revision 2)' },
      ]),
    });

    const provider = createTelemetryProvider({ settingsStore: store, monotonicNow: monotonicCounter(), isDev: true });
    const samples: TelemetrySample[] = [];
    const states: string[] = [];
    provider.onSample((s) => samples.push(s));
    provider.onStateChange((s) => states.push(s));

    provider.start();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(3_000); // the relaunched (0x49) generation reaches polling.
    await flushMicrotasks();

    // The fallback triggered from the unsupported-channel determination
    // itself -- the ONLY signal available here, since 0x5A was NRC'd and no
    // sample of any channel could ever reach the sample callback.
    expect(provider.getDiagnostics().pedalSource).not.toBe('5A');
    expect(provider.getDiagnostics().unsupportedChannels ?? []).not.toContain('accelPedalPct'); // the fresh 0x49 generation polls a channel the ECU answers.
    const pedalSamples = samples.filter((s) => s.channel === 'accelPedalPct');
    expect(pedalSamples.length).toBeGreaterThan(0);
    expect(pedalSamples.every((s) => Number.isFinite(s.value))).toBe(true);
    expect(states).not.toContain('failed');

    await provider.stop();
  });
});
