import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ObdTransport, TelemetrySample } from '../../../src/telemetry/contracts';
import { DEFAULT_ENET_CHANNEL_SPECS } from '../../../src/telemetry/enet/enetChannelSpecs';
import { createEnetSession, type EnetConfig, type EnetSession, type EnetState } from '../../../src/telemetry/enet/enetSession';
import {
  binaryStringToBytes,
  bytesToBinaryString,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
} from '../../../src/telemetry/enet/hsfzCodec';
import { DEFAULT_ENET_SCENARIO, SimulatedEnetTransport } from '../../../src/telemetry/enet/simulatedEnetTransport';
import { FakeClock } from '../../controller/testSupport';

function config(overrides: Partial<EnetConfig> = {}): EnetConfig {
  return {
    channelSpecs: DEFAULT_ENET_CHANNEL_SPECS,
    pollPlan: [],
    testerAddress: 0xf4,
    targetAddress: 0x12,
    testerPresentIntervalMs: 2_000,
    commandTimeoutMs: 200,
    maxConsecutiveErrors: 5,
    attemptObd01: true,
    ...overrides,
  };
}

function nextState(session: EnetSession, target: EnetState): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = session.onStateChange((state) => {
      if (state !== target) return;
      unsubscribe();
      resolve();
    });
  });
}

