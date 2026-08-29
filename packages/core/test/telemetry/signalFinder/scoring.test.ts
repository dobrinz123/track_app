import { describe, expect, it } from 'vitest';
import {
  buildMetronomeTimeline,
  scoreSignalCandidates,
  type MetronomeTimeline,
  type SignalActionScript,
  type SignalFinderSample,
} from '../../../src/telemetry/signalFinder';

/**
 * Ticket P4l / contracts.md "Signal Finder (Phase 4l)" item 3 (binding):
 * "Scoring is per DID: matchedEdges / expectedEdges (a change inside a press
 * window and a change back inside the release window), baselineChanges (must
 * be 0), and, for analogs, correlation sign. Verdicts: found (>= 4/5 edges,
 * 0 baseline changes), probable (>= 3/5), unrelated. Insufficient samples
 * (< 2 per window) -> insufficient, never ranked."
 *
 * Every fixture below uses the RAW BYTE VALUES the field export
 * `data/field/sweeps/2026-08-29-test4-*.json` actually recorded; only the
 * TIMING is synthesized, because the field run used the old free-form 6 s
 * phases and no metronome existed yet.
 */

const SCRIPT: SignalActionScript = {
  repetitions: 5,
  baselineMs: 2_000,
  pressMs: 2_000,
  holdMs: 0,
  releaseMs: 2_000,
  settleMs: 500,
};

const ECU_29 = 0x29;
const ECU_12 = 0x12;

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Lays one hex value per sample onto the timeline's own evidence windows --
 * `perWindow[i]` is what the DID read during step `i`, spread evenly inside
 * that step's evidence window.
 */
function layOnTimeline(
  timeline: MetronomeTimeline,
  ecu: number,
  did: number,
  perWindow: readonly (readonly string[])[],
): SignalFinderSample[] {
  const samples: SignalFinderSample[] = [];
  perWindow.forEach((hexes, index) => {
    const step = timeline.steps[index];
    if (step === undefined) return;
    const span = step.evidenceToMs - step.evidenceFromMs;
    hexes.forEach((hex, j) => {
      samples.push({
        ecu,
        did,
        tMs: step.evidenceFromMs + ((j + 0.5) * span) / hexes.length,
        raw: hexToBytes(hex),
      });
    });
  });
  return samples;
}

/** baseline, then press/release pairs. */
function cycles(baseline: string[], pairs: readonly (readonly [string[], string[]])[]): string[][] {
  const out: string[][] = [baseline];
  for (const [press, release] of pairs) {
    out.push(press);
    out.push(release);
  }
  return out;
}

