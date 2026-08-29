import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import { buildMetronomeTimeline, type SignalActionScript, type SignalCandidateScore } from '@circuit/core';
import {
  SIGNAL_FINDER_EXPORT_KIND,
  SIGNAL_FINDER_EXPORT_SCHEMA_VERSION,
  buildSignalFinderExportDocument,
  buildSignalFinderSummaryMarkdown,
  shareSignalFinderExport,
  shareSignalFinderJson,
  signalFinderExportFileName,
  type SignalFinderExportInput,
} from '../../src/session/signalFinderExport';

/**
 * Ticket P4l S5 (user requirement 2026-08-29, binding) / contracts.md
 * "Signal Finder (Phase 4l)" items 6 and 8: "one tap 'Share' on the result
 * screen exports TWO files: (a) the full JSON session
 * (`trace-signal-finder-<yyyy-mm-dd>-<target>.json`, schemaVersion 1) and
 * (b) a human-readable summary `...md` (<= 1 page: target, engine state,
 * ECUs + DID count read, per-DID verdict table with evidence, confirmed
 * bindings, next step with minutes)."
 */

const SCRIPT: SignalActionScript = {
  repetitions: 5,
  baselineMs: 2_000,
  pressMs: 2_000,
  holdMs: 0,
  releaseMs: 2_000,
  settleMs: 500,
};
const TIMELINE = buildMetronomeTimeline(SCRIPT);

function score(overrides: Partial<SignalCandidateScore> = {}): SignalCandidateScore {
  return {
    ecu: 0x29,
    did: 0x500c,
    length: 1,
    lengthConsistent: true,
    verdict: 'found',
    matchedEdges: 10,
    expectedEdges: 10,
    baselineChanges: 0,
    responseBaselineChanges: 0,
    restValueHex: '04',
    lastRawHex: '04',
    min: 4,
    max: 5,
    sampleCount: 22,
    windowsBelowMinimum: 0,
    byteOffset: null,
    correlationSign: null,
    insufficientReason: null,
    ...overrides,
  };
}

function input(overrides: Partial<SignalFinderExportInput> = {}): SignalFinderExportInput {
  return {
    nowIso: '2026-08-29T18:12:03.000Z',
    sessionId: 'signal-finder-1788-abc',
    profileId: 'toyota-supra-b58',
    targetId: 'brakeSwitch',
    targetLabel: 'Brake switch',
    engineRequirement: 'off-ok',
    startedAtUtc: '2026-08-29T18:10:00.000Z',
    measuredReqPerSec: 15.8,
    timeline: TIMELINE,
    passes: [
      { ecu: 0x12, dids: [0x58b7], hypothesisDids: [0x58b7], cachedDids: [] },
      { ecu: 0x29, dids: [0x500c, 0x500b], hypothesisDids: [0x500c, 0x500b], cachedDids: [] },
    ],
    scores: [score(), score({ did: 0x500b, length: 2, verdict: 'unrelated', matchedEdges: 2, min: 2, max: 6, restValueHex: '0002', lastRawHex: '0002' })],
    noResponseDids: [{ ecu: 0x12, did: 0x58b7 }],
    samples: [{ ecu: 0x29, did: 0x500c, tMs: 1_250, raw: Uint8Array.from([0x04]) }],
    confirmedBindings: [],
    nextStep: null,
    ...overrides,
  };
}

beforeEach(() => {
  fileSystemTracker.writeCalls = [];
  fileSystemTracker.writeShouldThrow = false;
  sharingTracker.available = true;
  sharingTracker.shareCalls = [];
  sharingTracker.shareShouldThrow = false;
});

describe('buildSignalFinderExportDocument', () => {
  it('is schemaVersion 1 of trace-signal-finder and carries the whole session', () => {
    const doc = buildSignalFinderExportDocument(input());
    expect(doc.schemaVersion).toBe(SIGNAL_FINDER_EXPORT_SCHEMA_VERSION);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.kind).toBe(SIGNAL_FINDER_EXPORT_KIND);
    expect(doc.kind).toBe('trace-signal-finder');
    expect(doc.session).toMatchObject({
      sessionId: 'signal-finder-1788-abc',
      profileId: 'toyota-supra-b58',
      targetId: 'brakeSwitch',
      engineRequirement: 'off-ok',
    });
    expect(doc.metronome).toMatchObject({ repetitions: 5, expectedEdges: 10, settleMs: 500 });
    expect(doc.metronome.steps).toHaveLength(TIMELINE.steps.length);
  });

  it('renders every ECU/DID as hex, never a bare number', () => {
    const doc = buildSignalFinderExportDocument(input());
    expect(doc.passes.map((p) => p.ecuHex)).toEqual(['0x12', '0x29']);
    expect(doc.passes[1]!.didHex).toEqual(['0x500C', '0x500B']);
    expect(doc.candidates[0]).toMatchObject({ ecuHex: '0x29', didHex: '0x500C', verdict: 'found', matchedEdges: 10 });
    expect(doc.noResponse).toEqual([{ ecuHex: '0x12', didHex: '0x58B7' }]);
    expect(doc.samples[0]).toMatchObject({ ecuHex: '0x29', didHex: '0x500C', tMs: 1_250, rawHex: '04' });
  });

  it('names the files after the date and target', () => {
    expect(signalFinderExportFileName('2026-08-29T18:12:03.000Z', 'brakeSwitch', 'json')).toBe(
      'trace-signal-finder-2026-08-29-brakeSwitch.json',
    );
    expect(signalFinderExportFileName('2026-08-29T18:12:03.000Z', 'brakeSwitch', 'md')).toBe(
      'trace-signal-finder-2026-08-29-brakeSwitch.md',
    );
  });
});

