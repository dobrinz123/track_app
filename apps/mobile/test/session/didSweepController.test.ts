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
  computeChangingValuePrePassDurationMs,
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
import { createInMemoryDidSweepStore, type DidSweepStore } from '../../src/persistence/didSweepStore';

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

/**
 * F1 fix (P4i-FIX1, binding, after Codex P4hrev2c) test support: wraps a real
 * `DidSweepStore` so a test can HOLD the NEXT `flushRunProgress` call
 * in-flight (never resolving until `release()`), then let a LATER call
 * proceed immediately -- lets tests interleave a controller action (a second
 * flush, a new `start()`) while an earlier flush is still pending, exactly
 * the race the ticket's HIGH finding describes ("A quick new Start while the
 * previous flush awaits storage...").
 */
function createGatedDidSweepStore(inner: DidSweepStore): {
  store: DidSweepStore;
  holdNextFlush: () => void;
  release: () => void;
  flushCalls: Array<{ runId: string; responderCount: number }>;
} {
  let gate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  let holdNext = false;
  const flushCalls: Array<{ runId: string; responderCount: number }> = [];
  const store: DidSweepStore = {
    ...inner,
    async flushRunProgress(runId, responders, patch, nowUtc) {
      flushCalls.push({ runId, responderCount: responders.length });
      if (holdNext) {
        holdNext = false;
        gate = new Promise((resolve) => {
          releaseGate = resolve;
        });
        await gate;
      }
      return inner.flushRunProgress(runId, responders, patch, nowUtc);
    },
  };
  return {
    store,
    holdNextFlush: () => {
      holdNext = true;
    },
    release: () => {
      releaseGate?.();
      releaseGate = null;
    },
    flushCalls,
  };
}

/**
 * X1/X2 fix (P4i-FIX3, binding) test support: wraps a real `DidSweepStore`
 * whose `flushRunProgress` calls FAIL (reject, never touching the inner
 * store) exactly on the call indices `failOnCallIndex` names -- every other
 * call proceeds to the real, underlying store. Every attempted call
 * (regardless of outcome) is recorded in `calls`, in order, with the exact
 * responder DIDs it tried to write -- lets a test assert PRECISELY which
 * slice each flush attempted, the ticket's own "A claims 0-1, B claims 1-2"
 * scenario.
 */
function createFlakyDidSweepStore(
  inner: DidSweepStore,
  failOnCallIndex: ReadonlySet<number>,
): { store: DidSweepStore; calls: Array<{ dids: number[] }> } {
  let callIndex = 0;
  const calls: Array<{ dids: number[] }> = [];
  const store: DidSweepStore = {
    ...inner,
    async flushRunProgress(runId, responders, patch, nowUtc) {
      const idx = callIndex;
      callIndex += 1;
      calls.push({ dids: responders.map((r) => r.did) });
      if (failOnCallIndex.has(idx)) throw new Error(`flush #${idx} boom (test double)`);
      return inner.flushRunProgress(runId, responders, patch, nowUtc);
    },
  };
  return { store, calls };
}

/**
 * X2 fix (P4i-FIX3, binding) test support: like {@link createGatedDidSweepStore},
 * but the ONE held call FAILS (rejects) once released, instead of succeeding
 * -- models "flush A hangs, then genuinely fails" (never reaching the real
 * underlying store for that one attempt). Every call after the held one
 * behaves normally (delegates straight to `inner`).
 */
function createHoldThenFailStore(inner: DidSweepStore): {
  store: DidSweepStore;
  holdNextFlush: () => void;
  release: () => void;
  calls: Array<{ dids: number[] }>;
} {
  let releaseGate: (() => void) | null = null;
  let holdNext = false;
  const calls: Array<{ dids: number[] }> = [];
  const store: DidSweepStore = {
    ...inner,
    async flushRunProgress(runId, responders, patch, nowUtc) {
      calls.push({ dids: responders.map((r) => r.did) });
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        throw new Error('disk full (test double)'); // the HELD call always fails once released.
      }
      return inner.flushRunProgress(runId, responders, patch, nowUtc);
    },
  };
  return {
    store,
    holdNextFlush: () => {
      holdNext = true;
    },
    release: () => {
      releaseGate?.();
      releaseGate = null;
    },
    calls,
  };
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
 * F1 fix (P4i-FIX1, binding, after Codex P4hrev2c HIGH finding #3): "flushes
 * are queued (serialized promise chain), run-scoped (each flush captures its
 * runId + index and is discarded if the controller moved to another run),
 * forced stop/complete flush is NEVER dropped (awaited, chained after the
 * active flush) ... batch window ≤ 1 s." These tests use a REAL (but gated/
 * delayed) store -- not the builder in isolation -- to reproduce the exact
 * races the finding describes.
 */
describe('didSweepController: persistence queueing/run-scoping (binding, P4i-FIX1 F1)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a forced flush is QUEUED behind an already in-flight one -- runs strictly AFTER it settles, never dropped, never concurrent', async () => {
    const gated = createGatedDidSweepStore(createInMemoryDidSweepStore());
    // A big, all-timeout range -- pause() lands mid-sweep (never reaches its
    // own natural completion), so the run stays 'paused' (not yet terminal)
    // right up until the test's own explicit stop().
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store: gated.store,
      requestTimeoutMs: 20,
    });

    controller.start({ from: 0x0000, to: 0xffff });
    await vi.advanceTimersByTimeAsync(1_200); // past the 1s batch window -- a periodic flush fires.
    await flush();
    expect(gated.flushCalls.length).toBeGreaterThanOrEqual(1); // at least one periodic flush has been ISSUED so far.

    gated.holdNextFlush(); // the NEXT flush call (pause()'s own forced one) will hang until released.
    controller.pause();
    // pause() only flips a flag read by the in-flight request loop -- the
    // phase transition (and its forced flush) lands once the CURRENT pending
    // DID's own timeout resolves and the loop notices, not synchronously.
    await vi.advanceTimersByTimeAsync(30);
    await flush();
    expect(controller.getSnapshot().phase).toBe('paused');
    const callsAfterPause = gated.flushCalls.length;
    expect(gated.flushCalls.length).toBeGreaterThanOrEqual(1);

    controller.stop(); // a SECOND forced flush, issued WHILE pause()'s own is still pending on the gate.
    await flush();
    // The stop() flush must be QUEUED behind the still-pending pause() flush
    // -- it CANNOT have started executing yet (the serialized tail runs the
    // pause() flush's continuation strictly BEFORE stop()'s), so the call
    // count is UNCHANGED right here -- proving queued-not-dropped is really
    // sequential, not silently skipped.
    expect(gated.flushCalls.length).toBe(callsAfterPause);

    gated.release(); // let the held (pause()) flush's storage write settle -- unblocks the queued stop() flush right after.
    await vi.runAllTimersAsync();
    await flush();

    // The stop() flush DID eventually run (queued, not dropped) -- the call
    // count grew, and the run's FINAL persisted status is 'stopped' (stop()'s
    // own status), landing strictly AFTER the pause() flush it was queued
    // behind.
    expect(gated.flushCalls.length).toBeGreaterThan(callsAfterPause);
    const runId = controller.getCurrentRunId()!;
    const persisted = await gated.store.getRun(runId);
    expect(persisted?.status).toBe('stopped');
  });
});

/**
 * F7 fix (P4i-FIX1, binding, after Codex P4hrev2c MEDIUM finding): "unmount
 * must not overwrite a naturally completed run with status `stopped` --
 * stop() is a no-op on completed; status transitions are monotone."
 */
