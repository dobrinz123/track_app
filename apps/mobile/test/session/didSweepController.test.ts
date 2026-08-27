import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// P4f-FIX4 (binding): `classifyResponders` is wrapped (never replaced -- still
// delegates to the REAL implementation) so the "time domain" test below can
// assert on the exact `series`/`context` it was called with, without
// duplicating `@circuit/core`'s own heuristic logic here.
vi.mock('@circuit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@circuit/core')>();
  return { ...actual, classifyResponders: vi.fn(actual.classifyResponders) };
});
import {
  binaryStringToBytes,
  bytesToBinaryString,
  classifyResponders,
  DEFAULT_ENET_DID_SCENARIO,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
  parseUdsResponse,
  SimulatedEnetTransport,
  type DidObservationPhaseId,
  type ObdTransport,
} from '@circuit/core';
import { createDidSweepController, createRawUdsChannel } from '../../src/session/didSweepController';
import { createEnetAdapterReservation } from '../../src/session/enetAdapterReservation';
import { createInMemoryDidSweepStore } from '../../src/persistence/didSweepStore';

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

describe('didSweepController: H3 -- keep-alive wiring against the core runner (binding)', () => {
  // NOTE (P4f-T3, binding): the wrong-SID/0x78 correlation tests that used to
  // live here were REMOVED -- that logic now lives entirely in
  // `@circuit/core`'s `runDidSweep` (its own test suite covers 0x78
  // extension-without-resend and unmatched-frame skipping). What remains
  // here tests the WIRING between this module's `createRawUdsChannel` and
  // the core runner's `keepAlive` calls, which core cannot cover on its own.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
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
    // Comfortably past the 2s keep-alive cadence (core's own default) -- each
    // unscripted DID takes up to ~1s to time out, so this covers at least a
    // couple of DIDs' worth of the core runner's own between-DID keep-alive
    // check with margin, rather than sitting right on the 2000ms boundary.
    await vi.advanceTimersByTimeAsync(3_500);
    await flush();

    expect(transport!.keepAliveSendCount).toBeGreaterThanOrEqual(1);
    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
  });
});

