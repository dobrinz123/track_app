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
  type HsfzFrame,
} from '../../../src/telemetry/enet/hsfzCodec';
import { DEFAULT_ENET_SCENARIO, SimulatedEnetTransport } from '../../../src/telemetry/enet/simulatedEnetTransport';
import { FakeClock } from '../../controller/testSupport';

/** Advances both the FakeClock and vitest's fake timers together, in small steps, until `predicate()` is true (or `maxSteps` is hit). */
async function advanceUntil(
  clock: FakeClock,
  predicate: () => boolean,
  stepMs = 5,
  maxSteps = 400,
): Promise<void> {
  for (let index = 0; index < maxSteps && !predicate(); index += 1) {
    clock.advance(stepMs);
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

/**
 * Test double that records every sent frame (fully decoded) and lets the
 * test deliver arbitrary HAND-BUILT wire bytes at will -- independent of the
 * session's own request-encoding path, so a correlation bug in the session
 * can't also hide inside a fixture that reuses the same codec to answer.
 */
class ScriptableTransport implements ObdTransport {
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(error?: Error) => void>();
  readonly sentFrames: HsfzFrame[] = [];
  closeCount = 0;

  async connect(): Promise<void> {}

  send(line: string): void {
    const bytes = binaryStringToBytes(line);
    const [frame] = new HsfzFrameParser().push(bytes);
    if (frame !== undefined) this.sentFrames.push(frame);
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

  /** Delivers raw wire bytes as if they arrived from the transport, unrelated to anything this transport itself sent. */
  deliverRaw(bytes: Uint8Array): void {
    const chunk = bytesToBinaryString(bytes);
    for (const listener of [...this.dataListeners]) listener(chunk);
  }
}

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
      this.sentSids.push(frame?.kind === 'diagnostic' ? (frame.payload[0] ?? -1) : -1);
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
      if (requestFrame === undefined || requestFrame.kind !== 'diagnostic') {
        throw new Error('held bytes did not parse as a diagnostic frame');
      }
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

// ---------------------------------------------------------------------------
// H2: response correlation (Codex P4e-REV1 HIGH finding).
// Hand-built wire vectors, delivered independently of the session's own
// request-encoding path (ScriptableTransport never auto-replies).
// ---------------------------------------------------------------------------
describe('EnetSessionEngine: response correlation (H2)', () => {
  it('review scenario 1: a late RPM response arriving during the speedKph request does not resolve the wrong request', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new ScriptableTransport();
    const session = createEnetSession(
      transport,
      config({
        pollPlan: [
          { channel: 'rpm', hz: 5 },
          { channel: 'speedKph', hz: 5 },
        ],
        commandTimeoutMs: 100,
        testerPresentIntervalMs: 5_000,
      }),
      () => clock.now(),
    );
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    // rpm (01 0C) goes out first and is never answered -- times out.
    await advanceUntil(clock, () => transport.sentFrames.length >= 1);
    expect(transport.sentFrames[0]?.kind).toBe('diagnostic');
    await advanceUntil(clock, () => transport.sentFrames.length >= 2, 20, 50); // let the timeout elapse and speedKph (01 0D) go out

    // Late positive RPM response (41 0C 1A F8), addresses correctly swapped
    // (source=ECU target address, target=tester) -- arrives while speedKph is pending.
    transport.deliverRaw(
      encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: 0x12,
        target: 0xf4,
        payload: Uint8Array.from([0x41, 0x0c, 0x1a, 0xf8]),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(session.getDiagnostics().unmatchedResponses).toBeGreaterThan(0);
    expect(samples.some((s) => s.channel === 'rpm')).toBe(false);

    // The speedKph request must still be alive -- the correct response now resolves it.
    transport.deliverRaw(
      encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: 0x12,
        target: 0xf4,
        payload: Uint8Array.from([0x41, 0x0d, 0x50]),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(samples.some((s) => s.channel === 'speedKph' && s.value === 0x50)).toBe(true);
    await session.stop();
  });

  it('review scenario 2: a delayed 7F 3E 31 (TesterPresent negative) during an rpm poll never marks rpm unsupported', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new ScriptableTransport();
    const session = createEnetSession(
      transport,
      config({
        pollPlan: [{ channel: 'rpm', hz: 5 }],
        commandTimeoutMs: 2_000,
        testerPresentIntervalMs: 500,
      }),
      () => clock.now(),
    );
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    // rpm (01 0C) is sent immediately, occupying the single in-flight slot
    // for the full commandTimeoutMs (this transport never replies) before
    // TesterPresent (already overdue by then) finally gets a turn, followed
    // immediately by a SECOND rpm request -- that second request is what
    // must still be pending when the stray TesterPresent-negative arrives.
    await advanceUntil(
      clock,
      () => transport.sentFrames.filter((f) => f.kind === 'diagnostic' && f.payload[0] === 0x01).length >= 2,
      50,
      100, // up to 5000ms of virtual time -- comfortably past commandTimeoutMs (2000ms)
    );
    expect(transport.sentFrames.some((f) => f.kind === 'diagnostic' && f.payload[0] === 0x3e)).toBe(true);

    // Delayed negative response to the EARLIER TesterPresent (0x7F 0x3E 0x31), addresses matching the same ECU/tester pair.
    transport.deliverRaw(
      encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: 0x12,
        target: 0xf4,
        payload: Uint8Array.from([0x7f, 0x3e, 0x31]),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    let diagnostics = session.getDiagnostics();
    expect(diagnostics.unmatchedResponses).toBeGreaterThan(0);
    expect(diagnostics.unsupportedChannels).toEqual([]);
    expect(diagnostics.supportedChannels).toEqual(['rpm']);

    // The real rpm response still resolves the still-pending request.
    transport.deliverRaw(
      encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: 0x12,
        target: 0xf4,
        payload: Uint8Array.from([0x41, 0x0c, 0x1a, 0xf8]),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    diagnostics = session.getDiagnostics();
    expect(samples.some((s) => s.channel === 'rpm' && s.value === 1_726)).toBe(true);
    expect(diagnostics.unsupportedChannels).toEqual([]);
    await session.stop();
  });

  it('review scenario 3: a different-DID positive response does not resolve or clear the in-flight DID request', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new ScriptableTransport();
    const session = createEnetSession(
      transport,
      config({
        channelSpecs: [
          {
            channel: 'engineOilC',
            mode: 'did',
            requestHex: '1E1C',
            decode: { byteOffset: 0, byteLength: 1, scale: 1, offset: -40 },
            provenance: 'test',
          },
        ],
        pollPlan: [{ channel: 'engineOilC', hz: 5 }],
        commandTimeoutMs: 200,
        testerPresentIntervalMs: 5_000,
      }),
      () => clock.now(),
    );
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    await advanceUntil(clock, () => transport.sentFrames.length >= 1);

    // Positive response for a DIFFERENT DID (0x1E1D, not the requested 0x1E1C).
    transport.deliverRaw(
      encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: 0x12,
        target: 0xf4,
        payload: Uint8Array.from([0x62, 0x1e, 0x1d, 0x00]),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(session.getDiagnostics().unmatchedResponses).toBeGreaterThan(0);
    expect(samples).toHaveLength(0);

    // The correct DID now resolves the still-pending request.
    transport.deliverRaw(
      encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: 0x12,
        target: 0xf4,
        payload: Uint8Array.from([0x62, 0x1e, 0x1c, 0x4b]),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(samples.some((s) => s.channel === 'engineOilC' && s.value === 35)).toBe(true);
    await session.stop();
  });
});

// ---------------------------------------------------------------------------
// M1: a corrupted length is FATAL -- transport closed, normal failure path,
// never "clear buffer and continue" across chunk boundaries.
// ---------------------------------------------------------------------------
describe('EnetSessionEngine: fatal HSFZ framing errors (M1)', () => {
  it("review's malformed-length sequence closes the transport and fails the session, instead of resyncing mid-stream", async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new ScriptableTransport();
    const session = createEnetSession(
      transport,
      config({ pollPlan: [{ channel: 'rpm', hz: 5 }], testerPresentIntervalMs: 5_000 }),
      () => clock.now(),
    );
    const failed = nextState(session, 'failed');
    session.start();
    await vi.advanceTimersByTimeAsync(0);

    // [00 00 00 00] -- length 0, too small: fatal.
    transport.deliverRaw(Uint8Array.from([0x00, 0x00, 0x00, 0x00]));
    await vi.advanceTimersByTimeAsync(0);

    // [00 00 00 20] -- would-be length 32 if the stream were still trusted after the corruption.
    // Must NOT be accepted as a fresh frame header -- the connection is already being torn down.
    transport.deliverRaw(Uint8Array.from([0x00, 0x00, 0x00, 0x20]));
    await vi.advanceTimersByTimeAsync(0);

    // A complete, otherwise-valid alive-check frame.
    transport.deliverRaw(
      Uint8Array.from([0x00, 0x00, 0x00, 0x02, 0x00, 0x12, 0xf4, 0x00]),
    );
    await vi.advanceTimersByTimeAsync(0);

    await failed;
    const diagnostics = session.getDiagnostics();
    expect(diagnostics.lastError).toBeDefined();
    expect(transport.closeCount).toBe(1); // closed exactly once, via the normal failure path.
    expect(diagnostics.aliveChecksAnswered).toBe(0); // the trailing "valid" alive frame was never processed as new data.
  });
});

// ---------------------------------------------------------------------------
// L1: TesterPresent interval clamp + starvation guarantee.
// ---------------------------------------------------------------------------
describe('EnetSessionEngine: TesterPresent clamp + starvation guarantee (L1)', () => {
  class RecordingTransport implements ObdTransport {
    readonly sentSids: number[] = [];
    private readonly dataListeners = new Set<(chunk: string) => void>();
    private readonly closeListeners = new Set<(error?: Error) => void>();

    async connect(): Promise<void> {}

    send(line: string): void {
      const bytes = binaryStringToBytes(line);
      const [frame] = new HsfzFrameParser().push(bytes);
      this.sentSids.push(frame?.kind === 'diagnostic' ? (frame.payload[0] ?? -1) : -1);
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

  it('clamps a near-zero configured interval to a floor of 500ms', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new RecordingTransport();
    const session = createEnetSession(transport, config({ pollPlan: [], testerPresentIntervalMs: 1 }), () => clock.now());
    await startUntil(session, 'polling');

    for (let index = 0; index < 6; index += 1) {
      clock.advance(100); // 600ms total
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    // An unclamped 1ms interval would fire hundreds of times in 600ms.
    expect(transport.sentSids.length).toBeLessThanOrEqual(2);
    expect(transport.sentSids.every((sid) => sid === 0x3e)).toBe(true);
  });

  it('never sends two TesterPresent frames back-to-back without an intervening channel poll, even with a tiny configured interval', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new RecordingTransport();
    const session = createEnetSession(
      transport,
      config({
        pollPlan: [{ channel: 'rpm', hz: 50 }],
        testerPresentIntervalMs: 1,
        commandTimeoutMs: 10,
        maxConsecutiveErrors: 100_000,
      }),
      () => clock.now(),
    );
    await startUntil(session, 'polling');

    for (let index = 0; index < 200; index += 1) {
      clock.advance(5);
      await vi.advanceTimersByTimeAsync(5);
    }
    // See the L2 test's comment: flush a bit more virtual time before the
    // graceful stop() so a request started right at the loop boundary can't
    // leave stop() waiting on a timer this test never advances again.
    clock.advance(15);
    await vi.advanceTimersByTimeAsync(15);
    await session.stop();

    expect(transport.sentSids.some((sid) => sid === 0x3e)).toBe(true);
    expect(transport.sentSids.some((sid) => sid === 0x01)).toBe(true);
    for (let index = 1; index < transport.sentSids.length; index += 1) {
      if (transport.sentSids[index] === 0x3e) {
        expect(transport.sentSids[index - 1]).not.toBe(0x3e);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// L2: ACK latency attributed only to the last diagnostic REQUEST, never to
// TesterPresent or alive-check replies.
// ---------------------------------------------------------------------------
describe('EnetSessionEngine: ACK latency correlation (L2)', () => {
  class AckOnlyForTesterPresentTransport implements ObdTransport {
    private readonly dataListeners = new Set<(chunk: string) => void>();
    private readonly closeListeners = new Set<(error?: Error) => void>();

    async connect(): Promise<void> {}

    send(line: string): void {
      const bytes = binaryStringToBytes(line);
      const [frame] = new HsfzFrameParser().push(bytes);
      if (frame === undefined || frame.kind !== 'diagnostic') return;
      if ((frame.payload[0] ?? -1) !== 0x3e) return; // only ACK TesterPresent -- real diagnostic requests get NO ack and NO response.
      const ack = encodeFrame({
        control: HSFZ_CONTROL.ACKNOWLEDGE,
        source: frame.target,
        target: frame.source,
        payload: frame.payload.slice(0, 2),
      });
      const chunk = bytesToBinaryString(ack);
      queueMicrotask(() => {
        for (const listener of [...this.dataListeners]) listener(chunk);
      });
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

  it('produces no ack-latency stats when only TesterPresent frames are ever acked', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new AckOnlyForTesterPresentTransport();
    const session = createEnetSession(
      transport,
      config({
        pollPlan: [{ channel: 'rpm', hz: 5 }],
        testerPresentIntervalMs: 500,
        commandTimeoutMs: 50,
        maxConsecutiveErrors: 100_000,
      }),
      () => clock.now(),
    );
    await startUntil(session, 'polling');

    for (let index = 0; index < 20; index += 1) {
      clock.advance(100); // 2000ms: several TesterPresent acks + many rpm timeouts
      await vi.advanceTimersByTimeAsync(100);
    }
    // Graceful stop() waits for any in-flight request's OWN timeout (it does
    // not abort it) -- flush a bit more virtual time first so a request that
    // happened to start right at the loop boundary doesn't leave stop()
    // waiting on a timer this test would otherwise never advance.
    clock.advance(60);
    await vi.advanceTimersByTimeAsync(60);
    await session.stop();

    const diagnostics = session.getDiagnostics();
    expect(diagnostics.framesRx).toBeGreaterThan(0); // the TesterPresent acks were received...
    expect(diagnostics.ackLatencyMsP50).toBeUndefined(); // ...but never attributed as diagnostic-request ack latency.
    expect(diagnostics.ackLatencyMsP95).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// M2 (engine wiring): a non-finite decoded value is dropped, counted as a
// decode error, and never resets consecutiveErrors.
// ---------------------------------------------------------------------------
describe('EnetSessionEngine: non-finite decoded values are dropped (M2)', () => {
  it('drops the sample and increments decodeErrors when scale/offset overflow to a non-finite value', async () => {
    vi.useFakeTimers();
    const clock = new FakeClock();
    const transport = new SimulatedEnetTransport({
      monotonicNow: () => clock.now(),
      scenario: [{ mode: 'did', requestHex: '1E1C', encodeDataBytes: () => Uint8Array.from([0xff, 0xff]) }],
      seed: 12,
    });
    const session = createEnetSession(
      transport,
      config({
        channelSpecs: [
          {
            channel: 'engineOilC',
            mode: 'did',
            requestHex: '1E1C',
            decode: { byteOffset: 0, byteLength: 2, scale: Number.MAX_VALUE, offset: 0 },
            provenance: 'test',
          },
        ],
        pollPlan: [{ channel: 'engineOilC', hz: 5 }],
      }),
      () => clock.now(),
    );
    const samples: TelemetrySample[] = [];
    session.onSample((sample) => samples.push(sample));
    await startUntil(session, 'polling');

    for (let index = 0; index < 20; index += 1) {
      clock.advance(100);
      await vi.advanceTimersByTimeAsync(100);
    }
    await session.stop();

    expect(samples).toHaveLength(0);
    const diagnostics = session.getDiagnostics();
    expect(diagnostics.decodeErrors).toBeGreaterThan(0);
    expect(diagnostics.errorCount).toBe(0);
  });
});