describe('didSweepController: stop() is a no-op on any terminal state (binding, P4i-FIX1 F7)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calling stop() after a NATURAL sweepComplete never overwrites the persisted status back to "stopped"', async () => {
    const store = createInMemoryDidSweepStore();
    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');
    const runId = controller.getCurrentRunId()!;
    expect((await store.getRun(runId))?.status).toBe('complete');

    // Mirrors `DidSweepScreen.tsx`'s own unmount cleanup: `stop()` called
    // UNCONDITIONALLY, regardless of the current phase.
    controller.stop();
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('sweepComplete'); // untouched -- never flipped to 'stopped'.
    expect((await store.getRun(runId))?.status).toBe('complete'); // the persisted status is likewise untouched.
  });

  it('calling stop() after observationComplete is ALSO a no-op (never re-releases/re-emits)', async () => {
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
    controller.startObservation(50);
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('observationComplete');

    const snapshotsSeen: string[] = [];
    controller.subscribe((s) => snapshotsSeen.push(s.phase));
    controller.stop();
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('observationComplete'); // never flipped to 'stopped'.
    expect(snapshotsSeen.every((p) => p === 'observationComplete')).toBe(true); // stop() never re-emitted anything.
  });

  it('stop() still works normally (sets "stopped") from every NON-terminal phase -- idle and the terminal states are the ONLY no-ops', () => {
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    expect(controller.getSnapshot().phase).toBe('idle');
    controller.stop(); // idle -- a no-op (pre-existing behavior, unchanged).
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('a real kill (no stop()) inside the batch window resumes from the LAST actually-committed checkpoint -- never re-sending already-visited DIDs', async () => {
    const store = createInMemoryDidSweepStore();
    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], mode: 'oneFramePerSend', delayMs: 5 }]]);
    const controllerA = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
      requestTimeoutMs: 20,
    });

    controllerA.start({ from: 0x0000, to: 0x0005 });
    // Past the 1s batch window -- at least one periodic flush commits on its
    // own, with NO stop()/pause() ever called (models a real process kill:
    // the app just disappears, mid-sweep, with the periodic checkpoint being
    // the ONLY thing that survives).
    await vi.advanceTimersByTimeAsync(1_200);
    await flush();
    const runId = controllerA.getCurrentRunId()!;
    const committedBeforeKill = await store.getRun(runId);
    expect(committedBeforeKill?.lastDid).not.toBeNull(); // the periodic flush genuinely committed a checkpoint.
    const committedLastDid = committedBeforeKill!.lastDid!;
    // "Kill" -- simply stop touching controllerA. NEVER call stop()/pause().

    const transportsBuiltByB: FakeSweepTransport[] = [];
    const controllerB = createDidSweepController({
      transportFactory: () => {
        const t = new FakeSweepTransport(script);
        transportsBuiltByB.push(t);
        return t;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
      requestTimeoutMs: 20,
    });
    await controllerB.resumePersistedRun(runId);
    await vi.runAllTimersAsync();
    await flush();

    const [transportB] = transportsBuiltByB;
    for (let did = 0x0000; did <= committedLastDid; did += 1) {
      expect(transportB!.sendCallCountByDid.get(did) ?? 0).toBe(0); // never re-sent beyond the last COMMITTED checkpoint.
    }
  });

  it('an immediate new Start while the previous run\'s own completion flush still awaits storage never cross-writes the new run (no dropped/skipped responders)', async () => {
    const gated = createGatedDidSweepStore(createInMemoryDidSweepStore());
    let sweepCount = 0;
    const scriptA = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], mode: 'oneFramePerSend', delayMs: 5 }]]);
    const scriptB = new Map<number, ScriptEntry>([[0x0002, { responses: [positivePdu(0x0002, [0x60])], mode: 'oneFramePerSend', delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(sweepCount === 0 ? scriptA : scriptB),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store: gated.store,
    });

    gated.holdNextFlush(); // run A's OWN natural-completion ('complete') forced flush hangs until released.
    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');
    const runIdA = controller.getCurrentRunId()!;
    expect(gated.flushCalls).toHaveLength(1); // run A's completion flush -- in flight, held.

    // A quick new Start while that flush STILL awaits storage.
    sweepCount = 1;
    controller.start({ from: 0x0002, to: 0x0002 });
    await vi.runAllTimersAsync();
    await flush();
    const runIdB = controller.getCurrentRunId()!;
    expect(runIdB).not.toBe(runIdA);
    // Run B's own completion flush is QUEUED behind run A's still-pending
    // one -- it cannot have executed yet (the serialized tail is strictly
    // sequential), so only ONE call has actually reached the store so far.
    expect(gated.flushCalls).toHaveLength(1);

    gated.release(); // let run A's held flush settle -- unblocks run B's queued one right after.
    await vi.runAllTimersAsync();
    await flush();
    expect(gated.flushCalls.length).toBeGreaterThanOrEqual(2);

    // Run A's own persisted state is untouched by anything from run B --
    // the exact HIGH bug: "a quick new Start ... lets that old flush update
    // the new global currentRunId/accumulator and overwrite
    // lastPersistedResponderIndex, potentially marking the new run complete
    // and permanently skipping its responders."
    const persistedA = await gated.store.getRun(runIdA);
    expect(persistedA?.status).toBe('complete');
    const respondersA = await gated.store.getResponders(runIdA);
    expect(respondersA.map((r) => r.did)).toEqual([0x0001]); // never gained run B's 0x0002.

    // Run B reaches its OWN correct terminal state -- not silently marked
    // complete/skipped by a cross-write from run A's stale flush continuation.
    const persistedB = await gated.store.getRun(runIdB);
    expect(persistedB?.status).toBe('complete');
    const respondersB = await gated.store.getResponders(runIdB);
    expect(respondersB.map((r) => r.did)).toEqual([0x0002]); // run B's own responder was NOT dropped/skipped.
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

    const phasesSeen: Array<DidObservationPhaseId | 'prePass'> = [];
    controller.subscribe((s) => {
      if (s.guidedPhase !== null && phasesSeen[phasesSeen.length - 1] !== s.guidedPhase) phasesSeen.push(s.guidedPhase);
    });

    controller.startGuidedObservation();
    expect(controller.getSnapshot().phase).toBe('observing');

    // Bounded advance through the F2 pre-pass (round + ~2s gap + round, ~6s)
    // PLUS all 4 ~6s phases (24s), ~30s total -- NOT `runAllTimersAsync` (the
    // transport's own recurring keep-alive timer stays armed while open).
    for (let i = 0; i < 40 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    // F2 fix (binding): the two-sample changing-value pre-pass runs FIRST,
    // then the fixed 4-phase plan in order.
    expect(phasesSeen).toEqual(['prePass', 'baseline', 'brake', 'steering', 'throttle']);
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
    // F2 fix (binding): the pre-pass (round + ~2s gap + round, ~6s for a
    // single candidate) runs BEFORE "baseline" -- advance past it, then a
    // little further into baseline itself.
    await vi.advanceTimersByTimeAsync(6_500);
    await flush();
    expect(controller.getSnapshot().phase).toBe('observing');
    expect(controller.getSnapshot().guidedPhase).toBe('baseline');

    controller.stopGuidedObservationEarly();
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(controller.getSnapshot().candidateSummaries.length).toBeGreaterThan(0);
  });

  /**
   * F2 fix (P4i-FIX1, binding, after Codex P4hrev2c HIGH finding #4): "300
   * candidates at 15 req/s → phase length grows, every DID sampled ≥ 2× per
   * phase; cursor continuity across phases." Uses `resumePersistedRun` to
   * seed 300 responders directly (skipping an actual 300-DID sweep pass) --
   * the guided run itself still goes through the REAL pre-pass + phase
   * pipeline against a real (65ms/request, ~15.4 req/s) scripted transport.
   */
  it('300 candidates at ~15 req/s: the phase length grows well beyond the 6s base, and the cursor advances between phases instead of restarting at the front of the list', async () => {
    const DID_COUNT = 300;
    const dids = Array.from({ length: DID_COUNT }, (_, i) => 0x2000 + i);
    const store = createInMemoryDidSweepStore();
    await store.createRun({
      runId: 'run-300',
      adapterType: 'enet',
      targetAddress: TARGET_ADDRESS,
      rangeFrom: dids[0]!,
      rangeTo: dids[dids.length - 1]!,
      lastDid: dids[dids.length - 1]!, // already fully swept -- resuming re-sends NOTHING.
      startedAtUtc: '2026-08-27T18:00:00.000Z',
      updatedAtUtc: '2026-08-27T18:00:00.000Z',
      status: 'stopped',
      visitedCount: DID_COUNT,
      timeoutCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
      nrcCounts: {},
    });
    await store.upsertResponders(
      'run-300',
      dids.map((did) => ({ did, raw: Uint8Array.from([did % 2 === 0 ? 0x10 : 0x20]), rttMs: 65 })),
      '2026-08-27T18:00:05.000Z',
    );

    // Fast, deterministic responses -- the SIZING formula
    // (`computeGuidedPhaseDurationMs`) always assumes the SAME fixed ~15
    // req/s regardless of how fast this test's own transport actually
    // answers; what this test needs is simply that the pre-pass' own fixed
    // (also duration-formula-sized) window comfortably covers all 300
    // candidates twice, so the guided phases still see the FULL 300-DID set.
    const script = new Map<number, ScriptEntry>(
      dids.map((did) => [
        did,
        { responses: Array.from({ length: 8 }, (_, k) => positivePdu(did, [k % 2 === 0 ? 0x10 : 0x20])), mode: 'oneFramePerSend' as const, delayMs: 20 },
      ]),
    );
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
    });

    await controller.resumePersistedRun('run-300');
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');
    expect(controller.getSnapshot().responders).toHaveLength(DID_COUNT);

    controller.startGuidedObservation();
    await flush(); // lets the async connect+channel-creation continuation reach the pre-pass' own first `emit` (microtask-only, no timer needed).
    expect(controller.getSnapshot().guidedPhase).toBe('prePass');

    // Drain the pre-pass (round + ~2s gap + round -- each round
    // computeGuidedPhaseDurationMs(300, ..., 1) = ceil(300/15*1000) = 20s, so
    // ~42s total) in bounded steps (the keep-alive ticker stays armed).
    for (let i = 0; i < 50 && controller.getSnapshot().guidedPhase === 'prePass'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().guidedPhase).toBe('baseline'); // the pre-pass finished -- phases have begun.
    // F2 fix: "show it" -- the auto-raised duration is on the snapshot, and
    // it is MUCH larger than the fixed 6s base (300 candidates @ ~15 req/s
    // needs ~40s to guarantee 2 samples/candidate).
    expect(controller.getSnapshot().guidedPhaseDurationMs).toBeGreaterThan(30_000);

    for (let i = 0; i < 50 && controller.getSnapshot().guidedPhase === 'baseline'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().guidedPhase).toBe('brake'); // moved on to the next phase.

    const samplesSoFar = controller.getGuidedSamples();
    const baselineFirstDid = samplesSoFar.find((s) => s.phase === 'baseline')?.did;
    // Let a little of "brake" run so it has at least one sample of its own.
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    const brakeFirstDid = controller.getGuidedSamples().find((s) => s.phase === 'brake')?.did;

    expect(baselineFirstDid).toBeDefined();
    expect(brakeFirstDid).toBeDefined();
    // F2 fix (the "persistent cursor" requirement): "brake" does NOT restart
    // round-robin at the same DID "baseline" started at -- coverage
    // continues from wherever "baseline" left off. With 300 candidates and a
    // ~40s phase (only ~2 rounds), a naive non-rotating implementation would
    // restart both phases at the exact same first DID every time.
    expect(brakeFirstDid).not.toBe(baselineFirstDid);

    // Every candidate that answered got AT LEAST one sample across baseline
    // (not permanently starved the way the pre-fix "phase always restarts at
    // DID #1" defect left the tail of a large candidate list unsampled).
    const baselineDidsSeen = new Set(samplesSoFar.filter((s) => s.phase === 'baseline').map((s) => s.did));
    expect(baselineDidsSeen.size).toBeGreaterThan(DID_COUNT / 2); // a full ~2-round phase covers well over half in one round alone.

    controller.stopGuidedObservationEarly();
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('observationComplete');
  }, 20_000);

  /**
   * F3 fix (P4i-FIX1, binding, after Codex P4hrev2c HIGH finding #5):
   * "controller exposes `getGuidedSamples()` (per DID, per phase, relative
   * timestamps, raw hex)."
   */
  it('getGuidedSamples() returns every phase-tagged sample from the guided run -- never the pre-pass\' own two reads', async () => {
    const responses = Array.from({ length: 20 }, (_, i) => positivePdu(0x0001, [i % 2 === 0 ? 0x10 : 0x20]));
    const script = new Map<number, ScriptEntry>([[0x0001, { responses, mode: 'oneFramePerSend', delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    expect(controller.getGuidedSamples()).toEqual([]); // nothing yet.

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();

    controller.startGuidedObservation();
    for (let i = 0; i < 40 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().phase).toBe('observationComplete');

    const samples = controller.getGuidedSamples();
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.did === 0x0001)).toBe(true);
    // Every sample is tagged with one of the FOUR fixed phases -- the
    // pre-pass' own two reads are never phase-tagged/included here.
    const phaseIds = new Set(samples.map((s) => s.phase));
    for (const phaseId of phaseIds) expect(['baseline', 'brake', 'steering', 'throttle']).toContain(phaseId);
    for (const sample of samples) {
      expect(typeof sample.tMs).toBe('number');
      expect(sample.raw).toBeInstanceOf(Uint8Array);
    }
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

/**
 * F4 fix (P4i-FIX1, binding, after Codex P4hrev2c MEDIUM finding): "keep-alive
 * continuity: one TesterPresent ticker across the pre-pass and all phases ...
 * never > 2 s between keep-alives at phase boundaries. Test with fake clock."
 * Each guided phase (and the pre-pass' own two rounds) is still a SEPARATE
 * `runDidObservation` call with its OWN internal 2s ticker that resets at
 * every call boundary -- without a controller-owned ticker spanning the
 * whole sequence, the gap right at a phase boundary can reach roughly double
 * the per-call interval.
 */
describe('didSweepController: guided keep-alive continuity across the pre-pass and every phase (binding, P4i-FIX1 F4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the gap between successive TesterPresent frames never exceeds 2s, across the pre-pass -> baseline -> brake -> steering -> throttle sequence', async () => {
    const keepAliveTimestamps: number[] = [];
    const responses = Array.from({ length: 40 }, (_, i) => positivePdu(0x0001, [i % 2 === 0 ? 0x10 : 0x20]));
    const script = new Map<number, ScriptEntry>([[0x0001, { responses, mode: 'oneFramePerSend', delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => {
        const transport = new FakeSweepTransport(script);
        const parser = new HsfzFrameParser();
        const realSend = transport.send.bind(transport);
        transport.send = (line: string) => {
          try {
            for (const frame of parser.push(binaryStringToBytes(line))) {
              if (frame.control === HSFZ_CONTROL.DIAGNOSTIC_REQ_RES && (frame.payload[0] ?? 0) === 0x3e) keepAliveTimestamps.push(Date.now());
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

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();

    controller.startGuidedObservation();
    // Drain the pre-pass + all 4 phases (~30s worth) in bounded 1s steps --
    // NOT `runAllTimersAsync` (the keep-alive ticker stays armed while open).
    for (let i = 0; i < 40 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().phase).toBe('observationComplete');

    expect(keepAliveTimestamps.length).toBeGreaterThan(5); // spans the pre-pass and every phase boundary.
    for (let i = 1; i < keepAliveTimestamps.length; i += 1) {
      const gap = keepAliveTimestamps[i]! - keepAliveTimestamps[i - 1]!;
      expect(gap).toBeLessThanOrEqual(2_000); // "never > 2s between keep-alives at phase boundaries" (binding).
    }
  });
});

/**
 * Ticket P4i-FIX2 (Codex P4hrev3 H3 PARTIAL + 5 NEW MEDIUM). Every test below
 * targets one of R1-R6 and FAILS against the pre-fix `didSweepController.ts`.
 */
describe('didSweepController: R1 -- stop()/pause() await their own terminal flush (binding, P4i-FIX2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stop() resolves only AFTER its own terminal flush lands -- the phase still flips to "stopped" synchronously', async () => {
    const gated = createGatedDidSweepStore(createInMemoryDidSweepStore());
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store: gated.store,
      requestTimeoutMs: 20,
    });

    controller.start({ from: 0x0000, to: 0xffff });
    await vi.advanceTimersByTimeAsync(30);
    await flush();

    gated.holdNextFlush(); // stop()'s own forced flush hangs until released.
    let stopSettled = false;
    const stopPromise = controller.stop().then(() => {
      stopSettled = true;
    });
    await flush();

    expect(controller.getSnapshot().phase).toBe('stopped'); // the phase flip is unchanged -- immediate.
    expect(stopSettled).toBe(false); // but the returned promise has NOT resolved -- the checkpoint is still in flight.

    gated.release();
    await stopPromise;
    expect(stopSettled).toBe(true); // resolves once the write genuinely lands.
  });

  it('stop() resolves immediately when there is nothing to persist (no store)', async () => {
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    controller.start({ from: 0x0000, to: 0xffff });
    await flush();
    await expect(controller.stop()).resolves.toBeUndefined();
  });

  it('pause() resolves only AFTER the "paused" phase\'s own terminal flush commits', async () => {
    const gated = createGatedDidSweepStore(createInMemoryDidSweepStore());
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store: gated.store,
      requestTimeoutMs: 20,
    });

    controller.start({ from: 0x0000, to: 0xffff });
    await vi.advanceTimersByTimeAsync(30);
    await flush();

    gated.holdNextFlush(); // pause()'s own forced flush hangs until released.
    let pauseSettled = false;
    const pausePromise = controller.pause().then(() => {
      pauseSettled = true;
    });
    await vi.advanceTimersByTimeAsync(30); // lets the in-flight (timing-out) DID notice `control.paused`.
    await flush();

    expect(controller.getSnapshot().phase).toBe('paused'); // the phase flip is unchanged -- unblocked by the still-held flush.
    expect(pauseSettled).toBe(false);

    gated.release();
    await pausePromise;
    expect(pauseSettled).toBe(true);
    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
  });

  it('a pause() superseded by stop() before the sweep ever reaches "paused" still resolves (never hangs)', async () => {
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      requestTimeoutMs: 20,
    });
    controller.start({ from: 0x0000, to: 0xffff });
    await flush();

    let pauseSettled = false;
    const pausePromise = controller.pause().then(() => {
      pauseSettled = true;
    });
    controller.stop(); // supersedes the pause before it is ever noticed.
    await vi.runAllTimersAsync();
    await flush();
    await pausePromise;
    expect(pauseSettled).toBe(true);
  });

  // R1's "export document discloses the accepted resume bound" test lives in
  // `test/session/didSweepExport.test.ts` -- that file already mocks
  // `expo-file-system`/`expo-sharing` (required to import `didSweepExport.ts`
  // at all; this file does not, and does not need to for anything else it
  // tests).
});

/**
 * R3 (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "queued flushes can
 * double-count responder samples"): "Test: stalled periodic flush + forced
 * flush -> sampleCount 1" (the ticket's own literal scenario).
 */
describe('didSweepController: R3 -- no double-count on a forced flush queued behind a stalled periodic one (binding, P4i-FIX2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the one real responder is persisted with sampleCount 1, never 2, when a forced flush is queued behind a still-in-flight periodic one', async () => {
    const gated = createGatedDidSweepStore(createInMemoryDidSweepStore());
    const script = new Map<number, ScriptEntry>([[0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store: gated.store,
      requestTimeoutMs: 20,
    });

    gated.holdNextFlush(); // the periodic flush (first due, ~1s in) hangs until released.
    controller.start({ from: 0x0000, to: 0xffff }); // huge, all-timeout range -- never reaches natural completion here.
    await vi.advanceTimersByTimeAsync(1_200); // the scripted 0x0001 answers, and the 1s batch window elapses.
    await flush();
    expect(gated.flushCalls).toHaveLength(1);
    expect(gated.flushCalls[0]!.responderCount).toBe(1); // the periodic flush's own snapshot captured the one real responder.

    controller.pause(); // queues a SECOND (forced) flush behind the still-held periodic one.
    await vi.advanceTimersByTimeAsync(30);
    await flush();
    expect(controller.getSnapshot().phase).toBe('paused');
    expect(gated.flushCalls).toHaveLength(1); // the forced flush has NOT run yet -- strictly queued behind the held one.

    gated.release(); // let the periodic flush settle -- the forced flush runs immediately after.
    await vi.runAllTimersAsync();
    await flush();

    expect(gated.flushCalls).toHaveLength(2);
    // R3 (binding): the marker already advanced at the PERIODIC flush's own
    // snapshot time -- the forced flush's slice is therefore EMPTY. The
    // pre-fix bug re-sliced the SAME responder a second time here.
    expect(gated.flushCalls[1]!.responderCount).toBe(0);

    const runId = controller.getCurrentRunId()!;
    const responders = await gated.store.getResponders(runId);
    expect(responders).toHaveLength(1);
    expect(responders[0]!.sampleCount).toBe(1); // never double-counted.

    // Release the (default, module-shared) reservation -- this test left the
    // controller 'paused' (still holding it), which would otherwise starve
    // later tests in this file that rely on the SAME shared singleton.
    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
  });
});

/**
 * R4 (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "the new transactional
 * API can create orphan responder rows"): covered end-to-end at the store
 * level in `test/persistence/didSweepStore.test.ts` (`flushRunProgress`
 * never creates orphan responder rows when the run no longer exists).
 */

/**
 * R5 (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "the continuous
 * keep-alive ticker can produce an unhandled rejection"): "a failure ends the
 * guided sequence with a visible error and closes/releases cleanly (no
 * unhandled rejection). Test with a rejecting transport."
 */
describe('didSweepController: R5 -- a rejecting keep-alive ends the guided sequence cleanly (binding, P4i-FIX2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a TesterPresent send that throws surfaces a visible error, ends the guided run, and releases the reservation -- no unhandled rejection', async () => {
    const reservation = createEnetAdapterReservation();
    const responses = Array.from({ length: 30 }, (_, i) => positivePdu(0x0001, [i % 2 === 0 ? 0x10 : 0x20]));
    const script = new Map<number, ScriptEntry>([[0x0001, { responses, mode: 'oneFramePerSend', delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => {
        const transport = new FakeSweepTransport(script);
        const parser = new HsfzFrameParser();
        const realSend = transport.send.bind(transport);
        // Every TesterPresent (0x3E) send throws -- models a disconnected
        // ENET socket noticed only when the keep-alive ticker tries to write.
        transport.send = (line: string) => {
          const frames = parser.push(binaryStringToBytes(line));
          for (const frame of frames) {
            if (frame.control === HSFZ_CONTROL.DIAGNOSTIC_REQ_RES && (frame.payload[0] ?? 0) === 0x3e) {
              throw new Error('keep-alive send boom (test double)');
            }
          }
          realSend(line);
        };
        return transport;
      },
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      reservation,
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    controller.startGuidedObservation();
    for (let i = 0; i < 40 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }

    // Ends visibly (never hangs, never crashes the test via an unhandled
    // rejection) -- reaches observationComplete with an error set, and the
    // reservation is released like every other guided-sequence exit path.
    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(controller.getSnapshot().error).toMatch(/keep-alive/i);
    expect(reservation.holder()).toBeNull();
  });
});

/**
 * R6 (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "the new pre-pass
 * countdown is materially wrong"): real phase duration (2 rounds + gap,
 * scaled by candidate count) and advancing elapsed/countdown.
 */
describe('didSweepController: R6 -- the pre-pass countdown reflects the REAL duration and advances (binding, P4i-FIX2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('guidedPhaseDurationMs is the two-round-plus-gap total (never the old frozen 2000ms), and guidedPhaseElapsedMs advances through the gap between rounds', async () => {
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
    await flush();
    expect(controller.getSnapshot().guidedPhase).toBe('prePass');
    // computeGuidedPhaseDurationMs(1, 2000, 15, 1) = 2000 (floor stays at the
    // 2s base for a single candidate) -- total = 2000*2 + 2000(gap) = 6000.
    expect(controller.getSnapshot().guidedPhaseDurationMs).toBe(6_000);
    expect(controller.getSnapshot().guidedPhaseElapsedMs).toBe(0);

    // Past the first round (~2s) -- now inside the dead gap, where the
    // pre-fix controller never advanced elapsed time at all.
    await vi.advanceTimersByTimeAsync(3_000);
    await flush();
    expect(controller.getSnapshot().guidedPhase).toBe('prePass'); // still in the pre-pass (total is 6s).
    expect(controller.getSnapshot().guidedPhaseElapsedMs).toBeGreaterThan(2_000); // advanced past the first round, INTO the gap.
    expect(controller.getSnapshot().guidedPhaseElapsedMs).toBeLessThan(6_000);

    for (let i = 0; i < 40 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().phase).toBe('observationComplete');
  });

  it('300 candidates: guidedPhaseDurationMs during the pre-pass matches computeChangingValuePrePassDurationMs exactly', async () => {
    const DID_COUNT = 300;
    const dids = Array.from({ length: DID_COUNT }, (_, i) => 0x2000 + i);
    const store = createInMemoryDidSweepStore();
    await store.createRun({
      runId: 'run-300',
      adapterType: 'enet',
      targetAddress: TARGET_ADDRESS,
      rangeFrom: dids[0]!,
      rangeTo: dids[dids.length - 1]!,
      lastDid: dids[dids.length - 1]!,
      startedAtUtc: '2026-08-27T18:00:00.000Z',
      updatedAtUtc: '2026-08-27T18:00:00.000Z',
      status: 'stopped',
      visitedCount: DID_COUNT,
      timeoutCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
      nrcCounts: {},
    });
    await store.upsertResponders(
      'run-300',
      dids.map((did) => ({ did, raw: Uint8Array.from([did % 2 === 0 ? 0x10 : 0x20]), rttMs: 65 })),
      '2026-08-27T18:00:05.000Z',
    );
    const script = new Map<number, ScriptEntry>(
      dids.map((did) => [
        did,
        { responses: Array.from({ length: 8 }, (_, k) => positivePdu(did, [k % 2 === 0 ? 0x10 : 0x20])), mode: 'oneFramePerSend' as const, delayMs: 20 },
      ]),
    );
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
    });

    await controller.resumePersistedRun('run-300');
    await vi.runAllTimersAsync();
    await flush();

    controller.startGuidedObservation();
    await flush();
    expect(controller.getSnapshot().guidedPhase).toBe('prePass');
    // Each round: computeGuidedPhaseDurationMs(300, 2000, 15, 1) = ceil(300/15*1000) = 20000; total = 20000*2 + 2000 = 42000.
    expect(controller.getSnapshot().guidedPhaseDurationMs).toBe(computeChangingValuePrePassDurationMs(300, 2_000, 2_000));
    expect(controller.getSnapshot().guidedPhaseDurationMs).toBe(42_000);

    for (let i = 0; i < 60 && controller.getSnapshot().guidedPhase === 'prePass'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().guidedPhase).toBe('baseline'); // the pre-pass finished on schedule.

    controller.stopGuidedObservationEarly();
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('observationComplete');
  }, 20_000);
});

