import { describe, expect, it } from 'vitest';
import { explainInvalidReason, INVALID_REASON_COPY } from '../../src/ui/screens/invalidReasonCopy';

/**
 * V1 (blind-verifier finding, pre track day) -- `SessionResultsScreen.tsx`'s
 * `explainInvalid` had no `PIT_AMBIGUOUS` entry, so it fell through to the
 * bare humanized-code fallback (`reason.replace(/_/g, ' ').toLowerCase()`)
 * and a driver read "pit ambiguous" next to fully-worded siblings like
 * "Included a pit lane transit." This mattered most at MotorPark, where the
 * pit lane runs inside the track's own corridor near start/finish, making
 * `PIT_AMBIGUOUS` the mark most likely to appear on track day.
 *
 * REVIEWER REPRODUCTION (pre-fix): `explainInvalid('PIT_AMBIGUOUS')` fell
 * through `INVALID_REASON_COPY['PIT_AMBIGUOUS'] === undefined` to
 * `'PIT_AMBIGUOUS'.replace(/_/g, ' ').toLowerCase()` === `'pit ambiguous'` --
 * a bare, disclosure-free string.
 */
describe('V1 -- PIT_AMBIGUOUS gets real, sibling-matched copy', () => {
  it('has a dedicated entry, not the bare-code fallback', () => {
    expect(INVALID_REASON_COPY.PIT_AMBIGUOUS).toBeDefined();
    expect(explainInvalidReason('PIT_AMBIGUOUS')).not.toBe('pit ambiguous');
  });

  it('says the boundary and time are real and usable, not that the lap is broken', () => {
    const copy = explainInvalidReason('PIT_AMBIGUOUS');
    expect(copy).toMatch(/pit lane/i);
    expect(copy).toMatch(/real|usable/i);
    expect(copy.toLowerCase()).not.toContain('broken');
    expect(copy.toLowerCase()).not.toContain('invalid');
  });

  it('matches the voice of its siblings -- a complete, capitalized sentence', () => {
    const copy = explainInvalidReason('PIT_AMBIGUOUS');
    expect(copy[0]).toBe(copy[0].toUpperCase());
    expect(copy.endsWith('.')).toBe(true);
  });
});

describe('every known invalidReasons code the timing engine can emit resolves to real copy', () => {
  // packages/core/src/timing/lap-timing-engine.ts's invalidReasons.add(...) call sites.
  const knownCodes = [
    'PIT_TRANSIT',
    'PIT_AMBIGUOUS',
    'MISSED_SECTOR_GATE',
    'DUPLICATE_SECTOR_GATE',
    'SHORT_LAP',
    'LOW_QUALITY',
    'REVERSE_TRAVEL',
  ];

  it.each(knownCodes)('%s has a dedicated entry (never the bare-code fallback)', (code) => {
    expect(INVALID_REASON_COPY[code]).toBeDefined();
    expect(explainInvalidReason(code)).not.toBe(code.replace(/_/g, ' ').toLowerCase());
  });
});

it('still humanizes an unrecognized code instead of rendering nothing', () => {
  expect(explainInvalidReason('SOME_FUTURE_CODE')).toBe('some future code');
});