describe('buildSignalFinderSummaryMarkdown (pure, <= 1 page)', () => {
  it('states target, engine state, what was read, the verdict table and the confirmed binding (EN)', () => {
    const doc = buildSignalFinderExportDocument(
      input({
        confirmedBindings: [
          {
            profileId: 'toyota-supra-b58',
            channel: 'brakeSwitch',
            ecu: 0x29,
            did: 0x500c,
            length: 1,
            decode: 'bit0 (0x04 released -> 0x05 pressed)',
            status: 'field-confirmed',
            evidenceJson: '{}',
            updatedAtUtc: '2026-08-29T18:12:00.000Z',
          },
        ],
      }),
    );
    const md = buildSignalFinderSummaryMarkdown(doc, 'en');
    expect(md).toContain('# Signal Finder — Brake switch');
    expect(md).toContain('engine off');
    expect(md).toContain('0x12'); // ECUs read
    expect(md).toContain('0x29');
    expect(md).toMatch(/\| *0x500C *\|/); // verdict table row
    expect(md).toContain('found');
    expect(md).toContain('10/10');
    expect(md).toContain('bit0 (0x04 released -> 0x05 pressed)');
    // <= 1 page: the summary never dumps the raw sample log.
    expect(md.split('\n').length).toBeLessThanOrEqual(60);
  });

  it('says what to do next, with minutes, whenever nothing was found (honesty, item 4)', () => {
    const doc = buildSignalFinderExportDocument(
      input({
        scores: [score({ verdict: 'unrelated', matchedEdges: 2 })],
        nextStep: {
          ecu: 0x29,
          fromDid: 0x58f3,
          toDid: 0x6fff,
          didCount: 0x6fff - 0x58f3 + 1,
          estimatedMinutes: 6.76,
          engineRequirement: 'off-ok',
          note: 'the part of 0x29 test 4 stopped short of',
        },
      }),
    );
    const md = buildSignalFinderSummaryMarkdown(doc, 'en');
    expect(md).toContain('Next step');
    expect(md).toContain('0x58F3');
    expect(md).toContain('0x6FFF');
    expect(md).toMatch(/≈ ?7 min/);
    expect(md).toContain('engine off');
    expect(md).not.toContain('no brake on this car');
  });

  it('renders the same summary in Romanian', () => {
    const doc = buildSignalFinderExportDocument(input());
    const ro = buildSignalFinderSummaryMarkdown(doc, 'ro');
    expect(ro).toContain('Semnal găsit');
    expect(ro).toContain('motor oprit');
    expect(ro).toMatch(/\| *0x500C *\|/);
    expect(ro).not.toBe(buildSignalFinderSummaryMarkdown(doc, 'en'));
  });

  it('reports "no response" DIDs so a silent ECU never reads as "measured and static"', () => {
    const md = buildSignalFinderSummaryMarkdown(buildSignalFinderExportDocument(input()), 'en');
    expect(md.toLowerCase()).toContain('no response');
    expect(md).toContain('0x58B7');
  });
});

describe('shareSignalFinderExport', () => {
  it('writes BOTH files and hands the human-readable .md to the share sheet first', async () => {
    const doc = buildSignalFinderExportDocument(input());
    const result = await shareSignalFinderExport(doc, 'en');
    expect(result).toMatchObject({ ok: true, shared: true });
    expect(fileSystemTracker.writeCalls.map((c) => c.path)).toEqual([
      'trace-signal-finder-2026-08-29-brakeSwitch.md',
      'trace-signal-finder-2026-08-29-brakeSwitch.json',
    ]);
    expect(sharingTracker.shareCalls).toHaveLength(1);
    expect(sharingTracker.shareCalls[0]!.url).toContain('.md');
    // The JSON is written and its uri handed back, so the screen can offer
    // the second button (expo-sharing shares exactly one file per call).
    expect(result.jsonUri).toContain('.json');
    expect(JSON.parse(fileSystemTracker.writeCalls[1]!.content)).toMatchObject({ kind: 'trace-signal-finder' });
  });

  it('shareSignalFinderJson shares the JSON on its own (the second button)', async () => {
    const doc = buildSignalFinderExportDocument(input());
    const result = await shareSignalFinderJson(doc);
    expect(result).toMatchObject({ ok: true, shared: true });
    expect(sharingTracker.shareCalls[0]!.url).toContain('.json');
  });

  it('falls back (never throws) when sharing is unavailable -- web preview', async () => {
    sharingTracker.available = false;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await shareSignalFinderExport(buildSignalFinderExportDocument(input()), 'en');
    expect(result).toMatchObject({ ok: true, shared: false });
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it('never throws when the share sheet itself fails', async () => {
    sharingTracker.shareShouldThrow = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await shareSignalFinderExport(buildSignalFinderExportDocument(input()), 'en');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/share sheet failed/);
    logSpy.mockRestore();
  });
});