async function startUntil(session: EnetSession, target: EnetState): Promise<void> {
  const reached = nextState(session, target);
  session.start();
  await reached;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('EnetSessionEngine + SimulatedEnetTransport', () => {
  it('decodes samples for all 5 default channels with correct values', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({ monotonicNow: () => clock.now(), seed: 11 });
    const session = createEnetSession(
      transport,
      config({
        pollPlan: [
          { channel: 'rpm', hz: 5 },
          { channel: 'speedKph', hz: 5 },
          { channel: 'throttlePct', hz: 5 },
          { channel: 'coolantC', hz: 0.5 },
          { channel: 'engineOilC', hz: 0.5 },
        ],
      }),
      () => clock.now(),
    );
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    for (let index = 0; index < 60; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    const seenChannels = new Set(samples.map((sample) => sample.channel));
    expect(seenChannels).toEqual(new Set(['rpm', 'speedKph', 'throttlePct', 'coolantC', 'engineOilC']));
    expect(samples.every((sample) => Number.isFinite(sample.value))).toBe(true);
    // rpm is in the plausible warm-up band from DEFAULT_ENET_SCENARIO (850 +/- 2700, +/- jitter-free here).
    expect(samples.filter((s) => s.channel === 'rpm').every((s) => s.value >= 0 && s.value <= 4_000)).toBe(true);
    expect(session.getDiagnostics().errorCount).toBe(0);
  });

  it('drops a channel from the poll plan after NRC 0x11 and never retries it', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({
      monotonicNow: () => clock.now(),
      scenario: [
        { mode: 'obd01', requestHex: '0C', encodeDataBytes: () => Uint8Array.from([0x1a, 0xf8]) },
        { mode: 'obd01', requestHex: '05', nrc: 0x11, encodeDataBytes: () => Uint8Array.from([0x00]) },
      ],
      seed: 3,
    });
    const session = createEnetSession(
      transport,
      config({
        pollPlan: [
          { channel: 'rpm', hz: 5 },
          { channel: 'coolantC', hz: 5 },
        ],
      }),
      () => clock.now(),
    );
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    for (let index = 0; index < 30; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    const diagnostics = session.getDiagnostics();
    expect(diagnostics.unsupportedChannels).toEqual(['coolantC']);
    expect(diagnostics.supportedChannels).toEqual(['rpm']);
    expect(diagnostics.lastNrcByChannel.coolantC).toBe(0x11);
    expect(samples.some((sample) => sample.channel === 'coolantC')).toBe(false);
    expect(samples.some((sample) => sample.channel === 'rpm')).toBe(true);
    // An UNSUPPORTED determination is a graceful outcome, never an error.
    expect(diagnostics.errorCount).toBe(0);
  });

  it('answers an unsolicited alive-check (0x0012) with an alive-check frame, recorded in diagnostics', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({
      monotonicNow: () => clock.now(),
      aliveCheckIntervalMs: 300,
      seed: 4,
    });
    const session = createEnetSession(transport, config({ pollPlan: [{ channel: 'rpm', hz: 5 }] }), () => clock.now());
    await startUntil(session, 'polling');

    for (let index = 0; index < 20; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    expect(session.getDiagnostics().aliveChecksAnswered).toBeGreaterThan(0);
  });

  it('populates ack latency p50/p95 diagnostics from HSFZ ACK frames', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({ monotonicNow: () => clock.now(), ackEnabled: true, seed: 9 });
    const session = createEnetSession(transport, config({ pollPlan: [{ channel: 'rpm', hz: 5 }] }), () => clock.now());
    await startUntil(session, 'polling');

    for (let index = 0; index < 20; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    const diagnostics = session.getDiagnostics();
    expect(diagnostics.ackLatencyMsP50).toBeDefined();
    expect(diagnostics.ackLatencyMsP95).toBeDefined();
    expect(diagnostics.framesTx).toBeGreaterThan(0);
    expect(diagnostics.framesRx).toBeGreaterThan(0);
  });

  it('produces no ack latency stats when the simulator has acks disabled', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({ monotonicNow: () => clock.now(), ackEnabled: false, seed: 9 });
    const session = createEnetSession(transport, config({ pollPlan: [{ channel: 'rpm', hz: 5 }] }), () => clock.now());
    await startUntil(session, 'polling');
    for (let index = 0; index < 10; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    const diagnostics = session.getDiagnostics();
    expect(diagnostics.ackLatencyMsP50).toBeUndefined();
    expect(diagnostics.ackLatencyMsP95).toBeUndefined();
  });

  it('decodes samples correctly even with TCP fragmentation into 1-3 byte chunks', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({ monotonicNow: () => clock.now(), fragmentResponses: true, seed: 5 });
    const session = createEnetSession(transport, config({ pollPlan: [{ channel: 'rpm', hz: 10 }] }), () => clock.now());
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    for (let index = 0; index < 20; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((sample) => sample.channel === 'rpm' && Number.isFinite(sample.value))).toBe(true);
    expect(session.getDiagnostics().errorCount).toBe(0);
  });

  it('honors a responsePending (0x78) extension before the real response arrives', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({
      monotonicNow: () => clock.now(),
      scenario: [
        { mode: 'obd01', requestHex: '0C', responsePendingCount: 2, encodeDataBytes: () => Uint8Array.from([0x1a, 0xf8]) },
      ],
      seed: 7,
    });
    const session = createEnetSession(
      transport,
      config({ pollPlan: [{ channel: 'rpm', hz: 5 }], commandTimeoutMs: 100 }),
      () => clock.now(),
    );
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    for (let index = 0; index < 10; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    expect(samples.some((sample) => sample.channel === 'rpm' && sample.value === 1_726)).toBe(true);
    expect(session.getDiagnostics().errorCount).toBe(0);
  });

  it('disconnects cleanly to failed via disconnectOnRequestNumber, with no unhandled rejection', async () => {
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({
      monotonicNow: () => clock.now(),
      disconnectOnRequestNumber: 2,
      seed: 5,
    });
    const session = createEnetSession(transport, config({ pollPlan: [{ channel: 'rpm', hz: 10 }] }), () => clock.now());

    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const failed = nextState(session, 'failed');
      session.start();
      await failed;
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      process.removeListener('unhandledRejection', onUnhandledRejection);
    }

    expect(session.getDiagnostics().lastError).toBeDefined();
    expect(rejections).toEqual([]);
  });
});

