import {
  CALIBRATION_ATTEMPT_RECORD_VERSION,
  type CalibrationAttemptOutcome,
  type CalibrationAttemptRecord,
  type CalibrationResult,
  type CalibrationThresholds,
  type CalibrationUncoveredGap,
} from '../contracts';
import {
  CALIBRATION_MAX_REJECTED_FRACTION,
  CALIBRATION_MAX_UNCOVERED_GAP_M,
  CALIBRATION_MIN_COVERAGE_FRACTION,
  CALIBRATION_MIN_OBSERVED_RATE_HZ,
} from './calibration-engine';

/**
 * Ticket P12 item B -- THE PURE HALF OF "every calibration attempt leaves a
 * record".
 *
 * `SessionController` owns the lifecycle (when an attempt starts, progresses,
 * concludes); everything about WHAT the row says lives here, as one function
 * of its inputs. That split is deliberate: the explanation is the part a human
 * reads months later, and it must be reproducible from the stored figures
 * rather than assembled from whatever the controller happened to have in
 * memory at the time.
 *
 * Nothing here reads a clock, a threshold table or a config: every number
 * arrives as an argument, so the record can be rebuilt verbatim from its own
 * fields in a test.
 */

/** What the caller knows about one attempt. */
export interface CalibrationAttemptInput {
  attemptId: string;
  sessionId: string;
  circuitId: string;
  layoutId: string;
  layoutVersion: number;
  startedAtUtc: string;
  /** Now, as the caller sees it. Becomes `updatedAtUtc`, and `endedAtUtc` too when `concluded`. */
  atUtc: string;
  /** How long the Learn lap has run, ms. */
  durationMs: number;
  /** `false` for a provisional row written mid-lap. */
  concluded: boolean;
  /** Did the lap reach the controller's completion threshold on its own? */
  reachedCompletionThreshold: boolean;
  /** Did the driver force-finish it through the escape hatch? */
  forceFinished: boolean;
  /** Did the driver CANCEL it? Decides the `'cancelled'` outcome outright. */
  cancelled: boolean;
  /** The engine's verdict, or `null` when it never produced one. */
  result: CalibrationResult | null;
  /** The live coverage reading, used only when there is no verdict to take one from. */
  liveCoverageFraction: number;
  /** Fixes fed to the engine this attempt. */
  samplesFed: number;
  thresholds: CalibrationThresholds;
}

/**
 * The outcome, decided in one place so no caller can invent a fifth answer.
 *
 * A cancel wins over everything, including a verdict the engine produced on
 * the way out: the owner was explicit that pressing Cancel IS the outcome and
 * must be recorded as a failure rather than dressed up as whatever the partial
 * lap happened to score.
 */
