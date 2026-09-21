import { describe, expect, it } from 'vitest';
import {
  dashboardCalibrationChip,
  pbCalibrationNotice,
  pbCalibrationProvenanceValue,
} from '../../src/ui/calibrationNotice';

/**
 * Ticket P10B H6-B and H7-B -- the two screens that reduced a three-valued
 * calibration provenance to a boolean and then said nothing for the value
 * they had dropped.
 *
 * REVIEWER REPRODUCTION (ActiveDashboardScreen.tsx:133): restore without
 * readable provenance and resume. The controller state is
 * `calibrationStatus: 'unknown'`, `matchingUnvalidated: false`; the JSX
 * checked only the latter, so the marker disappeared while timing
 * continued.
 *
 * REVIEWER REPRODUCTION (PersonalBestScreen.tsx:46): reject calibration with
 * ten stationary fixes, proceed, drive two TMR laps. A 92.662 s PB is stored
 * while the session's provenance stays `'unvalidated'`, and the screen shows
 * the time and a quality pill with no calibration qualification anywhere.
 */
describe('P10B H6-B -- the driving screen marks BOTH not-calibrated states', () => {
  it('marks a rejected calibration', () => {
    const chip = dashboardCalibrationChip('unvalidated');
    expect(chip?.label).toBe('UNCAL');
    expect(chip?.kind).toBe('unvalidated');
    expect(chip?.accessibilityLabel).toContain('not validated');
  });

  it('marks an UNKNOWN provenance too -- distinctly, and never with silence', () => {
    // WAS: null, because the screen asked `matchingUnvalidated` only.
    const chip = dashboardCalibrationChip('unknown');
    expect(chip).not.toBeNull();
    expect(chip?.label).toBe('CAL?');
    expect(chip?.kind).toBe('unknown');
    expect(chip?.label).not.toBe(dashboardCalibrationChip('unvalidated')?.label);
    expect(chip?.accessibilityLabel).toContain('unknown');
  });

  it('says nothing for a validated session -- the ordinary case stays clean', () => {
    expect(dashboardCalibrationChip('validated')).toBeNull();
  });
});

describe('P10B H7-B -- a personal best carries its calibration', () => {
  it('qualifies a PB set past a REJECTED calibration', () => {
    const notice = pbCalibrationNotice('unvalidated');
    expect(notice).not.toBeNull();
    expect(notice?.badge).toBe('CALIBRATION NOT VALIDATED');
    expect(notice?.hint).toContain('REJECTED');
    expect(pbCalibrationProvenanceValue('unvalidated')).toBe('Rejected — proceeded anyway');
  });

  it('qualifies a PB whose session provenance is unknown', () => {
    const notice = pbCalibrationNotice('unknown');
    expect(notice).not.toBeNull();
    expect(notice?.badge).toBe('CALIBRATION UNKNOWN');
    expect(notice?.kind).toBe('unknown');
    expect(pbCalibrationProvenanceValue('unknown')).toBe('Unknown');
  });

  it('leaves a validated PB unqualified, but still states the fact in the provenance row', () => {
    expect(pbCalibrationNotice('validated')).toBeNull();
    expect(pbCalibrationProvenanceValue('validated')).toBe('Validated');
  });
});
