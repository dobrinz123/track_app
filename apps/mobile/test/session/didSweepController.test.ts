import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  binaryStringToBytes,
  bytesToBinaryString,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
  parseUdsResponse,
  type ObdTransport,
} from '@circuit/core';
import { createDidSweepController, createRawUdsChannel } from '../../src/session/didSweepController';
import { createEnetAdapterReservation } from '../../src/session/enetAdapterReservation';

/**
 * ENET auto-discovery & DID sweep addendum, extended by the "sweep transport
 * interface & lifecycle amendment" (contracts.md, binding, both). Ticket
 * P4f-FIX2-mobile: "tests first (fail on HEAD), then fix". Every test below
 * targets a specific Codex P4f-REV2 Part B finding and FAILED against the
 * pre-fix `didSweepController.ts` (transport opened by the screen before
 * acquiring the reservation, reservation released while the socket stayed
 * open, `sendRequest` correlating only swapped addresses).
 */

const TESTER_ADDRESS = 0xf4;
const TARGET_ADDRESS = 0x12;

function positivePdu(did: number, dataBytes: number[]): Uint8Array {
  return Uint8Array.from([0x62, (did >> 8) & 0xff, did & 0xff, ...dataBytes]);
}
function negativePdu(nrc: number): Uint8Array {
  return Uint8Array.from([0x7f, 0x22, nrc]);
}
/** A stray, differently-SID'd positive response (mode-01, SID 0x41) -- address-matches but is NOT an answer to a 0x22 request; `nextResponse` (address-only correlation) still delivers it, `resolveOneDid` must skip it as unmatched. */
function wrongSidPdu(): Uint8Array {
  return Uint8Array.from([0x41, 0x0c, 0x12, 0x34]);
}

interface ScriptEntry {
  /**
   * Response PDU(s) delivered as separate `onData` chunks.
   * `mode: 'burst'` (default): ALL of `responses` are delivered for the
   * FIRST (and, per the binding amendment, only) physical `send()` this DID
   * ever receives -- models one UDS transaction with 0x78 extensions/an
   * unmatched frame before the real answer, proving no resend is needed.
   * `mode: 'oneFramePerSend'`: each successive `send()` call for this DID
   * delivers just the NEXT entry in `responses` (observation re-polls the
   * SAME DID with a FRESH `send()` every tick).
   */
  responses: Uint8Array[];
  mode?: 'burst' | 'oneFramePerSend';
  /** ms delay before EACH response (fake-timer controlled). */
  delayMs?: number;
}

/** Scriptable `ObdTransport` double: encodes/decodes real HSFZ frames (via `@circuit/core`), so `createRawUdsChannel`'s own address-swap parsing is exercised exactly as it would be against a real adapter. */
class FakeSweepTransport implements ObdTransport {
  closed = false;
  connectCalls = 0;
  sendCallCountByDid = new Map<number, number>();
  keepAliveSendCount = 0;
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly closeListeners = new Set<(err?: Error) => void>();
  private readonly parser = new HsfzFrameParser();
  private readonly oneFramePerSendCursor = new Map<number, number>();

  constructor(
    private readonly script: Map<number, ScriptEntry>,
    private readonly opts: { refuseConnect?: boolean; connectDelayMs?: number } = {},
  ) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.opts.connectDelayMs !== undefined) await new Promise((r) => setTimeout(r, this.opts.connectDelayMs));
    if (this.opts.refuseConnect) throw new Error('refused (test double)');
  }

  send(line: string): void {
    if (this.closed) return;
    const bytes = binaryStringToBytes(line);
    let frames: ReturnType<HsfzFrameParser['push']>;
    try {
      frames = this.parser.push(bytes);
    } catch {
      return;
    }
    for (const frame of frames) {
      if (frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) continue;
      const pdu = frame.payload;
      if ((pdu[0] ?? 0) === 0x3e) {
        this.keepAliveSendCount += 1;
        continue; // TesterPresent -- no scripted reply (suppressed positive response).
      }
      if ((pdu[0] ?? 0) !== 0x22) continue;
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      this.sendCallCountByDid.set(did, (this.sendCallCountByDid.get(did) ?? 0) + 1);
      const entry = this.script.get(did);
      if (entry === undefined) continue; // no scripted reply -- the request times out.
      const delayStep = entry.delayMs ?? 5;
      if (entry.mode === 'oneFramePerSend') {
        const cursor = this.oneFramePerSendCursor.get(did) ?? 0;
        const response = entry.responses[Math.min(cursor, entry.responses.length - 1)];
        this.oneFramePerSendCursor.set(did, cursor + 1);
        if (response !== undefined) setTimeout(() => this.deliver(response), delayStep);
        continue;
      }
      let delay = delayStep;
      for (const response of entry.responses) {
        setTimeout(() => this.deliver(response), delay);
        delay += delayStep;
      }
    }
  }

  private deliver(payload: Uint8Array): void {
    if (this.closed) return;
    const frame = encodeFrame({ control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES, source: TARGET_ADDRESS, target: TESTER_ADDRESS, payload });
    const chunk = bytesToBinaryString(frame);
    for (const listener of [...this.dataListeners]) listener(chunk);
  }

  onData(cb: (chunk: string) => void): () => void {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }
  onClose(cb: (err?: Error) => void): () => void {
    this.closeListeners.add(cb);
    return () => this.closeListeners.delete(cb);
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
  }
}

