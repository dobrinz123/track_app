/**
 * Shared copy for `LapRecord.invalidReasons` codes (`packages/core`'s
 * `LapTimingEngine`) — the plain-language sentence a driver reads under the
 * INVALID label on `SessionResultsScreen` and `LapDetailScreen`.
 *
 * V1 fix (blind-verifier finding, pre track day): `PIT_AMBIGUOUS`
 * (`packages/core/src/timing/lap-timing-engine.ts`) had no entry here, so it
 * fell through to the bare-code fallback and a driver read "pit ambiguous"
 * next to fully-worded siblings. The whole point of that code existing is
 * that when the detector cannot place a boundary inside or outside the pit
 * lane, the lap is still emitted and still timed (see the code's own doc
 * comment in `contracts.ts`'s `CrossingEvent.pitAmbiguous`) — so its copy
 * must say "we could not tell", never "this lap is broken". Its neighbour
 * `PIT_TRANSIT` fires when the pit-lane pass WAS confirmed; this one fires
 * when it could not be confirmed either way.
 *
 * Every code the timing engine can add to `invalidReasons` belongs here —
 * `explainInvalidReason` falls back to a humanized code for anything new so a
 * future reason never renders as an empty string, but that fallback is a gap
 * to close, not a design to rely on (this is the mistake `PIT_AMBIGUOUS` made).
 */
export const INVALID_REASON_COPY: Readonly<Record<string, string>> = {
  PIT_TRANSIT: 'Included a pit lane transit.',
  // V1 fix: real copy for the "could not tell" mark, matching the voice of
  // its siblings (short, factual, present tense) while saying the one thing
  // they don't have to: the boundary and the time are real, only the pit
  // lane question is open.
  PIT_AMBIGUOUS:
    'Could not confirm whether this lap passed through the pit lane. The lap boundary and time are real and usable — only the pit lane crossing is unconfirmed.',
  MISSED_SECTOR_GATE: 'Missed a sector timing gate.',
  SHORT_LAP: 'Lap distance was too short to be valid.',
  LOW_QUALITY: 'GNSS quality was too low during this lap.',
  REVERSE_TRAVEL: 'The car appeared to travel backwards along the circuit.',
  DUPLICATE_SECTOR_GATE: 'Crossed a sector timing gate more than once.',
} as const;

/** Plain-language sentence for one `invalidReasons` code; humanizes anything not yet in {@link INVALID_REASON_COPY}. */
export function explainInvalidReason(reason: string): string {
  return INVALID_REASON_COPY[reason] ?? reason.replace(/_/g, ' ').toLowerCase();
}
