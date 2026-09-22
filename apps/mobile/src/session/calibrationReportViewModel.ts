import type { CalibrationAttemptOutcome, CalibrationAttemptRecord } from '@circuit/core';

/**
 * Ticket P13B item 2 (binding, owner's words: "daca esueaza se face automat un
 * raport cum si de ce nu se calibreaza - sa fie clar si daca dau eu cancel se
 * considera ca e o eroare").
 *
 * The record built by `packages/core/src/calibration/calibrationAttempt.ts`
 * already holds every figure and an authored `explanation`. What was missing
 * is a SHAPE the screens can draw without deciding anything, because every
 * decision in it is one this repo cannot render-test:
 *
 *  - is this attempt a failure at all? (a cancel IS -- that is the owner's own
 *    instruction, and a screen must never soften it into "you stopped");
 *  - what coverage was reached, against which bar;
 *  - where the uncovered stretch was, or that nothing ever measured one;
 *  - which thresholds this attempt was judged against.
 *
 * Pure and language-free: `calibrationReportStrings.ts` turns these figures
 * into RO/EN sentences, and the engine's own `explanation` lines ride along
 * verbatim as the technical detail. Nothing here re-derives a verdict; a
 * threshold is only ever read out of the record it was applied in.
 */

/** Does this attempt need showing to the driver unasked? */
export function calibrationAttemptIsFailure(record: {
  outcome: CalibrationAttemptOutcome;
}): boolean {
  // Every outcome but `'accepted'`. A cancel is a failure because the owner
  // said it is one; a stall is a failure because the 83%-coverage track day
  // that started this whole ticket was a stall that looked like nothing.
  return record.outcome !== 'accepted';
}

/** One labelled figure in the report. Both halves are strings so the screen never formats a number. */
export interface CalibrationReportFigure {
  /** Which sentence of the strings table renders this. */
  key:
    | 'coverage'
    | 'gap'
    | 'gapUnmeasured'
    | 'duration'
    | 'samples'
    | 'rejected'
    | 'thresholds'
    | 'neverConcluded';
  /** The numbers this figure needs, already rounded. */
  values: Readonly<Record<string, string>>;
}

export interface CalibrationReportModel {
  outcome: CalibrationAttemptOutcome;
  /** True for everything but `'accepted'` -- drives the warning styling and the automatic display. */
  failure: boolean;
  /** The Learn lap was still running when the row was written. Its figures are a live reading, not a verdict. */
  concluded: boolean;
  /** The driver used the "start anyway" escape hatch on this attempt. */
  forceFinished: boolean;
  circuitId: string;
  startedAtUtc: string;
  /** The figures, in reading order. */
  figures: CalibrationReportFigure[];
  /**
   * The engine's own authored reasons, verbatim from the record. NOT
   * translated and not paraphrased: each line names a measured value and the
   * bar it was judged against, and rewriting them here would create a second
   * place where those two can disagree.
   */
  explanation: string[];
}

function pct(fraction: number): string {
  return `${String(Math.round(fraction * 1_000) / 10)}%`;
}

function metres(value: number): string {
  return String(Math.round(value));
}

function seconds(ms: number): string {
  return String(Math.round(ms / 1_000));
}

/** Builds the model from one attempt record. Pure; reads nothing but the record. */
export function buildCalibrationReport(record: CalibrationAttemptRecord): CalibrationReportModel {
  const figures: CalibrationReportFigure[] = [];

  if (!record.concluded) {
    figures.push({ key: 'neverConcluded', values: {} });
  }

  figures.push({
    key: 'coverage',
    values: {
      coverage: pct(record.coverageFraction),
      bar: pct(record.thresholds.minCoverageFraction),
      autoFinish: pct(record.thresholds.completeCoverageFraction),
    },
  });

  if (record.uncoveredGap === null) {
    // Deliberately a row and not silence: "no gap was measured" and "there was
    // no gap" are different, and only the first is true before a verdict.
    figures.push({ key: 'gapUnmeasured', values: {} });
  } else {
    figures.push({
      key: 'gap',
      values: {
        length: metres(record.uncoveredGap.lengthM),
        start: metres(record.uncoveredGap.startM),
        end: metres(record.uncoveredGap.endM),
        limit: metres(record.thresholds.maxUncoveredGapM),
      },
    });
  }

  figures.push({ key: 'duration', values: { seconds: seconds(record.durationMs) } });
  figures.push({ key: 'samples', values: { fed: String(record.samplesFed) } });

  if (record.samplesRejected !== null && record.samplesFed > 0) {
    figures.push({
      key: 'rejected',
      values: {
        rejected: String(record.samplesRejected),
        fed: String(record.samplesFed),
        limit: pct(record.thresholds.maxRejectedFraction),
      },
    });
  }

  figures.push({
    key: 'thresholds',
    values: {
      coverageBar: pct(record.thresholds.minCoverageFraction),
      gapLimit: metres(record.thresholds.maxUncoveredGapM),
      rateHz: String(record.thresholds.minObservedRateHz),
      corridor: metres(record.thresholds.corridorWidthM),
    },
  });

  return {
    outcome: record.outcome,
    failure: calibrationAttemptIsFailure(record),
    concluded: record.concluded,
    forceFinished: record.forceFinished,
    circuitId: record.circuitId,
    startedAtUtc: record.startedAtUtc,
    figures,
    explanation: [...record.explanation],
  };
}