/**
 * R2 (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "guided export samples
 * leak across runs"): "Test: run A guided -> run B shared without guided ->
 * empty series" (the ticket's own literal scenario) -- moved to
 * `test/session/didSweepExport.test.ts` (needs `buildDidSweepExportForRun`,
 * which requires that file's `expo-file-system`/`expo-sharing` mocks; this
 * file imports neither). `getGuidedSamples()` itself resetting across a
 * fresh `start()` is still exercised directly wherever else it matters in
 * this file's own guided-observation tests above.
 */

/**
 * X1 (P4i-FIX3, binding, after Codex P4irev3 R1 PARTIAL): "stop()/pause()
 * reject (or resolve with {persisted:false, error}) when the terminal
 * flushRunProgress fails ... Natural completion: emit sweepComplete only
 * AFTER the terminal flush settles ... Tests: rejecting store on
 * stop/pause/complete."
 */
describe('didSweepController: X1 -- a failing terminal flush is VISIBLE, never silently swallowed (P4i-FIX3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stop() REJECTS when its own terminal flush fails, and snapshot.persistError is set -- the phase still flips to "stopped" synchronously (results stay in memory)', async () => {
    const failing = createFlakyDidSweepStore(createInMemoryDidSweepStore(), new Set([0])); // the ONE (and only) flush call this run ever issues fails.
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store: failing.store,
    });

    controller.start({ from: 0x0000, to: 0xffff });
    await flush();
    expect(controller.getSnapshot().persistError).toBeNull();

    await expect(controller.stop()).rejects.toThrow(/save failed/i);
    expect(controller.getSnapshot().phase).toBe('stopped'); // unchanged -- still synchronous.
    expect(controller.getSnapshot().persistError).toMatch(/disk full|boom/i);
  });

  it('pause() REJECTS when its own terminal flush fails, and snapshot.persistError is set', async () => {
    const failing = createFlakyDidSweepStore(createInMemoryDidSweepStore(), new Set([0]));
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store: failing.store,
      requestTimeoutMs: 20,
    });

    controller.start({ from: 0x0000, to: 0xffff });
    await flush();

    const pausePromise = controller.pause();
    // Attach the rejection matcher SYNCHRONOUSLY, before advancing any fake
    // timers -- so the promise is never briefly unobserved (no spurious
    // "handled asynchronously" warning) once it actually settles below.
    const rejection = expect(pausePromise).rejects.toThrow(/save failed/i);
    // pause() only flips a flag read by the in-flight request loop -- the
    // phase transition (and its forced flush) lands once the CURRENT pending
    // DID's own timeout resolves and the loop notices, not synchronously.
    await vi.advanceTimersByTimeAsync(30);
    await flush();
    await rejection;
    expect(controller.getSnapshot().phase).toBe('paused');
    expect(controller.getSnapshot().persistError).toMatch(/disk full|boom/i);

    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
  });

  it('natural completion issues its OWN terminal flush visibly ("persisting" -- the ticket\'s own "saving state" alternative) and surfaces the failure via persistError once it settles', async () => {
    let releaseGate: (() => void) | null = null;
    const store: DidSweepStore = {
      ...createInMemoryDidSweepStore(),
      async flushRunProgress() {
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        throw new Error('disk full (test double)');
      },
    };
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()), // 0x0001 unscripted -- times out quickly, reaching natural completion.
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
      requestTimeoutMs: 20,
    });

    controller.start({ from: 0x0001, to: 0x0001 });
    await vi.advanceTimersByTimeAsync(30); // the one DID times out -- the sweep is done, teardown begins, the terminal flush is now issued and HELD.
    await flush();

    // The phase itself flips synchronously (unchanged -- e.g. a fresh
    // `start()` must be able to re-acquire the reservation immediately, even
    // while THIS flush is still settling), but `persisting` says the
    // checkpoint itself is not done yet -- the ticket's own "(or emit a
    // saving state first)" alternative to delaying the phase.
    expect(controller.getSnapshot().phase).toBe('sweepComplete');
    expect(controller.getSnapshot().persisting).toBe(true);
    expect(controller.getSnapshot().persistError).toBeNull();
    expect(releaseGate).not.toBeNull();

    releaseGate!();
    await flush();

    expect(controller.getSnapshot().persisting).toBe(false); // settled now.
    expect(controller.getSnapshot().persistError).toMatch(/disk full/i);
  });
});

