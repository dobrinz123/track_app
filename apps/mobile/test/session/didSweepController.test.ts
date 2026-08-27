import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseUdsResponse } from '@circuit/core';
import { createDidSweepController, type DidSweepSnapshot } from '../../src/session/didSweepController';
import { createEnetAdapterReservation } from '../../src/session/enetAdapterReservation';

/**
 * ENET auto-discovery & DID sweep addendum (contracts.md, binding, Phase 4f)
 * -- `didSweepController.ts`'s own state machine, driven with a scripted raw
 * `sendRequest` (built by hand, encoding a minimal valid UDS response PDU
 * directly -- no transport/HSFZ framing involved, since `runDidSweep`/this
 * controller both operate purely on parsed UDS bytes).
 */
function monotonicCounter(startAt = 0): { now: () => number } {
  let t = startAt;
  return { now: () => t };
}

/** Builds a fake clock whose `now()` advances by `stepMs` every call -- lets a scripted `sendRequest` produce distinct `tMs` timestamps without any real/fake timer involvement. */
function steppingClock(stepMs: number): { now: () => number } {
  let t = 0;
  return {
    now: () => {
      t += stepMs;
      return t;
    },
  };
}

/** Positive ReadDataByIdentifier response PDU: `62 <didHi> <didLo> ...dataBytes`. */
function positivePdu(did: number, dataBytes: number[]): Uint8Array {
  return Uint8Array.from([0x62, (did >> 8) & 0xff, did & 0xff, ...dataBytes]);
}

/** Negative response PDU: `7F 22 <nrc>`. */
function negativePdu(nrc: number): Uint8Array {
  return Uint8Array.from([0x7f, 0x22, nrc]);
}

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe('didSweepController: start/pause/resume/stop state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps a small range, classifying each response by its scripted DID, and reaches sweepComplete', async () => {
    const reservation = createEnetAdapterReservation();
    const script = new Map<number, Uint8Array>([
      [0x0001, positivePdu(0x0001, [0x64])], // 100 - 40 = engine-oil-ish byte
      [0x0002, negativePdu(0x11)], // serviceNotSupported
    ]);
    const controller = createDidSweepController({
      sendRequest: async (pdu) => {
        const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
        return script.get(did) ?? negativePdu(0x31);
      },
      clock: monotonicCounter(),
      reservation,
    });

    const snapshots: DidSweepSnapshot[] = [];
    controller.subscribe((s) => snapshots.push(s));

    controller.start({ from: 0x0000, to: 0x0003 });
    await vi.runAllTimersAsync();
    await flush();

    const final = controller.getSnapshot();
    expect(final.phase).toBe('sweepComplete');
    expect(final.responders).toHaveLength(1);
    expect(final.responders[0]!.did).toBe(0x0001);
    expect(final.responders[0]!.raw).toEqual(Uint8Array.from([0x64]));
    expect(final.nrcCounts[0x11]).toBe(1);
    expect(final.nrcCounts[0x31]).toBe(2); // DIDs 0x0000, 0x0003
    expect(reservation.holder()).toBeNull(); // released once the sweep finished on its own.
  });

  it('pause() stops advancing at the next DID boundary; resume() continues the SAME plan (no re-visiting, no reservation gap)', async () => {
    const reservation = createEnetAdapterReservation();
    let calls = 0;
    const controller = createDidSweepController({
      sendRequest: async () => {
        calls += 1;
        return negativePdu(0x11);
      },
      clock: monotonicCounter(),
      reservation,
    });

    controller.start({ from: 0x0000, to: 0x0009 });
    await flush(3); // let the FIRST request or two go out, then pause before the sweep would finish.
    controller.pause();
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('paused');
    expect(reservation.holder()).toBe('sweep'); // held throughout the pause.
    const callsAtPause = calls;
    expect(callsAtPause).toBeGreaterThan(0);
    expect(callsAtPause).toBeLessThan(10); // proves it genuinely paused before exhausting the range.

    controller.resume();
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('sweepComplete');
    expect(calls).toBe(10); // every DID 0x0000-0x0009 visited exactly once in total (no re-visits).
    // The NRC total ACCUMULATES across the pause/resume boundary (this
    // controller's own local merge, since the currently-committed
    // `runDidSweep` returns only each call's own newly-visited DIDs) --
    // proves the pre-pause portion's results were never dropped.
    expect(controller.getSnapshot().nrcCounts[0x11]).toBe(10);
    expect(reservation.holder()).toBeNull();
  });

  it('stop() releases the reservation immediately and ends the run permanently, even mid-sweep', async () => {
    const reservation = createEnetAdapterReservation();
    const controller = createDidSweepController({
      sendRequest: async () => negativePdu(0x11),
      clock: monotonicCounter(),
      reservation,
    });

    controller.start({ from: 0x0000, to: 0xffff }); // huge range -- never finishes on its own within this test.
    await flush(3);
    controller.stop();

    expect(controller.getSnapshot().phase).toBe('stopped');
    expect(reservation.holder()).toBeNull();

    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('stopped'); // no late continuation resurrects it.
  });

  it('reservation exclusivity: start() is refused (with an inline error, snapshot stays idle) while another owner holds the adapter', () => {
    const reservation = createEnetAdapterReservation();
    reservation.tryAcquire('provider'); // stands in for telemetry actively polling.

    const controller = createDidSweepController({
      sendRequest: async () => negativePdu(0x11),
      clock: monotonicCounter(),
      reservation,
    });

    controller.start();
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe('idle');
    expect(snapshot.error).toMatch(/adapter is in use/i);
    expect(reservation.holder()).toBe('provider'); // untouched by the refused attempt.
  });

  it('progress reports index/total/reqPerSec as the sweep advances', async () => {
    const controller = createDidSweepController({
      sendRequest: async () => negativePdu(0x11),
      clock: monotonicCounter(),
    });
    const progressSeen: Array<{ index: number; total: number }> = [];
    controller.subscribe((s) => {
      if (s.progress !== null) progressSeen.push({ index: s.progress.index, total: s.progress.total });
    });

    controller.start({ from: 0x0000, to: 0x0004 });
    await vi.runAllTimersAsync();
    await flush();

    expect(progressSeen.length).toBeGreaterThan(0);
    expect(progressSeen.at(-1)).toEqual({ index: 5, total: 5 });
    expect(controller.getSnapshot().progress?.reqPerSec).toBeGreaterThan(0);
  });

  it('an invalid range surfaces as an inline error (never throws), and releases the reservation it briefly held', () => {
    const reservation = createEnetAdapterReservation();
    const controller = createDidSweepController({
      sendRequest: async () => negativePdu(0x11),
      clock: monotonicCounter(),
      reservation,
    });

    expect(() => controller.start({ from: 10, to: 5 })).not.toThrow();
    expect(controller.getSnapshot().error).toMatch(/inverted/i);
    expect(controller.getSnapshot().phase).toBe('idle');
    expect(reservation.holder()).toBeNull();
  });
});

