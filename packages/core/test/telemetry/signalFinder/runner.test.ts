import { describe, expect, it } from 'vitest';
import {
  FINDER_MISSES_BEFORE_BACKOFF,
  FINDER_REQUEST_TIMEOUT_MS,
  runFinderRound,
  summarizeFinderProbe,
  type FinderRoundResult,
} from '../../../src/telemetry/signalFinder';
import type { SweepTransport } from '../../../src/telemetry/enet/didSweep';

/**
 * Ticket P4m-FIX1 X1/X2/X3 (Codex P4m-REV1 findings 1, 2, 3 — all HIGH).
 *
 *  X1 "Measure, never assume": a ~2 s PROBE reads every planned DID once per
 *      ECU and yields the MEASURED request rate plus per-ECU liveness.
 *  X2 "A silent ECU must not starve the live one": a per-DID request timeout
 *      of 300 ms and a back-off after 3 consecutive misses (the same numbers
 *      `enetSession.ts` uses for a binding-sourced entry, N5).
 *  X3 "Only ATTEMPTED (ecu,did) keys count as read": the runner returns the
 *      keys it actually sent a request for, so a stopped/partial round leaves
 *      everything else in `notRead` instead of inflating "no response".
 *
 * The runner is also what makes X4 possible: it polls COMPOSITE (ecu, did)
 * entries over one channel per ECU, so the same DID number on two ECUs is one
 * round, not two.
 */

const REQUEST_TIMEOUT_MS = 40;

type Answer = Uint8Array | 'nrc' | 'silent';

/** A per-ECU `SweepTransport` double: correlates by the DID the request carried, exactly like `createRawUdsChannel` + a real ECU. */
function makeChannel(
  ecu: number,
  answer: (ecu: number, did: number) => Answer,
  log: { requests: Array<{ ecu: number; did: number }>; keepAlives: number },
): SweepTransport {
  const queue: Uint8Array[] = [];
  return {
    async send(pdu: Uint8Array): Promise<void> {
      const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
      log.requests.push({ ecu, did });
      const result = answer(ecu, did);
      if (result === 'silent') return;
      queue.push(
        result === 'nrc'
          ? Uint8Array.from([0x7f, 0x22, 0x31])
          : Uint8Array.from([0x62, (did >> 8) & 0xff, did & 0xff, ...result]),
      );
    },
    nextResponse(timeoutMs: number): Promise<Uint8Array | 'timeout'> {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise((resolve) => setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs)));
    },
    async keepAlive(): Promise<void> {
      log.keepAlives += 1;
    },
  };
}

function harness(answer: (ecu: number, did: number) => Answer, ecus: readonly number[]) {
  const log = { requests: [] as Array<{ ecu: number; did: number }>, keepAlives: 0 };
  const channels = new Map<number, SweepTransport>();
  for (const ecu of ecus) channels.set(ecu, makeChannel(ecu, answer, log));
  return { channels, log };
}

const CLOCK = { now: (): number => Date.now() };