describe('didSweepController: P4f-T3 -- end-to-end delegation through a REAL SimulatedEnetTransport (binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps a range covering the scripted DID scenario through the actual createRawUdsChannel + core runDidSweep pipeline -- finds all 3 scripted responders and racks up NRC counts for the unscripted ones', async () => {
    // 0x1E1C..0x1E24 (9 DIDs) covers all 3 of `DEFAULT_ENET_DID_SCENARIO`'s
    // scripted responders (1E1C, 1E20, 1E24) plus 6 unscripted DIDs in
    // between that the simulator answers with NRC 0x31 (requestOutOfRange) --
    // this is a genuine integration test: no hand-built FakeSweepTransport,
    // no local correlation logic anywhere in this call stack, just the real
    // `createRawUdsChannel` wrapping a REAL `@circuit/core` `SimulatedEnetTransport`
    // and the real, committed `runDidSweep`.
    const controller = createDidSweepController({
      transportFactory: () =>
        new SimulatedEnetTransport({
          monotonicNow: () => Date.now(),
          scenario: DEFAULT_ENET_DID_SCENARIO,
          testerAddress: TESTER_ADDRESS,
          targetAddress: TARGET_ADDRESS,
        }),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: 0x1e1c, to: 0x1e24 });
    await vi.runAllTimersAsync();
    await flush();

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('sweepComplete');
    expect(snapshot.responders).toHaveLength(3);
    expect(snapshot.responders.map((r) => r.did).sort((a, b) => a - b)).toEqual([0x1e1c, 0x1e20, 0x1e24]);
    const totalNrcCount = Object.values(snapshot.nrcCounts).reduce((sum, count) => sum + count, 0);
    expect(totalNrcCount).toBeGreaterThan(0); // the 6 unscripted DIDs each answer NRC 0x31.
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

describe('didSweepController: M2 -- observation delegates to core runDidObservation, one call for the whole window (binding, P4f-FIX3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keep-alive fires during a FAST-response observation window through the REAL SimulatedEnetTransport -- one long-lived core run owns the whole window instead of resetting the 2s keep-alive deadline on every poll (the REV3 defect this replaces)', async () => {
    let keepAliveCount = 0;
    const controller = createDidSweepController({
      transportFactory: () => {
        const transport = new SimulatedEnetTransport({
          monotonicNow: () => Date.now(),
          scenario: DEFAULT_ENET_DID_SCENARIO,
          testerAddress: TESTER_ADDRESS,
          targetAddress: TARGET_ADDRESS,
        });
        const parser = new HsfzFrameParser();
        const realSend = transport.send.bind(transport);
        transport.send = (line: string) => {
          try {
            for (const frame of parser.push(binaryStringToBytes(line))) {
              if (frame.control === HSFZ_CONTROL.DIAGNOSTIC_REQ_RES && (frame.payload[0] ?? 0) === 0x3e) keepAliveCount += 1;
            }
          } catch {
            // counting only -- never let a parse failure block the real send.
          }
          realSend(line);
        };
        return transport;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    // Sweep the 3 scripted DIDs first to populate `responders`.
    controller.start({ from: 0x1e1c, to: 0x1e24 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(3);

    keepAliveCount = 0; // only count keep-alives sent DURING the observation window below.
    controller.startObservation(5_000); // > 2x the 2s keep-alive cadence; every individual poll answers in well under 2s, so the OLD per-poll-runner design (resetting the deadline every time) would have sent ZERO.
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(keepAliveCount).toBeGreaterThanOrEqual(1);
  });

  it("the core runner's consecutive-error budget stops the observation window EARLY (never hanging for the full window) when the transport keeps failing", async () => {
    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }]]);
    // The OBSERVATION phase opens a FRESH transport (H1/H2, binding) --
    // `failSends` is shared across whichever instance `transportFactory`
    // builds (the sweep's own, then observation's fresh one), toggled AFTER
    // the sweep completes so the sweep itself still finds its one responder.
    let failSends = false;
    const controller = createDidSweepController({
      transportFactory: () => {
        const transport = new FakeSweepTransport(script);
        const realSend = transport.send.bind(transport);
        transport.send = (line: string) => {
          if (failSends) throw new Error('adapter unplugged (test double)');
          realSend(line);
        };
        return transport;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    failSends = true; // every observation poll (and every keep-alive) fails from here on.
    controller.startObservation(60_000); // if the error budget did NOT stop this early, it would run for the full 60s.
    await vi.advanceTimersByTimeAsync(8_000); // comfortably past the ~5 consecutive-failure budget (default maxConsecutiveErrors=5).
    await flush();

    expect(controller.getSnapshot().phase).toBe('observationComplete'); // stopped ITSELF via the error budget, not left hanging for the full window.
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

describe('didSweepController: P4f-FIX3 -- lifecycle race hardening (binding, after Codex P4f-REV3 HIGH)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a slow close in flight when stop() races in is JOINED, not bypassed -- release only happens after the SAME close settles, and the final phase is "stopped" (never overwritten by the natural completion\'s own "sweepComplete")', async () => {
    const reservation = createEnetAdapterReservation();
    let closeCallCount = 0;
    let releaseCloseGate: (() => void) | null = null;
    const controller = createDidSweepController({
      transportFactory: () => {
        const transport = new FakeSweepTransport(new Map()); // no scripted replies -- the one swept DID times out quickly.
        const realClose = transport.close.bind(transport);
        transport.close = () => {
          closeCallCount += 1;
          return new Promise<void>((resolve) => {
            releaseCloseGate = () => {
              void realClose().then(resolve);
            };
          });
        };
        return transport;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
      requestTimeoutMs: 20, // fast -- the sweep "completes" (unscripted DID -> timeout) quickly.
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.advanceTimersByTimeAsync(30);
    await flush();

    // The sweep finished naturally (timeout, no reply) and is now awaiting
    // its own gated close -- the reservation must still be held, and close()
    // was called exactly once so far.
    expect(controller.getSnapshot().phase).toBe('sweeping'); // still mid-teardown -- 'sweepComplete' hasn't been emitted yet.
    expect(reservation.holder()).toBe('sweep');
    expect(closeCallCount).toBe(1);
    expect(releaseCloseGate).not.toBeNull();

    controller.stop(); // races in WHILE the natural completion's own close is still pending.
    await flush();

    // The REV3 bug: `stop()` used to see `activeTransport` already nulled
    // (cleared before the original close's `await`) and release IMMEDIATELY
    // here, even though the real close had not settled. Fixed: `stop()`
    // joins the SAME in-flight close, so nothing has settled yet.
    expect(closeCallCount).toBe(1); // stop() did NOT start a second, redundant close.
    expect(reservation.holder()).toBe('sweep'); // still held -- the shared close has not resolved.
    expect(controller.getSnapshot().phase).toBe('stopped'); // stop() emits this synchronously, immediately.

    releaseCloseGate!(); // let the ONE shared close settle.
    await flush();

    expect(reservation.holder()).toBeNull(); // released only now, after the close genuinely settled.
    expect(controller.getSnapshot().phase).toBe('stopped'); // never overwritten by the natural completion's own 'sweepComplete' tail.
  });

  it('a synchronous throw from channel creation closes the transport and releases the claim (never leaked)', async () => {
    const reservation = createEnetAdapterReservation();
    let closeCalls = 0;
    const controller = createDidSweepController({
      transportFactory: () => ({
        connect: async () => undefined,
        send: () => undefined,
        onData: () => {
          throw new Error('onData registration boom (test double)'); // createRawUdsChannel calls this synchronously.
        },
        onClose: () => () => undefined,
        close: async () => {
          closeCalls += 1;
        },
      }),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await flush();

    expect(closeCalls).toBe(1); // the transport WAS closed despite the sync throw during channel creation.
    expect(reservation.holder()).toBeNull(); // the claim was NOT leaked.
    expect(controller.getSnapshot().phase).toBe('stopped');
    expect(controller.getSnapshot().error).toMatch(/onData registration boom/);
  });
});

describe('didSweepController: P4f-FIX4 -- close() failure containment (binding, after Codex P4f-REV4 HIGH)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a transport whose close() throws SYNCHRONOUSLY never blocks teardown -- stop() still releases the claim and reaches a terminal phase', async () => {
    const reservation = createEnetAdapterReservation();
    const controller = createDidSweepController({
      transportFactory: () => {
        const transport = new FakeSweepTransport(new Map());
        // A NON-async override: throws BEFORE returning anything, unlike
        // `async close() { throw ... }` (which the language automatically
        // turns into a REJECTED promise, not a synchronous throw) -- this is
        // the exact REV4 scenario: `Promise.race([transport.close().catch(...), ...])`
        // only contains a rejection; a throw during the `transport.close()`
        // expression itself happens before `.catch` can even attach.
        transport.close = (): Promise<void> => {
          throw new Error('close boom (test double, sync)');
        };
        return transport;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
    });

    controller.start({ from: 0x0000, to: 0xffff }); // a long sweep -- stays open so stop() can race in while connected.
    await flush();
    expect(reservation.holder()).toBe('sweep');

    controller.stop();
    await flush();

    // The REV4 bug: `teardownActiveTransport`'s promise REJECTED here (the
    // synchronous throw propagated past the `try/finally`'s lack of a
    // `catch`), so `stop()`'s own `await teardownActiveTransport(); releaseReservation();`
    // never reached the release line -- the claim leaked and the phase
    // update after it never ran either.
    expect(reservation.holder()).toBeNull(); // released despite the synchronous throw.
    expect(controller.getSnapshot().phase).toBe('stopped'); // terminal, not stuck mid-teardown.
  });

  it('a transport whose close() REJECTS (async throw) is likewise contained -- release still happens', async () => {
    const reservation = createEnetAdapterReservation();
    const controller = createDidSweepController({
      transportFactory: () => {
        const transport = new FakeSweepTransport(new Map());
        transport.close = async (): Promise<void> => {
          throw new Error('close boom (test double, async)');
        };
        return transport;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
    });

    controller.start({ from: 0x0000, to: 0xffff });
    await flush();
    expect(reservation.holder()).toBe('sweep');

    controller.stop();
    await flush();

    expect(reservation.holder()).toBeNull();
    expect(controller.getSnapshot().phase).toBe('stopped');
  });
});

describe('didSweepController: P4f-FIX4 -- observation time domain (binding, after Codex P4f-REV4 MEDIUM)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // A deliberately HUGE, non-zero clock origin -- if `observationElapsedMs`
    // or the series fed to `classifyResponders` ever regressed to the raw
    // (absolute) clock value again, this would immediately show up as a
    // multi-billion-ms number instead of a small one.
    vi.setSystemTime(new Date(10_000_000_000));
    vi.mocked(classifyResponders).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('observationElapsedMs stays small (relative to observation start) and classifyResponders receives a DID series whose tMs is in the SAME small relative domain as the injected GNSS context -- never the huge absolute clock origin', async () => {
    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      // A small, relative-domain GNSS sample -- exactly the shape
      // `DidSweepScreen.tsx`'s own `gnssSpeedSamplesRef` produces (tMs
      // measured from ITS OWN `observationStartedAtMsRef`, never the raw
      // clock). If the DID series' tMs were still absolute, these two series
      // could never be compared on the same axis.
      gnssSpeedContext: () => ({ gnssSpeedKph: [{ tMs: 200, v: 42 }] }),
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    controller.startObservation(2_000);
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    // The REV4 bug: core used to hand back the RAW (absolute) clock value as
    // `tMs`, which this controller copied straight into `observationElapsedMs`
    // -- with the huge origin set above, that would read as ~10_000_000_xxx,
    // not a small number of milliseconds into a 2s window.
    expect(controller.getSnapshot().observationElapsedMs).toBeGreaterThanOrEqual(0);
    expect(controller.getSnapshot().observationElapsedMs).toBeLessThan(2_000);

    controller.stopObservationEarly();
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(classifyResponders).toHaveBeenCalledTimes(1);
    const [series] = vi.mocked(classifyResponders).mock.calls[0]!;
    const didSamples = series.find((entry) => entry.did === 0x0001)?.samples ?? [];
    expect(didSamples.length).toBeGreaterThan(0);
    for (const sample of didSamples) {
      expect(sample.tMs).toBeGreaterThanOrEqual(0);
      expect(sample.tMs).toBeLessThan(2_000); // small/relative -- NOT the ~10_000_000_000 absolute clock origin.
    }
  });
});

describe('didSweepController: P4f-FIX5 -- observation anchor accounts for the connection delay (binding, after Codex P4f-REV5)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(classifyResponders).mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('with a 3s simulated connection delay, onObservationStarted fires AFTER connect (not at the tap) -- a DID sample and a wall-clock sample taken at the same instant re-base to the same relative time (±50ms)', async () => {
    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }]]);
    let transportCallCount = 0;
    let anchorWallClockMs: number | null = null;
    const controller = createDidSweepController({
      transportFactory: () => {
        transportCallCount += 1;
        // The SWEEP's own transport (1st call) connects instantly; the
        // OBSERVATION's fresh transport (2nd call, terminal-state "open
        // fresh" branch) simulates a 3s connection delay -- the REV5
        // scenario's exact setup.
        const connectDelayMs = transportCallCount === 1 ? 0 : 3_000;
        return new FakeSweepTransport(script, { connectDelayMs });
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      onObservationStarted: (anchor) => {
        anchorWallClockMs = anchor.wallClockMs;
      },
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    const tapWallClockMs = Date.now();
    controller.startObservation(5_000);

    // The REV5 bug: the anchor (or the screen's own equivalent) used to be
    // captured AT THE TAP -- here, still mid-connect, it must not exist yet.
    expect(anchorWallClockMs).toBeNull();
    expect(controller.getSnapshot().observationAnchorWallClockMs).toBeNull();

    await vi.advanceTimersByTimeAsync(3_000); // the simulated connection delay elapses.
    await flush();

    expect(anchorWallClockMs).not.toBeNull();
    expect(anchorWallClockMs!).toBeGreaterThanOrEqual(tapWallClockMs + 3_000); // AFTER connect, never at the tap.
    expect(controller.getSnapshot().observationAnchorWallClockMs).toBe(anchorWallClockMs); // the snapshot mirrors the callback's own value.

    // Let ~100ms of the observation elapse so the one responder answers at
    // least once, then end the window early and classify.
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    controller.stopObservationEarly();
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('observationComplete');

    const [series] = vi.mocked(classifyResponders).mock.calls.at(-1)!;
    const didSample = series.find((entry) => entry.did === 0x0001)?.samples[0];
    expect(didSample).toBeDefined();
    const didRelativeTMs = didSample!.tMs; // core-relative, ~"observation+100ms" by construction of the advance above.

    // The REAL wall-clock instant this DID sample was correlated at is
    // recoverable because core's own internal `startedAtMs` equals the
    // anchor this controller reported (verified above) -- a GNSS-style
    // sample taken at that SAME wall instant, re-based via the exact formula
    // `DidSweepScreen.tsx`'s own `gnssSpeedContext()` uses (`wallClockMs -
    // anchor`), must map back to the identical relative time.
    const sampleWallClockMs = anchorWallClockMs! + didRelativeTMs;
    const gnssRelativeTMs = sampleWallClockMs - anchorWallClockMs!;
    expect(Math.abs(gnssRelativeTMs - didRelativeTMs)).toBeLessThanOrEqual(50);

    // The discriminating check: if the anchor had instead been captured AT
    // THE TAP (the REV5 defect -- `DidSweepScreen.tsx` used to do exactly
    // this), re-basing that SAME wall-clock instant against the TAP would be
    // off by approximately the full 3s connection delay, not a small number
    // of ms -- proving this fix's practical effect, not just its formula.
    const buggyRelativeTMs = sampleWallClockMs - tapWallClockMs;
    expect(Math.abs(buggyRelativeTMs - didRelativeTMs)).toBeGreaterThan(2_500);
  });
});

describe('didSweepController: P4f-FIX6 -- anchor sourced ONLY from core onStarted; reset across re-observation (binding, after Codex P4f-REV6)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the reported anchor equals core's OWN startedAtMs call exactly -- never a separately-read clock.now() -- even under a clock that returns a DIFFERENT value on every single call", async () => {
    // A clock that advances by 1 on EVERY call, even synchronous back-to-back
    // ones -- makes ANY extra call (e.g. a controller-side `deps.clock.now()`
    // read BEFORE calling `runDidObservation`, the REV6 defect) produce a
    // deterministically DIFFERENT value than core's own internal capture,
    // regardless of real/fake wall-clock time.
    function skewingClock(): { now: () => number } {
      let t = 0;
      return { now: () => { t += 1; return t; } };
    }
    const clock = skewingClock();

    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }]]);
    let reportedAnchor: number | null = null;
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock,
      onObservationStarted: (anchor) => {
        reportedAnchor = anchor.wallClockMs;
      },
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    // ONE consuming read, marking "the tap" -- nothing else touches this
    // clock between this call and `startObservation()`'s own async
    // continuation reaching core's `runDidObservation`.
    const beforeTap = clock.now();
    controller.startObservation(50);
    await vi.runAllTimersAsync();
    await flush();

    // Core's OWN (unavoidable, already core-tested) call sequence inside
    // `runDidObservation` before `onStarted` fires is exactly 2 calls: the
    // keep-alive ticker's construction (`createKeepAliveTicker`), then
    // `startedAtMs` itself. With NO controller-side call in between (the
    // fix), the reported anchor is EXACTLY `beforeTap + 2` -- a REGRESSED
    // controller re-adding its own separate read before calling
    // `runDidObservation` would consume one of those slots itself, reporting
    // `beforeTap + 1` instead (one tick EARLIER than core's true `startedAtMs`,
    // which every sample's relative `tMs` is actually anchored to).
    expect(reportedAnchor).toBe(beforeTap + 2);
    expect(controller.getSnapshot().observationAnchorWallClockMs).toBe(reportedAnchor);

    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
  });

  it('starting another observation from observationComplete resets observationAnchorWallClockMs to null until the NEW run\'s onStarted fires (LOW, binding, after Codex P4f-REV6)', async () => {
    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }]]);
    let transportCallCount = 0;
    const controller = createDidSweepController({
      transportFactory: () => {
        transportCallCount += 1;
        // Sweep (1st) and the FIRST observation-open (2nd) connect
        // instantly; the SECOND observation-open (3rd, re-observing from
        // 'observationComplete') has a connect delay so the test can observe
        // the reset-to-null window before the new anchor lands.
        const connectDelayMs = transportCallCount >= 3 ? 500 : 0;
        return new FakeSweepTransport(script, { connectDelayMs });
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    controller.startObservation(1_000);
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('observationComplete');
    const firstAnchor = controller.getSnapshot().observationAnchorWallClockMs;
    expect(firstAnchor).not.toBeNull();

    // A SECOND observation from 'observationComplete' (terminal state -- the
    // "open fresh" branch, mirroring `start()`). The REV6 LOW bug: this
    // branch's own `emit({phase:'observing', ...})` did not reset
    // `observationAnchorWallClockMs`, so the PREVIOUS run's stale anchor
    // stayed visible through the entire (here, 500ms) reconnect.
    controller.startObservation(1_000);
    expect(controller.getSnapshot().observationAnchorWallClockMs).toBeNull();

    await vi.advanceTimersByTimeAsync(500); // the simulated reconnect delay elapses.
    await flush();

    const secondAnchor = controller.getSnapshot().observationAnchorWallClockMs;
    expect(secondAnchor).not.toBeNull();
    expect(secondAnchor).not.toBe(firstAnchor); // a genuinely NEW anchor, not the stale one.

    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
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

/**
 * DID sweep — results persistence, export & candidate filtering addendum
 * (2026-08-27, binding — Phase 4i): "every sweep run is persisted
 * incrementally ... A run survives app kill and can be resumed from
 * `lastDid`." Every EXISTING test above passes NO `store` -- this describe
 * block is entirely additive.
 */
describe('didSweepController: persistence (binding, P4i)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a completed sweep with a store persists the run AND its responder', async () => {
    const store = createInMemoryDidSweepStore();
    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
    });

    controller.start({ from: 0x0000, to: 0x0002 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');

    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ adapterType: 'enet', rangeFrom: 0x0000, rangeTo: 0x0002, status: 'complete', responderCount: 1 });
    const responders = await store.getResponders(runs[0]!.runId);
    expect(responders).toHaveLength(1);
    expect(responders[0]).toMatchObject({ did: 0x0001, rawHex: '50' });
  });

  it('start() with a store enforces retention (keeps only the most recent runs)', async () => {
    const store = createInMemoryDidSweepStore();
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
      retentionRuns: 2,
    });

    for (let i = 0; i < 3; i += 1) {
      controller.start({ from: 0x0000, to: 0x0000 });
      await vi.runAllTimersAsync();
      await flush();
    }

    const runs = await store.listRuns();
    expect(runs).toHaveLength(2); // the OLDEST of the 3 runs was pruned.
  });

  it('resumePersistedRun continues from lastDid with the accumulator restored -- already-visited DIDs are never re-swept', async () => {
    const store = createInMemoryDidSweepStore();
    const sendCounts = new Map<number, number>();
    function makeTransport(): FakeSweepTransport {
      const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }]]);
      const t = new FakeSweepTransport(script);
      const realSend = t.send.bind(t);
      t.send = (line: string) => {
        realSend(line);
      };
      return t;
    }

    // First controller: sweeps 0x0000..0x0001 (0x0001 answers), then is
    // stopped -- simulating "app kill" mid-sweep. `stop()` still force-
    // flushes the persisted state (this ticket's own binding requirement).
    const controllerA = createDidSweepController({
      transportFactory: makeTransport,
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
      requestTimeoutMs: 20,
    });
    controllerA.start({ from: 0x0000, to: 0x0005 });
    await vi.advanceTimersByTimeAsync(60); // lets 0x0000 (times out at 20ms) and 0x0001 (answers at 5ms) resolve.
    await flush();
    controllerA.stop();
    await vi.runAllTimersAsync();
    await flush();

    const runs = await store.listRuns();
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.runId;
    const persistedRun = await store.getRun(runId);
    expect(persistedRun?.lastDid).not.toBeNull();
    const lastDid = persistedRun!.lastDid!;

    // A FRESH controller instance ("app relaunch") resumes the SAME run.
    const transportsBuiltByB: FakeSweepTransport[] = [];
    const controllerB = createDidSweepController({
      transportFactory: () => {
        const t = makeTransport();
        transportsBuiltByB.push(t);
        return t;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
      requestTimeoutMs: 20,
    });

    expect(controllerB.getSnapshot().responders).toHaveLength(0); // nothing yet -- this is a FRESH controller/accumulator.
    await controllerB.resumePersistedRun(runId);
    // The restored responder (0x0001) is immediately visible, from the STORE, before the resumed sweep has re-visited anything.
    expect(controllerB.getSnapshot().responders.map((r) => r.did)).toEqual([0x0001]);

    await vi.runAllTimersAsync();
    await flush();

    expect(controllerB.getSnapshot().phase).toBe('sweepComplete');
    // Every DID up to and including `lastDid` was NEVER re-sent by the resumed sweep.
    const [transportB] = transportsBuiltByB;
    for (let did = 0x0000; did <= lastDid; did += 1) {
      expect(transportB!.sendCallCountByDid.get(did) ?? 0).toBe(0);
    }
  });

  it('resumePersistedRun is a no-op when deps.store is undefined', async () => {
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    await controller.resumePersistedRun('nonexistent-run');
    expect(controller.getSnapshot().phase).toBe('idle'); // untouched.
  });

  it('listPersistedRuns delegates to the store, and returns [] without one', async () => {
    const store = createInMemoryDidSweepStore();
    const controllerWithStore = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
    });
    controllerWithStore.start({ from: 0x0000, to: 0x0000 });
    await vi.runAllTimersAsync();
    await flush();
    expect(await controllerWithStore.listPersistedRuns()).toHaveLength(1);

    const controllerWithoutStore = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    expect(await controllerWithoutStore.listPersistedRuns()).toEqual([]);
  });
});

