import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ObdTransport, TelemetryChannelId, TelemetrySample } from '../../../src/telemetry/contracts';
import { DEFAULT_ENET_CHANNEL_SPECS, type EnetChannelSpec } from '../../../src/telemetry/enet/enetChannelSpecs';
import {
  createEnetSession,
  type EnetConfig,
  type EnetSession,
  type EnetState,
} from '../../../src/telemetry/enet/enetSession';
import {
  binaryStringToBytes,
  bytesToBinaryString,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
} from '../../../src/telemetry/enet/hsfzCodec';
import { FakeClock } from '../../controller/testSupport';

/**
 * Ticket P4l-FIX4 N5/N6 (Codex P4l-REV2b findings 9 and 10).
 *
 * A Signal-Finder-confirmed brake binding is the first poll entry this app
 * has ever addressed to a SECOND ECU inside one DME session, and it is the
 * only entry built from field evidence rather than from a protocol table.
 * Both of its failure modes were session-wide before this ticket:
 *
 *  N5 — a SILENT 0x29 occupies the single in-flight slot for the full
 *       `commandTimeoutMs` (1.5 s in production) on every one of its 5 Hz
 *       turns. The DME channels the driver actually sees (rpm, speed,
 *       throttle) collapse behind it. A binding-sourced entry therefore gets
 *       its OWN, much shorter timeout and is backed off exponentially after
 *       three consecutive misses, recovering the moment it answers.
 *
 *  N6 — a binding whose `decodeValue` says "I cannot read this response"
 *       (`null`) threw into the SESSION-wide consecutive-error budget, so
 *       five bad brake reads in a row killed every channel. It is a
 *       per-channel skipped sample instead: the channel is marked degraded
 *       after five, the session and every other channel keep going.
 */

const NOMINAL_HZ = 5;

/** Advances the FakeClock and vitest's fake timers together. */
async function run(clock: FakeClock, totalMs: number, stepMs = 50): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    clock.advance(stepMs);
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

/**
 * Answers every diagnostic request addressed to `answeringTargets`, from the
 * address it was sent to, and stays completely SILENT for any other target --
 * exactly what a tester sees when it addresses an ECU that is not on the bus
 * (no response, no NRC, nothing to correlate).
 */
class TargetedTransport implements ObdTransport {
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  private readonly parser = new HsfzFrameParser();
  readonly requestsByTarget = new Map<number, number>();

  constructor(private readonly answeringTargets: ReadonlySet<number>) {}

  async connect(): Promise<void> {}

  send(line: string): void {
    for (const frame of this.parser.push(binaryStringToBytes(line))) {
      if (frame.kind !== 'diagnostic' || frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) continue;
      const target = frame.target;
      this.requestsByTarget.set(target, (this.requestsByTarget.get(target) ?? 0) + 1);
      const pdu = frame.payload;
      const sid = pdu[0] ?? 0;
      if (sid === 0x3e) continue; // TesterPresent: suppress-positive-response.
      if (!this.answeringTargets.has(target)) continue; // silent ECU.
      const payload =
        sid === 0x22
          ? Uint8Array.from([0x62, pdu[1] ?? 0, pdu[2] ?? 0, 0x05])
          : Uint8Array.from([0x41, pdu[1] ?? 0, 0x1a, 0xf8]);
      const response = encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: target,
        target: frame.source,
        payload,
      });
      queueMicrotask(() => {
        const chunk = bytesToBinaryString(response);
        for (const listener of [...this.dataListeners]) listener(chunk);
      });
    }
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  onClose(cb: (error?: Error) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }

  async close(): Promise<void> {}
}

function brakeSpec(overrides: Partial<EnetChannelSpec> = {}): EnetChannelSpec {
  return {
    channel: 'brakeSwitch',
    mode: 'did',
    requestHex: '500C',
    targetAddress: 0x29,
    decodeValue: (bytes) => (bytes[0] === 0x04 ? 0 : 100),
    provenance: 'Signal Finder field-confirmed binding (test)',
    ...overrides,
  };
}