/**
 * X2 (P4i-FIX3, binding, after Codex P4irev3 R3 PARTIAL): "track claimed
 * slices per flush; on failure, mark THAT slice as unpersisted and re-queue
 * it (retry once) instead of Math.min on the shared marker; never
 * double-write slices claimed by later flushes. Test: A claims 0-1, B claims
 * 1-2, A fails, B succeeds -> next flush re-sends only slice A, sampleCount
 * of B's responder stays 1" (the ticket's own literal scenario).
 */
describe('didSweepController: X2 -- slice-aware retry never re-derives/double-writes a LATER flush\'s own claim (P4i-FIX3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('A claims [0x0001] and fails; B claims [0x0014] (queued behind A) and succeeds; the NEXT flush retries ONLY 0x0001 -- 0x0014 is never resent (sampleCount stays 1 for both)', async () => {
    const gated = createHoldThenFailStore(createInMemoryDidSweepStore());
    // 0x0014 (20) is deliberately FAR from 0x0001 -- pause() (called right
    // after 0x0001 answers, well before the sweep ever reaches 0x0014) is
    // what actually splits the two into separate flushes, not any timing
    // race with a second scripted responder landing in the SAME window. The
    // WHOLE test stays comfortably under `FLUSH_INTERVAL_MS` (1s) elapsed so
    // no incidental PERIODIC flush can slip in between A/B/C -- every call
    // below is filtered by its own `dids` content regardless, as a second
    // layer of robustness against exact call-count/position assumptions.
    const script = new Map<number, ScriptEntry>([
      [0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }],
      [0x0014, { responses: [positivePdu(0x0014, [0x60])], delayMs: 5 }],
    ]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store: gated.store,
      requestTimeoutMs: 20,
    });

    gated.holdNextFlush(); // the NEXT flush (pause()'s own forced one, below) hangs, then FAILS once released.
    controller.start({ from: 0x0000, to: 0xffff });
    await vi.advanceTimersByTimeAsync(30); // 0x0000 times out, 0x0001 answers.
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    // Flush A: forced (pause), claims JUST 0x0001 -- now held (about to fail).
    void controller.pause().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30); // lets the (unscripted, timing-out) in-flight DID notice `paused` -- 0x0014 is still far away, nowhere near reached.
    await flush();
    expect(controller.getSnapshot().phase).toBe('paused');
    expect(gated.calls).toHaveLength(1);
    expect(gated.calls[0]!.dids).toEqual([0x0001]);

    // Resume on the SAME transport/accumulator (M2) and let 0x0014 answer.
    controller.resume();
    await vi.advanceTimersByTimeAsync(700); // (0x14 - a few already-visited DIDs) worth of unscripted timeouts, plus generous margin -- stays well under the 1s periodic-flush threshold.
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(2);

    // Flush B: forced (pause again), claims JUST 0x0014 -- QUEUED behind the
    // still-held flush A (persistenceTail serializes them), so B's OWN claim
    // is captured now, at CALL time, before A's failure is even known.
    void controller.pause().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30);
    await flush();
    expect(gated.calls).toHaveLength(1); // B has not executed its own write yet -- still queued behind the held A.

    gated.release(); // A's write now proceeds and FAILS; B's (already-queued, already-sliced) write runs right after and succeeds.
    await flush();

    const callWith0x0014 = gated.calls.find((c) => c.dids.includes(0x0014));
    expect(callWith0x0014?.dids).toEqual([0x0014]); // B's claim, UNCHANGED by A's failure -- never folded/rolled back, never bundled with anything else.

    // Flush C: the retry -- resume then pause again (nothing NEW arrives),
    // forced anyway because a slice is awaiting its one retry.
    controller.resume();
    await vi.advanceTimersByTimeAsync(10);
    await flush();
    void controller.pause().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30);
    await flush();

    // ONLY the failed slice is ever retried -- 0x0014 is NEVER resent (never
    // appears in more than the ONE call found above).
    const callsWith0x0001 = gated.calls.filter((c) => c.dids.includes(0x0001));
    expect(callsWith0x0001).toHaveLength(2); // A's own (failed) attempt, then the retry.
    const callsWith0x0014 = gated.calls.filter((c) => c.dids.includes(0x0014));
    expect(callsWith0x0014).toHaveLength(1); // never resent.

    const runId = controller.getCurrentRunId()!;
    const responders = await gated.store.getResponders(runId);
    const r1 = responders.find((r) => r.did === 0x0001);
    const r2 = responders.find((r) => r.did === 0x0014);
    expect(r1?.sampleCount).toBe(1); // persisted exactly once (via the retry) -- A's own failed attempt never reached the real store.
    expect(r2?.sampleCount).toBe(1); // persisted exactly once (via B) -- never double-counted by the retry.

    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
  });
});