describe('didSweepController: observation phase + tagging', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('after a sweep finds a responder, startObservation() re-polls it, classifies it, and buildTaggedSpec() writes a spec matching enetSpecsFromSuggestion', async () => {
    const reservation = createEnetAdapterReservation();
    // Pedal-like: fast bimodal steps between two clusters, u8 raw decode.
    const pedalValues = [20, 20, 20, 220, 220, 220, 20, 20, 20, 220];
    let pollCount = 0;
    const controller = createDidSweepController({
      sendRequest: async (pdu) => {
        const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
        if (did !== 0x1e20) return negativePdu(0x11);
        const value = pedalValues[pollCount % pedalValues.length] ?? 20;
        pollCount += 1;
        return positivePdu(did, [value]);
      },
      clock: steppingClock(20), // small steps -- several clock reads happen per re-poll tick, so this keeps every actual sample-to-sample gap comfortably under didHeuristics' "fast transition" (<= 2s) bound.
      reservation,
      observationIntervalMs: 10,
    });

    controller.start({ from: 0x1e20, to: 0x1e20 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');
    expect(controller.getSnapshot().responders).toHaveLength(1);

    controller.startObservation(3_000); // generous relative to the stepping clock's own advance-per-tick, so well over pedalValues.length samples land before the window elapses.
    await vi.runAllTimersAsync();
    await flush();

    const observed = controller.getSnapshot();
    expect(observed.phase).toBe('observationComplete');
    expect(reservation.holder()).toBeNull();
    const suggestion = observed.suggestions.find((s) => s.did === 0x1e20);
    expect(suggestion).toBeDefined();
    expect(suggestion!.kind).toBe('pedal');

    const spec = controller.buildTaggedSpec(0x1e20, 'throttlePct', '2026-08-27');
    expect(spec).not.toBeNull();
    expect(spec!.channel).toBe('throttlePct');
    expect(spec!.mode).toBe('did');
    expect(spec!.requestHex).toBe('1E20');
    expect(spec!.provenance).toMatch(/^in-car sweep 2026-08-27, DID 0x1E20, decode/);
  });

  it('buildTaggedSpec() returns null for a DID with no current suggestion', () => {
    const controller = createDidSweepController({
      sendRequest: async () => negativePdu(0x11),
      clock: monotonicCounter(),
    });
    expect(controller.buildTaggedSpec(0x1234, 'rpm', '2026-08-27')).toBeNull();
  });

  it('stopObservationEarly() ends the window before it elapses and still classifies whatever was sampled', async () => {
    const reservation = createEnetAdapterReservation();
    const controller = createDidSweepController({
      sendRequest: async (pdu) => {
        const did = ((pdu[1] ?? 0) << 8) | (pdu[2] ?? 0);
        return did === 0x0005 ? positivePdu(did, [0x50]) : negativePdu(0x11);
      },
      clock: steppingClock(100),
      reservation,
      observationIntervalMs: 5,
    });

    controller.start({ from: 0x0005, to: 0x0005 });
    await vi.runAllTimersAsync();
    await flush();

    controller.startObservation(60_000); // a long window -- must be ended EARLY by the call below, not by elapsing.
    await flush(5); // a couple of re-poll ticks happen first.
    controller.stopObservationEarly();
    await vi.runAllTimersAsync();
    await flush();

    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(reservation.holder()).toBeNull();
  });
});

describe('didSweepController: sanity -- the scripted PDUs above really do parse as this module expects', () => {
  it('positivePdu/negativePdu round-trip through the real parseUdsResponse', () => {
    expect(parseUdsResponse(positivePdu(0x1e20, [0x14]))).toEqual({ kind: 'positive', sid: 0x62, data: Uint8Array.from([0x1e, 0x20, 0x14]) });
    expect(parseUdsResponse(negativePdu(0x11))).toEqual({ kind: 'negative', requestSid: 0x22, nrc: 0x11 });
  });
});
