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
import { createDidSweepController, type DidSweepController } from '../../src/session/didSweepController';
import { DEFAULT_ENET_DID_SCENARIO, SimulatedEnetTransport, type DidPhaseSample } from '@circuit/core';

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
        { did: 0x2010, lastRawHex: 'FF', sampleCount: 12, min: 0, max: 255, distinctValueCount: 2, changedInPhase: { baseline: false, brake: true, steering: false, throttle: false }, phaseEvidence: { baseline: 'unchanged', brake: 'changed', steering: 'unchanged', throttle: 'unchanged' }, lengthConsistent: true, rank: 'brakeCandidate' },
      ],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    expect(doc.candidates).toEqual([
      {
        didHex: '0x2010',
        rank: 'brakeCandidate',
        lastRawHex: 'FF',
        sampleCount: 12,
        min: 0,
        max: 255,
        distinctValueCount: 2,
        changedInPhase: { baseline: false, brake: true, steering: false, throttle: false },
        // Ticket P4j-FIX1 H2/M6 (binding): the tri-state verdict travels with the candidate.
        phaseEvidence: { baseline: 'unchanged', brake: 'changed', steering: 'unchanged', throttle: 'unchanged' },
      },
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
          phaseEvidence: { baseline: 'unchanged', brake: 'changed', steering: 'unchanged', throttle: 'unchanged' },
        },
      ],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    expect(doc.blockCandidates).toEqual([
      {
        didHex: '0x40B5',
        length: 10,
        sampleCount: 8,
        rank: 'brakeCandidate',
        changedOffsetsByPhase: { baseline: [], brake: [4, 5], steering: [], throttle: [] },
        phaseEvidence: { baseline: 'unchanged', brake: 'changed', steering: 'unchanged', throttle: 'unchanged' },
      },
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
        { did: 0x2010, lastRawHex: 'FF', sampleCount: 1, min: null, max: null, distinctValueCount: 1, changedInPhase: { baseline: false, brake: true, steering: false, throttle: false }, phaseEvidence: { baseline: 'unchanged', brake: 'changed', steering: 'unchanged', throttle: 'unchanged' }, lengthConsistent: true, rank: 'brakeCandidate' },
        { did: 0x3000, lastRawHex: '00', sampleCount: 1, min: null, max: null, distinctValueCount: 1, changedInPhase: { baseline: false, brake: false, steering: false, throttle: false }, phaseEvidence: { baseline: 'unchanged', brake: 'unchanged', steering: 'unchanged', throttle: 'unchanged' }, lengthConsistent: true, rank: 'static' },
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

// ---------------------------------------------------------------------------
// Ticket P4j-FIX1 M6 + H3 (binding, after Codex P4j-REV1). Kept in THIS file
// (never a new one) because the expo-file-system / expo-sharing mocks above
// are hoisted per test FILE -- a second export test file would collect them
// separately and re-run the whole module.
// ---------------------------------------------------------------------------

describe('P4j-FIX1 M6 — export schemaVersion 2 with a note and a numeric target (binding)', () => {
  it('declares schemaVersion 2 and explains the v1 -> v2 change in the document itself', () => {
    expect(DID_SWEEP_EXPORT_SCHEMA_VERSION).toBe(2);
    const doc = buildDidSweepExportDocument({ run: run(), responders: [], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(doc.schemaVersion).toBe(2);
    expect(doc.schemaNote).toMatch(/targetAddress/);
  });

  it('keeps run.targetAddress as the hex string AND adds targetAddressNumeric (a v1 consumer expecting a number has somewhere to look)', () => {
    const doc = buildDidSweepExportDocument({ run: run({ targetAddress: 0x12 }), responders: [], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(doc.run.targetAddress).toBe('0x12');
    expect(doc.run.targetAddressNumeric).toBe(0x12);

    const nullDoc = buildDidSweepExportDocument({ run: run({ targetAddress: null }), responders: [], nowIso: '2026-08-27T19:00:00.000Z' });
    expect(nullDoc.run.targetAddress).toBeNull();
    expect(nullDoc.run.targetAddressNumeric).toBeNull();
  });

  it('exports the per-phase EVIDENCE (changed / unchanged / insufficient) alongside the boolean changedInPhase', () => {
    const doc = buildDidSweepExportDocument({
      run: run(),
      responders: [],
      candidateSummaries: [
        {
          did: 0x4522,
          lastRawHex: '0127',
          sampleCount: 3,
          min: 295,
          max: 305,
          distinctValueCount: 3,
          changedInPhase: { baseline: false, brake: false, steering: false, throttle: false },
          phaseEvidence: { baseline: 'insufficient', brake: 'insufficient', steering: 'insufficient', throttle: 'insufficient' },
          lengthConsistent: true,
          rank: 'static',
        },
      ],
      insufficientDids: [0x4522],
      inconsistentDids: [0x4659],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    expect(doc.candidates[0]!.phaseEvidence.brake).toBe('insufficient');
    expect(doc.observationInsufficientDidHex).toEqual(['0x4522']);
    expect(doc.inconsistentDidHex).toEqual(['0x4659']);
  });
});

describe('P4j-FIX1 H3 — the export reads the observation series from the STORE, not only live memory (binding)', () => {
  it('a RECREATED controller (kill/reopen) still exports the persisted series, batchIndex and ranked candidates', async () => {
    const store = createInMemoryDidSweepStore();
    await store.createRun({
      runId: 'run-killed',
      adapterType: 'enet',
      targetAddress: 0x12,
      rangeFrom: 0x4000,
      rangeTo: 0x4fff,
      lastDid: 0x4fff,
      startedAtUtc: '2026-08-29T10:45:03.790Z',
      updatedAtUtc: '2026-08-29T10:49:58.177Z',
      status: 'complete',
      visitedCount: 4096,
      timeoutCount: 36,
      unmatchedCount: 1,
      errorCount: 0,
      nrcCounts: { '49': 3519 },
    });
    // Real field shapes: 0x4522 read 297 -> 305 (0x0129 / 0x0131).
    await store.appendObservationSamples('run-killed', 'obs-a', [
      { did: 0x4522, phase: 'baseline', tMs: 8030, raw: Uint8Array.from([0x01, 0x29]), batchIndex: 2 },
      { did: 0x4522, phase: 'brake', tMs: 4221, raw: Uint8Array.from([0x01, 0x31]), batchIndex: 2 },
    ]);
    await store.saveObservationSummary(
      'run-killed',
      'obs-a',
      JSON.stringify({
        candidates: [
          {
            did: 0x4522,
            lastRawHex: '0131',
            sampleCount: 2,
            min: 297,
            max: 305,
            distinctValueCount: 2,
            changedInPhase: { baseline: false, brake: false, steering: false, throttle: false },
            phaseEvidence: { baseline: 'insufficient', brake: 'insufficient', steering: 'insufficient', throttle: 'insufficient' },
            lengthConsistent: true,
            rank: 'static',
          },
        ],
        blockCandidates: [],
        insufficientDids: [0x4522],
        inconsistentDids: [],
        noResponseDids: [],
      }),
      '2026-08-29T10:50:00.000Z',
    );

    // A FRESH controller instance -- exactly what a kill/reopen produces: it
    // has never run an observation, so its live memory is empty.
    const controller = createDidSweepController({
      transportFactory: () =>
        new SimulatedEnetTransport({ monotonicNow: () => Date.now(), scenario: DEFAULT_ENET_DID_SCENARIO, testerAddress: 0xf4, targetAddress: 0x12 }),
      testerAddress: 0xf4,
      targetAddress: 0x12,
      clock: { now: () => Date.now() },
      store,
    });
    expect(controller.getGuidedSamples()).toEqual([]);

    const doc = await buildDidSweepExportForRun(controller, store, 'run-killed', '2026-08-29T11:00:00.000Z');
    expect(doc).not.toBeNull();
    const series = doc!.observationSeries.find((s) => s.didHex === '0x4522' && s.phase === 'brake');
    expect(series?.batchIndex).toBe(2);
    expect(series?.samples).toEqual([{ tMs: 4221, rawHex: '0131' }]);
    expect(doc!.candidates.map((c) => c.didHex)).toEqual(['0x4522']);
    expect(doc!.observationInsufficientDidHex).toEqual(['0x4522']);
  });

  it('a run with NOTHING persisted still exports the sweep results with empty observation sections', async () => {
    const store = createInMemoryDidSweepStore();
    await store.createRun({
      runId: 'run-bare',
      adapterType: 'enet',
      targetAddress: 0x12,
      rangeFrom: 0,
      rangeTo: 0xffff,
      lastDid: null,
      startedAtUtc: '2026-08-29T10:45:03.790Z',
      updatedAtUtc: '2026-08-29T10:45:03.790Z',
      status: 'stopped',
      visitedCount: 0,
      timeoutCount: 0,
      unmatchedCount: 0,
      errorCount: 0,
      nrcCounts: {},
    });
    const controller = createDidSweepController({
      transportFactory: () =>
        new SimulatedEnetTransport({ monotonicNow: () => Date.now(), scenario: DEFAULT_ENET_DID_SCENARIO, testerAddress: 0xf4, targetAddress: 0x12 }),
      testerAddress: 0xf4,
      targetAddress: 0x12,
      clock: { now: () => Date.now() },
      store,
    });
    const doc = await buildDidSweepExportForRun(controller, store, 'run-bare', '2026-08-29T11:00:00.000Z');
    expect(doc!.observationSeries).toEqual([]);
    expect(doc!.candidates).toEqual([]);
    expect(doc!.blockCandidates).toEqual([]);
  });
});

/**
 * Ticket P4j-FIX2 V3/V4 (binding, after Codex P4j-REV2 NEW MEDIUM #1/#2).
 * Kept in THIS file (vitest collection quirk, per the ticket) rather than
 * `didSweepController.test.ts`.
 *
 * A minimal `Pick<DidSweepController, 'getSnapshot' | 'getGuidedSamples'>`
 * double -- `buildDidSweepExportForRun` only ever calls these two methods, so
 * this is exactly what it sees from a REAL controller mid-observation,
 * without needing to orchestrate a genuine persistence-lag timing race
 * (fragile and non-deterministic) just to get "live ahead of its own last
 * checkpoint". A real controller's `getSnapshot()` (even its INITIAL, never-
 * started snapshot) is a fully valid `DidSweepSnapshot` -- reused verbatim
 * here, with only `observationId` overridden, so this stays honest to the
 * REAL shape rather than a hand-rolled partial cast.
 */
describe('P4j-FIX2 V3/V4 — export reconciles live/persisted samples PER OBSERVATION, never "pick the longer source" (binding)', () => {
  function phaseSample(did: number, tMs: number, rawByte: number, observationId: string, batchIndex?: number): DidPhaseSample {
    return batchIndex === undefined
      ? { did, phase: 'baseline', tMs, raw: Uint8Array.from([rawByte]), observationId }
      : { did, phase: 'baseline', tMs, raw: Uint8Array.from([rawByte]), observationId, batchIndex };
  }

  async function fakeControllerAt(store: ReturnType<typeof createInMemoryDidSweepStore>, observationId: string | null, liveSamples: DidPhaseSample[]): Promise<Pick<DidSweepController, 'getSnapshot' | 'getGuidedSamples'>> {
    // A throwaway REAL controller, never run -- its `getSnapshot()` is the
    // genuine `INITIAL_SNAPSHOT` shape (every field present, correctly
    // typed), reused verbatim with only `observationId` overridden.
    const real = createDidSweepController({
      transportFactory: () => new SimulatedEnetTransport({ monotonicNow: () => Date.now(), scenario: DEFAULT_ENET_DID_SCENARIO, testerAddress: 0xf4, targetAddress: 0x12 }),
      testerAddress: 0xf4,
      targetAddress: 0x12,
      clock: { now: () => Date.now() },
      store,
    });
    const baseSnapshot = real.getSnapshot();
    return {
      getSnapshot: () => ({ ...baseSnapshot, observationId }),
      getGuidedSamples: () => liveSamples,
    };
  }

  it('V3: reconciles by (observationId, seq) -- A persisted 320 (modelled smaller: 3), B live 10 (modelled: 3) / only 8 (modelled: 2) reached B\'s own checkpoint -> export has A + B\'s live count, NEVER the whole-run "pick the longer source"', async () => {
    const store = createInMemoryDidSweepStore();
    await store.createRun(run({ runId: 'run-v3' }));

    // Observation A: fully persisted, 3 samples (stands in for the ticket's "320").
    const obsA = 'obs-a';
    await store.appendObservationSamples('run-v3', obsA, [
      { did: 0x1002, phase: 'baseline', tMs: 0, raw: Uint8Array.from([1]) },
      { did: 0x1002, phase: 'baseline', tMs: 100, raw: Uint8Array.from([2]) },
      { did: 0x1002, phase: 'baseline', tMs: 200, raw: Uint8Array.from([3]) },
    ]);

    // Observation B: only its first 2 samples reached the store's own
    // checkpoint (stands in for the ticket's "8 of 10"); B is the CURRENT
    // (live) observation, with 3 live samples -- ONE fresher than storage.
    const obsB = 'obs-b';
    await store.appendObservationSamples('run-v3', obsB, [
      { did: 0x2003, phase: 'baseline', tMs: 0, raw: Uint8Array.from([10]) },
      { did: 0x2003, phase: 'baseline', tMs: 100, raw: Uint8Array.from([11]) },
    ]);
    const liveB: DidPhaseSample[] = [
      phaseSample(0x2003, 0, 0x0a, obsB), // matches the persisted seq-0 row.
      phaseSample(0x2003, 100, 0x0b, obsB), // matches the persisted seq-1 row.
      phaseSample(0x2003, 200, 0x0c, obsB), // NOT yet checkpointed -- live only.
    ];

    const controller = await fakeControllerAt(store, obsB, liveB);
    const doc = await buildDidSweepExportForRun(controller, store, 'run-v3', '2026-08-29T11:00:00.000Z');
    expect(doc).not.toBeNull();

    const totalSamples = doc!.observationSeries.reduce((sum, s) => sum + s.samples.length, 0);
    // A's 3 (untouched) + B's 3 (live, the MORE complete side) -- the
    // pre-fix code would have compared cumulative persisted (3 + 2 = 5)
    // against live-for-B-only (3) and picked storage wholesale, LOSING B's
    // one freshest not-yet-checkpointed sample (total would read 5, not 6).
    expect(totalSamples).toBe(6);
    const bSeries = doc!.observationSeries.find((s) => s.didHex === '0x2003');
    expect(bSeries?.samples).toEqual([
      { tMs: 0, rawHex: '0A' },
      { tMs: 100, rawHex: '0B' },
      { tMs: 200, rawHex: '0C' }, // the freshest live-only sample -- lost by the pre-fix "pick the longer source" logic.
    ]);
  });

  /**
   * V4: persisted observation groups stay SEPARATE in export -- a DID
   * sampled in TWO observations (one batched, one not) produces TWO series,
   * each with its OWN `batchIndex`, never merged into one that reports only
   * the first observation's `batchIndex`.
   */
  it('V4: the SAME DID sampled in two separate observations exports as TWO series, each with its own batchIndex -- never merged', async () => {
    const store = createInMemoryDidSweepStore();
    await store.createRun(run({ runId: 'run-v4' }));

    const did = 0x1234;
    // Observation A (batched): persisted with batchIndex 0.
    await store.appendObservationSamples('run-v4', 'obs-a', [
      { did, phase: 'baseline', tMs: 0, raw: Uint8Array.from([1]), batchIndex: 0 },
      { did, phase: 'baseline', tMs: 100, raw: Uint8Array.from([2]), batchIndex: 0 },
    ]);
    // Observation B (focused, never batched): persisted with batchIndex null.
    await store.appendObservationSamples('run-v4', 'obs-b', [
      { did, phase: 'baseline', tMs: 0, raw: Uint8Array.from([9]) },
      { did, phase: 'baseline', tMs: 100, raw: Uint8Array.from([8]) },
    ]);

    const controller = await fakeControllerAt(store, null, []); // nothing live -- both observations are fully settled/persisted.
    const doc = await buildDidSweepExportForRun(controller, store, 'run-v4', '2026-08-29T11:00:00.000Z');
    expect(doc).not.toBeNull();

    const didSeries = doc!.observationSeries.filter((s) => s.didHex === '0x1234');
    // TWO series, not one merged one.
    expect(didSeries).toHaveLength(2);
    const withBatch = didSeries.find((s) => s.batchIndex === 0);
    const withoutBatch = didSeries.find((s) => s.batchIndex === null);
    expect(withBatch?.samples).toEqual([
      { tMs: 0, rawHex: '01' },
      { tMs: 100, rawHex: '02' },
    ]);
    expect(withoutBatch?.samples).toEqual([
      { tMs: 0, rawHex: '09' },
      { tMs: 100, rawHex: '08' },
    ]);
    expect(withBatch?.observationId).toBe('obs-a');
    expect(withoutBatch?.observationId).toBe('obs-b');
  });
});