/**
 * X3 (P4i-FIX3, binding, after Codex P4irev3 R6 PARTIAL): "Pre-pass/phase
 * elapsed advances on a wall-clock ticker (250 ms) independent of onSample;
 * countdown reaches the advertised duration even with zero samples. Test
 * with fake timers and a transport that never answers."
 */
describe('didSweepController: X3 -- pre-pass/phase elapsed advances on a wall-clock ticker, even with zero samples (P4i-FIX3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Answers the target DID EXACTLY `answerCount` times (alternating bytes, so
   * `selectChangingCandidates`' own "changed" filter keeps it past the
   * pre-pass), then times out on every request after that -- lets a test
   * seed a candidate that survives the pre-pass (needs at least one answered
   * pair to be selected at all) while proving the FIXED phases afterward
   * (baseline/brake/steering/throttle) tick their own countdown purely from
   * the wall-clock ticker, with `onSample` never firing again.
   */
  function createLimitedAnswerTransport(targetDid: number, cutoffMs: number): ObdTransport {
    const dataListeners = new Set<(chunk: string) => void>();
    const parser = new HsfzFrameParser();
    const startedAtMs = Date.now(); // real (fake-timer-controlled) clock -- matches `deps.clock`'s own `Date.now()`.
    return {
      async connect(): Promise<void> {},
      send(line: string): void {
        let frames: ReturnType<HsfzFrameParser['push']>;
        try {
          frames = parser.push(binaryStringToBytes(line));
        } catch {
          return;
        }
        for (const frame of frames) {
          if (frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) continue;
          const pdu = frame.payload;
          if ((pdu[0] ?? 0) === 0x3e) continue; // TesterPresent -- no reply needed.
          if ((pdu[0] ?? 0) !== 0x22) continue;
          const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
          if (did !== targetDid) continue; // any other DID -- never scripted, times out.
          const elapsedMs = Date.now() - startedAtMs;
          if (elapsedMs >= cutoffMs) continue; // past the pre-pass window entirely -- times out from here on (the fixed phases below).
          // Different bytes either side of the pre-pass' own midpoint (round 1
          // vs round 2, across the dead gap) -- however many times THIS round
          // re-polls, so `selectChangingCandidates` sees a genuine change.
          const value = elapsedMs < cutoffMs / 2 ? 0x10 : 0x20;
          const responsePdu = Uint8Array.from([0x62, (did >> 8) & 0xff, did & 0xff, value]);
          const respFrame = encodeFrame({ control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES, source: TARGET_ADDRESS, target: TESTER_ADDRESS, payload: responsePdu });
          const chunk = bytesToBinaryString(respFrame);
          setTimeout(() => {
            for (const listener of [...dataListeners]) listener(chunk);
          }, 5);
        }
      },
      onData(cb: (chunk: string) => void): () => void {
        dataListeners.add(cb);
        return () => dataListeners.delete(cb);
      },
      onClose(): () => void {
        return () => undefined;
      },
      async close(): Promise<void> {},
    };
  }

  it('guidedPhaseElapsedMs reaches guidedPhaseDurationMs during the pre-pass -- and again during the fixed "baseline" phase -- once nothing answers (onSample never fires again)', async () => {
    const store = createInMemoryDidSweepStore();
    await store.createRun({
      runId: 'run-x3',
      adapterType: 'enet',
      targetAddress: TARGET_ADDRESS,
      rangeFrom: 0x0001,
      rangeTo: 0x0001,
      lastDid: 0x0001,
      startedAtUtc: '2026-08-28T00:00:00.000Z',
      updatedAtUtc: '2026-08-28T00:00:00.000Z',
      status: 'stopped',
      visitedCount: 1,
      timeoutCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
      nrcCounts: {},
    });
    await store.upsertResponders('run-x3', [{ did: 0x0001, raw: Uint8Array.from([0x10]), rttMs: 10 }], '2026-08-28T00:00:05.000Z');

    const controller = createDidSweepController({
      // Answers throughout the pre-pass window (6s -- both its rounds, so
      // 0x0001 survives the "changing value" filter and actually enters the
      // fixed phases below), then NEVER answers again -- proving those
      // phases' own countdown advances purely from the wall-clock ticker,
      // not `onSample`.
      transportFactory: () => createLimitedAnswerTransport(0x0001, 6_000),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
    });

    await controller.resumePersistedRun('run-x3');
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    controller.startGuidedObservation();
    await flush();
    expect(controller.getSnapshot().guidedPhase).toBe('prePass');
    const prePassDurationMs = controller.getSnapshot().guidedPhaseDurationMs;
    expect(prePassDurationMs).toBeGreaterThan(0);

    // Step through the ENTIRE pre-pass in small (ticker-aligned) increments --
    // the pre-fix bug: with nothing ever answering, `onSample` never fires,
    // so `guidedPhaseElapsedMs` stayed frozen at 0 for the two ROUNDS (only
    // the dead gap BETWEEN them ever ticked), never reaching the full total.
    let maxElapsedInPrePass = 0;
    for (let i = 0; i < Math.ceil(prePassDurationMs / 250) + 8 && controller.getSnapshot().guidedPhase === 'prePass'; i += 1) {
      await vi.advanceTimersByTimeAsync(250);
      await flush();
      if (controller.getSnapshot().guidedPhase === 'prePass') {
        maxElapsedInPrePass = Math.max(maxElapsedInPrePass, controller.getSnapshot().guidedPhaseElapsedMs);
      }
    }
    expect(controller.getSnapshot().guidedPhase).not.toBe('prePass'); // the pre-pass genuinely finished on schedule.
    expect(maxElapsedInPrePass).toBeGreaterThanOrEqual(prePassDurationMs - 300); // reached (within one tick of) the FULL advertised duration.

    // Same property for a FIXED phase (`DID_OBSERVATION_PHASES`, e.g.
    // "baseline") -- `runGuidedPhase`'s own ticker, not `onSample`.
    expect(controller.getSnapshot().guidedPhase).toBe('baseline');
    const baselineDurationMs = controller.getSnapshot().guidedPhaseDurationMs;
    let maxElapsedInBaseline = 0;
    for (let i = 0; i < Math.ceil(baselineDurationMs / 250) + 8 && controller.getSnapshot().guidedPhase === 'baseline'; i += 1) {
      await vi.advanceTimersByTimeAsync(250);
      await flush();
      if (controller.getSnapshot().guidedPhase === 'baseline') {
        maxElapsedInBaseline = Math.max(maxElapsedInBaseline, controller.getSnapshot().guidedPhaseElapsedMs);
      }
    }
    expect(controller.getSnapshot().guidedPhase).not.toBe('baseline');
    expect(maxElapsedInBaseline).toBeGreaterThanOrEqual(baselineDurationMs - 300);

    // Let the rest of the guided sequence (brake/steering/throttle) finish.
    for (let i = 0; i < 60 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().phase).toBe('observationComplete');
  });
});

