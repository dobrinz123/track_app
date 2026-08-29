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
  VEHICLE_PROFILE_EXPORT_KIND,
  VEHICLE_PROFILE_EXPORT_SCHEMA_VERSION,
  buildSignalFinderExportDocument,
  buildSignalFinderSummaryMarkdown,
  buildVehicleProfileDocument,
  shareSignalFinderExport,
  shareSignalFinderJson,
  shareVehicleProfileExport,
  signalFinderExportFileName,
  signalFinderExportInputFromSnapshot,
  vehicleProfileExportFileName,
  type SignalFinderExportInput,
} from '../../src/session/signalFinderExport';
import type { SignalFinderSnapshot } from '../../src/session/signalFinderController';
import type { VehicleProfileBinding } from '../../src/persistence/didSweepStore';

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
    rateSource: 'measured',
    timeline: TIMELINE,
    passes: [
      { ecu: 0x12, dids: [0x58b7], hypothesisDids: [0x58b7], changedDids: [], cachedDids: [] },
      { ecu: 0x29, dids: [0x500c, 0x500b], hypothesisDids: [0x500c, 0x500b], changedDids: [], cachedDids: [] },
    ],
    rounds: 1,
    budget: 12,
    notReadDids: [],
    silentDids: [],
    silentEcus: [],
    scores: [score(), score({ did: 0x500b, length: 2, verdict: 'unrelated', matchedEdges: 2, min: 2, max: 6, restValueHex: '0002', lastRawHex: '0002' })],
    noResponseDids: [{ ecu: 0x12, did: 0x58b7 }],
    samples: [{ ecu: 0x29, did: 0x500c, tMs: 1_250, raw: Uint8Array.from([0x04]) }],
    confirmedBindings: [],
    nextStep: null,
    diagnostics: { rawError: null, timeoutInclusiveReqPerSec: null, adapterTeardownPending: false },
    ...overrides,
  };
}