describe('runFinderRound -- composite (ecu, did) polling (X4) and attempted keys (X3)', () => {
  it('polls the SAME DID number on two ECUs inside ONE round and keeps the series apart', async () => {
    const { channels } = harness(
      (ecu) => Uint8Array.from([ecu === 0x12 ? 0x11 : 0x22]),
      [0x12, 0x29],
    );
    const result = await runFinderRound({
      entries: [
        { ecu: 0x12, did: 0x500c },
        { ecu: 0x29, did: 0x500c },
      ],
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 200,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    expect(result.attempted).toEqual([
      { ecu: 0x12, did: 0x500c },
      { ecu: 0x29, did: 0x500c },
    ]);
    const dme = result.samples.filter((s) => s.ecu === 0x12);
    const other = result.samples.filter((s) => s.ecu === 0x29);
    expect(dme.length).toBeGreaterThan(0);
    expect(other.length).toBeGreaterThan(0);
    expect([...new Set(dme.map((s) => s.raw[0]))]).toEqual([0x11]);
    expect([...new Set(other.map((s) => s.raw[0]))]).toEqual([0x22]);
  });

  it('returns ONLY the keys it actually requested -- a stop mid-round leaves the rest untouched (X3)', async () => {
    const control = { paused: false, stopped: false };
    const { channels } = harness((_ecu, did) => {
      if (did === 0x4002) control.stopped = true; // stop as soon as the first DID is asked for.
      return Uint8Array.from([0x01]);
    }, [0x12]);
    const result = await runFinderRound({
      entries: [
        { ecu: 0x12, did: 0x4002 },
        { ecu: 0x12, did: 0x4007 },
        { ecu: 0x12, did: 0x4659 },
      ],
      channels,
      clock: CLOCK,
      control,
      durationMs: 500,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    expect(result.attempted).toEqual([{ ecu: 0x12, did: 0x4002 }]);
  });

  it('an entry whose ECU has no channel is never attempted', async () => {
    const { channels } = harness(() => Uint8Array.from([0x01]), [0x12]);
    const result = await runFinderRound({
      entries: [
        { ecu: 0x12, did: 0x4002 },
        { ecu: 0x30, did: 0x4002 },
      ],
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 150,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    expect(result.attempted).toEqual([{ ecu: 0x12, did: 0x4002 }]);
  });
});

describe('runFinderRound -- a silent ECU must not starve the live one (X2)', () => {
  it('backs off a DID after 3 consecutive misses, and the live ECU keeps its samples', async () => {
    const { channels, log } = harness(
      (ecu) => (ecu === 0x29 ? 'silent' : Uint8Array.from([0x01])),
      [0x12, 0x29],
    );
    const result = await runFinderRound({
      entries: [
        { ecu: 0x29, did: 0x500c },
        { ecu: 0x29, did: 0x500b },
        { ecu: 0x12, did: 0x4002 },
      ],
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 900,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    // Each silent DID is asked at most `FINDER_MISSES_BEFORE_BACKOFF` times...
    for (const did of [0x500c, 0x500b]) {
      const asked = log.requests.filter((r) => r.ecu === 0x29 && r.did === did).length;
      expect(asked).toBe(FINDER_MISSES_BEFORE_BACKOFF);
    }
    expect(result.backedOff).toEqual([
      { ecu: 0x29, did: 0x500c },
      { ecu: 0x29, did: 0x500b },
    ]);
    // ...while the answering DME keeps being polled for the whole window.
    const dmeSamples = result.samples.filter((s) => s.ecu === 0x12).length;
    expect(dmeSamples).toBeGreaterThan(FINDER_MISSES_BEFORE_BACKOFF);
    expect(result.respondingEcus).toEqual([0x12]);
  });

  it('defaults the per-DID request timeout to the 300 ms telemetryProvider/enetSession N5 number', () => {
    expect(FINDER_REQUEST_TIMEOUT_MS).toBe(300);
    expect(FINDER_MISSES_BEFORE_BACKOFF).toBe(3);
  });

  it('an NRC is an ANSWER (the ECU is alive), never a miss', async () => {
    const { channels, log } = harness((ecu) => (ecu === 0x29 ? 'nrc' : Uint8Array.from([0x01])), [0x12, 0x29]);
    const result = await runFinderRound({
      entries: [
        { ecu: 0x29, did: 0x500c },
        { ecu: 0x12, did: 0x4002 },
      ],
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 300,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    expect(result.backedOff).toEqual([]);
    expect(result.respondingEcus).toEqual([0x12, 0x29]);
    expect(log.requests.filter((r) => r.ecu === 0x29).length).toBeGreaterThan(FINDER_MISSES_BEFORE_BACKOFF);
    expect(result.samples.some((s) => s.ecu === 0x29)).toBe(false);
  });
});

describe('runFinderRound -- the probe (X1)', () => {
  it('one pass over every planned DID, and the measured rate comes from the exchanges that ANSWERED', async () => {
    const { channels, log } = harness(() => Uint8Array.from([0x01]), [0x12]);
    const result = await runFinderRound({
      entries: [
        { ecu: 0x12, did: 0x4002 },
        { ecu: 0x12, did: 0x4007 },
      ],
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 2_000,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxPasses: 1,
    });
    expect(log.requests).toHaveLength(2);
    expect(result.answeredCount).toBe(2);
    const summary = summarizeFinderProbe(result, [{ ecu: 0x12, did: 0x4002 }, { ecu: 0x12, did: 0x4007 }], 15.8);
    expect(summary.rateSource).toBe('measured');
    expect(summary.reqPerSec).toBeGreaterThan(0);
    expect(summary.silentEcus).toEqual([]);
    expect(summary.liveEcus).toEqual([0x12]);
  });

  it('an ECU that answered NOTHING in the probe is silent; a probe that measured nothing reports rateSource "assumed"', async () => {
    const { channels } = harness(() => 'silent', [0x12, 0x29]);
    const result = await runFinderRound({
      entries: [
        { ecu: 0x12, did: 0x4002 },
        { ecu: 0x29, did: 0x500c },
      ],
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 1_000,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxPasses: 1,
    });
    const summary = summarizeFinderProbe(result, [{ ecu: 0x12, did: 0x4002 }, { ecu: 0x29, did: 0x500c }], 15.8);
    expect(summary.rateSource).toBe('assumed');
    expect(summary.reqPerSec).toBe(15.8);
    expect(summary.measuredReqPerSec).toBeNull();
    expect(summary.silentEcus).toEqual([0x12, 0x29]);
    expect(summary.liveEcus).toEqual([]);
  });

  it('only the ECU that stayed silent is dropped -- the live one keeps its DIDs', async () => {
    const { channels } = harness((ecu) => (ecu === 0x29 ? 'silent' : Uint8Array.from([0x01])), [0x12, 0x29]);
    const result: FinderRoundResult = await runFinderRound({
      entries: [
        { ecu: 0x12, did: 0x4002 },
        { ecu: 0x29, did: 0x500c },
      ],
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 1_000,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxPasses: 1,
    });
    const summary = summarizeFinderProbe(result, [{ ecu: 0x12, did: 0x4002 }, { ecu: 0x29, did: 0x500c }], 15.8);
    expect(summary.silentEcus).toEqual([0x29]);
    expect(summary.liveEcus).toEqual([0x12]);
    expect(summary.rateSource).toBe('measured');
  });
});

/**
 * Ticket P4m-FIX2 (Codex P4m-REV2 findings 11–14, 2 HIGH + 2 MEDIUM).
 *
 *  Y1 (H11) The probe is "one attempted request per planned (ecu,did)", NOT a
 *      2 s deadline: a slow first ECU must never leave later ECUs unattempted,
 *      and an ECU is `silent` only when EVERY one of its probe attempts was
 *      actually made and missed.
 *  Y2 (H12) The measured rate INCLUDES timeout cost (attempts / wall time),
 *      and the probe reports the individual DIDs that missed.
 *  Y3 (M13) Back-off is a bounded cooldown for the CURRENT evidence window,
 *      retried once at the start of every following window.
 *  Y4 (M14) `attempted`/`requestCount` are recorded only after `send()`
 *      actually resolved.
 *  Y8 (LOW) One pass over the entries takes at least `entries / targetHz`.
 */
describe('runFinderRound -- P4m-FIX2 probe completeness, honest rate, bounded cooldown, confirmed sends, pacing', () => {
  it('Y1: the probe attempts EVERY planned entry even when the first ECU times out on all of its DIDs', async () => {
    const { channels, log } = harness((ecu) => (ecu === 0x12 ? 'silent' : Uint8Array.from([0x01])), [0x12, 0x29, 0x30]);
    const entries = [
      { ecu: 0x12, did: 0x4001 },
      { ecu: 0x12, did: 0x4002 },
      { ecu: 0x12, did: 0x4003 },
      { ecu: 0x12, did: 0x4004 },
      { ecu: 0x29, did: 0x500c },
      { ecu: 0x30, did: 0x6001 },
    ];
    const result = await runFinderRound({
      entries,
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      // Deliberately far SHORTER than one pass costs (4 x 40 ms of timeouts):
      // the probe's bound is the entry count, never this deadline.
      durationMs: 10,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxPasses: 1,
      completePass: true,
    });
    expect(result.attempted).toEqual(entries);
    expect(log.requests).toHaveLength(entries.length);
    const summary = summarizeFinderProbe(result, entries, 15.8);
    expect(summary.silentEcus).toEqual([0x12]);
    expect(summary.liveEcus).toEqual([0x29, 0x30]);
    expect(summary.unprobedEcus).toEqual([]);
  });

  it('Y1: an ECU whose entries were never attempted is UNPROBED -- never classified silent', async () => {
    const control = { paused: false, stopped: false };
    const { channels } = harness((ecu, did) => {
      if (ecu === 0x12 && did === 0x4002) control.stopped = true; // stop before 0x29 is ever asked.
      return 'silent';
    }, [0x12, 0x29]);
    const entries = [
      { ecu: 0x12, did: 0x4002 },
      { ecu: 0x29, did: 0x500c },
    ];
    const result = await runFinderRound({
      entries,
      channels,
      clock: CLOCK,
      control,
      durationMs: 1_000,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxPasses: 1,
      completePass: true,
    });
    const summary = summarizeFinderProbe(result, entries, 15.8);
    expect(summary.silentEcus).toEqual([0x12]);
    expect(summary.unprobedEcus).toEqual([0x29]);
  });

  it('Y2: the measured rate INCLUDES the timeout cost of the misses, and the missed DIDs are named', async () => {
    const { channels } = harness((_ecu, did) => (did === 0x4002 ? Uint8Array.from([0x01]) : 'silent'), [0x12]);
    const entries = [
      { ecu: 0x12, did: 0x4002 },
      { ecu: 0x12, did: 0x4003 },
      { ecu: 0x12, did: 0x4004 },
      { ecu: 0x12, did: 0x4005 },
    ];
    const result = await runFinderRound({
      entries,
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 10,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      maxPasses: 1,
      completePass: true,
    });
    const summary = summarizeFinderProbe(result, entries, 15.8);
    expect(summary.rateSource).toBe('measured');
    // 4 attempts over ~120 ms of wall time is ~33 req/s -- the answered-only
    // denominator would have reported four figures.
    expect(summary.measuredReqPerSec).toBeLessThan(100);
    expect(summary.silentDids).toEqual([
      { ecu: 0x12, did: 0x4003 },
      { ecu: 0x12, did: 0x4004 },
      { ecu: 0x12, did: 0x4005 },
    ]);
    expect(summary.silentEcus).toEqual([]); // one answering DID keeps the ECU.
  });

  it('Y3: a back-off is a COOLDOWN for the current evidence window -- a recovering DID samples again', async () => {
    let silent = true;
    setTimeout(() => {
      silent = false;
    }, 150);
    const { channels } = harness(() => (silent ? 'silent' : Uint8Array.from([0x07])), [0x12]);
    const result = await runFinderRound({
      entries: [{ ecu: 0x12, did: 0x4002 }],
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 600,
      requestTimeoutMs: 10,
      windowMs: 100,
      missesBeforeBackoff: 3,
    });
    // Build 7 removed the DID for the whole round after 3 misses, so every
    // later window was empty and the scorer said `insufficient`.
    expect(result.samples.length).toBeGreaterThan(0);
    expect(Math.max(...result.samples.map((s) => s.tMs))).toBeGreaterThan(150);
    expect(result.respondingEcus).toEqual([0x12]);
  });

  it('Y4: a send that throws leaves the key UNATTEMPTED and uncounted', async () => {
    const channels = new Map<number, SweepTransport>([
      [
        0x12,
        {
          send(): Promise<void> {
            throw new Error('socket gone');
          },
          nextResponse(): Promise<Uint8Array | 'timeout'> {
            return Promise.resolve('timeout');
          },
          async keepAlive(): Promise<void> {},
        },
      ],
    ]);
    const result = await runFinderRound({
      entries: [{ ecu: 0x12, did: 0x4002 }],
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 200,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
    });
    expect(result.attempted).toEqual([]);
    expect(result.requestCount).toBe(0);
  });

  it('Y8: the round is PACED to the planned rate -- an instant channel never turns into a hot loop', async () => {
    const { channels, log } = harness(() => Uint8Array.from([0x01]), [0x12]);
    const entries = [
      { ecu: 0x12, did: 0x4002 },
      { ecu: 0x12, did: 0x4003 },
      { ecu: 0x12, did: 0x4004 },
      { ecu: 0x12, did: 0x4005 },
    ];
    const targetHz = 20;
    const result = await runFinderRound({
      entries,
      channels,
      clock: CLOCK,
      control: { paused: false, stopped: false },
      durationMs: 500,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      targetReqPerSec: targetHz,
    });
    const perSecond = (log.requests.length * 1_000) / Math.max(1, result.elapsedMs);
    expect(perSecond).toBeLessThanOrEqual(targetHz * 1.2);
    expect(log.requests.length).toBeGreaterThan(0);
  });
});