describe('EnetSessionEngine: TesterPresent cadence', () => {
  class RecordingTransport implements ObdTransport {
    readonly sentSids: number[] = [];
    private readonly dataListeners = new Set<(chunk: string) => void>();
    private readonly closeListeners = new Set<(error?: Error) => void>();
    closeCount = 0;

    async connect(): Promise<void> {}

    send(line: string): void {
      const bytes = binaryStringToBytes(line);
      const parser = new HsfzFrameParser();
      const [frame] = parser.push(bytes);
      this.sentSids.push(frame?.payload[0] ?? -1);
      // No reply: TesterPresent's suppress-positive-response bit means the
      // engine never waits on a response for this request.
    }

    onData(cb: (chunk: string) => void): () => void {
      this.dataListeners.add(cb);
      return () => this.dataListeners.delete(cb);
    }

    onClose(cb: (error?: Error) => void): () => void {
      this.closeListeners.add(cb);
      return () => this.closeListeners.delete(cb);
    }

    async close(): Promise<void> {
      this.closeCount += 1;
    }
  }

  it('sends TesterPresent (0x3E 0x80) every testerPresentIntervalMs while polling, even with an empty poll plan', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new RecordingTransport();
    const session = createEnetSession(
      transport,
      config({ pollPlan: [], testerPresentIntervalMs: 1_000 }),
      () => clock.now(),
    );
    await startUntil(session, 'polling');

    for (let index = 0; index < 10; index += 1) {
      clock.advance(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await session.stop();

    expect(transport.sentSids.length).toBeGreaterThanOrEqual(9);
    expect(transport.sentSids.every((sid) => sid === 0x3e)).toBe(true);
  });
});

describe('EnetSessionEngine: failure escalation', () => {
  it('fails after maxConsecutiveErrors consecutive channel errors (non-unsupported NRC)', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({
      monotonicNow: () => clock.now(),
      scenario: [{ mode: 'obd01', requestHex: '0C', nrc: 0x22, encodeDataBytes: () => Uint8Array.from([0x00]) }],
      seed: 6,
    });
    const session = createEnetSession(
      transport,
      config({ pollPlan: [{ channel: 'rpm', hz: 5 }], maxConsecutiveErrors: 3 }),
      () => clock.now(),
    );
    const failed = nextState(session, 'failed');
    session.start();

    for (let index = 0; index < 20; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await failed;

    expect(session.getDiagnostics().errorCount).toBe(3);
    expect(session.getDiagnostics().lastError).toContain('Maximum consecutive telemetry errors');
  });
});

describe('EnetSessionEngine: clean stop mid-request (generation guard)', () => {
  class HoldableTransport implements ObdTransport {
    private readonly dataListeners = new Set<(chunk: string) => void>();
    private readonly closeListeners = new Set<(error?: Error) => void>();
    private held: Uint8Array | null = null;
    closeCount = 0;

    async connect(): Promise<void> {}

    send(line: string): void {
      this.held = binaryStringToBytes(line);
    }

    onData(cb: (chunk: string) => void): () => void {
      this.dataListeners.add(cb);
      return () => this.dataListeners.delete(cb);
    }

    onClose(cb: (error?: Error) => void): () => void {
      this.closeListeners.add(cb);
      return () => this.closeListeners.delete(cb);
    }

    async close(): Promise<void> {
      this.closeCount += 1;
    }

    /** Answers the held request positively, as if the ECU finally responded. */
    respondPositive(dataBytes: Uint8Array): void {
      if (this.held === null) throw new Error('no request is held');
      const parser = new HsfzFrameParser();
      const [requestFrame] = parser.push(this.held);
      if (requestFrame === undefined) throw new Error('held bytes did not parse as a frame');
      const pdu = requestFrame.payload;
      const sid = pdu[0] ?? 0;
      const isDid = sid === 0x22;
      const responseSid = isDid ? 0x62 : 0x41;
      const echoedId = isDid ? pdu.slice(1, 3) : pdu.slice(1, 2);
      const payload = new Uint8Array(1 + echoedId.length + dataBytes.length);
      payload.set([responseSid], 0);
      payload.set(echoedId, 1);
      payload.set(dataBytes, 1 + echoedId.length);
      const responseFrame = encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: 0x12,
        target: requestFrame.source,
        payload,
      });
      const chunk = bytesToBinaryString(responseFrame);
      for (const listener of [...this.dataListeners]) listener(chunk);
    }
  }

  it('never emits a sample for a request that resolves after stop() was called', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new HoldableTransport();
    const session = createEnetSession(transport, config({ pollPlan: [{ channel: 'rpm', hz: 5 }] }), () => clock.now());
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');
    await vi.advanceTimersByTimeAsync(0); // let the first request go out and get held

    let stopped = false;
    const stopping = session.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false); // stop() genuinely waits for the in-flight request.
    expect(transport.closeCount).toBe(0);

    transport.respondPositive(Uint8Array.from([0x1a, 0xf8])); // arrives AFTER stop() was requested
    await stopping;

    expect(stopped).toBe(true);
    expect(transport.closeCount).toBe(1);
    expect(samples).toHaveLength(0); // no late sample despite a legitimate, decodable response arriving post-stop
  });
});

describe('DEFAULT_ENET_SCENARIO sanity', () => {
  it('covers exactly the 5 default channels used by DEFAULT_ENET_CHANNEL_SPECS', () => {
    const scenarioKeys = new Set(DEFAULT_ENET_SCENARIO.map((entry) => `${entry.mode}:${entry.requestHex}`));
    const specKeys = new Set(DEFAULT_ENET_CHANNEL_SPECS.map((spec) => `${spec.mode}:${spec.requestHex}`));
    expect(scenarioKeys).toEqual(specKeys);
  });
});
