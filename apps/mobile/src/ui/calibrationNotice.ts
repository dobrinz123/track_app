import type { SessionCalibrationStatus } from '@circuit/core';

/**
 * Ticket P10B H6-B / H7-B -- WHAT EACH SCREEN SAYS ABOUT A SESSION'S
 * CALIBRATION, IN ONE TESTABLE PLACE.
 *
 * Both defects the P10B reviewer found here were the same mistake made
 * twice: a screen reduced a THREE-valued fact to a boolean and then said
 * nothing for the value it had dropped.
 *
 *  - The driving screen checked `matchingUnvalidated` only, so a restored
 *    session whose provenance could not be read back (`'unknown'`) showed no
 *    marker at all while timing continued.
 *  - The personal-best screen showed a time and a quality pill with no
 *    calibration qualification anywhere, so a 92.662 s PB set past a
 *    REJECTED calibration looked exactly like a validated one.
 *
 * `'unvalidated'` and `'unknown'` mean different things and neither means
 * calibrated, so each gets its own words. `'validated'` gets none: that is
 * the ordinary case and the screens stay clean for it.
 *
 * Pure strings, no react-native import -- which is what lets the test runner
 * import this module and pin the branch logic the screens only render.
 */
export interface CalibrationChip {
  /** Short marker for a screen read at speed. */
  label: string;
  /** Which fact it states -- the screens colour the two differently. */
  kind: 'unvalidated' | 'unknown';
  /** Full sentence, used as the accessibility label. */
  accessibilityLabel: string;
}

export interface CalibrationNotice {
  badge: string;
  hint: string;
  kind: 'unvalidated' | 'unknown';
}

/** Ticket P10B H6-B: the persistent marker on the driving screen, or `null` for a validated session. */
export function dashboardCalibrationChip(status: SessionCalibrationStatus): CalibrationChip | null {
  if (status === 'unvalidated') {
    return {
      label: 'UNCAL',
      kind: 'unvalidated',
      accessibilityLabel:
        'Calibration not validated for this session. Lap and sector times may be wrong or missing.',
    };
  }
  if (status === 'unknown') {
    return {
      label: 'CAL?',
      kind: 'unknown',
      accessibilityLabel:
        'Calibration status unknown for this session. This device holds no record that its matching was ever validated, so lap and sector times are unverified.',
    };
  }
  return null;
}

/** Ticket P10B H7-B: the qualification shown beside a personal-best time, or `null` when the source session was validated. */
export function pbCalibrationNotice(status: SessionCalibrationStatus): CalibrationNotice | null {
  if (status === 'unvalidated') {
    return {
      badge: 'CALIBRATION NOT VALIDATED',
      hint: 'This time came from a session that ran past a REJECTED calibration. It may be wrong, and it may not be a complete lap.',
      kind: 'unvalidated',
    };
  }
  if (status === 'unknown') {
    return {
      badge: 'CALIBRATION UNKNOWN',
      hint: 'No record of whether the session this time came from was ever validated. Treat it as unverified.',
      kind: 'unknown',
    };
  }
  return null;
}

/** Ticket P10B H7-B: the one-line value for the PB screen's provenance row. Never blank -- an unstated calibration is what this ticket is about. */
export function pbCalibrationProvenanceValue(status: SessionCalibrationStatus): string {
  if (status === 'validated') return 'Validated';
  if (status === 'unvalidated') return 'Rejected — proceeded anyway';
  return 'Unknown';
}
