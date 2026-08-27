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

/**
 * P4h-FIX1 M4 (after Codex P4h-REV1 MEDIUM, `pedalNormalization.ts:32-49`):
 * "learning requires speed to equal exactly `0`. If speed is unavailable,
 * noisy (for example 0.1 km/h), or never zero during the first ten seconds,
 * the window still expires with no offset." A real DME reports speed in whole
 * km/h but can sit at 0.x through rounding/jitter on other transports -- "at
 * rest" is therefore anything strictly below this, never an exact 0 compare.
 * A missing speed reading is still NOT at rest (it cannot be confirmed).
 */
export const PEDAL_AT_REST_MAX_KPH = 1;

/**
 * P4h-FIX1 M3 (after Codex P4h-REV1 MEDIUM, `pedalNormalization.ts:45-64`):
 * "offset `100` produces `0/0`, and the clamp preserves `NaN`. A valid 0x49
 * byte `FF` observed at speed zero therefore causes emitted pedal samples to
 * become `NaN`." An offset this high is not a rest floor -- it is a broken or
 * misread channel -- so it is REFUSED: the raw value is kept and diagnostics
 * report `49-raw` instead of claiming a normalization that never happened.
 */
export const MAX_PEDAL_REST_OFFSET_PCT = 95;

/** Whether a learned rest offset is usable at all: strictly inside (0, {@link MAX_PEDAL_REST_OFFSET_PCT}), and finite. */
export function isPedalOffsetValid(offset: number | null): offset is number {
  return offset !== null && Number.isFinite(offset) && offset > 0 && offset < MAX_PEDAL_REST_OFFSET_PCT;
}

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
  // P4h-FIX1 M4: "at rest" is speed < 1 km/h, not === 0 (see
  // `PEDAL_AT_REST_MAX_KPH`); `undefined` (no speed reading) still never
  // qualifies. P4h-FIX1 M3: a non-finite raw reading never enters the
  // learner -- it could only ever poison the offset.
  if (speedKph === undefined || !(speedKph < PEDAL_AT_REST_MAX_KPH)) return { ...learner, startedAtMs };
  if (!Number.isFinite(rawPct)) return { ...learner, startedAtMs };
  const minRestValue = learner.minRestValue === null ? rawPct : Math.min(learner.minRestValue, rawPct);
  return { minRestValue, startedAtMs };
}

/**
 * The offset actually usable for normalization, or `null` when none was ever
 * learned (no at-rest sample in the window) or the learned value is not
 * credible ({@link isPedalOffsetValid}). `null` is what makes diagnostics
 * report `49-raw` rather than `49-normalized` (P4h-FIX1 M3+M4).
 */
export function resolvePedalOffset(learner: PedalOffsetLearner): number | null {
  return isPedalOffsetValid(learner.minRestValue) ? learner.minRestValue : null;
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
  // P4h-FIX1 M3: an offset at/over the 95 % ceiling (or non-finite) is not a
  // rest floor -- it is refused, and the RAW value is kept, rather than
  // dividing by a vanishing (or zero) span and clamping a `NaN` through.
  if (!isPedalOffsetValid(offset)) return clampFinite(rawPct);
  const scaled = ((rawPct - offset) / (100 - offset)) * 100;
  return clampFinite(scaled);
}

/** Clamp to [0, 100] that never turns a non-finite input into a plausible-looking finite reading (`Math.max`/`Math.min` would map `NaN` through, and `Infinity` to 100). */
function clampFinite(value: number): number {
  if (!Number.isFinite(value)) return value;
  return clamp(value, 0, 100);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}
