import { describe, expect, it, vi } from 'vitest';

import type { TelemetrySample } from '../../../src/telemetry/contracts';
import {
  ACCEL_PEDAL_FALLBACK_ENET_SPEC,
  DEFAULT_ENET_CHANNEL_SPECS,
} from '../../../src/telemetry/enet/enetChannelSpecs';
import { createEnetSession, type EnetConfig } from '../../../src/telemetry/enet/enetSession';
import {
  ACCEL_PEDAL_FALLBACK_ENET_SCRIPT,
  ACCEL_PEDAL_NRC_UNSUPPORTED,
  DEFAULT_ENET_SCENARIO,
  SimulatedEnetTransport,
} from '../../../src/telemetry/enet/simulatedEnetTransport';
import { FakeClock } from '../../controller/testSupport';

function config(overrides: Partial<EnetConfig> = {}): EnetConfig {
  return {
    channelSpecs: DEFAULT_ENET_CHANNEL_SPECS,
    pollPlan: [{ channel: 'accelPedalPct', hz: 5 }],
    testerAddress: 0xf1,
    targetAddress: 0x12,
    testerPresentIntervalMs: 2_000,
    commandTimeoutMs: 200,
    maxConsecutiveErrors: 5,
    attemptObd01: true,
    ...overrides,
  };
}

async function startUntil(session: ReturnType<typeof createEnetSession>, target: string): Promise<void> {
  const reached = new Promise<void>((resolve) => {
    const unsubscribe = session.onStateChange((state) => {
      if (state !== target) return;
      unsubscribe();
      resolve();
    });
  });
  session.start();
  await reached;
}

/**
 * Field revision 2 (2026-08-27, binding — Phase 4h, P4h ticket item 3):
 * "primary source PID 0x5A ... if the DME answers NRC/unsupported for 0x5A,
 * fall back to 0x49." `ACCEL_PEDAL_FALLBACK_ENET_SCRIPT` scripts exactly
 * that -- this proves the CORE-level mechanism the mobile provider's
 * fallback relies on: an NRC'd 0x5A marks `accelPedalPct` unsupported
 * (never an error), and swapping in `ACCEL_PEDAL_FALLBACK_ENET_SPEC` (0x49)
 * for a FRESH session then answers normally.
 */
describe('ENET accelPedalPct PID fallback (Field revision 2, binding, P4h)', () => {
  it('0x5A NRC\'d -- accelPedalPct is marked unsupported (never an error), no sample ever arrives', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({
      monotonicNow: () => clock.now(),
      scenario: ACCEL_PEDAL_FALLBACK_ENET_SCRIPT,
      seed: 11,
    });
    const session = createEnetSession(transport, config(), () => clock.now());
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    for (let index = 0; index < 20; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    const diagnostics = session.getDiagnostics();
    expect(diagnostics.unsupportedChannels).toEqual(['accelPedalPct']);
    expect(diagnostics.lastNrcByChannel.accelPedalPct).toBe(ACCEL_PEDAL_NRC_UNSUPPORTED);
    expect(diagnostics.errorCount).toBe(0); // an NRC'd/unsupported channel is a graceful outcome, never an error.
    expect(samples).toHaveLength(0);
  });

  it('a FRESH session built with ACCEL_PEDAL_FALLBACK_ENET_SPEC (0x49) instead answers normally, against the SAME scripted transport', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({
      monotonicNow: () => clock.now(),
      scenario: ACCEL_PEDAL_FALLBACK_ENET_SCRIPT,
      seed: 11,
    });
    const fallbackChannelSpecs = [
      ...DEFAULT_ENET_CHANNEL_SPECS.filter((spec) => spec.channel !== 'accelPedalPct'),
      ACCEL_PEDAL_FALLBACK_ENET_SPEC,
    ];
    const session = createEnetSession(transport, config({ channelSpecs: fallbackChannelSpecs }), () => clock.now());
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    for (let index = 0; index < 20; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    const diagnostics = session.getDiagnostics();
    expect(diagnostics.unsupportedChannels).toEqual([]);
    expect(diagnostics.errorCount).toBe(0);
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((sample) => sample.channel === 'accelPedalPct' && Number.isFinite(sample.value))).toBe(true);
    // 0x49's own ~15% rest-offset scenario floor (ACCEL_PEDAL_FALLBACK_ENET_SCRIPT) --
    // the RAW (un-normalized) decoded value stays within its own scripted band.
    expect(samples.every((sample) => sample.value >= 14 && sample.value <= 56)).toBe(true);
  });

  it('DEFAULT_ENET_SCENARIO answers the PRIMARY 0x5A source with no fallback scripting involved', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({
      monotonicNow: () => clock.now(),
      scenario: DEFAULT_ENET_SCENARIO,
      seed: 11,
    });
    const session = createEnetSession(transport, config(), () => clock.now());
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    for (let index = 0; index < 20; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    expect(session.getDiagnostics().unsupportedChannels).toEqual([]);
    expect(samples.length).toBeGreaterThan(0);
  });
});