export function resolveCalibrationOutcome(
  input: Pick<
    CalibrationAttemptInput,
    'cancelled' | 'concluded' | 'reachedCompletionThreshold' | 'result'
  >,
): CalibrationAttemptOutcome {
  if (input.cancelled) return 'cancelled';
  if (!input.concluded || input.result === null) return 'stalled';
  if (input.result.accepted) return 'accepted';
  return input.reachedCompletionThreshold ? 'rejected' : 'stalled';
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function percent(fraction: number): string {
  return `${String(round(fraction * 100, 1))}%`;
}

function metres(value: number): string {
  return `${String(Math.round(value))} m`;
}

/**
 * The uncovered stretch, taken from the engine's own diagnostics.
 *
 * `null` when there is no verdict (nothing measured it) -- deliberately NOT
 * `{0,0,0}`, which would read as "measured, and there was no gap".
 * `uncoveredGapLengthM` is preferred over `end - start` because a gap that
 * wraps the start/finish line has its end clamped to the line; a record
 * written before that field existed falls back to the clamped span and is
 * still self-consistent.
 */
export function uncoveredGapOf(result: CalibrationResult | null): CalibrationUncoveredGap | null {
  if (result === null) return null;
  const { uncoveredGapStartM, uncoveredGapEndM, uncoveredGapLengthM } = result.diagnostics;
  if (uncoveredGapStartM === undefined || uncoveredGapEndM === undefined) return null;
  return {
    startM: uncoveredGapStartM,
    endM: uncoveredGapEndM,
    lengthM: uncoveredGapLengthM ?? Math.max(0, uncoveredGapEndM - uncoveredGapStartM),
  };
}

/**
 * Human-readable reasons, one line each, every one of them derived from a
 * figure that is also in the record.
 *
 * Written for the person reading an exported file with no device in front of
 * them, which is why each line names the measured value AND the bar it was
 * judged against: "coverage reached 83.1% -- the bar is 85%" answers the
 * question, where "INSUFFICIENT_COVERAGE" only repeats it.
 */
export function explainCalibrationAttempt(
  record: Omit<CalibrationAttemptRecord, 'explanation'>,
): string[] {
  const lines: string[] = [];
  const { result, thresholds, uncoveredGap } = record;

  if (!record.concluded) {
    lines.push(
      `This calibration attempt never finished. It was still running when the record was last written, after ${String(Math.round(record.durationMs / 1_000))} s and ${String(record.samplesFed)} GNSS fix(es).`,
    );
    lines.push(
      `Coverage had reached ${percent(record.coverageFraction)}; the Learn lap finishes on its own at ${percent(thresholds.completeCoverageFraction)}.`,
    );
    return lines;
  }

  switch (record.outcome) {
    case 'cancelled':
      lines.push(
        `The driver CANCELLED this calibration after ${String(Math.round(record.durationMs / 1_000))} s. This is recorded as a failed attempt, not as an attempt that never happened.`,
      );
      break;
    case 'accepted':
      lines.push(
        `Calibration was ACCEPTED: coverage ${percent(record.coverageFraction)} (bar ${percent(thresholds.minCoverageFraction)}), no failing quality gate.`,
      );
      break;
    case 'stalled':
      lines.push(
        result === null
          ? `The Learn lap STALLED: it ended at ${percent(record.coverageFraction)} coverage without the engine ever producing a verdict -- the ${percent(thresholds.completeCoverageFraction)} coverage at which it finishes on its own was never reached.`
          : `The Learn lap STALLED: it never reached the ${percent(thresholds.completeCoverageFraction)} coverage at which it would finish on its own, and was force-finished at ${percent(record.coverageFraction)}.`,
      );
      break;
    case 'rejected':
      lines.push(
        `The Learn lap ran to completion and the quality gates REFUSED it at ${percent(record.coverageFraction)} coverage.`,
      );
      break;
  }

  if (record.forceFinished && record.outcome !== 'cancelled') {
    lines.push(
      'The driver force-finished this lap (the "start anyway" escape hatch). The verdict below is the engine\'s own, computed from what was actually driven -- no threshold was lowered.',
    );
  }

  if (result === null) {
    lines.push('No engine verdict was ever computed for this attempt, so there are no gate results to report.');
    return lines;
  }

  for (const reason of result.failureReasons) {
    switch (reason) {
      case 'INSUFFICIENT_COVERAGE':
        lines.push(
          `INSUFFICIENT_COVERAGE: only ${percent(record.coverageFraction)} of the centerline was observed; the bar is ${percent(thresholds.minCoverageFraction)}.`,
        );
        break;
      case 'COVERAGE_GAP':
        lines.push(
          uncoveredGap === null
            ? `COVERAGE_GAP: one uncovered stretch exceeded ${metres(thresholds.maxUncoveredGapM)}, but its position was not recorded.`
            : `COVERAGE_GAP: the longest stretch never observed was ${metres(uncoveredGap.lengthM)} long, from ${metres(uncoveredGap.startM)} to ${metres(uncoveredGap.endM)} past the start/finish line; the limit is ${metres(thresholds.maxUncoveredGapM)}.`,
        );
        break;
      case 'WRONG_DIRECTION':
        lines.push(
          `WRONG_DIRECTION: the lap was driven ${result.diagnostics.directionDetected}, which is not the direction this layout expects.`,
        );
        break;
      case 'POOR_GNSS':
        lines.push(
          `POOR_GNSS: more than ${percent(thresholds.maxRejectedFraction)} of fixes were unusable (${String(record.samplesRejected ?? 0)} rejected of ${String(record.samplesFed)} fed).`,
        );
        break;
      case 'RATE_TOO_LOW':
        lines.push(
          `RATE_TOO_LOW: fixes arrived at ${String(round(result.diagnostics.observedRateHz, 2))} Hz; at least ${String(thresholds.minObservedRateHz)} Hz is required.`,
        );
        break;
      case 'CALIBRATION_OVERRUN':
        lines.push(
          'CALIBRATION_OVERRUN: the Learn lap ran far past the sample budget one lap can need, so it was force-failed rather than allowed to grow without bound.',
        );
        break;
      case 'CANCELLED':
        // Already stated by the outcome line above; not repeated.
        break;
      default:
        lines.push(`${reason}: reported by the calibration engine (no plain-language text for this code yet).`);
        break;
    }
  }

  const rejectionCodes = Object.entries(result.diagnostics.rejectionReasons)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (rejectionCodes.length > 0) {
    lines.push(
      `Fixes were rejected for: ${rejectionCodes.map(([code, count]) => `${code} x${String(count)}`).join(', ')}.`,
    );
  }
  const bias = result.appliedBias;
  if (bias.e !== 0 || bias.n !== 0) {
    lines.push(
      `A systematic position offset of ${String(round(Math.hypot(bias.e, bias.n), 2))} m was estimated and applied before coverage was recomputed.`,
    );
  }
  lines.push(
    `Lateral fit: mean ${String(round(result.diagnostics.meanLateralM, 2))} m, p95 ${String(round(result.diagnostics.p95LateralM, 2))} m, against a ${metres(thresholds.corridorWidthM)} corridor.`,
  );
  return lines;
}

/** Builds one complete, self-explaining attempt record. Pure. */
export function buildCalibrationAttemptRecord(
  input: CalibrationAttemptInput,
): CalibrationAttemptRecord {
  const outcome = resolveCalibrationOutcome(input);
  const result = input.result;
  const base: Omit<CalibrationAttemptRecord, 'explanation'> = {
    schemaVersion: CALIBRATION_ATTEMPT_RECORD_VERSION,
    attemptId: input.attemptId,
    sessionId: input.sessionId,
    circuitId: input.circuitId,
    layoutId: input.layoutId,
    layoutVersion: input.layoutVersion,
    startedAtUtc: input.startedAtUtc,
    updatedAtUtc: input.atUtc,
    endedAtUtc: input.concluded ? input.atUtc : null,
    durationMs: Math.max(0, input.durationMs),
    outcome,
    concluded: input.concluded,
    reachedCompletionThreshold: input.reachedCompletionThreshold,
    forceFinished: input.forceFinished,
    result: result === null ? null : structuredClone(result),
    // A verdict's coverage is the bias-corrected one and supersedes the live
    // reading; without a verdict the live reading is all there is, and
    // `concluded` above says which of the two this is.
    coverageFraction: result === null ? input.liveCoverageFraction : result.diagnostics.coverageFraction,
    uncoveredGap: uncoveredGapOf(result),
    samplesFed: input.samplesFed,
    samplesAccepted: result === null ? null : result.diagnostics.samplesAccepted,
    samplesRejected: result === null ? null : result.diagnostics.samplesRejected,
    rejectionReasons: result === null ? {} : { ...result.diagnostics.rejectionReasons },
    thresholds: { ...input.thresholds },
  };
  return { ...base, explanation: explainCalibrationAttempt(base) };
}

/**
 * The engine-side half of {@link CalibrationThresholds}: the bars `finish()`
 * applies. The caller supplies the two it owns instead -- the corridor and bin
 * width it configured the engine with, and the coverage at which IT finishes
 * the lap -- because those are configuration, not engine constants.
 */
export function calibrationThresholds(config: {
  corridorWidthM: number;
  coverageBinM: number;
  completeCoverageFraction: number;
}): CalibrationThresholds {
  return {
    corridorWidthM: config.corridorWidthM,
    coverageBinM: config.coverageBinM,
    completeCoverageFraction: config.completeCoverageFraction,
    minCoverageFraction: CALIBRATION_MIN_COVERAGE_FRACTION,
    maxUncoveredGapM: CALIBRATION_MAX_UNCOVERED_GAP_M,
    minObservedRateHz: CALIBRATION_MIN_OBSERVED_RATE_HZ,
    maxRejectedFraction: CALIBRATION_MAX_REJECTED_FRACTION,
  };
}
