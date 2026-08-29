import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  scoreSignalCandidates,
  type MetronomeStep,
  type MetronomeTimeline,
  type SignalCandidateScore,
  type SignalExpectedShape,
  type SignalFinderSample,
} from '../../../src/telemetry/signalFinder';

/**
 * Ticket P4m M1 / contracts.md "Signal Finder REVISION (2026-08-29, after
 * field test 5)" item 13 (BINDING REGRESSION INPUTS):
 *
 *   "Field fixtures (binding regression inputs):
 *    data/field/signal-finder/2026-08-29-brakeSwitch.json -> 0x12/0x4002
 *    `found` (brake), 0x12/0x1701 unrelated; ...-accelPedal.json ->
 *    0x12/0x4007 `found` (accel idle flag, bit0), 0x4659 unrelated/static."
 *
 * These are the REAL exports of field test 5 on the user's own Supra (engine
 * off, ignition on) -- the run whose verdicts were all `insufficient` because
 * build 5 gave every DID 1-2 samples per window. The samples themselves are
 * good evidence; item 11's sparse-but-consistent rule is what turns them into
 * verdicts. The scorer is replayed here against the export's OWN metronome,
 * so a regression in either the change rule or the sufficiency gate fails
 * against the field, not against a synthetic fixture.
 */

interface ExportedSample {
  ecuHex: string;
  didHex: string;
  tMs: number;
  rawHex: string;
}

interface ExportedStep {
  index: number;
  kind: string;
  repetition: number;
  startMs: number;
  endMs: number;
  prompt: string;
}

interface ExportedSession {
  metronome: { totalMs: number; pollDurationMs: number; settleMs: number; repetitions: number; expectedEdges: number; steps: ExportedStep[] };
  samples: ExportedSample[];
}

function loadExport(name: string): ExportedSession {
  const path = resolve(__dirname, '../../../../../data/field/signal-finder', name);
  return JSON.parse(readFileSync(path, 'utf8')) as ExportedSession;
}

/** The export carries the prompt timeline; the evidence windows are its own settle-shifted derivation (`metronome.ts`). */
function timelineFromExport(doc: ExportedSession): MetronomeTimeline {
  const settleMs = doc.metronome.settleMs;
  const steps: MetronomeStep[] = doc.metronome.steps.map((step) => ({
    index: step.index,
    kind: step.kind as MetronomeStep['kind'],
    repetition: step.repetition,
    startMs: step.startMs,
    endMs: step.endMs,
    durationMs: step.endMs - step.startMs,
    evidenceFromMs: step.startMs + settleMs,
    evidenceToMs: step.endMs + settleMs,
    prompt: step.prompt,
  }));
  return {
    steps,
    totalMs: doc.metronome.totalMs,
    pollDurationMs: doc.metronome.pollDurationMs,
    repetitions: doc.metronome.repetitions,
    expectedEdges: doc.metronome.expectedEdges,
    settleMs,
  };
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function samplesFromExport(doc: ExportedSession): SignalFinderSample[] {
  return doc.samples.map((sample) => ({
    ecu: Number.parseInt(sample.ecuHex, 16),
    did: Number.parseInt(sample.didHex, 16),
    tMs: sample.tMs,
    raw: hexToBytes(sample.rawHex),
  }));
}

function scoreField(name: string, shape: SignalExpectedShape): Map<string, SignalCandidateScore> {
  const doc = loadExport(name);
  const scores = scoreSignalCandidates({
    samples: samplesFromExport(doc),
    timeline: timelineFromExport(doc),
    shape,
  });
  return new Map(scores.map((score) => [`${score.ecu}:${score.did}`, score]));
}

describe('field test 5 replay -- brake run (2026-08-29-brakeSwitch.json)', () => {
  const scores = scoreField('2026-08-29-brakeSwitch.json', 'boolean-edge');

  it('DME 0x12 DID 0x4002 (0x01 rest -> 0x19 pressed, every press window) is FOUND -- the brake pedal build 5 called insufficient', () => {
    const score = scores.get(`${0x12}:${0x4002}`);
    expect(score).toBeDefined();
    expect(score).toMatchObject({
      verdict: 'found',
      expectedEdges: 10,
      baselineChanges: 0,
      restValueHex: '01',
      length: 1,
    });
    // Item 11: the evidence IS sparse (1-2 samples in several windows) -- the
    // verdict says so rather than refusing to judge.
    expect(score!.sparse).toBe(true);
    expect(score!.windowsBelowMinimum).toBeGreaterThan(0);
    expect(score!.insufficientReason).toBeNull();
    expect(score!.min).toBe(0x01);
    expect(score!.max).toBe(0x19);
  });

  it('the uptime counter 0x1701 is UNRELATED -- it moves during the baseline too', () => {
    expect(scores.get(`${0x12}:${0x1701}`)?.verdict).toBe('unrelated');
  });

  it('0x4007 (the accelerator idle flag) never moved in the BRAKE run -- unrelated, not insufficient', () => {
    const score = scores.get(`${0x12}:${0x4007}`);
    expect(score).toMatchObject({ verdict: 'unrelated', restValueHex: '9001' });
  });

  it('nothing else in the run is ranked above the brake DID', () => {
    const found = [...scores.values()].filter((s) => s.verdict === 'found');
    expect(found.map((s) => [s.ecu, s.did])).toEqual([[0x12, 0x4002]]);
  });
});

describe('field test 5 replay -- accelerator run (2026-08-29-accelPedal.json)', () => {
  const scores = scoreField('2026-08-29-accelPedal.json', 'analog-monotone');

  it('DME 0x12 DID 0x4007 (0x9001 -> 0x9000, bit0 clears while pressed) is FOUND -- a single-bit flag, so the monotone direction rule does not apply', () => {
    const score = scores.get(`${0x12}:${0x4007}`);
    expect(score).toBeDefined();
    expect(score).toMatchObject({
      verdict: 'found',
      expectedEdges: 10,
      baselineChanges: 0,
      restValueHex: '9001',
      length: 2,
    });
    expect(score!.sparse).toBe(true);
    expect(score!.flagBit).toBe(0);
    expect(score!.min).toBe(0x9000);
    expect(score!.max).toBe(0x9001);
  });

  it('0x4659 answered 17 times with the identical 0x27FF -- UNRELATED (static), never "insufficient"', () => {
    expect(scores.get(`${0x12}:${0x4659}`)).toMatchObject({ verdict: 'unrelated', restValueHex: '27FF' });
  });

  it('0x4002 (the brake DID) is flat through the accelerator run -- unrelated', () => {
    expect(scores.get(`${0x12}:${0x4002}`)?.verdict).toBe('unrelated');
  });

  it('the accelerator idle flag is the only thing found', () => {
    const found = [...scores.values()].filter((s) => s.verdict === 'found');
    expect(found.map((s) => [s.ecu, s.did])).toEqual([[0x12, 0x4007]]);
  });
});
