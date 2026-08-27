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
  DID_SWEEP_EXPORT_SCHEMA_VERSION,
  didSweepExportFileName,
  shareDidSweepExport,
  type DidSweepExportDocument,
} from '../../src/session/didSweepExport';
import type { DidSweepResponderRecord, DidSweepRunRecord } from '../../src/persistence/didSweepStore';

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
        { did: 0x2010, lastRawHex: 'FF', sampleCount: 12, min: 0, max: 255, distinctValueCount: 2, changedInPhase: { baseline: false, brake: true, steering: false, throttle: false }, rank: 'brakeOrSteeringCandidate' },
      ],
      nowIso: '2026-08-27T19:00:00.000Z',
    });
    expect(doc.candidates).toEqual([
      { didHex: '0x2010', rank: 'brakeOrSteeringCandidate', lastRawHex: 'FF', sampleCount: 12, min: 0, max: 255, distinctValueCount: 2, changedInPhase: { baseline: false, brake: true, steering: false, throttle: false } },
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
        { did: 0x2010, lastRawHex: 'FF', sampleCount: 1, min: null, max: null, distinctValueCount: 1, changedInPhase: { baseline: false, brake: true, steering: false, throttle: false }, rank: 'brakeOrSteeringCandidate' },
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