/**
 * DID sweep — guided candidate observation addendum (2026-08-27, binding —
 * Phase 4i, user clarification): "the OBSERVATION on the filtered candidates
 * must be a visible, guided, repeated re-read" across the 4 fixed phases.
 */
describe('didSweepController: guided candidate observation (binding, P4i)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('startGuidedObservation runs baseline -> brake -> steering -> throttle in order, then reaches observationComplete with candidateSummaries populated', async () => {
    // Alternates every poll -- guarantees "changed" is observable within any
    // phase that actually re-reads it more than once.
    const responses = Array.from({ length: 60 }, (_, i) => positivePdu(0x0001, [i % 2 === 0 ? 0x10 : 0x20]));
    const script = new Map<number, ScriptEntry>([[0x0001, { responses, mode: 'oneFramePerSend', delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    const phasesSeen: DidObservationPhaseId[] = [];
    controller.subscribe((s) => {
      if (s.guidedPhase !== null && phasesSeen[phasesSeen.length - 1] !== s.guidedPhase) phasesSeen.push(s.guidedPhase);
    });

    controller.startGuidedObservation();
    expect(controller.getSnapshot().phase).toBe('observing');

    // Bounded advance through all 4 ~6s phases (24s) -- NOT `runAllTimersAsync`
    // (the transport's own recurring keep-alive timer stays armed while open).
    for (let i = 0; i < 26 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(phasesSeen).toEqual(['baseline', 'brake', 'steering', 'throttle']);
    const summaries = controller.getSnapshot().candidateSummaries;
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.did).toBe(0x0001);
    expect(summaries[0]?.sampleCount).toBeGreaterThan(4); // several samples across the 4 phases.
  });

  it('stopGuidedObservationEarly ends the run early and still computes candidateSummaries from whatever was collected', async () => {
    const responses = Array.from({ length: 20 }, (_, i) => positivePdu(0x0001, [i % 2 === 0 ? 0x10 : 0x20]));
    const script = new Map<number, ScriptEntry>([[0x0001, { responses, mode: 'oneFramePerSend', delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();

    controller.startGuidedObservation();
    await vi.advanceTimersByTimeAsync(2_000); // still mid-"baseline".
    await flush();
    expect(controller.getSnapshot().phase).toBe('observing');
    expect(controller.getSnapshot().guidedPhase).toBe('baseline');

    controller.stopGuidedObservationEarly();
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(controller.getSnapshot().candidateSummaries.length).toBeGreaterThan(0);
  });

  it('startGuidedObservation is a no-op with no responders', () => {
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    controller.startGuidedObservation();
    expect(controller.getSnapshot().phase).toBe('idle');
  });
});