describe('scoreSignalCandidates -- boolean-edge (brake switch)', () => {
  const timeline = buildMetronomeTimeline(SCRIPT);

  it('0x500C (0x04 released -> 0x05 pressed, five paced presses) is FOUND', () => {
    // Field: data/field/sweeps/2026-08-29-test4-ecu29-0x5000-0x58F2.json,
    // 0x29 DID 0x500C -- 0x04 at rest, 0x05 while the brake is pressed.
    // Cycle 1 shows the driver's own reaction lag inside the window (the
    // first press sample still reads 0x04); the rule still matches it.
    const samples = layOnTimeline(
      timeline,
      ECU_29,
      0x500c,
      cycles(
        ['04', '04'],
        [
          [['04', '05'], ['05', '04']],
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
        ],
      ),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({
      ecu: ECU_29,
      did: 0x500c,
      verdict: 'found',
      matchedEdges: 10,
      expectedEdges: 10,
      baselineChanges: 0,
      length: 1,
    });
    expect(score!.restValueHex).toBe('04');
    expect(score!.min).toBe(4);
    expect(score!.max).toBe(5);
  });

  it('0x500B (a single 0x0006 in the whole run) is UNRELATED -- one edge pair out of ten', () => {
    // Field: 0x29 DID 0x500B read 0x0002 everywhere except ONE 0x0006 sample
    // in the brake phase. The profile calls it "weak"; the metronome rule
    // says 2/10 edges = unrelated.
    const rest = ['0002', '0002'];
    const samples = layOnTimeline(
      timeline,
      ECU_29,
      0x500b,
      cycles(rest, [
        [rest, rest],
        [rest, rest],
        [['0002', '0006'], rest],
        [rest, rest],
        [rest, rest],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ did: 0x500b, verdict: 'unrelated', matchedEdges: 2, expectedEdges: 10, baselineChanges: 0 });
  });

  it('a free-running counter DID is UNRELATED -- it moves during the baseline too', () => {
    // Field: 0x29 DID 0x5002, a 21-byte block whose byte 4 increments on
    // every single read (0x84, 0x86, 0x87, ...).
    let counter = 0x84;
    const block = (): string => `0000019A${(counter++).toString(16).toUpperCase().padStart(2, '0')}0101010058070500001B1A480A28FFFF`;
    const perWindow: string[][] = [];
    for (let w = 0; w < timeline.steps.length; w += 1) perWindow.push([block(), block()]);
    const samples = layOnTimeline(timeline, ECU_29, 0x5002, perWindow);
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ did: 0x5002, verdict: 'unrelated' });
    // It is restless during the baseline itself -- reported at the whole-
    // response level, which is what tells a counter apart from a block whose
    // quiet byte offsets merely score nothing.
    expect(score!.responseBaselineChanges).toBeGreaterThan(0);
  });

  it('the battery-voltage dip (13636 -> 13611) is UNRELATED -- it is not locked to the metronome', () => {
    // Field: data/field/sweeps/2026-08-29-test4-dme12-0x5000-0x5FFF.json,
    // DME 0x12 DID 0x5468 -- 0x3544 (13636 mV) at rest, dipping to 0x352B
    // (13611 mV) whenever a load comes on: during the BRAKE phase, but just
    // as often during steering and throttle. Its own 18 field samples, in
    // their real recorded order, laid on a four-press metronome.
    const fourPress = buildMetronomeTimeline({ ...SCRIPT, repetitions: 4 });
    const field = [
      '3544', '3544', // baseline phase
      '3544', '3544', // (baseline phase, cont.)
      '3544', '3544',
      '3544', '352B', // brake phase
      '352B', '3544',
      '352B', '3544', // steering phase
      '352B', '3544',
      '3544', '3544', // throttle phase
      '3544', '3544',
    ];
    const perWindow: string[][] = [];
    for (let i = 0; i < fourPress.steps.length; i += 1) perWindow.push(field.slice(i * 2, i * 2 + 2));
    const samples = layOnTimeline(fourPress, ECU_12, 0x5468, perWindow);
    const [score] = scoreSignalCandidates({ samples, timeline: fourPress, shape: 'boolean-edge' });
    expect(score).toMatchObject({ did: 0x5468, verdict: 'unrelated', baselineChanges: 0, expectedEdges: 8 });
    expect(score!.matchedEdges).toBeLessThan(5); // below the 3/5 probable ratio.
  });

  it('four of five cycles is FOUND, three of five is PROBABLE', () => {
    const pressed = ['05', '05'];
    const rest = ['04', '04'];
    const fourOfFive = layOnTimeline(
      timeline,
      ECU_29,
      0x500c,
      cycles(rest, [
        [pressed, rest],
        [pressed, rest],
        [pressed, rest],
        [pressed, rest],
        [rest, rest],
      ]),
    );
    expect(scoreSignalCandidates({ samples: fourOfFive, timeline, shape: 'boolean-edge' })[0]).toMatchObject({
      verdict: 'found',
      matchedEdges: 8,
    });
    const threeOfFive = layOnTimeline(
      timeline,
      ECU_29,
      0x500c,
      cycles(rest, [
        [pressed, rest],
        [pressed, rest],
        [pressed, rest],
        [rest, rest],
        [rest, rest],
      ]),
    );
    expect(scoreSignalCandidates({ samples: threeOfFive, timeline, shape: 'boolean-edge' })[0]).toMatchObject({
      verdict: 'probable',
      matchedEdges: 6,
    });
  });
});

