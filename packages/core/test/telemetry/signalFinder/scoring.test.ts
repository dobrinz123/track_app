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

  // P4m (item 11): thin sampling alone is no longer `insufficient` -- a DID
  // that answered EVERY window with the identical 0x04 is knowledge (it did
  // not answer the driver), so the honest verdict is `unrelated`.
  it('a DID that answered EVERY window with ONE identical value is UNRELATED, even at one sample per window', () => {
    const samples: SignalFinderSample[] = [];
    for (const step of timeline.steps) {
      samples.push({
        ecu: ECU_29,
        did: 0x5555,
        tMs: (step.evidenceFromMs + step.evidenceToMs) / 2,
        raw: hexToBytes('04'),
      });
    }
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ verdict: 'unrelated', verdictCapReason: 'never-moved' });
    expect(score!.windowsBelowMinimum).toBeGreaterThan(0);
    expect(score!.insufficientReason).toBeNull();
  });

  /**
   * P4m-FIX1 X7 (Codex P4m-REV1 finding 8, MEDIUM): `never-moved` used to
   * need only two identical samples plus the baseline and ONE press window,
   * so a barely-polled DID -- one the driver's action may simply never have
   * been observed on -- was reported as `unrelated`, i.e. as knowledge. The
   * same coverage the sparse rule demands before it says `found` is now
   * demanded before it says `unrelated`: every press AND every release window
   * must have been sampled at least once.
   */
  it('X7: a never-moved DID whose action windows were NOT all sampled is INSUFFICIENT, not unrelated', () => {
    const samples: SignalFinderSample[] = [];
    for (let tMs = 1_250; tMs < timeline.pollDurationMs; tMs += 5_000) {
      samples.push({ ecu: ECU_29, did: 0x5557, tMs, raw: hexToBytes('04') });
    }
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ verdict: 'insufficient', insufficientReason: 'undersampled' });
    expect(score!.verdictCapReason).toBeNull();
  });

  it('a window with ZERO samples is INSUFFICIENT -- nothing was observed there to judge (item 11)', () => {
    // Two samples in the baseline and two in the first press window, then
    // silence: every later window is empty, so no verdict is honest.
    const samples: SignalFinderSample[] = [
      { ecu: ECU_29, did: 0x5556, tMs: 1_000, raw: hexToBytes('04') },
      { ecu: ECU_29, did: 0x5556, tMs: 2_000, raw: hexToBytes('04') },
      { ecu: ECU_29, did: 0x5556, tMs: 3_000, raw: hexToBytes('05') },
      { ecu: ECU_29, did: 0x5556, tMs: 4_000, raw: hexToBytes('05') },
    ];
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ verdict: 'insufficient', insufficientReason: 'undersampled' });
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
    // Ticket P4o O2: two levels overall (the jitter merges under the noise
    // floor) -- `probable`, not `found` (see the P4l-FIX4 "protects the
    // SCORED byte" fixture below, which pins the SAME series' baselineChanges).
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
    expect(score).toMatchObject({ baselineChanges: 0, verdict: 'probable', verdictCapReason: 'two-level' });
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
    // P4l-FIX4 N2 (Codex P4l-REV2b finding 2): `probable` was still a RANKED
    // verdict for one-sided evidence -- both sides are now required for both.
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-bipolar' });
    expect(score!.matchedEdges).toBe(10);
    expect(score!.verdict).not.toBe('found');
    expect(score).toMatchObject({ verdict: 'unrelated', bipolarSides: 'positive', verdictCapReason: 'one-sided-bipolar' });
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

/**
 * Ticket P4l-FIX4 (Codex P4l-REV2b findings 1 and 2) -- the two rules
 * P4l-FIX2 only got half right.
 *
 * N1: the whole-response baseline-restlessness cap was decisive for
 * `boolean-edge` ONLY. For an analog shape a rolling counter byte escaped
 * both gates at once: its own byte offset is hidden by the analog noise
 * floor (a +1 step is inside `analogMarginRawUnits`), and the raw-hex view
 * was never consulted. The noise floor is a statement about the SCORED
 * series -- the byte the verdict is about -- so it now applies to that byte
 * alone; every OTHER byte of the same response is compared exactly, for
 * every shape.
 *
 * N2: `analog-bipolar` means both sides of rest. One-sided evidence is not a
 * weaker version of a steering channel, it is a different signal -- so it is
 * `unrelated`, not `probable`.
 */
