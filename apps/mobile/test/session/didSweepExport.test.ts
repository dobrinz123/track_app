import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fileSystemTracker = vi.hoisted(() => ({
  writeCalls: [] as Array<{ path: string; content: string }>,
  writeShouldThrow: false,
}));

vi.mock('expo-file-system', () => ({
  Paths: { cache: { toString: () => 'cache' } },
  File: class {
    uri: string;
    private readonly name: string;
    constructor(_dir: unknown, name: string) {
      this.name = name;
      this.uri = `file:///cache/${name}`;
    }
    write(content: string): void {
      if (fileSystemTracker.writeShouldThrow) throw new Error('disk full (test double)');
      fileSystemTracker.writeCalls.push({ path: this.name, content });
    }
  },
}));

const sharingTracker = vi.hoisted(() => ({
  available: true,
  shareCalls: [] as Array<{ url: string; options: unknown }>,
  shareShouldThrow: false,
}));

vi.mock('expo-sharing', () => ({
  isAvailableAsync: async () => sharingTracker.available,
  shareAsync: async (url: string, options: unknown) => {
    if (sharingTracker.shareShouldThrow) throw new Error('share sheet failed (test double)');
    sharingTracker.shareCalls.push({ url, options });
  },
}));

import {
  buildCopySummaryText,
  buildDidSweepExportDocument,
  buildDidSweepExportForRun,
  DID_SWEEP_EXPORT_SCHEMA_VERSION,
  DID_SWEEP_RESUME_BOUND,
  didSweepExportFileName,
  shareDidSweepExport,
  type DidSweepExportDocument,
} from '../../src/session/didSweepExport';
import { createInMemoryDidSweepStore, type DidSweepResponderRecord, type DidSweepRunRecord } from '../../src/persistence/didSweepStore';
import { createDidSweepController } from '../../src/session/didSweepController';
import { DEFAULT_ENET_DID_SCENARIO, SimulatedEnetTransport } from '@circuit/core';

async function flush(times = 30): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function run(overrides: Partial<DidSweepRunRecord> = {}): DidSweepRunRecord {
  return {
    runId: 'run-1',
    adapterType: 'enet',
    targetAddress: 0x12,
    rangeFrom: 0,
    rangeTo: 0xffff,
    lastDid: 0x1002,
    startedAtUtc: '2026-08-27T18:00:00.000Z',
    updatedAtUtc: '2026-08-27T18:05:00.000Z',
    status: 'stopped',
    visitedCount: 100,
    responderCount: 2,
    timeoutCount: 90,
    unmatchedCount: 3,
    errorCount: 0,
    nrcCounts: { '17': 5, '49': 2 },
    ...overrides,
  };
}

function responder(overrides: Partial<DidSweepResponderRecord> = {}): DidSweepResponderRecord {
  return {
    runId: 'run-1',
    did: 0x1002,
    length: 1,
    rawHex: '2A',
    rttMs: 22,
    firstSeenUtc: '2026-08-27T18:00:05.000Z',
    lastSeenUtc: '2026-08-27T18:04:00.000Z',
    sampleCount: 3,
    ...overrides,
  };
}

/**
 * DID sweep — results persistence, export & candidate filtering addendum
 * (2026-08-27, binding — Phase 4i): "'Share results' produces a JSON file
 * (`trace-did-sweep-<date>.json`: run meta, counters, responders with raw
 * hex, observation series if any, suggestions) through the OS share sheet
 * ... Web preview: export falls back to showing the JSON length + a
 * console log (never throws)."
 */
