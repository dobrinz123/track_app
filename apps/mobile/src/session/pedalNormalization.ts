/**
 * Field revision 2 (2026-08-27, binding — Phase 4h, P4h ticket item 3):
 * "primary source PID 0x5A ... if the DME answers NRC/unsupported for 0x5A,
 * fall back to 0x49 with a learned rest offset (minimum of the first 10 s of
 * samples while speed = 0, re-learned per session; value = max(0, raw −
 * offset) rescaled to 0–100)." Pure module (no I/O, no `@circuit/core`
 * import) — `telemetryProvider.ts` is the only caller, kept separate so the
 * offset-learning window and the rescale formula are directly
 * unit-testable, exactly like `circuitProximity.ts`/`calibrationEscape.ts`.
 *
 * "raw" throughout is the ALREADY-DECODED 0x49 percentage (0–100, what
 * `pidCodec.ts`'s `accelPedalPct` decode formula — 100/255·A, identical for
 * both source PIDs — produces), never the underlying OBD byte A itself.
 */

export const PEDAL_OFFSET_LEARNING_WINDOW_MS = 10_000;

export interface PedalOffsetLearner {
  /** The minimum raw (0x49) pedal percentage observed so far while `speedKph === 0`, within the learning window -- `null` until at least one qualifying sample has arrived. */
  minRestValue: number | null;
  /** Monotonic ms the learner started at (the first 0x49 sample this session ever saw) -- the window is `[startedAtMs, startedAtMs + PEDAL_OFFSET_LEARNING_WINDOW_MS)`. `null` before any sample has arrived. */
  startedAtMs: number | null;
}

export const INITIAL_PEDAL_OFFSET_LEARNER: PedalOffsetLearner = { minRestValue: null, startedAtMs: null };

/**
 * Folds one incoming 0x49 pedal sample into the learner. Pure — returns a
 * NEW learner, never mutates `learner`. A sample arriving with the vehicle
 * moving (`speedKph !== 0`, including `undefined` — no speed reading yet, so
 * "at rest" cannot be confirmed) never contributes to the offset, but still
 * anchors `startedAtMs` on the very first sample seen (the window is wall
 * time since the FIRST 0x49 sample, not since the first REST sample).
 */
export function registerPedalOffsetSample(
  learner: PedalOffsetLearner,
  rawPct: number,
  speedKph: number | undefined,
  nowMs: number,
): PedalOffsetLearner {
  const startedAtMs = learner.startedAtMs ?? nowMs;
  if (nowMs - startedAtMs >= PEDAL_OFFSET_LEARNING_WINDOW_MS) return { ...learner, startedAtMs };
  if (speedKph !== 0) return { ...learner, startedAtMs };
  const minRestValue = learner.minRestValue === null ? rawPct : Math.min(learner.minRestValue, rawPct);
  return { minRestValue, startedAtMs };
}

/** Whether the learning window has fully elapsed (the offset, if any was ever observed, is now final for this session). */
export function isPedalOffsetLearningComplete(learner: PedalOffsetLearner, nowMs: number): boolean {
  return learner.startedAtMs !== null && nowMs - learner.startedAtMs >= PEDAL_OFFSET_LEARNING_WINDOW_MS;
}

/**
 * Rescales a raw 0x49 percentage using the learned rest `offset` (0 when
 * nothing has been learned yet -- a no-op rescale, still clamped to
 * [0, 100]). Ticket-pinned vector: offset 15, raw 39 -> (39-15)/(100-15)*100
 * = 28.24% ("~28%"); raw 15 (at the offset itself) -> 0%.
 */
export function normalizeAccelPedalPct(rawPct: number, offset: number): number {
  if (offset <= 0) return clamp(rawPct, 0, 100);
  const scaled = ((rawPct - offset) / (100 - offset)) * 100;
  return clamp(scaled, 0, 100);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