/**
 * A `MonotonicClock` backed by the REAL (fake-timer-controlled) `Date.now()`
 * -- required so the controller's own timing math (round-elapsed, pacing
 * deadlines) advances in lockstep with `vi.useFakeTimers()`/`FakeSweepTransport`'s
 * scripted `setTimeout` delays. An artificial incrementing counter, decoupled
 * from real elapsed time, would make cadence/timeout math meaningless under
 * fake timers (M3's own cadence-math tests need genuine ms deltas).
 */
function monotonicCounter(): { now: () => number } {
  return { now: () => Date.now() };
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('createRawUdsChannel (H3, binding): address-swap-only correlation, FIFO in-order delivery', () => {
  it('nextResponse does NOT filter by SID/DID -- a wrong-SID frame is delivered on the FIRST call, the correct one on the SECOND, both from one chunk, in order', async () => {
    const dataListeners: Array<(chunk: string) => void> = [];
    const transport: ObdTransport = {
      connect: async () => undefined,
      send: () => undefined,
      onData: (cb) => {
        dataListeners.push(cb);
        return () => undefined;
      },
      onClose: () => () => undefined,
      close: async () => undefined,
    };
    const channel = createRawUdsChannel(transport, TESTER_ADDRESS, TARGET_ADDRESS);

    const wrongFrame = encodeFrame({ control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES, source: TARGET_ADDRESS, target: TESTER_ADDRESS, payload: wrongSidPdu() });
    const correctFrame = encodeFrame({ control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES, source: TARGET_ADDRESS, target: TESTER_ADDRESS, payload: positivePdu(0x1234, [0x99]) });
    // Both frames delivered in ONE chunk (one onData call) -- the H3 test scenario.
    const oneChunk = bytesToBinaryString(new Uint8Array([...binaryStringToBytes(bytesToBinaryString(wrongFrame)), ...binaryStringToBytes(bytesToBinaryString(correctFrame))]));
    dataListeners[0]!(oneChunk);

    const first = await channel.nextResponse(1_000);
    const second = await channel.nextResponse(1_000);
    expect(first).toEqual(wrongSidPdu());
    expect(second).toEqual(positivePdu(0x1234, [0x99]));
  });

  it('resolves "timeout" if the transport closes while a response is awaited', async () => {
    let closeCb: (() => void) | null = null;
    const transport: ObdTransport = {
      connect: async () => undefined,
      send: () => undefined,
      onData: () => () => undefined,
      onClose: (cb) => {
        closeCb = cb;
        return () => undefined;
      },
      close: async () => undefined,
    };
    const channel = createRawUdsChannel(transport, TESTER_ADDRESS, TARGET_ADDRESS);
    const pending = channel.nextResponse(5_000);
    closeCb!();
    await expect(pending).resolves.toBe('timeout');
  });
});

describe('didSweepController: H1/H2 lifecycle -- the controller owns the transport (binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refused start opens NO socket (reservation already held by another owner)', () => {
    const reservation = createEnetAdapterReservation();
    reservation.tryAcquire('provider'); // telemetry already owns the adapter.
    let transportsBuilt = 0;
    const controller = createDidSweepController({
      transportFactory: () => {
        transportsBuilt += 1;
        return new FakeSweepTransport(new Map());
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
    });

    controller.start({ from: 0x0000, to: 0x0001 });

    expect(transportsBuilt).toBe(0); // H1 finding: HEAD called transport.connect() BEFORE the (refused) acquire.
    expect(controller.getSnapshot().phase).toBe('idle');
    expect(controller.getSnapshot().error).toMatch(/adapter is in use/i);
  });

  it('on natural completion, close() happens BEFORE release() (never the reverse)', async () => {
    const reservation = createEnetAdapterReservation();
    const events: string[] = [];
    const realRelease = reservation.release.bind(reservation);
    reservation.release = (token) => {
      events.push('release');
      realRelease(token);
    };
    let transport: FakeSweepTransport | null = null;
    const controller = createDidSweepController({
      transportFactory: () => {
        transport = new FakeSweepTransport(new Map());
        const realClose = transport.close.bind(transport);
        transport.close = async () => {
          events.push('close');
          await realClose();
        };
        return transport;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
    });

    controller.start({ from: 0x0000, to: 0x0001 }); // tiny range, no script -- every DID times out quickly.
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('sweepComplete');
    expect(events).toEqual(['close', 'release']); // NEVER ['release', 'close'] (the H2 ordering finding).
    expect(reservation.holder()).toBeNull();
  });

  it('stop() also closes BEFORE releasing, even mid-sweep', async () => {
    const reservation = createEnetAdapterReservation();
    const events: string[] = [];
    const realRelease = reservation.release.bind(reservation);
    reservation.release = (token) => {
      events.push('release');
      realRelease(token);
    };
    const controller = createDidSweepController({
      transportFactory: () => {
        const t = new FakeSweepTransport(new Map());
        const realClose = t.close.bind(t);
        t.close = async () => {
          events.push('close');
          await realClose();
        };
        return t;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
    });

    controller.start({ from: 0x0000, to: 0xffff }); // huge range -- still running when stop() is called.
    await flush(5);
    controller.stop();
    await vi.runAllTimersAsync();
    await flush();

    expect(events).toEqual(['close', 'release']);
    expect(controller.getSnapshot().phase).toBe('stopped');
    expect(reservation.holder()).toBeNull();
  });

  it('a SECOND start() (after sweepComplete) opens a genuinely NEW transport instance', async () => {
    const instances: FakeSweepTransport[] = [];
    const controller = createDidSweepController({
      transportFactory: () => {
        const t = new FakeSweepTransport(new Map());
        instances.push(t);
        return t;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: 0x0000, to: 0x0000 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();

    expect(instances).toHaveLength(2);
    expect(instances[0]).not.toBe(instances[1]);
    expect(instances[0]!.closed).toBe(true);
  });

  it('a reentrant start() while sweeping neither opens a second transport nor leaks/re-derives the reservation', async () => {
    const reservation = createEnetAdapterReservation();
    let transportsBuilt = 0;
    const controller = createDidSweepController({
      transportFactory: () => {
        transportsBuilt += 1;
        return new FakeSweepTransport(new Map()); // no script -- every DID times out (1s each), so the sweep over a big range stays 'sweeping' throughout this test.
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
    });

    controller.start({ from: 0x0000, to: 0xffff });
    await flush(5);
    expect(controller.getSnapshot().phase).toBe('sweeping');
    expect(transportsBuilt).toBe(1);

    controller.start({ from: 0x0000, to: 0x0001 }); // reentrant -- must be a complete no-op.
    await flush(5);

    expect(transportsBuilt).toBe(1); // no second transport opened.
    expect(reservation.holder()).toBe('sweep'); // still held by the ORIGINAL run.
    expect(controller.getSnapshot().phase).toBe('sweeping'); // untouched.

    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
    expect(reservation.holder()).toBeNull(); // the original run's own token released cleanly -- nothing was leaked.
  });
});

describe('didSweepController: H3 -- correlation/0x78 correctness against HEAD\'s exact failing scenarios', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a wrong-SID frame immediately followed by the correct 0x62 response (SAME chunk) still yields the responder -- the real answer is never discarded', async () => {
    const script = new Map<number, ScriptEntry>([[0x1234, { responses: [wrongSidPdu(), positivePdu(0x1234, [0x77])], delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: 0x1234, to: 0x1234 });
    await vi.runAllTimersAsync();
    await flush();

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('sweepComplete');
    expect(snapshot.responders).toHaveLength(1);
    expect(snapshot.responders[0]!.raw).toEqual(Uint8Array.from([0x77]));
  });

  it('NRC 0x78 (responsePending) extends the wait WITHOUT re-sending the request -- exactly ONE physical send() for the DID', async () => {
    const script = new Map<number, ScriptEntry>([
      [0x0005, { responses: [negativePdu(0x78), negativePdu(0x78), positivePdu(0x0005, [0x42])], delayMs: 5 }],
    ]);
    let transport: FakeSweepTransport | null = null;
    const controller = createDidSweepController({
      transportFactory: () => {
        transport = new FakeSweepTransport(script);
        return transport;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: 0x0005, to: 0x0005 });
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().responders).toHaveLength(1);
    expect(transport!.sendCallCountByDid.get(0x0005)).toBe(1); // NOT re-sent for either 0x78 extension.
  });

  it('the keep-alive cadence issues TesterPresent (0x3E) periodically while the transport is open', async () => {
    let transport: FakeSweepTransport | null = null;
    const controller = createDidSweepController({
      transportFactory: () => {
        transport = new FakeSweepTransport(new Map());
        return transport;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: 0x0000, to: 0xffff }); // long sweep -- stays open long enough for keep-alive to fire.
    await flush(3);
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();

    expect(transport!.keepAliveSendCount).toBeGreaterThanOrEqual(1);
    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
  });
});

describe('didSweepController: M2 -- observation from paused reuses the held claim (binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pause() then startObservation() succeeds WITHOUT a second tryAcquire (never "adapter in use")', async () => {
    const reservation = createEnetAdapterReservation();
    const tryAcquireSpy = vi.spyOn(reservation, 'tryAcquire');
    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
    });

    // ONE sweep spanning several DIDs -- 0x0001 answers (so `responders` is
    // non-empty), 0x0002/0x0003 are unscripted (time out) -- paused mid-run,
    // still the SAME generation/transport/token throughout.
    controller.start({ from: 0x0001, to: 0x0003 });
    await vi.advanceTimersByTimeAsync(50); // lets the scripted 0x0001 response land.
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    controller.pause();
    // Bounded advance (NOT `runAllTimersAsync()`): the transport stays OPEN
    // across a pause (M2), so its recurring keep-alive timer is still armed
    // and would make `runAllTimersAsync()` spin "forever" (it never runs out
    // of pending timers). 1.5s is enough for the in-flight (unscripted) DID
    // to hit its own 1s request timeout and for the loop to then notice
    // `paused`.
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(controller.getSnapshot().phase).toBe('paused');
    expect(controller.getSnapshot().responders).toHaveLength(1); // preserved across the pause.

    expect(tryAcquireSpy).toHaveBeenCalledTimes(1); // the ONE start() call above -- NOT startObservation() yet.

    controller.startObservation(200);
    expect(controller.getSnapshot().phase).toBe('observing');
    expect(tryAcquireSpy).toHaveBeenCalledTimes(1); // UNCHANGED -- M2: no second acquire when resuming from paused.

    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
  });
});

describe('didSweepController: M3 -- observation cadence math (binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a handful of fast responders sample at true ~1 Hz each (not degraded)', async () => {
    const script = new Map<number, ScriptEntry>([
      [0x0001, { responses: [positivePdu(0x0001, [0x01])], delayMs: 2 }],
      [0x0002, { responses: [positivePdu(0x0002, [0x02])], delayMs: 2 }],
      [0x0003, { responses: [positivePdu(0x0003, [0x03])], delayMs: 2 }],
    ]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    controller.start({ from: 0x0001, to: 0x0003 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(3);

    controller.startObservation(3_500); // ~3 rounds at true 1Hz.
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(controller.getSnapshot().observationCadenceDegraded).toBe(false);
  });

  it('many slow responders (N x RTT > 1s) report degraded cadence rather than silently slower sampling', async () => {
    const script = new Map<number, ScriptEntry>();
    const dids = Array.from({ length: 10 }, (_, i) => 0x2000 + i);
    for (const did of dids) script.set(did, { responses: [positivePdu(did, [0x01])], delayMs: 150 }); // 10 x 150ms = 1500ms/round > 1000ms target.
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    controller.start({ from: dids[0]!, to: dids[dids.length - 1]! });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(10);

    controller.startObservation(3_000);
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().observationCadenceDegraded).toBe(true);
  });
});

describe('didSweepController: pause/resume/stop/tagging (regression -- still correct under the new lifecycle)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps a small range, classifying each response, and reaches sweepComplete', async () => {
    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x64])], delayMs: 5 }], [0x0002, { responses: [negativePdu(0x11)], delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    controller.start({ from: 0x0000, to: 0x0003 });
    await vi.runAllTimersAsync();
    await flush();

    const final = controller.getSnapshot();
    expect(final.phase).toBe('sweepComplete');
    expect(final.responders).toHaveLength(1);
    expect(final.responders[0]!.did).toBe(0x0001);
    expect(final.nrcCounts[0x11]).toBe(1);
    expect(final.timeouts).toBe(2); // DIDs 0x0000, 0x0003 (unscripted).
  });

  it('an invalid range surfaces as an inline error (never throws), and never acquires the reservation', () => {
    const reservation = createEnetAdapterReservation();
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
    });
    expect(() => controller.start({ from: 10, to: 5 })).not.toThrow();
    expect(controller.getSnapshot().error).toMatch(/inverted/i);
    expect(controller.getSnapshot().phase).toBe('idle');
    expect(reservation.holder()).toBeNull();
  });

  it('after observation, buildTaggedSpec() writes a valid EnetChannelSpec matching enetSpecsFromSuggestion', async () => {
    // Pedal-like: fast bimodal steps. Each observation re-poll tick consumes
    // the NEXT response in this fixed list, in order -- `classifyResponders`
    // only needs >= 6 samples to score 'pedal' confidently.
    const pedalValues = [20, 20, 20, 220, 220, 220, 20, 20, 20, 220];
    const pedalScript = new Map<number, ScriptEntry>([
      [0x1e20, { responses: pedalValues.map((v) => positivePdu(0x1e20, [v])), mode: 'oneFramePerSend', delayMs: 1 }],
    ]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(pedalScript),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    controller.start({ from: 0x1e20, to: 0x1e20 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    controller.startObservation(3_000);
    await vi.runAllTimersAsync();
    await flush();

    const observed = controller.getSnapshot();
    expect(observed.phase).toBe('observationComplete');
    const suggestion = observed.suggestions.find((s) => s.did === 0x1e20);
    expect(suggestion).toBeDefined();

    const spec = controller.buildTaggedSpec(0x1e20, 'throttlePct', '2026-08-27');
    expect(spec).not.toBeNull();
    expect(spec!.channel).toBe('throttlePct');
    expect(spec!.mode).toBe('did');
    expect(spec!.requestHex).toBe('1E20');
  });

  it('buildTaggedSpec() returns null for a DID with no current suggestion', () => {
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    expect(controller.buildTaggedSpec(0x1234, 'rpm', '2026-08-27')).toBeNull();
  });

  it('stopObservationEarly() ends the window early and STILL classifies (observationComplete, never "stopped")', async () => {
    const script = new Map<number, ScriptEntry>([[0x0005, { responses: [positivePdu(0x0005, [0x50])], delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    controller.start({ from: 0x0005, to: 0x0005 });
    await vi.runAllTimersAsync();
    await flush();

    controller.startObservation(60_000);
    await flush(5);
    controller.stopObservationEarly();
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('observationComplete');
  });
});

/** Sanity check that the scripted PDUs above really parse the way this test file assumes. */
describe('didSweepController test fixtures: sanity', () => {
  it('positivePdu/negativePdu/wrongSidPdu round-trip through the real parseUdsResponse', () => {
    expect(parseUdsResponse(positivePdu(0x1e20, [0x14]))).toEqual({ kind: 'positive', sid: 0x62, data: Uint8Array.from([0x1e, 0x20, 0x14]) });
    expect(parseUdsResponse(negativePdu(0x11))).toEqual({ kind: 'negative', requestSid: 0x22, nrc: 0x11 });
    expect(parseUdsResponse(wrongSidPdu())).toEqual({ kind: 'positive', sid: 0x41, data: Uint8Array.from([0x0c, 0x12, 0x34]) });
  });
});
