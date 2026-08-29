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
    const summary = summarizeFinderProbe(result, [0x12], 15.8);
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
    const summary = summarizeFinderProbe(result, [0x12, 0x29], 15.8);
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
    const summary = summarizeFinderProbe(result, [0x12, 0x29], 15.8);
    expect(summary.silentEcus).toEqual([0x29]);
    expect(summary.liveEcus).toEqual([0x12]);
    expect(summary.rateSource).toBe('measured');
  });
});
