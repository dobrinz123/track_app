/**
 * Signal Finder — metronome timeline (contracts.md "Signal Finder (Phase 4l,
 * 2026-08-29)", item 3, binding):
 *
 *   "Metronome, not free-form phases: the screen paces the driver (PRESS /
 *    HOLD / RELEASE with a countdown and haptic) so the expected timeline is
 *    known. A settle window (P4k) applies at every step edge."
 *
 * The whole point is that, unlike the P4i/P4j free-form phases ("press the
 * brake a few times"), the EXPECTED timeline is known up front: the driver is
 * told exactly when to act, so scoring can ask "did this DID change inside
 * THIS press window and change back inside THIS release window?" rather than
 * "did it change at all during a 6 s phase".
 *
 * SETTLE (P4k, binding) — how it differs here. In the free-form flow the fix
 * was to DISCARD samples inside the first 1.5 s of a phase
 * (`didObservationPhases.ts`'s `isSettlingSample`), because the phase edge was
 * the only thing known. The metronome can do strictly better: a sample that
 * lands `settleMs` after a prompt flips still reflects the PREVIOUS step (the
 * driver has not reacted yet, and the adapter round-trip adds its own lag), so
 * it is EVIDENCE FOR THAT PREVIOUS STEP rather than noise to be thrown away.
 * Each step's evidence window is therefore the step's own window SHIFTED LATER
 * by `settleMs` — which fixes the exact P4k field defect (0x500C's first
 * steering-phase sample still read 0x05 because the brake was still held) and,
 * unlike discarding, costs no samples: a 1 Hz per-DID series still fills a 2 s
 * window with 2 samples.
 *
 * Pure, deterministic — no I/O, no clock.
 */

import type { SignalActionScript, SignalActionVerbs } from './targets';

export type MetronomeStepKind = 'baseline' | 'press' | 'hold' | 'release';

export interface MetronomeStep {
  /** 0-based position in {@link MetronomeTimeline.steps}. */
  index: number;
  kind: MetronomeStepKind;
  /** 1-based press/release cycle; `0` for the baseline step. */
  repetition: number;
  /** When the PROMPT for this step appears, relative to the run's start. */
  startMs: number;
  /** When the prompt for the NEXT step appears (exclusive). */
  endMs: number;
  /** `endMs - startMs`. */
  durationMs: number;
  /** First sample instant that counts as evidence for this step (`startMs + settleMs`) — see this module's own doc comment. */
  evidenceFromMs: number;
  /** Exclusive end of the evidence window (`endMs + settleMs`). */
  evidenceToMs: number;
  /** What the screen shows for the whole step, from the TARGET's own verbs. */
  prompt: string;
}

export interface MetronomeTimeline {
  steps: readonly MetronomeStep[];
  /** When the last PROMPT ends. */
  totalMs: number;
  /** How long the controller must keep polling: `totalMs + settleMs`, so the final release window's own evidence is actually collected. */
  pollDurationMs: number;
  repetitions: number;
  /** One press edge AND one change-back edge per repetition (item 3). */
  expectedEdges: number;
  settleMs: number;
}

export interface BuildMetronomeTimelineOptions {
  /** Prompts, from the target (data). Defaults to neutral PRESS/HOLD/RELEASE wording. */
  verbs?: SignalActionVerbs;
  /**
   * The MEASURED per-DID sample rate this run will achieve (requests/sec
   * divided by the number of DIDs in the pass). When given, press/hold/
   * release/baseline windows are widened so each still collects
   * `minSamplesPerWindow` samples — the run takes longer instead of scoring
   * `insufficient` after the driver has already done the work.
   */
  samplesPerSecPerDid?: number;
  /** Default 2 (item 3: "Insufficient samples (< 2 per window)"). */
  minSamplesPerWindow?: number;
}

const DEFAULT_VERBS: SignalActionVerbs = {
  baseline: 'Hold still',
  press: 'PRESS',
  hold: 'HOLD',
  release: 'RELEASE',
};

