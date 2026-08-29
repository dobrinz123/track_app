import { describe, expect, it } from 'vitest';
import {
  buildMetronomeTimeline,
  metronomeCountdownMs,
  metronomeStepAt,
  metronomeStepForSample,
  resolveSignalTargetCatalog,
  findSignalTarget,
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

  it('scales press/release windows up so the measured per-DID sample rate still fills each window', () => {
    // 0.5 samples/s per DID (32 DIDs at ~16 req/s) cannot put 2 samples in a
    // 2 s window -- the window grows instead of the run silently reporting
    // `insufficient`.
    const scaled = buildMetronomeTimeline(SCRIPT, { samplesPerSecPerDid: 0.5, minSamplesPerWindow: 2 });
    expect(scaled.steps[1]!.endMs - scaled.steps[1]!.startMs).toBeGreaterThanOrEqual(4_000);
    const unscaled = buildMetronomeTimeline(SCRIPT, { samplesPerSecPerDid: 4, minSamplesPerWindow: 2 });
    expect(unscaled.steps[1]!.endMs - unscaled.steps[1]!.startMs).toBe(2_000);
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

  it('renders prompts from the TARGET s own verbs (data), never a hard-coded pedal name', () => {
    const catalog = resolveSignalTargetCatalog('toyota-supra-b58');
    const brake = findSignalTarget(catalog, 'brakeSwitch');
    expect(brake).not.toBeNull();
    const timeline = buildMetronomeTimeline(brake!.actionScript, { verbs: brake!.verbs });
    expect(timeline.steps[1]!.prompt).toBe(brake!.verbs.press);
    expect(timeline.steps[0]!.prompt).toBe(brake!.verbs.baseline);
  });
});