function config(overrides: Partial<EnetConfig> = {}): EnetConfig {
  return {
    channelSpecs: [...DEFAULT_ENET_CHANNEL_SPECS, brakeSpec()],
    pollPlan: [
      { channel: 'rpm', hz: NOMINAL_HZ },
      { channel: 'speedKph', hz: NOMINAL_HZ },
      { channel: 'throttlePct', hz: NOMINAL_HZ },
      { channel: 'brakeSwitch', hz: NOMINAL_HZ },
    ],
    testerAddress: 0xf4,
    targetAddress: 0x12,
    testerPresentIntervalMs: 2_000,
    commandTimeoutMs: 1_500,
    maxConsecutiveErrors: 5,
    attemptObd01: true,
    ...overrides,
  };
}

function startUntil(session: EnetSession, target: EnetState): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = session.onStateChange((state) => {
      if (state !== target) return;
      unsubscribe();
      resolve();
    });
    session.start();
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('P4l-FIX4 N5: a silent second ECU never stalls DME polling', () => {
  it('keeps every DME channel at >= 80 % of its nominal rate while 0x29 never answers', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new TargetedTransport(new Set([0x12]));
    const session = createEnetSession(transport, config(), () => clock.now());
    const states: EnetState[] = [];
    session.onStateChange((state) => states.push(state));
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));

    await startUntil(session, 'polling');
    await run(clock, 20_000);
    const diagnostics = session.getDiagnostics();
    await session.stop();

    expect(states).not.toContain('failed');
    for (const channel of ['rpm', 'speedKph', 'throttlePct'] as const) {
      expect(diagnostics.observedHzByChannel[channel] ?? 0).toBeGreaterThanOrEqual(NOMINAL_HZ * 0.8);
    }
    // The brake entry itself is backed off to a trickle and says so.
    expect(diagnostics.degradedChannels).toContain<TelemetryChannelId>('brakeSwitch');
    expect(diagnostics.channelWarnings.join(' ')).toMatch(/brakeSwitch/);
    expect(transport.requestsByTarget.get(0x29) ?? 0).toBeLessThan(20);
    expect(samples.some((sample) => sample.channel === 'brakeSwitch')).toBe(false);
  }, 60_000);

  it('recovers the binding channel to its nominal rate once the ECU answers again', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const answering = new Set<number>([0x12]);
    const transport = new TargetedTransport(answering);
    const session = createEnetSession(transport, config(), () => clock.now());
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));

    await startUntil(session, 'polling');
    await run(clock, 10_000);
    expect(session.getDiagnostics().degradedChannels).toContain<TelemetryChannelId>('brakeSwitch');

    answering.add(0x29); // the ECU wakes up
    await run(clock, 10_000);
    const brakeSamples = samples.filter((sample) => sample.channel === 'brakeSwitch').length;
    await session.stop();

    expect(brakeSamples).toBeGreaterThan(10);
    expect(session.getDiagnostics().degradedChannels).not.toContain('brakeSwitch');
  }, 60_000);
});

describe('P4l-FIX4 N6: an undecodable binding response is a per-channel skip', () => {
  it('survives 20 consecutive null decodes with every other channel still flowing', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new TargetedTransport(new Set([0x12, 0x29]));
    const session = createEnetSession(
      transport,
      config({
        channelSpecs: [...DEFAULT_ENET_CHANNEL_SPECS, brakeSpec({ decodeValue: () => null })],
        maxConsecutiveErrors: 5,
      }),
      () => clock.now(),
    );
    const states: EnetState[] = [];
    session.onStateChange((state) => states.push(state));
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));

    await startUntil(session, 'polling');
    await run(clock, 6_000);
    const diagnostics = session.getDiagnostics();
    await session.stop();

    expect(states).not.toContain('failed');
    expect(transport.requestsByTarget.get(0x29) ?? 0).toBeGreaterThan(20);
    expect(samples.some((sample) => sample.channel === 'brakeSwitch')).toBe(false);
    expect(samples.filter((sample) => sample.channel === 'rpm').length).toBeGreaterThan(20);
    // Counted on the channel's OWN budget, never the session-wide one.
    expect(diagnostics.degradedChannels).toContain<TelemetryChannelId>('brakeSwitch');
    expect(diagnostics.errorCount).toBe(0);
  }, 60_000);
});