/** Item 3 (binding): "Insufficient samples (< 2 per window)". */
export const DEFAULT_MIN_SAMPLES_PER_WINDOW = 2;

function sanitizeMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** The window duration that still fits `minSamples` samples at `samplesPerSecPerDid`; `base` when no rate is known or the base already suffices. */
function widenedMs(base: number, samplesPerSecPerDid: number | undefined, minSamples: number): number {
  if (base <= 0) return base;
  if (samplesPerSecPerDid === undefined || !Number.isFinite(samplesPerSecPerDid) || samplesPerSecPerDid <= 0) return base;
  return Math.max(base, Math.ceil((minSamples / samplesPerSecPerDid) * 1_000));
}

/**
 * Builds the full step timeline: one baseline window, then `repetitions` ×
 * (press [, hold], release), back to back. Pure.
 */
export function buildMetronomeTimeline(
  script: SignalActionScript,
  options: BuildMetronomeTimelineOptions = {},
): MetronomeTimeline {
  const verbs = options.verbs ?? DEFAULT_VERBS;
  const minSamples = options.minSamplesPerWindow ?? DEFAULT_MIN_SAMPLES_PER_WINDOW;
  const settleMs = sanitizeMs(script.settleMs);
  const repetitions = Number.isFinite(script.repetitions) && script.repetitions > 0 ? Math.floor(script.repetitions) : 1;

  const baselineMs = widenedMs(sanitizeMs(script.baselineMs), options.samplesPerSecPerDid, minSamples);
  const pressMs = widenedMs(sanitizeMs(script.pressMs), options.samplesPerSecPerDid, minSamples);
  const holdMs = widenedMs(sanitizeMs(script.holdMs), options.samplesPerSecPerDid, minSamples);
  const releaseMs = widenedMs(sanitizeMs(script.releaseMs), options.samplesPerSecPerDid, minSamples);

  const steps: MetronomeStep[] = [];
  let cursorMs = 0;

  function push(kind: MetronomeStepKind, repetition: number, durationMs: number, prompt: string): void {
    if (durationMs <= 0) return;
    const startMs = cursorMs;
    const endMs = startMs + durationMs;
    steps.push({
      index: steps.length,
      kind,
      repetition,
      startMs,
      endMs,
      durationMs,
      evidenceFromMs: startMs + settleMs,
      evidenceToMs: endMs + settleMs,
      prompt,
    });
    cursorMs = endMs;
  }

  push('baseline', 0, baselineMs, verbs.baseline);
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    push('press', repetition, pressMs, verbs.press);
    push('hold', repetition, holdMs, verbs.hold);
    push('release', repetition, releaseMs, verbs.release);
  }

  return {
    steps,
    totalMs: cursorMs,
    pollDurationMs: cursorMs + settleMs,
    repetitions,
    expectedEdges: repetitions * 2,
    settleMs,
  };
}

/** The step whose PROMPT is on screen at `tMs` (what the driver is being told to do), or `null` once the run is over. */
export function metronomeStepAt(timeline: MetronomeTimeline, tMs: number): MetronomeStep | null {
  return timeline.steps.find((step) => tMs >= step.startMs && tMs < step.endMs) ?? null;
}

/**
 * The step a sample taken at `tMs` is EVIDENCE for — the settle-shifted
 * window (see this module's doc comment). `null` for a sample inside the very
 * first settle window (before any step has evidence) or past the run's end.
 */
export function metronomeStepForSample(timeline: MetronomeTimeline, tMs: number): MetronomeStep | null {
  return timeline.steps.find((step) => tMs >= step.evidenceFromMs && tMs < step.evidenceToMs) ?? null;
}

/** Milliseconds left in `step` at `tMs`, clamped to `[0, step.durationMs]` — the on-screen countdown. */
export function metronomeCountdownMs(step: MetronomeStep, tMs: number): number {
  return Math.min(step.durationMs, Math.max(0, step.endMs - tMs));
}
