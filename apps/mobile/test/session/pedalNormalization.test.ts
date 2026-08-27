import { describe, expect, it } from 'vitest';
import {
  INITIAL_PEDAL_OFFSET_LEARNER,
  isPedalOffsetLearningComplete,
  normalizeAccelPedalPct,
  PEDAL_OFFSET_LEARNING_WINDOW_MS,
  registerPedalOffsetSample,
  type PedalOffsetLearner,
} from '../../src/session/pedalNormalization';

/**
 * Field revision 2 (2026-08-27, binding — Phase 4h, P4h ticket item 3):
 * "0x49 with a learned rest offset (minimum of the first 10 s of samples
 * while speed = 0 ... value = max(0, raw − offset) rescaled to 0–100)."
 * Ticket-pinned scenario: "raw 15 -> 0%, raw 39 -> ~28%".
 */
describe('normalizeAccelPedalPct (Field revision 2, binding: 0x49 rest-offset normalization)', () => {
  it('with the ticket-pinned offset (15): raw 15 -> 0%', () => {
    expect(normalizeAccelPedalPct(15, 15)).toBe(0);
  });

  it('with the ticket-pinned offset (15): raw 39 -> ~28%', () => {
    expect(normalizeAccelPedalPct(39, 15)).toBeCloseTo(28.235, 2);
  });

  it('offset 0 (nothing learned yet) is a pass-through, still clamped to [0,100]', () => {
    expect(normalizeAccelPedalPct(42, 0)).toBe(42);
    expect(normalizeAccelPedalPct(150, 0)).toBe(100);
    expect(normalizeAccelPedalPct(-10, 0)).toBe(0);
  });

  it('a raw value AT full scale (100) still maps to 100 regardless of offset', () => {
    expect(normalizeAccelPedalPct(100, 15)).toBe(100);
  });

  it('never returns a negative value even if raw is below the offset (sensor noise at rest)', () => {
    expect(normalizeAccelPedalPct(10, 15)).toBe(0);
  });
});

describe('registerPedalOffsetSample / isPedalOffsetLearningComplete (binding: the 10s rest-offset learning window)', () => {
  it('the first sample anchors startedAtMs and, if at rest (speedKph 0), sets the initial minRestValue', () => {
    const learner = registerPedalOffsetSample(INITIAL_PEDAL_OFFSET_LEARNER, 15, 0, 1_000);
    expect(learner).toEqual({ minRestValue: 15, startedAtMs: 1_000 });
  });

  it('a moving sample (speedKph !== 0) never contributes to the offset, but still anchors startedAtMs on the FIRST sample seen', () => {
    const learner = registerPedalOffsetSample(INITIAL_PEDAL_OFFSET_LEARNER, 50, 30, 1_000);
    expect(learner).toEqual({ minRestValue: null, startedAtMs: 1_000 });
  });

  it('an undefined speedKph (no speed reading yet) is treated as "not confirmed at rest" -- never contributes', () => {
    const learner = registerPedalOffsetSample(INITIAL_PEDAL_OFFSET_LEARNER, 15, undefined, 1_000);
    expect(learner.minRestValue).toBeNull();
  });

  it('takes the MINIMUM of multiple at-rest samples within the window', () => {
    let learner: PedalOffsetLearner = INITIAL_PEDAL_OFFSET_LEARNER;
    learner = registerPedalOffsetSample(learner, 18, 0, 1_000);
    learner = registerPedalOffsetSample(learner, 15, 0, 2_000);
    learner = registerPedalOffsetSample(learner, 17, 0, 3_000);
    expect(learner.minRestValue).toBe(15);
  });

  it('a sample arriving AFTER the 10s window closes is ignored (offset is final, "re-learned per session" only)', () => {
    let learner: PedalOffsetLearner = INITIAL_PEDAL_OFFSET_LEARNER;
    learner = registerPedalOffsetSample(learner, 15, 0, 0);
    learner = registerPedalOffsetSample(learner, 5, 0, PEDAL_OFFSET_LEARNING_WINDOW_MS + 1);
    expect(learner.minRestValue).toBe(15); // the late, lower sample never overwrites it.
  });

  it('isPedalOffsetLearningComplete is false before any sample and before the window elapses, true once it has', () => {
    expect(isPedalOffsetLearningComplete(INITIAL_PEDAL_OFFSET_LEARNER, 100_000)).toBe(false);
    const started = registerPedalOffsetSample(INITIAL_PEDAL_OFFSET_LEARNER, 15, 0, 1_000);
    expect(isPedalOffsetLearningComplete(started, 1_000 + PEDAL_OFFSET_LEARNING_WINDOW_MS - 1)).toBe(false);
    expect(isPedalOffsetLearningComplete(started, 1_000 + PEDAL_OFFSET_LEARNING_WINDOW_MS)).toBe(true);
  });

  it('end-to-end: 10s of mixed samples then normalization matches the ticket vector exactly', () => {
    let learner: PedalOffsetLearner = INITIAL_PEDAL_OFFSET_LEARNER;
    // A few at-rest samples (idling, speed 0) settling around 15%, plus one
    // moving sample that must be excluded from the offset.
    learner = registerPedalOffsetSample(learner, 16, 0, 0);
    learner = registerPedalOffsetSample(learner, 15, 0, 2_000);
    learner = registerPedalOffsetSample(learner, 3, 45, 4_000); // moving -- excluded.
    learner = registerPedalOffsetSample(learner, 17, 0, 6_000);
    expect(isPedalOffsetLearningComplete(learner, 10_000)).toBe(true);
    const offset = learner.minRestValue ?? 0;
    expect(offset).toBe(15);
    expect(normalizeAccelPedalPct(15, offset)).toBe(0);
    expect(normalizeAccelPedalPct(39, offset)).toBeCloseTo(28.235, 2);
  });
});