/**
 * Y1 (P4i-FIX4, binding, after Codex P4irev4 X1 PARTIAL): "`persisting` must
 * reflect ALL outstanding flushes for the current run: keep a counter/set of
 * pending flush ids; emit persisting:false only when the count reaches zero
 * (a Resume while a pause flush is pending must not let an earlier
 * settlement clear the flag while a later flush is pending). Test: pause
 * (flush A pending, slow store) -> Resume -> natural completion queues B ->
 * A settles -> persisting stays true until B settles; Share stays disabled
 * until then" (the ticket's own literal scenario).
 */
describe('didSweepController: Y1 -- persisting reflects ALL outstanding flushes, not just the most recently settled one (P4i-FIX4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pause() flush A held -> resume() -> natural completion queues flush B -> A settles (still held B pending) -> persisting stays TRUE -- only flips false once B ALSO settles', async () => {
    const gated = createGatedDidSweepStore(createInMemoryDidSweepStore());
    const controller = createDidSweepController({
      // Nothing ever answers -- every DID times out, so `pause()` (called
      // while 0x0000 is still in flight) pauses before 0x0001 is ever
      // visited, and a subsequent `resume()` naturally completes as soon as
      // 0x0001 ALSO times out (the range is exactly {0x0000, 0x0001}).
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store: gated.store,
      requestTimeoutMs: 20,
    });

    gated.holdNextFlush(); // flush A (pause's own forced flush) hangs until released below -- a SLOW store, per the ticket's own scenario.
    controller.start({ from: 0x0000, to: 0x0001 });
    await vi.advanceTimersByTimeAsync(5); // 0x0000's request is issued and in flight -- pause() below races ahead of its own timeout.

    const pausePromise = controller.pause();
    await vi.advanceTimersByTimeAsync(30); // 0x0000 times out, the loop notices `paused`, finishSweepRun('paused') issues flush A (now held).
    await flush();
    expect(controller.getSnapshot().phase).toBe('paused');
    expect(controller.getSnapshot().persisting).toBe(true);
    expect(gated.flushCalls).toHaveLength(1); // flush A's own call has started (and is now held) -- 0x0001 was never visited.

    // Resume on the SAME transport/accumulator/generation (M2) -- `resume()`
    // never bumps `generation`, which is exactly what let the pre-fix bug
    // conflate A's and B's own settlements.
    gated.holdNextFlush(); // arm the hold for flush B too -- it will not actually be CALLED until A's own (still-held) write settles (persistenceTail serializes them).
    controller.resume();
    await vi.advanceTimersByTimeAsync(30); // 0x0001 (the only DID left) times out -- the plan is exhausted, natural completion fires.
    await flush();

    expect(controller.getSnapshot().phase).toBe('sweepComplete'); // phase flips synchronously, unchanged -- Share gating is on `persisting`, not `phase`.
    expect(controller.getSnapshot().persisting).toBe(true); // still saving -- flush A is held, flush B is QUEUED behind it (not yet even called).
    expect(gated.flushCalls).toHaveLength(1); // B has not executed its own write yet -- still queued behind the held A.

    gated.release(); // A's write now proceeds and SUCCEEDS; B's (queued) write starts right after, immediately hits the NEWLY re-armed hold.
    await flush();

    // THE FIX: A settling must never clear `persisting` while B is still
    // outstanding -- the pre-fix bug emitted `persisting: false` the instant
    // THIS (A's) flush settled, regardless of B.
    expect(gated.flushCalls).toHaveLength(2); // B's own call has now started (and is held).
    expect(controller.getSnapshot().persisting).toBe(true); // <-- the whole point of Y1: still true, B not done yet.
    expect(controller.getSnapshot().persistError).toBeNull(); // A's own result (success) -- never a stale failure.

    gated.release(); // B's write now proceeds and succeeds.
    await flush();

    expect(controller.getSnapshot().persisting).toBe(false); // BOTH settled now -- count reached zero.
    expect(controller.getSnapshot().persistError).toBeNull();
    await expect(pausePromise).resolves.toBeUndefined(); // pause()'s own promise resolves once ITS OWN flush (A) landed -- unaffected by B.

    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
  });
});