describe('scoreSignalCandidates -- sample gate and ordering', () => {
  const timeline = buildMetronomeTimeline(SCRIPT);

  it('1 Hz sampling with 2 s windows is NOT insufficient (2 samples per window)', () => {
    const samples: SignalFinderSample[] = [];
    for (let tMs = 1_250; tMs < timeline.pollDurationMs; tMs += 1_000) {
      const inPress = timeline.steps.some(
        (s) => s.kind === 'press' && tMs >= s.evidenceFromMs && tMs < s.evidenceToMs,
      );
      samples.push({ ecu: ECU_29, did: 0x500c, tMs, raw: hexToBytes(inPress ? '05' : '04') });
    }
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score!.verdict).not.toBe('insufficient');
    expect(score!.verdict).toBe('found');
    expect(score!.windowsBelowMinimum).toBe(0);
  });

  it('fewer than 2 samples in any window is INSUFFICIENT and never ranked', () => {
    const samples: SignalFinderSample[] = [];
    for (let tMs = 1_250; tMs < timeline.pollDurationMs; tMs += 3_000) {
      samples.push({ ecu: ECU_29, did: 0x5555, tMs, raw: hexToBytes('04') });
    }
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ verdict: 'insufficient' });
    expect(score!.windowsBelowMinimum).toBeGreaterThan(0);
    expect(score!.insufficientReason).toBe('undersampled');
  });

  it('a DID whose responses disagree on length is INSUFFICIENT, never split into two candidates', () => {
    const timelineOne = buildMetronomeTimeline({ ...SCRIPT, repetitions: 1 });
    const samples = layOnTimeline(timelineOne, ECU_29, 0x4444, [
      ['04', '0400'],
      ['05', '05'],
      ['04', '04'],
    ]);
    const scores = scoreSignalCandidates({ samples, timeline: timelineOne, shape: 'boolean-edge' });
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ verdict: 'insufficient', insufficientReason: 'length-inconsistent', lengthConsistent: false });
  });

  it('ranks found before probable before unrelated before insufficient', () => {
    const pressed = ['05', '05'];
    const rest = ['04', '04'];
    const samples = [
      ...layOnTimeline(timeline, ECU_29, 0x0003, cycles(rest, [[rest, rest], [rest, rest], [rest, rest], [rest, rest], [rest, rest]])),
      ...layOnTimeline(
        timeline,
        ECU_29,
        0x0002,
        cycles(rest, [[pressed, rest], [pressed, rest], [pressed, rest], [rest, rest], [rest, rest]]),
      ),
      ...layOnTimeline(
        timeline,
        ECU_29,
        0x0001,
        cycles(rest, [[pressed, rest], [pressed, rest], [pressed, rest], [pressed, rest], [pressed, rest]]),
      ),
      { ecu: ECU_29, did: 0x0004, tMs: 1_250, raw: hexToBytes('04') },
    ];
    expect(scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' }).map((s) => [s.did, s.verdict])).toEqual([
      [0x0001, 'found'],
      [0x0002, 'probable'],
      [0x0003, 'unrelated'],
      [0x0004, 'insufficient'],
    ]);
  });
});