function snapshot(overrides: Partial<SignalFinderSnapshot> = {}): SignalFinderSnapshot {
  return {
    phase: 'result',
    profileId: 'toyota-supra-b58',
    targetId: 'brakeSwitch',
    targetLabel: 'Brake switch',
    engineRequirement: 'off-ok',
    timeline: TIMELINE,
    passes: [{ ecu: 0x29, dids: [0x500c], hypothesisDids: [0x500c], changedDids: [], cachedDids: [] }],
    round: 1,
    budget: 12,
    readDids: [{ ecu: 0x29, did: 0x500c }],
    notReadDids: [],
    notReadCount: 0,
    silentDids: [],
    silentEcus: [],
    ecus: [0x29],
    step: null,
    scores: [score()],
    noResponseDids: [],
    nextStep: null,
    confirmedChannels: [],
    sessionId: 'signal-finder-1788-abc',
    startedAtUtc: '2026-08-29T18:10:00.000Z',
    measuredReqPerSec: 15.8,
    rateSource: 'measured',
    diagnosticReqPerSec: null,
    probeProgress: null,
    adapterTeardownPending: false,
    error: null,
    errorCode: null,
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
  it('is schemaVersion 4 of trace-signal-finder and carries the whole session, rounds included (P4m M3, P4m-FIX1 X1/X2, P4m-FIX3 Z7)', () => {
    const doc = buildSignalFinderExportDocument(input());
    expect(doc.schemaVersion).toBe(SIGNAL_FINDER_EXPORT_SCHEMA_VERSION);
    expect(doc.schemaVersion).toBe(4);
    expect(doc.kind).toBe(SIGNAL_FINDER_EXPORT_KIND);
    expect(doc.kind).toBe('trace-signal-finder');
    expect(doc.session).toMatchObject({
      sessionId: 'signal-finder-1788-abc',
      profileId: 'toyota-supra-b58',
      targetId: 'brakeSwitch',
      engineRequirement: 'off-ok',
      rounds: 1,
      budget: 12,
    });
    expect(doc.notRead).toEqual([]);
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

  /**
   * P4l-FIX3 J6 (binding — Codex P4l re-review finding L12, added mid-ticket
   * by the coordinator): verdicts are computed from `netEdges` (=
   * `matchedEdges - extraTransitions`), not the gross `matchedEdges` — the
   * export must carry that same net figure plus the extras/cap-reason
   * fields P4l-FIX2 added to `SignalCandidateScore`, so a reader of the JSON
   * sees the SAME evidence the verdict was actually based on.
   */
  it('carries netEdges (matchedEdges minus extraTransitions) and the P4l-FIX2 extras on every candidate', () => {
    const doc = buildSignalFinderExportDocument(
      input({
        scores: [
          score({
            did: 0x500c,
            verdict: 'probable',
            matchedEdges: 5,
            expectedEdges: 5,
            extraTransitions: 1,
            didBaselineChanges: 0,
            bipolarSides: null,
            verdictCapReason: 'extra-transitions',
          }),
        ],
      }),
    );
    expect(doc.candidates[0]).toMatchObject({
      matchedEdges: 5,
      extraTransitions: 1,
      netEdges: 4, // 5 - 1
      didBaselineChanges: 0,
      bipolarSides: null,
      verdictCapReason: 'extra-transitions',
    });
  });

  it('netEdges defaults to matchedEdges (extraTransitions 0) when the score carries none of the optional P4l-FIX2 fields', () => {
    const doc = buildSignalFinderExportDocument(input({ scores: [score({ matchedEdges: 10, expectedEdges: 10 })] }));
    expect(doc.candidates[0]).toMatchObject({ netEdges: 10, extraTransitions: 0, didBaselineChanges: 0, bipolarSides: null, verdictCapReason: null });
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

describe('signalFinderExportInputFromSnapshot (P4l-FIX3 J2, after Codex P4l-REV1 M7)', () => {
  /**
   * "the on-screen summary/export document is built from
   * `controller.getSnapshot()` after `find()` resolves ... never from the
   * closure that started the run." A component-render test is not available
   * in this repo (no `@testing-library/react-native` dependency) -- verified
   * here at the level the screen's `buildDocument()` now delegates to: a
   * PURE function of whichever snapshot it is handed, so `SignalFinderScreen.tsx`
   * calling it with `controller.getSnapshot()` (the fresh, post-`find()`
   * snapshot) can never combine data from an earlier run the way closing
   * over React's `snapshot` STATE did.
   */
  it('returns null when the given snapshot has no target yet (nothing has run)', () => {
    expect(signalFinderExportInputFromSnapshot(snapshot({ targetId: null }), [], [], '2026-08-29T18:12:03.000Z')).toBeNull();
  });

  it('builds an input that reproduces the GIVEN snapshot exactly, never a memoized one', () => {
    const samples = [{ ecu: 0x29, did: 0x500c, tMs: 1_250, raw: Uint8Array.from([0x04]) }];
    const result = signalFinderExportInputFromSnapshot(snapshot(), samples, [], '2026-08-29T18:12:03.000Z');
    expect(result).toMatchObject({
      nowIso: '2026-08-29T18:12:03.000Z',
      sessionId: 'signal-finder-1788-abc',
      profileId: 'toyota-supra-b58',
      targetId: 'brakeSwitch',
      targetLabel: 'Brake switch',
      engineRequirement: 'off-ok',
      startedAtUtc: '2026-08-29T18:10:00.000Z',
      measuredReqPerSec: 15.8,
      passes: [{ ecu: 0x29, dids: [0x500c] }],
      nextStep: null,
    });
    expect(result!.samples).toBe(samples);
  });

  it('a SECOND call with a DIFFERENT (later) snapshot reflects ONLY that later run -- no leakage from the first (the exact bug: a stale closure combining two runs)', () => {
    const run1 = snapshot({
      sessionId: 'signal-finder-run-1',
      targetId: 'brakeSwitch',
      scores: [score({ did: 0x500c, verdict: 'unrelated', matchedEdges: 1 })],
    });
    const run2 = snapshot({
      sessionId: 'signal-finder-run-2',
      targetId: 'steeringAngle',
      targetLabel: 'Steering angle',
      scores: [score({ did: 0x4000, verdict: 'found', matchedEdges: 10 })],
    });
    const first = signalFinderExportInputFromSnapshot(run1, [], [], '2026-08-29T18:12:03.000Z')!;
    const second = signalFinderExportInputFromSnapshot(run2, [], [], '2026-08-29T18:14:00.000Z')!;
    expect(first.sessionId).toBe('signal-finder-run-1');
    expect(first.targetId).toBe('brakeSwitch');
    expect(second.sessionId).toBe('signal-finder-run-2');
    expect(second.targetId).toBe('steeringAngle');
    expect(second.scores).toEqual([score({ did: 0x4000, verdict: 'found', matchedEdges: 10 })]);
  });

  it('carries the confirmed bindings and samples handed to it (screen-supplied, not part of the controller snapshot)', () => {
    const bindings = [
      {
        profileId: 'toyota-supra-b58',
        channel: 'brakeSwitch',
        ecu: 0x29,
        did: 0x500c,
        length: 1,
        decode: 'bit0',
        status: 'field-confirmed' as const,
        evidenceJson: '{}',
        updatedAtUtc: '2026-08-29T18:12:00.000Z',
      },
    ];
    const result = signalFinderExportInputFromSnapshot(snapshot(), [], bindings, '2026-08-29T18:12:03.000Z');
    expect(result!.confirmedBindings).toBe(bindings);
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

  /**
   * P4l-FIX3 J6 (binding, Codex re-review L12): the table's evidence column
   * shows NET edges (what the verdict is actually based on), and states the
   * extras/cap reason in one short line -- e.g. "4/5 edges (1 extra), capped:
   * one-sided" -- whenever they are present, so a reader is never left
   * looking at a bare edge count that doesn't explain a lower-than-expected
   * verdict.
   */
  it('shows netEdges as the primary evidence plus extraTransitions and the cap reason in one short line', () => {
    const doc = buildSignalFinderExportDocument(
      input({
        scores: [
          score({
            did: 0x500c,
            verdict: 'probable',
            matchedEdges: 5,
            expectedEdges: 5,
            extraTransitions: 1,
            didBaselineChanges: 0,
            verdictCapReason: 'one-sided-bipolar',
          }),
        ],
      }),
    );
    const md = buildSignalFinderSummaryMarkdown(doc, 'en');
    // netEdges (4 = 5 - 1) over expectedEdges, never the gross matchedEdges (5).
    expect(md).toMatch(/\b4\/5\b/);
    expect(md).not.toMatch(/\b5\/5\b/);
    expect(md).toContain('1 extra');
    expect(md).toMatch(/capped:.*one-sided/);
  });

  it('shows didBaselineChanges when present and nonzero, alongside the edge count', () => {
    const doc = buildSignalFinderExportDocument(
      input({
        scores: [score({ did: 0x500c, verdict: 'unrelated', matchedEdges: 2, expectedEdges: 10, didBaselineChanges: 3 })],
      }),
    );
    const md = buildSignalFinderSummaryMarkdown(doc, 'en');
    expect(md).toMatch(/baseline.*3/i);
  });

  it('omits every extras marker when the score carries none of them (the common case)', () => {
    const doc = buildSignalFinderExportDocument(input({ scores: [score({ matchedEdges: 10, expectedEdges: 10 })] }));
    const md = buildSignalFinderSummaryMarkdown(doc, 'en');
    expect(md).not.toContain('extra');
    expect(md).not.toContain('capped');
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

  /**
   * P4l-FIX3 J3 (binding, after Codex P4l-REV1 M8/MEDIUM: "the Markdown
   * exporter does not guarantee the binding <= 1-page limit" -- candidate
   * rows were capped, but the no-response DID list and binding decode
   * strings were NOT, and counting SOURCE lines never bounded the rendered
   * page). Total budget: ~60 lines / ~4 KB, hard-enforced regardless of how
   * many/how long the variable-length sections are; every truncated section
   * carries an explicit "(+N more...)" marker.
   */
  it('a 200-DID no-response list and a 500-char decode string stay within the ~60-line/~4KB budget, with a truncation marker', () => {
    const noResponseDids = Array.from({ length: 200 }, (_v, i) => ({ ecu: 0x29, did: 0x5000 + i }));
    const longDecode = 'x'.repeat(500);
    const doc = buildSignalFinderExportDocument(
      input({
        noResponseDids,
        confirmedBindings: [
          {
            profileId: 'toyota-supra-b58',
            channel: 'brakeSwitch',
            ecu: 0x29,
            did: 0x500c,
            length: 1,
            decode: longDecode,
            status: 'field-confirmed',
            evidenceJson: '{}',
            updatedAtUtc: '2026-08-29T18:12:00.000Z',
          },
        ],
      }),
    );
    const md = buildSignalFinderSummaryMarkdown(doc, 'en');
    expect(md.length).toBeLessThanOrEqual(4_096);
    expect(md.split('\n').length).toBeLessThanOrEqual(60);
    // The full 500-char decode string never appears verbatim -- it was
    // truncated -- and SOME "more" marker is present (the no-response list
    // alone cannot possibly fit all 200 entries under the budget above).
    expect(md).not.toContain(longDecode);
    expect(md).toMatch(/\(\+\d+ more/);
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

/**
 * P4l-FIX3 J4 (binding — contracts.md "Signal Finder (Phase 4l)" item 5:
 * "exportable JSON identical to `data/vehicle-profiles/*.json`"):
 * `buildVehicleProfileDocument(profileId, bindings)` merges PERSISTED
 * bindings (`VehicleProfileBindingStore.listBindings()`) into the canonical
 * vehicle-profile shape -- `profileId`, `make`/`model` when the profile is a
 * known one, `transport`, `ecus`, and `channels[]` carrying each binding's
 * own `status`/`decode`/evidence.
 */
function binding(overrides: Partial<VehicleProfileBinding> = {}): VehicleProfileBinding {
  return {
    profileId: 'toyota-supra-b58',
    channel: 'brakeSwitch',
    ecu: 0x29,
    did: 0x500c,
    length: 1,
    decode: 'bit0 (0x04 released -> 0x05 pressed)',
    status: 'field-confirmed',
    evidenceJson: JSON.stringify({ restValueHex: '04', min: 4, max: 5, byteOffset: null }),
    updatedAtUtc: '2026-08-29T18:12:00.000Z',
    ...overrides,
  };
}

describe('buildVehicleProfileDocument', () => {
  it('is schemaVersion 1 of trace-vehicle-profile', () => {
    const doc = buildVehicleProfileDocument('toyota-supra-b58', [], '2026-08-29T18:12:03.000Z');
    expect(doc.schemaVersion).toBe(VEHICLE_PROFILE_EXPORT_SCHEMA_VERSION);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.kind).toBe(VEHICLE_PROFILE_EXPORT_KIND);
    expect(doc.kind).toBe('trace-vehicle-profile');
    expect(doc.profileId).toBe('toyota-supra-b58');
    expect(doc.transport).toBe('enet');
  });

  it('two confirmed bindings become channels[] with status field-confirmed and evidence (the ticket s own test)', () => {
    const bindings = [
      binding(),
      binding({
        channel: 'brakePressure',
        ecu: 0x12,
        did: 0x58b7,
        length: 1,
        decode: 'u8 hPa',
        evidenceJson: JSON.stringify({ restValueHex: '00', min: 0, max: 200, byteOffset: null }),
      }),
    ];
    const doc = buildVehicleProfileDocument('toyota-supra-b58', bindings, '2026-08-29T18:12:03.000Z');
    expect(doc.channels).toHaveLength(2);
    for (const channel of doc.channels) {
      expect(channel.status).toBe('field-confirmed');
      expect(channel.evidence).not.toBeNull();
      expect(channel.evidence).not.toBeUndefined();
    }
    expect(doc.channels[0]).toMatchObject({ channel: 'brakeSwitch', ecu: '0x29', did: '0x500C', source: 'did' });
    expect(doc.channels[0]!.evidence).toMatchObject({ min: 4, max: 5 });
    expect(doc.channels[1]).toMatchObject({ channel: 'brakePressure', ecu: '0x12', did: '0x58B7' });
  });

  it('make/model are filled in for a known profile, absent for an unknown one', () => {
    const known = buildVehicleProfileDocument('toyota-supra-b58', [], '2026-08-29T18:12:03.000Z');
    expect(known.make).toBeTruthy();
    expect(known.model).toBeTruthy();
    const unknown = buildVehicleProfileDocument('generic', [], '2026-08-29T18:12:03.000Z');
    expect(unknown.make).toBeUndefined();
    expect(unknown.model).toBeUndefined();
  });

  it('collects every distinct ECU address seen across bindings', () => {
    const doc = buildVehicleProfileDocument(
      'toyota-supra-b58',
      [binding({ ecu: 0x29 }), binding({ channel: 'brakePressure', ecu: 0x12, did: 0x58b7 })],
      '2026-08-29T18:12:03.000Z',
    );
    expect(Object.keys(doc.ecus).sort()).toEqual(['0x12', '0x29']);
  });

  it('a corrupt evidence blob never throws -- the raw string is carried instead', () => {
    const doc = buildVehicleProfileDocument('toyota-supra-b58', [binding({ evidenceJson: 'not json{' })], '2026-08-29T18:12:03.000Z');
    expect(doc.channels[0]!.evidence).toBe('not json{');
  });

  it('names the file after the profile and the date', () => {
    expect(vehicleProfileExportFileName('toyota-supra-b58', '2026-08-29T18:12:03.000Z')).toBe(
      'trace-vehicle-profile-toyota-supra-b58-2026-08-29.json',
    );
  });
});

describe('shareVehicleProfileExport', () => {
  it('writes and shares the profile JSON, never throws', async () => {
    const doc = buildVehicleProfileDocument('toyota-supra-b58', [binding()], '2026-08-29T18:12:03.000Z');
    const result = await shareVehicleProfileExport(doc);
    expect(result).toMatchObject({ ok: true, shared: true });
    expect(sharingTracker.shareCalls[0]!.url).toContain('.json');
    expect(fileSystemTracker.writeCalls[0]!.path).toBe('trace-vehicle-profile-toyota-supra-b58-2026-08-29.json');
    expect(JSON.parse(fileSystemTracker.writeCalls[0]!.content)).toMatchObject({ kind: 'trace-vehicle-profile', profileId: 'toyota-supra-b58' });
  });

  it('falls back (never throws) when sharing is unavailable', async () => {
    sharingTracker.available = false;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const doc = buildVehicleProfileDocument('toyota-supra-b58', [], '2026-08-29T18:12:03.000Z');
    const result = await shareVehicleProfileExport(doc);
    expect(result).toMatchObject({ ok: true, shared: false });
    logSpy.mockRestore();
  });
});

/**
 * Ticket P4m M3 (binding, contracts.md items 10 and 12): the header states
 * "Read N DIDs across E ECUs in R round(s)"; unread DIDs are reported as
 * "not read" with a Next-round hint and NEVER listed under "No response"
 * (build 5 reported 1372 never-polled DIDs as "No response (NRC or silence)");
 * a sparse verdict says so.
 */
describe('buildSignalFinderSummaryMarkdown -- P4m M3 (rounds, not read, sparse)', () => {
  it('says how many ROUNDS the driver actually performed, in both languages', () => {
    const one = buildSignalFinderExportDocument(input({ rounds: 1 }));
    expect(buildSignalFinderSummaryMarkdown(one, 'en')).toContain('3 DIDs across 2 ECUs in 1 round');
    expect(buildSignalFinderSummaryMarkdown(one, 'ro')).toContain('3 DID-uri pe 2 ECU în 1 rundă');
    const three = buildSignalFinderExportDocument(input({ rounds: 3 }));
    expect(buildSignalFinderSummaryMarkdown(three, 'en')).toContain('in 3 rounds');
    expect(buildSignalFinderSummaryMarkdown(three, 'ro')).toContain('în 3 runde');
  });

  it('reports unread DIDs as "Not read" with the Next round hint -- never under "No response"', () => {
    const doc = buildSignalFinderExportDocument(
      input({
        notReadDids: Array.from({ length: 20 }, (_v, i) => ({ ecu: 0x12, did: 0x2000 + i })),
        noResponseDids: [{ ecu: 0x12, did: 0x58b7 }],
      }),
    );
    expect(doc.notRead).toHaveLength(20);
    const en = buildSignalFinderSummaryMarkdown(doc, 'en');
    expect(en).toContain('Not read: 20 (tap Next round)');
    // The unread DIDs are NOT in the no-response section.
    const noResponseLine = en.split('\n').find((line) => line.startsWith('**No response')) ?? '';
    expect(noResponseLine).toContain('0x58B7');
    expect(noResponseLine).not.toContain('0x2000');
    expect(buildSignalFinderSummaryMarkdown(doc, 'ro')).toContain('Necitite: 20 (apasă Runda următoare)');
  });

  it('marks a sparse verdict as such and shows the window agreement it rests on', () => {
    const doc = buildSignalFinderExportDocument(
      input({
        scores: [
          score({
            ecu: 0x12,
            did: 0x4002,
            verdict: 'found',
            matchedEdges: 6,
            expectedEdges: 10,
            sparse: true,
            windowMatchedEdges: 10,
            restValueHex: '01',
          }),
        ],
      }),
    );
    expect(doc.candidates[0]).toMatchObject({ sparse: true, windowMatchedEdges: 10 });
    const en = buildSignalFinderSummaryMarkdown(doc, 'en');
    expect(en).toContain('found (sparse)');
    expect(en).toContain('10/10');
    expect(buildSignalFinderSummaryMarkdown(doc, 'ro')).toContain('găsit (rar)');
  });
});

/**
 * Ticket P4m-FIX2 Y7 (Codex P4m-REV2 finding 9, MEDIUM — the PARTIAL half of
 * P4m-FIX1 X8): "Romanian output can still contain English — the controller
 * stores `target.label` in English and the export consumes it unchanged; the
 * candidate truncation line still hard-codes `more`".
 *
 * The `.md` is the file the driver FORWARDS, so the target's name in it is
 * resolved by LANGUAGE from the catalog (data), at export time — the JSON keeps
 * `session.targetLabel` as the stable English/tooling name.
 */
describe('P4m-FIX2 Y7 -- the RO summary carries no English', () => {
  it('titles the RO summary with the catalog s Romanian target name, never `Brake switch`', () => {
    const doc = buildSignalFinderExportDocument(input());
    const ro = buildSignalFinderSummaryMarkdown(doc, 'ro');
    expect(ro).toContain('Contact de frână');
    expect(ro).not.toContain('Brake switch');
    // The machine-readable half is unchanged: tooling still reads one stable name.
    expect(doc.session.targetLabel).toBe('Brake switch');
    expect(buildSignalFinderSummaryMarkdown(doc, 'en')).toContain('Brake switch');
  });

  it('uses the localized truncation marker for the candidate tail, never the hard-coded `more`', () => {
    const many = Array.from({ length: 30 }, (_v, i) => score({ did: 0x6000 + i, verdict: 'unrelated' }));
    const doc = buildSignalFinderExportDocument(input({ scores: many }));
    const ro = buildSignalFinderSummaryMarkdown(doc, 'ro');
    expect(ro).not.toMatch(/\bmore\b/);
    expect(ro).toContain('(+încă');
  });

  it('leaves no English word anywhere in a fully populated RO summary', () => {
    const doc = buildSignalFinderExportDocument(
      input({
        notReadDids: [{ ecu: 0x12, did: 0x4100 }],
        silentDids: [{ ecu: 0x29, did: 0x500b }],
        silentEcus: [0x29],
        scores: Array.from({ length: 30 }, (_v, i) => score({ did: 0x6000 + i, verdict: 'unrelated' })),
      }),
    );
    const ro = buildSignalFinderSummaryMarkdown(doc, 'ro');
    for (const english of ['Brake switch', 'more', 'Not read', 'No response', 'found']) {
      expect(ro, `RO summary still contains "${english}"`).not.toContain(english);
    }
  });
});

/**
 * Ticket P4m-FIX3 Z7 (Codex P4m-REV3 finding 9, PARTIAL) + Z1: the RAW failure
 * text and the probe's timeout-inclusive rate leave the app through the
 * export's `diagnostics` section — and through nothing else.
 */
describe('P4m-FIX3 Z1/Z7 -- the export diagnostics section', () => {
  it('carries the raw error, the probe s own overall rate and the teardown flag (schema 4)', () => {
    const doc = buildSignalFinderExportDocument(
      input({
        measuredReqPerSec: 15.2,
        diagnostics: { rawError: 'socket hang up', timeoutInclusiveReqPerSec: 1.8, adapterTeardownPending: true },
      }),
    );
    expect(doc.schemaVersion).toBe(4);
    expect(doc.diagnostics).toEqual({
      rawError: 'socket hang up',
      timeoutInclusiveReqPerSec: 1.8,
      adapterTeardownPending: true,
    });
    // The budget/estimate rate and the probe's overall rate are DIFFERENT
    // numbers, and the export keeps them apart (the LEAD's E2E defect).
    expect(doc.session.measuredReqPerSec).toBe(15.2);
  });

  it('the snapshot bridge is what puts the raw error there -- the driver never reads it', () => {
    const doc = buildSignalFinderExportDocument(
      signalFinderExportInputFromSnapshot(
        snapshot({ phase: 'error', error: 'refused (test double)', errorCode: 'run-failed', diagnosticReqPerSec: 2.4 }),
        [],
        [],
        '2026-08-29T18:12:03.000Z',
      )!,
    );
    expect(doc.diagnostics.rawError).toBe('refused (test double)');
    expect(doc.diagnostics.timeoutInclusiveReqPerSec).toBe(2.4);
  });

  it('Z4: the summary says "no answer to the probe or its one retry" when no ECU was wholly silent', () => {
    const en = buildSignalFinderSummaryMarkdown(
      buildSignalFinderExportDocument(input({ silentDids: [{ ecu: 0x12, did: 0x4002 }], silentEcus: [] })),
      'en',
    );
    // Never "ECU  silent" about an ECU that answered everything else.
    expect(en).toContain('no answer to the probe or its one retry');
    expect(en).not.toMatch(/ECU\s+silent/);
    const ro = buildSignalFinderSummaryMarkdown(
      buildSignalFinderExportDocument(input({ silentDids: [{ ecu: 0x12, did: 0x4002 }], silentEcus: [] })),
      'ro',
    );
    expect(ro).toContain('fără răspuns la sondaj sau la reîncercare');
  });
});

/**
 * Ticket P4m-FIX4 W4 (Codex P4m-REV4 finding 4, MEDIUM): "schema 4 exports
 * arbitrary underlying error text without redaction ... transport/platform
 * errors can contain addresses, paths, identifiers, or credentials". The
 * diagnostics section is the one place a raw message travels, and this is what
 * it may carry: the error's own name/code, its first 120 characters, and no
 * address, host:port, path or token whatsoever.
 */
describe('P4m-FIX4 W4 -- the export redacts diagnostics.rawError', () => {
  it('replaces the IP, the file path and the long hex token, and keeps the error name', () => {
    const raw =
      String.raw`Error: connect ETIMEDOUT 192.168.1.42:6801 while reading D:\CODE\APLICTIE_Circuit\apps\mobile\src\session\enet.ts token=a3f19c7d5b0e4482a3f19c7d5b0e4482`;
    const doc = buildSignalFinderExportDocument(input({ diagnostics: { rawError: raw, timeoutInclusiveReqPerSec: 1.8, adapterTeardownPending: false } }));
    const redacted = doc.diagnostics.rawError!;
    expect(redacted).toContain('Error: connect ETIMEDOUT');
    expect(redacted).toContain('‹redacted›');
    expect(redacted).not.toContain('192.168.1.42');
    expect(redacted).not.toContain('6801');
    expect(redacted).not.toContain('APLICTIE_Circuit');
    expect(redacted).not.toContain('a3f19c7d5b0e4482');
    expect(redacted.length).toBeLessThanOrEqual(121); // 120 chars, plus the ellipsis that says it was cut.
  });

  it('leaves an ordinary message alone, and passes null through', () => {
    // The two messages the controller itself installs must survive verbatim --
    // an eager pattern that mangled them would make the diagnostics useless.
    for (const message of [
      'The adapter is in use (telemetry, the DID probe or a sweep) -- stop it first.',
      'The previous transport close() has not settled yet -- the adapter is not free.',
    ]) {
      expect(
        buildSignalFinderExportDocument(
          input({ diagnostics: { rawError: message, timeoutInclusiveReqPerSec: null, adapterTeardownPending: false } }),
        ).diagnostics.rawError,
      ).toBe(message);
    }
    expect(
      buildSignalFinderExportDocument(input({ diagnostics: { rawError: 'socket hang up', timeoutInclusiveReqPerSec: null, adapterTeardownPending: false } }))
        .diagnostics.rawError,
    ).toBe('socket hang up');
    expect(buildSignalFinderExportDocument(input()).diagnostics.rawError).toBeNull();
  });

  it('redacts an IPv6 address and a bare host:port too', () => {
    const doc = buildSignalFinderExportDocument(
      input({
        diagnostics: {
          rawError: 'EHOSTUNREACH fe80::1c2d:3e4f:5a6b:7c8d and adapter.local:6801',
          timeoutInclusiveReqPerSec: null,
          adapterTeardownPending: false,
        },
      }),
    );
    expect(doc.diagnostics.rawError).toContain('EHOSTUNREACH');
    expect(doc.diagnostics.rawError).not.toContain('fe80');
    expect(doc.diagnostics.rawError).not.toContain('adapter.local');
  });
});