/**
 * Y2 test support: like {@link createHoldThenFailStore}, but holds-then-fails
 * the FIRST call, then (once released) fails the SECOND call IMMEDIATELY (no
 * hold needed -- by construction it is already serialized strictly after the
 * first via `persistenceTail`), then delegates every call after that straight
 * to `inner` (succeeds). This reproduces the ticket's own "A and B both fail"
 * scenario deterministically: B's own forced flush is invoked (and captures
 * its OWN, disjoint `newResponders` snapshot) WHILE A is still held -- i.e.
 * strictly BEFORE A's failure (and its `pendingRetrySlices` entry) exists --
 * exactly like the queued-behind-a-held-flush mechanics {@link createHoldThenFailStore}
 * already exercises for X2, just carried one flush further.
 */
function createHoldThenFailTwiceStore(inner: DidSweepStore): {
  store: DidSweepStore;
  calls: Array<{ dids: number[] }>;
  releaseA: () => void;
} {
  let releaseGate: (() => void) | null = null;
  let callIndex = 0;
  const calls: Array<{ dids: number[] }> = [];
  const store: DidSweepStore = {
    ...inner,
    async flushRunProgress(runId, responders, patch, nowUtc) {
      const idx = callIndex;
      callIndex += 1;
      calls.push({ dids: responders.map((r) => r.did) });
      if (idx === 0) {
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
        throw new Error('disk full (test double, A)');
      }
      if (idx === 1) throw new Error('disk full (test double, B)');
      return inner.flushRunProgress(runId, responders, patch, nowUtc);
    },
  };
  return {
    store,
    calls,
    releaseA: () => {
      releaseGate?.();
      releaseGate = null;
    },
  };
}

/**
 * Y2 (P4i-FIX4, binding, after Codex P4irev4 X2 PARTIAL): "failed slices are
 * a LIST (pendingRetrySlices[]), all retried once in the next flush (merged
 * into that flush's transaction), never overwritten. Test: A and B both fail
 * -> next flush re-sends both slices exactly once; sampleCount unchanged"
 * (the ticket's own literal scenario).
 */
describe('didSweepController: Y2 -- failed retry slices are a LIST -- two independently-failed flushes are BOTH retried, neither ever overwritten (P4i-FIX4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('A (0x0001) and B (0x0014) each fail on their OWN forced flush, queued back to back while A is still held; the NEXT flush folds in BOTH slices exactly once -- sampleCount stays 1 for each, never dropped, never double-counted', async () => {
    const failing = createHoldThenFailTwiceStore(createInMemoryDidSweepStore());
    const script = new Map<number, ScriptEntry>([
      [0x0001, { responses: [positivePdu(0x0001, [0x50])], delayMs: 5 }],
      [0x0014, { responses: [positivePdu(0x0014, [0x60])], delayMs: 5 }],
    ]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store: failing.store,
      requestTimeoutMs: 20,
    });

    controller.start({ from: 0x0000, to: 0xffff });
    await vi.advanceTimersByTimeAsync(30); // 0x0000 times out, 0x0001 answers.
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(1);

    // Flush A: forced (pause), claims JUST 0x0001 -- now HELD (about to fail).
    void controller.pause().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30); // lets the in-flight (unscripted) DID notice `paused`.
    await flush();
    expect(controller.getSnapshot().phase).toBe('paused');
    expect(failing.calls).toHaveLength(1);
    expect(failing.calls[0]!.dids).toEqual([0x0001]);

    // Resume on the SAME transport/accumulator (M2) and let 0x0014 answer --
    // A is STILL held (not yet failed), so `pendingRetrySlices` is still
    // empty and no periodic flush is "due by retry" during this window.
    controller.resume();
    await vi.advanceTimersByTimeAsync(700); // stays well under FLUSH_INTERVAL_MS (1s) elapsed since start.
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(2);

    // Flush B: forced (pause again), claims JUST 0x0014. A is STILL held, so
    // B's own snapshot (retrySlices=[], newResponders=[0x0014]) is captured
    // BEFORE A's failure -- and its own write is chained strictly AFTER A's
    // on `persistenceTail`, so it has not executed yet.
    void controller.pause().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30);
    await flush();
    expect(controller.getSnapshot().phase).toBe('paused');
    expect(failing.calls).toHaveLength(1); // B's own write has not run yet -- still queued behind the held A.

    // Release A: A's write proceeds and FAILS (pushing its own [0x0001]
    // slice); B's already-queued (already-sliced) write runs right after,
    // immediately, and ALSO FAILS (pushing its own [0x0014] slice). Pre-fix,
    // B's failure would OVERWRITE A's still-untouched `pendingRetrySlice` via
    // a raw assignment, losing 0x0001 forever; fixed, both now sit side by
    // side in the list.
    failing.releaseA();
    await flush();
    expect(failing.calls).toHaveLength(2);
    expect(failing.calls[0]!.dids).toEqual([0x0001]);
    expect(failing.calls[1]!.dids).toEqual([0x0014]);

    // Flush C: the retry -- resume then let one more (unscripted) DID time
    // out, which triggers a PERIODIC flush that is "due by retry" (both
    // slices are pending); this call SUCCEEDS and must fold in BOTH A and B.
    controller.resume();
    await vi.advanceTimersByTimeAsync(30);
    await flush();

    expect(failing.calls).toHaveLength(3);
    expect(failing.calls[2]!.dids).toEqual([0x0001, 0x0014]); // BOTH failed slices folded into the one retry attempt, in order, neither dropped.

    const runId = controller.getCurrentRunId()!;
    const responders = await failing.store.getResponders(runId);
    const r1 = responders.find((r) => r.did === 0x0001);
    const r2 = responders.find((r) => r.did === 0x0014);
    expect(r1?.sampleCount).toBe(1); // persisted exactly once (via the retry) -- A's own failed attempt never reached the real store.
    expect(r2?.sampleCount).toBe(1); // persisted exactly once (via the retry) -- B's own failed attempt never reached the real store either.

    controller.stop();
    await vi.runAllTimersAsync();
    await flush();
  });
});

/**
 * Ticket P4j (binding): "batched guided observation ... runs batch after
 * batch (progress 'Batch 3/8'), repeating the on-screen prompts per batch;
 * pause/stop-safe; export includes `batchIndex` and >= 5 samples per DID per
 * phase; keep-alive continuous across batches." Field evidence: a single
 * 128-candidate phase at ~9 req/s gave every DID only 1-2 samples/phase.
 */