describe('scoreSignalCandidates -- analog shapes', () => {
  const timeline = buildMetronomeTimeline(SCRIPT);

  it('analog-monotone requires a POSITIVE correlation sign', () => {
    const rising = layOnTimeline(
      timeline,
      ECU_12,
      0x58b7,
      cycles(['0000', '0000'], [
        [['0140', '0150'], ['0000', '0000']],
        [['0140', '0150'], ['0000', '0000']],
        [['0140', '0150'], ['0000', '0000']],
        [['0140', '0150'], ['0000', '0000']],
        [['0140', '0150'], ['0000', '0000']],
      ]),
    );
    const [up] = scoreSignalCandidates({ samples: rising, timeline, shape: 'analog-monotone' });
    expect(up).toMatchObject({ verdict: 'found', correlationSign: 1 });

    // The SAME shape inverted (the value DROPS while pressed) is not a brake
    // pressure channel -- reported, never ranked `found`.
    const falling = rising.map((s) => ({ ...s, raw: hexToBytes(s.raw[0] === 0x01 ? '0000' : '0150') }));
    const [down] = scoreSignalCandidates({ samples: falling, timeline, shape: 'analog-monotone' });
    expect(down!.correlationSign).toBe(-1);
    expect(down!.verdict).not.toBe('found');
  });

  it('analog-bipolar accepts either direction (steering left/right)', () => {
    const swing = layOnTimeline(
      timeline,
      0x30,
      0x1234,
      cycles(['8000', '8000'], [
        [['9000', '9500'], ['8000', '8000']],
        [['7000', '6B00'], ['8000', '8000']],
        [['9000', '9500'], ['8000', '8000']],
        [['7000', '6B00'], ['8000', '8000']],
        [['9000', '9500'], ['8000', '8000']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples: swing, timeline, shape: 'analog-bipolar' });
    expect(score).toMatchObject({ verdict: 'found', matchedEdges: 10 });
  });

  it('baseline jitter inside the noise floor is not a baseline change', () => {
    const jitter = layOnTimeline(
      timeline,
      ECU_12,
      0x4522,
      cycles(['0129', '0131'], [
        [['0300', '0300'], ['0129', '0131']],
        [['0300', '0300'], ['0129', '0131']],
        [['0300', '0300'], ['0129', '0131']],
        [['0300', '0300'], ['0129', '0131']],
        [['0300', '0300'], ['0129', '0131']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples: jitter, timeline, shape: 'analog-monotone' });
    expect(score).toMatchObject({ baselineChanges: 0, verdict: 'found' });
  });
});

/**
 * Ticket P4l-FIX2 (Codex P4l-REV1 findings 1, 2, 4, 6, 10) -- the scoring
 * rules the first cut got wrong. Same binding text as above; these fixtures
 * are the adversarial cases the review constructed.
 */
describe('scoreSignalCandidates -- P4l-FIX2 review findings', () => {
  const timeline = buildMetronomeTimeline(SCRIPT);

  it('G1: a block with a rolling counter byte AND a brake byte is UNRELATED, not found', () => {
    // The winning byte offset (the brake byte) is perfectly quiet during the
    // baseline, but the DID as a whole is not: byte 0 rolls on every read.
    // Item 3's "baselineChanges (must be 0)" is a per-DID rule.
    let counter = 0x10;
    const block = (brake: string): string =>
      `${(counter++ & 0xff).toString(16).toUpperCase().padStart(2, '0')}0000FF${brake}`;
    const perWindow: string[][] = [];
    perWindow.push([block('04'), block('04')]);
    for (let repetition = 0; repetition < 5; repetition += 1) {
      perWindow.push([block('05'), block('05')]);
      perWindow.push([block('04'), block('04')]);
    }
    const samples = layOnTimeline(timeline, ECU_29, 0x5100, perWindow);
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ did: 0x5100, verdict: 'unrelated', byteOffset: 4, matchedEdges: 10 });
    expect(score!.responseBaselineChanges).toBeGreaterThan(0);
    expect(score!.didBaselineChanges).toBeGreaterThan(0);
    expect(score!.verdictCapReason).toBe('response-baseline-changes');
  });

  it('G2: analog-bipolar with a ONE-SIDED excursion is never found', () => {
    // rest 100 (0x64), pressed 120 (0x78), released back to 100 -- it never
    // goes BELOW rest, so it cannot be a steering angle / lateral g.
    const rest = ['64', '64'];
    const samples = layOnTimeline(
      timeline,
      0x30,
      0x1235,
      cycles(rest, [
        [['78', '78'], rest],
        [['78', '78'], rest],
        [['78', '78'], rest],
        [['78', '78'], rest],
        [['78', '78'], rest],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-bipolar' });
    expect(score!.matchedEdges).toBe(10);
    expect(score!.verdict).not.toBe('found');
    expect(score).toMatchObject({ verdict: 'probable', bipolarSides: 'positive', verdictCapReason: 'one-sided-bipolar' });
  });

  it('G2: a genuine two-sided bipolar swing keeps its `found` verdict', () => {
    const swing = layOnTimeline(
      timeline,
      0x30,
      0x1234,
      cycles(['8000', '8000'], [
        [['9000', '9500'], ['8000', '8000']],
        [['7000', '6B00'], ['8000', '8000']],
        [['9000', '9500'], ['8000', '8000']],
        [['7000', '6B00'], ['8000', '8000']],
        [['9000', '9500'], ['8000', '8000']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples: swing, timeline, shape: 'analog-bipolar' });
    expect(score).toMatchObject({ verdict: 'found', bipolarSides: 'both', verdictCapReason: null });
  });

  it('G3: a 2-byte response is compared as ONE big-endian scalar (0x500B 0002 -> 0006)', () => {
    // Field: data/field/sweeps/2026-08-29-test4-ecu29-0x5000-0x58F2.json,
    // 0x29 DID 0x500B -- byte 0 never moves, so a per-byte comparison of
    // byte 0 would see nothing; the scalar 2 -> 6 is the edge.
    const rest = ['0002', '0002'];
    const samples = layOnTimeline(
      timeline,
      ECU_29,
      0x500b,
      cycles(rest, [
        [['0006', '0006'], rest],
        [['0006', '0006'], rest],
        [['0006', '0006'], rest],
        [['0006', '0006'], rest],
        [['0006', '0006'], rest],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ did: 0x500b, verdict: 'found', matchedEdges: 10, byteOffset: null, length: 2 });
    expect(score!.min).toBe(2);
    expect(score!.max).toBe(6);
  });

  it('G3: a block reports the SELECTED offset min/max, never null', () => {
    const rest = ['0001020304', '0001020304'];
    const pressed = ['0001020305', '0001020305'];
    const samples = layOnTimeline(
      timeline,
      ECU_29,
      0x5101,
      cycles(rest, [
        [pressed, rest],
        [pressed, rest],
        [pressed, rest],
        [pressed, rest],
        [pressed, rest],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ did: 0x5101, verdict: 'found', byteOffset: 4, length: 5 });
    expect(score!.min).toBe(4);
    expect(score!.max).toBe(5);
  });

  it('G4: every non-empty metronome step is gated on its own (0 press + 2 hold = insufficient)', () => {
    const holdTimeline = buildMetronomeTimeline({ ...SCRIPT, repetitions: 1, holdMs: 2_000 });
    expect(holdTimeline.steps.map((s) => s.kind)).toEqual(['baseline', 'press', 'hold', 'release']);
    const samples = layOnTimeline(holdTimeline, ECU_29, 0x500c, [
      ['04', '04'], // baseline
      [], // press -- nothing came back inside this window
      ['05', '05'], // hold
      ['04', '04'], // release
    ]);
    const [score] = scoreSignalCandidates({ samples, timeline: holdTimeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ verdict: 'insufficient', insufficientReason: 'undersampled' });
    expect(score!.windowsBelowMinimum).toBe(1);
  });

  it('G5: a quiet-baseline random toggler is NOT found -- extra transitions count against it', () => {
    // Baseline is perfectly still, and each press/release window happens to
    // contain a rest->active and an active->rest transition; but the DID
    // toggles TWICE per window, which no brake switch does.
    const rest4 = ['00', '00', '00', '00'];
    const samples = layOnTimeline(
      timeline,
      ECU_29,
      0x5102,
      cycles(rest4, [
        [['00', '01', '00', '01'], ['01', '00', '01', '00']],
        [['00', '01', '00', '01'], ['01', '00', '01', '00']],
        [['00', '01', '00', '01'], ['01', '00', '01', '00']],
        [['00', '01', '00', '01'], ['01', '00', '01', '00']],
        [['00', '01', '00', '01'], ['01', '00', '01', '00']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score!.baselineChanges).toBe(0);
    expect(score!.extraTransitions).toBeGreaterThan(0);
    expect(score!.verdict).not.toBe('found');
    expect(score!.verdict).toBe('unrelated');
  });

  it('G5: with no transition anywhere, no press edge is credited', () => {
    // Never leaves rest at all: no rest->active transition, so no press edge
    // can be credited (and therefore no change-back edge either).
    const rest = ['04', '04'];
    const samples = layOnTimeline(
      timeline,
      ECU_29,
      0x5103,
      cycles(rest, [
        [rest, rest],
        [rest, rest],
        [rest, rest],
        [rest, rest],
        [rest, rest],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ verdict: 'unrelated', matchedEdges: 0, extraTransitions: 0 });
  });
});
