import { describe, expect, it } from 'vitest';
import {
  buildCalibrationAttemptRecord,
  calibrationThresholds,
  type CalibrationAttemptInput,
  type CalibrationResult,
} from '@circuit/core';

import {
  buildCalibrationReport,
  calibrationAttemptIsFailure,
} from '../../src/session/calibrationReportViewModel';
import { resolveCalibrationReportStrings } from '../../src/ui/screens/calibrationReportStrings';

/**
 * Ticket P13B item 2 -- the automatic calibration report.
 *
 * Built over REAL records from `buildCalibrationAttemptRecord`, not over
 * hand-written literals, so a change to what the controller records shows up
 * here as a failing test rather than as a screen quietly rendering a field
 * that no longer exists.
 */

const THRESHOLDS = calibrationThresholds({
  corridorWidthM: 12,
  coverageBinM: 5,
  completeCoverageFraction: 0.97,
});

function result(overrides: Partial<CalibrationResult> = {}): CalibrationResult {
  return {
    accepted: false,
    confidence: 0.4,
    failureReasons: ['INSUFFICIENT_COVERAGE'],
    appliedBias: { e: 0, n: 0 },
    diagnostics: {
      coverageFraction: 0.72,
      samplesAccepted: 800,
      samplesRejected: 40,
      rejectionReasons: { OFF_CORRIDOR: 30, LOW_QUALITY: 10 },
      observedRateHz: 9.8,
      meanLateralM: 2.1,
      p95LateralM: 5.4,
      directionDetected: 'forward',
      uncoveredGapStartM: 1_200,
      uncoveredGapEndM: 1_700,
      uncoveredGapLengthM: 500,
    },
    ...overrides,
  } as CalibrationResult;
}

function record(overrides: Partial<CalibrationAttemptInput> = {}) {
  return buildCalibrationAttemptRecord({
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    circuitId: 'tmr',
    layoutId: 'tmr-full',
    layoutVersion: 3,
    startedAtUtc: '2026-09-22T09:00:00.000Z',
    atUtc: '2026-09-22T09:02:30.000Z',
    durationMs: 150_000,
    concluded: true,
    reachedCompletionThreshold: true,
    forceFinished: false,
    cancelled: false,
    result: result(),
    liveCoverageFraction: 0.72,
    samplesFed: 840,
    thresholds: THRESHOLDS,
    ...overrides,
  });
}

describe('P13B item 2 -- a cancel is a failure', () => {
  it('treats every non-accepted outcome as a failure, cancel included', () => {
    expect(calibrationAttemptIsFailure({ outcome: 'cancelled' })).toBe(true);
    expect(calibrationAttemptIsFailure({ outcome: 'rejected' })).toBe(true);
    expect(calibrationAttemptIsFailure({ outcome: 'stalled' })).toBe(true);
    expect(calibrationAttemptIsFailure({ outcome: 'accepted' })).toBe(false);
  });

  it('labels a cancelled attempt as a FAILED calibration in both languages', () => {
    const report = buildCalibrationReport(record({ cancelled: true }));
    expect(report.outcome).toBe('cancelled');
    expect(report.failure).toBe(true);
    expect(resolveCalibrationReportStrings('en').outcomeHeading.cancelled).toMatch(/FAILED/);
    expect(resolveCalibrationReportStrings('ro').outcomeHeading.cancelled).toMatch(/EȘEC/);
  });
});

describe('P13B item 2 -- what it says', () => {
  it('states the coverage reached AND the bar it was judged against', () => {
    const report = buildCalibrationReport(record());
    const coverage = report.figures.find((f) => f.key === 'coverage');
    expect(coverage).toBeDefined();
    expect(coverage?.values.coverage).toBe('72%');
    expect(coverage?.values.bar).toBe('85%');
    expect(coverage?.values.autoFinish).toBe('97%');
    expect(resolveCalibrationReportStrings('en').figure(coverage!)).toContain('72%');
    expect(resolveCalibrationReportStrings('ro').figure(coverage!)).toContain('85%');
  });

  it('places the uncovered stretch, with the limit beside it', () => {
    const report = buildCalibrationReport(record());
    const gap = report.figures.find((f) => f.key === 'gap');
    expect(gap?.values).toMatchObject({ length: '500', start: '1200', end: '1700', limit: '250' });
  });

  it('says "no gap was MEASURED" -- never "there was no gap" -- when there is no verdict', () => {
    const report = buildCalibrationReport(record({ result: null, concluded: false }));
    expect(report.figures.some((f) => f.key === 'gap')).toBe(false);
    const unmeasured = report.figures.find((f) => f.key === 'gapUnmeasured');
    expect(unmeasured).toBeDefined();
    expect(resolveCalibrationReportStrings('en').figure(unmeasured!)).toContain(
      'not the same as "there was no gap"',
    );
  });

  it('leads with the never-concluded statement when the Learn lap was still running', () => {
    const report = buildCalibrationReport(record({ result: null, concluded: false }));
    expect(report.concluded).toBe(false);
    expect(report.figures[0].key).toBe('neverConcluded');
  });

  it('records the thresholds this attempt was actually judged against', () => {
    const report = buildCalibrationReport(record());
    const thresholds = report.figures.find((f) => f.key === 'thresholds');
    expect(thresholds?.values).toMatchObject({
      coverageBar: '85%',
      gapLimit: '250',
      corridor: '12',
    });
  });

  it('carries the engine’s own reason lines through verbatim', () => {
    const built = record();
    const report = buildCalibrationReport(built);
    expect(report.explanation).toEqual(built.explanation);
    expect(report.explanation.join(' ')).toContain('INSUFFICIENT_COVERAGE');
  });

  it('reports the rejected-fix ratio against its limit', () => {
    const report = buildCalibrationReport(record());
    const rejected = report.figures.find((f) => f.key === 'rejected');
    expect(rejected?.values).toMatchObject({ rejected: '40', fed: '840' });
  });

  it('notes the escape hatch without pretending a threshold moved', () => {
    const report = buildCalibrationReport(
      record({ forceFinished: true, reachedCompletionThreshold: false }),
    );
    expect(report.forceFinished).toBe(true);
    expect(resolveCalibrationReportStrings('en').forceFinished).toContain('no threshold was lowered');
  });

  it('renders every figure key in both languages -- no half-translated report', () => {
    for (const attempt of [record(), record({ cancelled: true }), record({ result: null, concluded: false })]) {
      const report = buildCalibrationReport(attempt);
      for (const language of ['en', 'ro'] as const) {
        const strings = resolveCalibrationReportStrings(language);
        for (const figure of report.figures) {
          const text = strings.figure(figure);
          expect(text.length, `${language}/${figure.key} is empty`).toBeGreaterThan(0);
          // Every placeholder was filled: no `{name}` may survive.
          expect(text, `${language}/${figure.key} has an unfilled placeholder`).not.toMatch(/\{\w+\}/);
        }
      }
    }
  });
});