describe('didSweepController: startBatchedObservation (ticket P4j, binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs batch by batch ("Batch index/total" progress), tags every sample with its own batchIndex, and reaches observationComplete with candidateSummaries populated', async () => {
    const did1 = 0x0001;
    const did2 = 0x0002;
    const responsesFor = (did: number) => Array.from({ length: 80 }, (_, i) => positivePdu(did, [i % 2 === 0 ? 0x10 : 0x20]));
    const script = new Map<number, ScriptEntry>([
      [did1, { responses: responsesFor(did1), mode: 'oneFramePerSend', delayMs: 5 }],
      [did2, { responses: responsesFor(did2), mode: 'oneFramePerSend', delayMs: 5 }],
    ]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: did1, to: did2 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().responders).toHaveLength(2);

    const batchIndicesSeen: number[] = [];
    controller.subscribe((s) => {
      if (s.batchIndex !== null && batchIndicesSeen[batchIndicesSeen.length - 1] !== s.batchIndex) batchIndicesSeen.push(s.batchIndex);
    });

    // batchSize: 1 -> 2 batches (one DID each); minSamplesPerPhase: 1 keeps
    // the scripted transport's per-phase duration small so the test finishes
    // in bounded fake-timer steps.
    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 1 });
    expect(controller.getSnapshot().phase).toBe('observing');
    expect(controller.getSnapshot().batchTotal).toBe(2);
    expect(controller.getSnapshot().batchIndex).toBe(0);

    for (let i = 0; i < 100 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    // Ticket: "runs batch after batch" -- BOTH batches actually ran, in order.
    expect(batchIndicesSeen).toEqual([0, 1]);
    // Reset once the whole batched run finishes.
    expect(controller.getSnapshot().batchIndex).toBeNull();
    expect(controller.getSnapshot().batchTotal).toBeNull();

    const samples = controller.getGuidedSamples();
    expect(samples.length).toBeGreaterThan(0);
    // Ticket: "export includes batchIndex" -- every sample is tagged with the
    // batch its OWN DID belonged to (did1 -> batch 0, did2 -> batch 1).
    expect(samples.filter((s) => s.did === did1).every((s) => s.batchIndex === 0)).toBe(true);
    expect(samples.filter((s) => s.did === did2).every((s) => s.batchIndex === 1)).toBe(true);

    expect(controller.getSnapshot().candidateSummaries.map((c) => c.did).sort()).toEqual([did1, did2]);
  }, 20_000);

  it('is pause/stop-safe: stopGuidedObservationEarly ends the batched run early and still computes candidateSummaries from whatever was sampled', async () => {
    const did1 = 0x0001;
    const did2 = 0x0002;
    const responsesFor = (did: number) => Array.from({ length: 80 }, (_, i) => positivePdu(did, [i % 2 === 0 ? 0x10 : 0x20]));
    const script = new Map<number, ScriptEntry>([
      [did1, { responses: responsesFor(did1), mode: 'oneFramePerSend', delayMs: 5 }],
      [did2, { responses: responsesFor(did2), mode: 'oneFramePerSend', delayMs: 5 }],
    ]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: did1, to: did2 });
    await vi.runAllTimersAsync();
    await flush();

    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 1 });
    // Let the FIRST batch's baseline phase run a little, then cut the whole
    // sequence short -- the SECOND batch must never run.
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(controller.getSnapshot().phase).toBe('observing');
    expect(controller.getSnapshot().batchIndex).toBe(0);

    controller.stopGuidedObservationEarly();
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(controller.getSnapshot().batchIndex).toBeNull();
    // Only did1 (batch 0) ever ran -- batch 1 (did2) never started.
    const samples = controller.getGuidedSamples();
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.did === did1)).toBe(true);
  });

  it('a full stop() during a batched run tears down cleanly (H1/H2 lifecycle unchanged)', async () => {
    const did1 = 0x0001;
    const responses = Array.from({ length: 40 }, (_, i) => positivePdu(did1, [i % 2 === 0 ? 0x10 : 0x20]));
    const script = new Map<number, ScriptEntry>([[did1, { responses, mode: 'oneFramePerSend', delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: did1, to: did1 });
    await vi.runAllTimersAsync();
    await flush();

    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(controller.getSnapshot().phase).toBe('observing');

    await controller.stop();
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('stopped');
  });

  it('is a no-op with no candidates after filtering (e.g. every responder is ASCII-like)', async () => {
    const asciiBytes = Uint8Array.from('SW1.2.34'.split('').map((c) => c.charCodeAt(0)));
    const store = createInMemoryDidSweepStore();
    await store.createRun({
      runId: 'run-ascii-only',
      adapterType: 'enet',
      targetAddress: TARGET_ADDRESS,
      rangeFrom: 0x4098,
      rangeTo: 0x4098,
      lastDid: 0x4098,
      startedAtUtc: '2026-08-29T10:00:00.000Z',
      updatedAtUtc: '2026-08-29T10:00:00.000Z',
      status: 'stopped',
      visitedCount: 1,
      timeoutCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
      nrcCounts: {},
    });
    await store.upsertResponders('run-ascii-only', [{ did: 0x4098, raw: asciiBytes, rttMs: 10 }], '2026-08-29T10:00:01.000Z');
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
      store,
    });
    await controller.resumePersistedRun('run-ascii-only');
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');

    controller.startBatchedObservation();
    expect(controller.getSnapshot().phase).toBe('sweepComplete'); // unchanged -- no-op.
  });

  it('is a no-op with no responders at all', () => {
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(new Map()),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    controller.startBatchedObservation();
    expect(controller.getSnapshot().phase).toBe('idle');
  });
});

/**
 * Ticket P4j (binding): "FOCUSED observation: the user can tick candidates
 * (or type DIDs) -> one long guided cycle on the shortlist only (>= 10
 * samples per phase)."
 */
describe('didSweepController: startFocusedObservation (ticket P4j, binding)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is refused from idle (same precondition as startGuidedObservation) -- a typed DID alone is not enough without a prior sweep', () => {
    const did = 0x2222;
    const responses = Array.from({ length: 80 }, (_, i) => positivePdu(did, [i % 2 === 0 ? 0x10 : 0x20]));
    const script = new Map<number, ScriptEntry>([[did, { responses, mode: 'oneFramePerSend', delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    expect(controller.getSnapshot().phase).toBe('idle');
    controller.startFocusedObservation([did]);
    expect(controller.getSnapshot().phase).toBe('idle');
  });

  it('runs over a shortlist from a completed sweep, tagging no batchIndex, and reaching observationComplete with candidateSummaries', async () => {
    const did1 = 0x3001;
    const did2 = 0x3002;
    const responsesFor = (d: number) => Array.from({ length: 80 }, (_, i) => positivePdu(d, [i % 2 === 0 ? 0x10 : 0x20]));
    const script = new Map<number, ScriptEntry>([
      [did1, { responses: responsesFor(did1), mode: 'oneFramePerSend', delayMs: 5 }],
      [did2, { responses: responsesFor(did2), mode: 'oneFramePerSend', delayMs: 5 }],
    ]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });

    controller.start({ from: did1, to: did2 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');

    // The user ticks only did1 (the shortlist) -- did2 is deliberately
    // excluded, even though it's a valid responder.
    controller.startFocusedObservation([did1]);
    expect(controller.getSnapshot().phase).toBe('observing');
    expect(controller.getSnapshot().batchIndex).toBeNull();
    expect(controller.getSnapshot().batchTotal).toBeNull();

    for (let i = 0; i < 60 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().phase).toBe('observationComplete');

    const samples = controller.getGuidedSamples();
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((s) => s.did === did1)).toBe(true); // did2 never sampled -- it wasn't on the shortlist.
    expect(samples.every((s) => s.batchIndex === undefined)).toBe(true); // focused observation never batches.
    expect(controller.getSnapshot().candidateSummaries.map((c) => c.did)).toEqual([did1]);
  }, 20_000);

  it('deduplicates and validates typed DIDs -- invalid values (negative, > 0xFFFF, non-integer) are dropped; an all-invalid list is a no-op', async () => {
    const did1 = 0x3001;
    const script = new Map<number, ScriptEntry>([[did1, { responses: [positivePdu(did1, [0x10])], mode: 'oneFramePerSend', delayMs: 5 }]]);
    const controller = createDidSweepController({
      transportFactory: () => new FakeSweepTransport(script),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: monotonicCounter(),
    });
    controller.start({ from: did1, to: did1 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');

    controller.startFocusedObservation([-1, 0x10000, 1.5]);
    expect(controller.getSnapshot().phase).toBe('sweepComplete'); // unchanged -- every value was invalid, so this is a no-op.

    controller.startFocusedObservation([did1, did1, did1]); // deduplicated to one DID.
    expect(controller.getSnapshot().phase).toBe('observing');
    controller.stopGuidedObservationEarly();
    await vi.runAllTimersAsync();
    await flush();
  });
});
