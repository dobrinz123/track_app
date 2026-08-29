import { describe, expect, it } from 'vitest';
import {
  buildMetronomeTimeline,
  metronomeCountdownMs,
  metronomeStepAt,
  metronomeStepForSample,
  resolveSignalTargetCatalog,
  findSignalTarget,
  resolveSignalActionVerbs,
  type SignalActionScript,
} from '../../../src/telemetry/signalFinder';

/**
 * Ticket P4l / contracts.md "Signal Finder (Phase 4l)" item 3 (binding):
 * "Metronome, not free-form phases: the screen paces the driver (PRESS /
 * HOLD / RELEASE with a countdown and haptic) so the expected timeline is
 * known. A settle window (P4k) applies at every step edge."
 */

const SCRIPT: SignalActionScript = {
  repetitions: 5,
  baselineMs: 2_000,
  pressMs: 2_000,
  holdMs: 0,
  releaseMs: 2_000,
  settleMs: 500,
};

describe('buildMetronomeTimeline', () => {
  it('lays out baseline + repetitions x (press, release) back to back', () => {
    const timeline = buildMetronomeTimeline(SCRIPT);
    expect(timeline.steps.map((s) => s.kind)).toEqual([
      'baseline',
      'press',
      'release',
      'press',
      'release',
      'press',
      'release',
      'press',
      'release',
      'press',
      'release',
    ]);
    expect(timeline.steps[0]).toMatchObject({ startMs: 0, endMs: 2_000, repetition: 0 });
    expect(timeline.steps[1]).toMatchObject({ startMs: 2_000, endMs: 4_000, repetition: 1, kind: 'press' });
    expect(timeline.steps[2]).toMatchObject({ startMs: 4_000, endMs: 6_000, repetition: 1, kind: 'release' });
    expect(timeline.totalMs).toBe(22_000);
  });

  it('emits a hold step only when the script asks for one', () => {
    const withHold = buildMetronomeTimeline({ ...SCRIPT, repetitions: 1, holdMs: 1_000 });
    expect(withHold.steps.map((s) => s.kind)).toEqual(['baseline', 'press', 'hold', 'release']);
    expect(withHold.totalMs).toBe(2_000 + 2_000 + 1_000 + 2_000);
  });

  it('expects one press edge AND one release edge per repetition', () => {
    expect(buildMetronomeTimeline(SCRIPT).expectedEdges).toBe(10);
    expect(buildMetronomeTimeline({ ...SCRIPT, repetitions: 3 }).expectedEdges).toBe(6);
  });

  it('shifts every evidence window later by the settle window (P4k) instead of DROPPING the samples inside it', () => {
    const timeline = buildMetronomeTimeline(SCRIPT);
    // P4k field defect: the first steering-phase sample of DID 0x500C still
    // read 0x05 because the driver's foot was still on the brake. The
    // metronome's fix is to attribute that sample to the step it physically
    // reflects (the previous one) rather than discard it -- so no window
    // loses samples and a 1 Hz series still fills a 2 s window.
    expect(timeline.settleMs).toBe(500);
    expect(timeline.steps[1]).toMatchObject({ startMs: 2_000, evidenceFromMs: 2_500, evidenceToMs: 4_500 });
    expect(timeline.pollDurationMs).toBe(22_500);
  });

  // P4m (item 9/10, binding): the window-widening this test used to pin is
  // GONE -- the script the human performs is fixed, and the DID BUDGET
  // (`plan.ts`) is what bends to the measured rate instead.
  it('keeps the script s OWN window lengths whatever the adapter s rate is', () => {
    expect(buildMetronomeTimeline(SCRIPT).steps[1]!.durationMs).toBe(2_000);
    expect(buildMetronomeTimeline({ ...SCRIPT, pressMs: 3_000 }).steps[1]!.durationMs).toBe(3_000);
  });

  it('never asks a human for more than 5 repetitions (item 9: "default 3, max 5")', () => {
    expect(buildMetronomeTimeline({ ...SCRIPT, repetitions: 9 }).repetitions).toBe(5);
    expect(buildMetronomeTimeline({ ...SCRIPT, repetitions: 3 }).repetitions).toBe(3);
    expect(buildMetronomeTimeline({ ...SCRIPT, repetitions: 3 }).expectedEdges).toBe(6);
  });

  it('the catalog s own pedal script is one 21 s run: baseline 3 s + 3 x (press 3 s, release 3 s)', () => {
    const catalog = resolveSignalTargetCatalog('toyota-supra-b58');
    const brake = findSignalTarget(catalog, 'brakeSwitch')!;
    const timeline = buildMetronomeTimeline(brake.actionScript);
    expect(brake.actionScript).toMatchObject({ repetitions: 3, baselineMs: 3_000, pressMs: 3_000, releaseMs: 3_000 });
    expect(timeline.totalMs).toBe(21_000);
    expect(timeline.expectedEdges).toBe(6);
  });

  it('metronomeStepAt returns the step the CLOCK is in, metronomeStepForSample the step a sample is EVIDENCE for', () => {
    const timeline = buildMetronomeTimeline(SCRIPT);
    expect(metronomeStepAt(timeline, 2_100)?.kind).toBe('press');
    expect(metronomeStepAt(timeline, 2_100)?.repetition).toBe(1);
    // 2100 ms is 100 ms into the press prompt -- physically still the baseline
    // level (the driver has not reacted yet), so it is EVIDENCE for baseline.
    expect(metronomeStepForSample(timeline, 2_100)?.kind).toBe('baseline');
    expect(metronomeStepForSample(timeline, 2_600)?.kind).toBe('press');
    expect(metronomeStepForSample(timeline, 100)).toBeNull(); // inside the very first settle -- evidence for nothing.
    expect(metronomeStepAt(timeline, 99_000)).toBeNull();
  });

  it('counts the countdown down inside the current step', () => {
    const timeline = buildMetronomeTimeline(SCRIPT);
    expect(metronomeCountdownMs(timeline.steps[1]!, 2_000)).toBe(2_000);
    expect(metronomeCountdownMs(timeline.steps[1]!, 3_500)).toBe(500);
    expect(metronomeCountdownMs(timeline.steps[1]!, 9_999)).toBe(0);
  });

  it('renders prompts from the TARGET s own verbs (data), never a hard-coded pedal name -- in the app s language (P4m M4)', () => {
    const catalog = resolveSignalTargetCatalog('toyota-supra-b58');
    const brake = findSignalTarget(catalog, 'brakeSwitch');
    expect(brake).not.toBeNull();
    const en = buildMetronomeTimeline(brake!.actionScript, { verbs: resolveSignalActionVerbs(brake!, 'en') });
    expect(en.steps[1]!.prompt).toBe('PRESS the brake');
    expect(en.steps[0]!.prompt).toBe(brake!.verbs.en.baseline);
    const ro = buildMetronomeTimeline(brake!.actionScript, { verbs: resolveSignalActionVerbs(brake!, 'ro') });
    expect(ro.steps[1]!.prompt).toBe('APASĂ frâna');
    expect(ro.steps[2]!.prompt).toBe('ELIBEREAZĂ frâna');
    // An unknown language falls back to English -- never a blank prompt.
    expect(resolveSignalActionVerbs(brake!, null).press).toBe('PRESS the brake');
  });
});