describe('scoreSignalCandidates -- P4l-FIX4 review findings', () => {
  const timeline = buildMetronomeTimeline(SCRIPT);

  it('N1: an ANALOG block with a rolling counter byte is UNRELATED, never found', () => {
    // byte 0 increments by exactly 1 on every read (inside the >= 3-unit
    // analog noise floor, so its own offset scores nothing); byte 5 is a
    // clean analog that tracks the metronome perfectly.
    let counter = 0x10;
    const block = (action: string): string =>
      `${(counter++ & 0xff).toString(16).toUpperCase().padStart(2, '0')}0000FF00${action}`;
    const perWindow: string[][] = [[block('10'), block('10')]];
    for (let repetition = 0; repetition < 5; repetition += 1) {
      perWindow.push([block('60'), block('60')]);
      perWindow.push([block('10'), block('10')]);
    }
    const samples = layOnTimeline(timeline, ECU_29, 0x5200, perWindow);
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-monotone' });
    expect(score!.byteOffset).toBe(5);
    expect(score!.matchedEdges).toBe(10);
    expect(score!.verdict).toBe('unrelated');
    expect(score!.verdictCapReason).toBe('response-baseline-changes');
    expect(score!.didBaselineChanges).toBeGreaterThan(0);
  });

  it('N1: the analog noise floor still protects the SCORED byte (a jittering LSB is not restlessness)', () => {
    // Ticket P4o O2: this series is ALSO, incidentally, exactly two levels
    // (baseline jitter 0x0129/0x0131 merge under the noise floor; 0x0300 is
    // the only other level ever seen) -- so it is now capped at `probable`
    // rather than `found`, same as every other two-level analog reading.
    // The point of THIS fixture (the jitter is not restlessness) still holds:
    // baselineChanges/didBaselineChanges stay 0.
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
    expect(score).toMatchObject({
      baselineChanges: 0,
      didBaselineChanges: 0,
      verdict: 'probable',
      verdictCapReason: 'two-level',
    });
  });

  it('N2: a ONE-SIDED analog-bipolar candidate is UNRELATED, not probable', () => {
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
    expect(score).toMatchObject({
      verdict: 'unrelated',
      bipolarSides: 'positive',
      verdictCapReason: 'one-sided-bipolar',
    });
  });

  it('N2: a one-sided candidate that only reached the PROBABLE ratio is unrelated too', () => {
    const rest = ['64', '64'];
    const pressed = ['78', '78'];
    const samples = layOnTimeline(
      timeline,
      0x30,
      0x1236,
      cycles(rest, [
        [pressed, rest],
        [pressed, rest],
        [pressed, rest],
        [rest, rest],
        [rest, rest],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-bipolar' });
    expect(score!.matchedEdges).toBe(6); // 3/5 cycles -- the `probable` ratio
    expect(score).toMatchObject({ verdict: 'unrelated', verdictCapReason: 'one-sided-bipolar' });
  });

  it('N2: a genuine two-sided swing is untouched', () => {
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
});

/**
 * Ticket P4m / contracts.md "Signal Finder REVISION (2026-08-29, after field
 * test 5)" item 11 (binding):
 *
 *   "Sparse-but-consistent = found. A DID whose every press window and every
 *    release window contains >= 1 sample, whose matched edges >= 80 % of
 *    expected, with 0 extra transitions and 0 baseline changes, is `found`
 *    (flagged `sparse`); `insufficient` only when some window has 0 samples
 *    or the whole DID has < 2 samples per window on average."
 *
 * The field replay of the real exports lives in `fieldFixtures.test.ts`;
 * these pin the RULE itself on synthetic series.
 */
describe('scoreSignalCandidates -- P4m item 11 (sparse but consistent)', () => {
  const timeline = buildMetronomeTimeline(SCRIPT);

  it('ONE sample per window, every window agreeing, is FOUND and flagged sparse', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x4002,
      cycles(['01'], [
        [['19'], ['01']],
        [['19'], ['01']],
        [['19'], ['01']],
        [['19'], ['01']],
        [['19'], ['01']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ verdict: 'found', sparse: true, insufficientReason: null });
    expect(score!.windowMatchedEdges).toBe(10);
    expect(score!.windowsBelowMinimum).toBeGreaterThan(0);
  });

  it('a sparse series with an EMPTY press window is insufficient -- nothing was observed there', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x4002,
      cycles(['01'], [
        [[], ['01']],
        [['19'], ['01']],
        [['19'], ['01']],
        [['19'], ['01']],
        [['19'], ['01']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ verdict: 'insufficient', insufficientReason: 'undersampled', sparse: false });
  });

  it('a sparse series that toggles on its OWN schedule is not rescued -- extra transitions block the rule', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x4003,
      cycles(['01'], [
        [['19'], ['19']],
        [['01'], ['19']],
        [['19'], ['01']],
        [['01'], ['19']],
        [['19'], ['01']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score!.verdict).not.toBe('found');
    expect(score!.extraTransitions ?? 0).toBeGreaterThan(0);
  });

  /**
   * P4m-FIX1 X6 (Codex P4m-REV1 finding 7, MEDIUM). Build 6 gave the flag
   * exception to ANY two-level series differing in one bit. Combined with the
   * sparse rule that meant an LSB counter or a noisy bit, sampled once per
   * window, could alternate its way to `found` under an ANALOG target -- the
   * direction rule (the thing that separates a pedal from a bit that merely
   * moves) was waived on the strength of the XOR shape alone.
   *
   * The exception now needs one of two independent reasons:
   *   (a) the DID is DECLARED a flag by the target catalog (data:
   *       `expectedShape: 'boolean-edge'` on the hypothesis -- DME 0x4007 is
   *       one, see `targets.ts`), or
   *   (b) every press AND every release window holds >= 2 AGREEING samples,
   *       i.e. the evidence is dense enough that the two levels are not an
   *       artefact of catching a counter at one sample per window.
   */
  it('X6: a SPARSE single-bit drop under an analog target is NOT rescued by the flag exception on its own', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x4007,
      cycles(['9001'], [
        [['9000'], ['9001']],
        [['9000'], ['9001']],
        [['9000'], ['9001']],
        [['9000'], ['9001']],
        [['9000'], ['9001']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-monotone' });
    expect(score!.verdict).not.toBe('found');
    expect(score!.flagBit).toBeNull();
  });

  it('X6 (a): the SAME sparse series IS found when the catalog declares that DID a boolean-edge flag', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x4007,
      cycles(['9001'], [
        [['9000'], ['9001']],
        [['9000'], ['9001']],
        [['9000'], ['9001']],
        [['9000'], ['9001']],
        [['9000'], ['9001']],
      ]),
    );
    const [score] = scoreSignalCandidates({
      samples,
      timeline,
      shape: 'analog-monotone',
      declaredFlagDids: [{ ecu: ECU_12, did: 0x4007 }],
    });
    expect(score).toMatchObject({ verdict: 'found', flagBit: 0, sparse: true, restValueHex: '9001' });
  });

  it('X6 (b): two AGREEING samples in every press and release window earn the exception without any catalog help', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x4007,
      cycles(['9001', '9001'], [
        [['9000', '9000'], ['9001', '9001']],
        [['9000', '9000'], ['9001', '9001']],
        [['9000', '9000'], ['9001', '9001']],
        [['9000', '9000'], ['9001', '9001']],
        [['9000', '9000'], ['9001', '9001']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-monotone' });
    expect(score).toMatchObject({ verdict: 'found', flagBit: 0, sparse: false });
  });

  it('X6 (b): windows that DISAGREE with themselves never earn it -- that is exactly the LSB counter case', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x4650,
      cycles(['9001', '9001'], [
        [['9000', '9001'], ['9001', '9000']],
        [['9000', '9001'], ['9001', '9000']],
        [['9000', '9001'], ['9001', '9000']],
        [['9000', '9001'], ['9001', '9000']],
        [['9000', '9001'], ['9001', '9000']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-monotone' });
    expect(score!.verdict).not.toBe('found');
  });

  it('a TWO-BIT drop under an analog-monotone target is still the wrong direction, sparse or not', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x58b7,
      cycles(['0150'], [
        [['0000'], ['0150']],
        [['0000'], ['0150']],
        [['0000'], ['0150']],
        [['0000'], ['0150']],
        [['0000'], ['0150']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-monotone' });
    expect(score!.flagBit).toBeNull();
    expect(score!.verdict).not.toBe('found');
  });
});

/**
 * Ticket P4n-FIX1 R5 (binding, Codex re-review MEDIUM): `activeValueHex` is
 * derived from the samples the scorer ACTUALLY observed as "active" (a
 * press/hold-window sample away from the rest level), never inferred after
 * the fact from `min`/`max` -- which cannot prove a two-level series, and
 * has no answer at all for a block series (whose `min`/`max` describe one
 * BYTE, not the whole multi-byte response `restValueHex` carries).
 */
describe('scoreSignalCandidates -- P4n-FIX1 R5 (activeValueHex)', () => {
  const timeline = buildMetronomeTimeline(SCRIPT);

  it('0x500C (0x04 released -> 0x05 pressed): activeValueHex is "05"', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_29,
      0x500c,
      cycles(
        ['04', '04'],
        [
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
        ],
      ),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score!.activeValueHex).toBe('05');
  });

  it('a block series (byteOffset 4): activeValueHex is the WHOLE response, and the selected byte reads the active level', () => {
    // Same fixture as "G3: a block reports the SELECTED offset min/max,
    // never null" above -- byte 4 moves 04 -> 05, the rest of the 5-byte
    // response never changes.
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
    expect(score!.byteOffset).toBe(4);
    expect(score!.activeValueHex).toBe('0001020305');
    // The selected byte's own active value, read out of the whole-response hex.
    const activeByte = score!.activeValueHex!.slice(score!.byteOffset! * 2, score!.byteOffset! * 2 + 2);
    expect(activeByte).toBe('05');
  });

  it('an analog reading has no single "active level" -- activeValueHex is undefined', () => {
    // Ticket P4o O2: this series is also exactly two levels (0x00 rest,
    // 0x20 pressed, nothing between) -- capped at `probable`. The point of
    // THIS fixture (no single active level for a real analog reading) still
    // holds regardless of the verdict.
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x58b7,
      cycles(['00'], [
        [['20'], ['00']],
        [['20'], ['00']],
        [['20'], ['00']],
        [['20'], ['00']],
        [['20'], ['00']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-monotone' });
    expect(score).toMatchObject({ verdict: 'probable', verdictCapReason: 'two-level' });
    expect(score!.activeValueHex).toBeUndefined();
  });
});

/**
 * Ticket P4o O2 (binding, field test 8): "Analog targets (`analog-monotone` /
 * `analog-bipolar`) never yield `found` on a TWO-LEVEL series: if the scored
 * series has <= 2 distinct values (after the noise floor) the verdict is
 * capped at `probable` with `verdictCapReason: 'two-level'` ... A graded
 * series (>= 3 distinct levels with intermediate values inside press windows,
 * like 0x58B7's 0x1A/0x30/0x3B/0x40) keeps `found`. Boolean targets
 * unchanged."
 *
 * The field bug this closes: on the GENERIC profile with the engine off, DME
 * 0x12 0x4002 (0x83 rest / 0x9B pressed, two levels, nothing between) scored
 * `found` for the brakePressure target and was confirmed over the real,
 * GRADED 0x58B7 (26–64, many intermediate levels) -- silently replacing it.
 */
describe('scoreSignalCandidates -- P4o O2 (two-level analog series capped at probable)', () => {
  const timeline = buildMetronomeTimeline(SCRIPT);

  it('a two-level analog-monotone series (field: DME 0x4002, 0x83 rest / 0x9B pressed) is capped at PROBABLE, never found', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x4002,
      cycles(['83', '83'], [
        [['9B', '9B'], ['83', '83']],
        [['9B', '9B'], ['83', '83']],
        [['9B', '9B'], ['83', '83']],
        [['9B', '9B'], ['83', '83']],
        [['9B', '9B'], ['83', '83']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-monotone' });
    expect(score).toMatchObject({
      did: 0x4002,
      verdict: 'probable',
      verdictCapReason: 'two-level',
      matchedEdges: 10,
    });
    expect(score!.verdict).not.toBe('found');
  });

  it('a GRADED analog-monotone series (field: DME 0x58B7, many intermediate levels) keeps FOUND', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x58b7,
      cycles(['00', '00'], [
        [['1A', '30'], ['00', '00']],
        [['36', '40'], ['00', '00']],
        [['05', '2D'], ['00', '00']],
        [['3B', '3D'], ['00', '00']],
        [['1A', '32'], ['00', '00']],
      ]),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'analog-monotone' });
    expect(score).toMatchObject({ did: 0x58b7, verdict: 'found', verdictCapReason: null });
  });

  // A genuine both-sided `analog-bipolar` reading needs at least 3 distinct
  // levels by construction (rest, a positive excursion beyond the noise
  // floor, a negative one) -- so the two-level cap never actually fires
  // there in practice; the ONE-sided case is already capped, more strictly,
  // by `one-sided-bipolar` (see the P4l-FIX4 fixtures above).

  it('boolean-edge targets are UNCHANGED by the two-level rule (a switch IS two levels)', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_29,
      0x500c,
      cycles(
        ['04', '04'],
        [
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
          [['05', '05'], ['04', '04']],
        ],
      ),
    );
    const [score] = scoreSignalCandidates({ samples, timeline, shape: 'boolean-edge' });
    expect(score).toMatchObject({ verdict: 'found', verdictCapReason: null });
  });

  it('a DECLARED flag under an analog target is exempt (that IS a switch, read as one)', () => {
    const samples = layOnTimeline(
      timeline,
      ECU_12,
      0x4007,
      cycles(['9001', '9001'], [
        [['9000', '9000'], ['9001', '9001']],
        [['9000', '9000'], ['9001', '9001']],
        [['9000', '9000'], ['9001', '9001']],
        [['9000', '9000'], ['9001', '9001']],
        [['9000', '9000'], ['9001', '9001']],
      ]),
    );
    const [score] = scoreSignalCandidates({
      samples,
      timeline,
      shape: 'analog-monotone',
      declaredFlagDids: [{ ecu: ECU_12, did: 0x4007 }],
    });
    expect(score).toMatchObject({ verdict: 'found', verdictCapReason: null, flagBit: 0 });
  });
});