describe('buildDidSweepExportDocument (binding, P4i)', () => {
  it('builds run meta, counters (NRC keys as hex), and responders (hex DID, sorted ascending)', () => {
    const doc = buildDidSweepExportDocument({
      run: run(),
      responders: [responder({ did: 0x4098, rawHex: 'AABB' }), responder({ did: 0x1002 })],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    expect(doc.schemaVersion).toBe(DID_SWEEP_EXPORT_SCHEMA_VERSION);
    expect(doc.generatedAtUtc).toBe('2026-08-27T19:00:00.000Z');
    expect(doc.run).toMatchObject({
      runId: 'run-1',
      rangeFromHex: '0x0000',
      rangeToHex: '0xFFFF',
      lastDidHex: '0x1002',
      status: 'stopped',
    });
    expect(doc.counters).toMatchObject({
      visitedCount: 100,
      responderCount: 2,
      timeoutCount: 90,
      unmatchedCount: 3,
      errorCount: 0,
      nrcCounts: { '0x11': 5, '0x31': 2 }, // NRC decimal 17 -> 0x11, decimal 49 -> 0x31.
    });
    expect(doc.responders.map((r) => r.didHex)).toEqual(['0x1002', '0x4098']); // sorted ascending, regardless of input order.
  });

  it('a null lastDid exports as null (never a fabricated hex)', () => {
    const doc = buildDidSweepExportDocument({ run: run({ lastDid: null }), responders: [], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(doc.run.lastDidHex).toBeNull();
  });

  it('candidateSummaries/observationSamples/suggestions are optional -- omitted entirely still exports the sweep results', () => {
    const doc = buildDidSweepExportDocument({ run: run(), responders: [responder()], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(doc.candidates).toEqual([]);
    expect(doc.observationSeries).toEqual([]);
    expect(doc.suggestions).toEqual([]);
  });

  it('candidateSummaries are hex-DID-mapped verbatim', () => {
    const doc = buildDidSweepExportDocument({
      run: run(),
      responders: [],
      candidateSummaries: [
        { did: 0x2010, lastRawHex: 'FF', sampleCount: 12, min: 0, max: 255, distinctValueCount: 2, changedInPhase: { baseline: false, brake: true, steering: false, throttle: false }, rank: 'brakeCandidate' },
      ],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    expect(doc.candidates).toEqual([
      { didHex: '0x2010', rank: 'brakeCandidate', lastRawHex: 'FF', sampleCount: 12, min: 0, max: 255, distinctValueCount: 2, changedInPhase: { baseline: false, brake: true, steering: false, throttle: false } },
    ]);
  });

  /**
   * Ticket P4j (binding): "Settings already has enetTargetAddress -- make
   * sure ... the export's `run.targetAddress` is a hex string too."
   */
  it('run.targetAddress exports as a 2-hex-digit byte string, and null stays null (never a fabricated hex)', () => {
    const docWithTarget = buildDidSweepExportDocument({ run: run({ targetAddress: 0x12 }), responders: [], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(docWithTarget.run.targetAddress).toBe('0x12');

    const docWithHighByte = buildDidSweepExportDocument({ run: run({ targetAddress: 0x29 }), responders: [], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(docWithHighByte.run.targetAddress).toBe('0x29');

    const docWithNull = buildDidSweepExportDocument({ run: run({ targetAddress: null }), responders: [], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(docWithNull.run.targetAddress).toBeNull();
  });

  /** Ticket P4j (binding, batched guided observation): "export includes `batchIndex`." */
  it('observationSamples carrying a batchIndex export it on the per-(did,phase) series; a sample with none exports batchIndex: null', () => {
    const doc = buildDidSweepExportDocument({
      run: run(),
      responders: [],
      observationSamples: [
        { did: 0x0001, phase: 'baseline', tMs: 0, raw: Uint8Array.from([0x10]), batchIndex: 3 },
        { did: 0x0001, phase: 'baseline', tMs: 1_000, raw: Uint8Array.from([0x10]), batchIndex: 3 },
        { did: 0x0002, phase: 'baseline', tMs: 0, raw: Uint8Array.from([0x20]) }, // no batchIndex -- legacy/focused run.
      ],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    const did1Series = doc.observationSeries.find((s) => s.didHex === '0x0001');
    const did2Series = doc.observationSeries.find((s) => s.didHex === '0x0002');
    expect(did1Series?.batchIndex).toBe(3);
    expect(did2Series?.batchIndex).toBeNull();
  });

  /**
   * Ticket P4j (binding): "Mid-size blocks (9-32 bytes) join the candidate
   * pool with per-byte-offset diffing ... the export lists changed offsets."
   */
  it('blockCandidateSummaries are hex-DID-mapped verbatim into blockCandidates; omitted entirely exports []', () => {
    const withNone = buildDidSweepExportDocument({ run: run(), responders: [], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(withNone.blockCandidates).toEqual([]);

    const doc = buildDidSweepExportDocument({
      run: run(),
      responders: [],
      blockCandidateSummaries: [
        {
          did: 0x40b5,
          length: 10,
          sampleCount: 8,
          rank: 'brakeCandidate',
          changedOffsetsByPhase: { baseline: [], brake: [4, 5], steering: [], throttle: [] },
        },
      ],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    expect(doc.blockCandidates).toEqual([
      { didHex: '0x40B5', length: 10, sampleCount: 8, rank: 'brakeCandidate', changedOffsetsByPhase: { baseline: [], brake: [4, 5], steering: [], throttle: [] } },
    ]);
  });

  it('observationSamples are grouped by (did, phase) into per-phase series, timestamps and raw hex preserved', () => {
    const doc = buildDidSweepExportDocument({
      run: run(),
      responders: [],
      observationSamples: [
        { did: 0x2010, phase: 'baseline', tMs: 0, raw: Uint8Array.from([0x10]) },
        { did: 0x2010, phase: 'baseline', tMs: 1_000, raw: Uint8Array.from([0x10]) },
        { did: 0x2010, phase: 'brake', tMs: 0, raw: Uint8Array.from([0xff]) },
      ],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    expect(doc.observationSeries).toHaveLength(2); // one per (did, phase) pair.
    const baseline = doc.observationSeries.find((s) => s.phase === 'baseline');
    expect(baseline?.didHex).toBe('0x2010');
    expect(baseline?.samples).toEqual([
      { tMs: 0, rawHex: '10' },
      { tMs: 1_000, rawHex: '10' },
    ]);
  });

  /**
   * R1 (P4i-FIX2, binding, after Codex P4hrev3 H3 PARTIAL): "document [the
   * accepted ≤1s batch-window residual] in a comment + contracts-facing note
   * in the export meta (`resumeBound: "≤1s of DIDs may be re-sent after a
   * hard kill"`)."
   */
  it('discloses the accepted resume bound (R1, binding)', () => {
    const doc = buildDidSweepExportDocument({ run: run(), responders: [], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(doc.resumeBound).toBe(DID_SWEEP_RESUME_BOUND);
    expect(doc.resumeBound).toContain('1s');
  });

  it('suggestions are hex-DID-mapped verbatim', () => {
    const doc = buildDidSweepExportDocument({
      run: run(),
      responders: [],
      suggestions: [{ did: 0x1002, kind: 'temperature', confidence: 0.9, decode: 'u8-40', rationale: 'x' }],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    expect(doc.suggestions).toEqual([{ didHex: '0x1002', kind: 'temperature', confidence: 0.9, decode: 'u8-40', rationale: 'x' }]);
  });
});

/**
 * F3 fix (P4i-FIX1, binding, after Codex P4hrev2c HIGH finding #5): "controller
 * exposes `getGuidedSamples()` ... the screen passes them to
 * `buildDidSweepExportDocument`. Test at screen/controller handoff level (not
 * just the builder)." Drives a REAL `createDidSweepController` guided run
 * (through `@circuit/core`'s own `SimulatedEnetTransport` -- no hand-fed
 * observation samples anywhere in this test) and calls the EXACT function
 * `DidSweepScreen.tsx`'s "Share results" calls -- proving the handoff itself,
 * not just that the builder can accept samples when told to.
 */
describe('buildDidSweepExportForRun (binding, P4i-FIX1 F3): the screen/controller handoff', () => {
  const TESTER_ADDRESS = 0xf4;
  const TARGET_ADDRESS = 0x12;

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a real guided run\'s samples end up in the exported observationSeries -- never [] the way the pre-fix screen always produced', async () => {
    const store = createInMemoryDidSweepStore();
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
      clock: { now: () => Date.now() },
      store,
    });

    // Sweep the 3 scripted DEFAULT_ENET_DID_SCENARIO responders first.
    controller.start({ from: 0x1e1c, to: 0x1e24 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');
    const runId = controller.getCurrentRunId()!;

    controller.startGuidedObservation();
    for (let i = 0; i < 40 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(controller.getGuidedSamples().length).toBeGreaterThan(0); // the controller genuinely collected phase-tagged samples.

    const doc = await buildDidSweepExportForRun(controller, store, runId, '2026-08-27T19:00:00.000Z');
    expect(doc).not.toBeNull();
    // The exact regression this fixes: "'Share results' always omits guided
    // observation series ... observationSeries is always []."
    expect(doc!.observationSeries.length).toBeGreaterThan(0);
    expect(doc!.candidates.length).toBeGreaterThan(0); // candidateSummaries also flow through.
  });

  /**
   * Ticket P4j (binding): "export includes `batchIndex`" and "the export's
   * `run.targetAddress` is a hex string too" -- a REAL `startBatchedObservation()`
   * run's samples/target address flow all the way through the handoff.
   */
  it('a real batched observation run\'s samples carry batchIndex through the export, and run.targetAddress is a hex string', async () => {
    const store = createInMemoryDidSweepStore();
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
      clock: { now: () => Date.now() },
      store,
    });

    controller.start({ from: 0x1e1c, to: 0x1e24 });
    await vi.runAllTimersAsync();
    await flush();
    expect(controller.getSnapshot().phase).toBe('sweepComplete');
    const runId = controller.getCurrentRunId()!;

    controller.startBatchedObservation({ batchSize: 1, minSamplesPerPhase: 1 });
    for (let i = 0; i < 100 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().phase).toBe('observationComplete');

    const doc = await buildDidSweepExportForRun(controller, store, runId, '2026-08-27T19:00:00.000Z');
    expect(doc).not.toBeNull();
    expect(doc!.run.targetAddress).toBe('0x12');
    expect(doc!.observationSeries.length).toBeGreaterThan(0);
    // Every series has a real (non-null) batchIndex -- a batched run always tags its samples.
    expect(doc!.observationSeries.every((s) => s.batchIndex !== null)).toBe(true);
  }, 20_000);

  /**
   * R2 (P4i-FIX2, binding, after Codex P4hrev3 NEW MEDIUM "guided export
   * samples leak across runs"): "Test: run A guided -> run B shared without
   * guided -> empty series" (the ticket's own literal scenario). Lives here
   * (rather than `didSweepController.test.ts`) because `buildDidSweepExportForRun`
   * requires this file's `expo-file-system`/`expo-sharing` mocks.
   */
  it('run A completes a guided observation; run B is started fresh (never runs guided) -- run B\'s export has an EMPTY observation series (R2, binding)', async () => {
    const store = createInMemoryDidSweepStore();
    const controller = createDidSweepController({
      transportFactory: () =>
        new SimulatedEnetTransport({ monotonicNow: () => Date.now(), scenario: DEFAULT_ENET_DID_SCENARIO, testerAddress: TESTER_ADDRESS, targetAddress: TARGET_ADDRESS }),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: { now: () => Date.now() },
      store,
    });

    // Run A: sweep the 3 scripted responders, then a full guided observation.
    controller.start({ from: 0x1e1c, to: 0x1e24 });
    await vi.runAllTimersAsync();
    await flush();
    const runIdA = controller.getCurrentRunId()!;

    controller.startGuidedObservation();
    for (let i = 0; i < 40 && controller.getSnapshot().phase === 'observing'; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush();
    }
    expect(controller.getSnapshot().phase).toBe('observationComplete');
    expect(controller.getGuidedSamples().length).toBeGreaterThan(0); // run A genuinely collected guided samples.

    const docA = await buildDidSweepExportForRun(controller, store, runIdA, '2026-08-27T19:00:00.000Z');
    expect(docA!.observationSeries.length).toBeGreaterThan(0); // run A's own export legitimately has a series.

    // Run B: a FRESH start() over the SAME range -- never runs guided observation.
    controller.start({ from: 0x1e1c, to: 0x1e24 });
    await vi.runAllTimersAsync();
    await flush();
    const runIdB = controller.getCurrentRunId()!;
    expect(runIdB).not.toBe(runIdA);
    expect(controller.getSnapshot().phase).toBe('sweepComplete'); // never ran (or even started) a guided observation.

    // The exact regression this fixes: run B's export used to still carry
    // run A's leftover `guidedSamples` under run B's own metadata.
    expect(controller.getGuidedSamples()).toEqual([]);
    const docB = await buildDidSweepExportForRun(controller, store, runIdB, '2026-08-27T19:05:00.000Z');
    expect(docB!.observationSeries).toEqual([]);
    expect(docB!.candidates).toEqual([]);
  });

  it('returns null when runId is not in the store (mirrors the screen\'s own "could not find this run" branch)', async () => {
    const store = createInMemoryDidSweepStore();
    const controller = createDidSweepController({
      transportFactory: () =>
        new SimulatedEnetTransport({ monotonicNow: () => Date.now(), scenario: DEFAULT_ENET_DID_SCENARIO, testerAddress: TESTER_ADDRESS, targetAddress: TARGET_ADDRESS }),
      testerAddress: TESTER_ADDRESS,
      targetAddress: TARGET_ADDRESS,
      clock: { now: () => Date.now() },
      store,
    });
    expect(await buildDidSweepExportForRun(controller, store, 'nonexistent-run', '2026-08-27T19:00:00.000Z')).toBeNull();
  });
});

describe('didSweepExportFileName (binding, P4i: "trace-did-sweep-<date>.json")', () => {
  it('truncates generatedAtUtc to YYYY-MM-DD', () => {
    expect(didSweepExportFileName('2026-08-27T19:00:00.000Z')).toBe('trace-did-sweep-2026-08-27.json');
  });
});

describe('buildCopySummaryText (binding, P4i: "Copy summary ... counts + top candidates")', () => {
  it('includes counts and the top (non-static) candidates', () => {
    const doc: DidSweepExportDocument = buildDidSweepExportDocument({
      run: run(),
      responders: [],
      candidateSummaries: [
        { did: 0x2010, lastRawHex: 'FF', sampleCount: 1, min: null, max: null, distinctValueCount: 1, changedInPhase: { baseline: false, brake: true, steering: false, throttle: false }, rank: 'brakeCandidate' },
        { did: 0x3000, lastRawHex: '00', sampleCount: 1, min: null, max: null, distinctValueCount: 1, changedInPhase: { baseline: false, brake: false, steering: false, throttle: false }, rank: 'static' },
      ],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    const summary = buildCopySummaryText(doc);
    expect(summary).toContain('2 responders');
    expect(summary).toContain('0x2010');
    expect(summary).not.toContain('0x3000'); // static candidates excluded from the "top candidates" line.
  });

  it('reports "no ranked candidates yet" when nothing has been ranked', () => {
    const doc = buildDidSweepExportDocument({ run: run(), responders: [], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(buildCopySummaryText(doc)).toContain('No ranked candidates yet');
  });
});

describe('shareDidSweepExport (binding, P4i: OS share sheet, never throws)', () => {
  beforeEach(() => {
    fileSystemTracker.writeCalls = [];
    fileSystemTracker.writeShouldThrow = false;
    sharingTracker.available = true;
    sharingTracker.shareCalls = [];
    sharingTracker.shareShouldThrow = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function doc(): DidSweepExportDocument {
    return buildDidSweepExportDocument({ run: run(), responders: [responder()], nowIso: '2026-08-27T19:00:00.000Z' });
  }

  it('writes the JSON file and invokes the OS share sheet when sharing is available', async () => {
    const result = await shareDidSweepExport(doc());
    expect(result).toMatchObject({ ok: true, shared: true });
    expect(fileSystemTracker.writeCalls).toHaveLength(1);
    expect(fileSystemTracker.writeCalls[0]!.path).toBe('trace-did-sweep-2026-08-27.json');
    expect(JSON.parse(fileSystemTracker.writeCalls[0]!.content).run.runId).toBe('run-1');
    expect(sharingTracker.shareCalls).toHaveLength(1);
    expect(sharingTracker.shareCalls[0]!.url).toBe('file:///cache/trace-did-sweep-2026-08-27.json');
  });

  it('falls back gracefully (never throws) when sharing is unavailable (web preview) -- logs the JSON length, shared:false', async () => {
    sharingTracker.available = false;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await shareDidSweepExport(doc());
    expect(result.ok).toBe(true);
    expect(result.shared).toBe(false);
    expect(result.jsonLength).toBeGreaterThan(0);
    expect(fileSystemTracker.writeCalls).toHaveLength(0); // never even attempted to write.
    expect(logSpy).toHaveBeenCalled();
  });

  it('a native write failure never throws -- falls back with ok:false and the error message', async () => {
    fileSystemTracker.writeShouldThrow = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await shareDidSweepExport(doc());
    expect(result.ok).toBe(false);
    expect(result.shared).toBe(false);
    expect(result.error).toMatch(/disk full/);
    expect(logSpy).toHaveBeenCalled();
  });

  it('a share-sheet failure never throws -- falls back with ok:false', async () => {
    sharingTracker.shareShouldThrow = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await shareDidSweepExport(doc());
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/share sheet failed/);
    expect(logSpy).toHaveBeenCalled();
  });
});
