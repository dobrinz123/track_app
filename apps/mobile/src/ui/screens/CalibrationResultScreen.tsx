import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { facade } from '../../session/composition';
import { useFacadeState } from '../hooks/useFacadeState';

type Props = NativeStackScreenProps<RootStackParamList, 'CalibrationResult'>;

/**
 * Maps machine-readable failure/rejection reason codes to plain language.
 * Kept in sync with the real codes `CalibrationEngine.finish()` can emit
 * (`packages/core/src/calibration/calibration-engine.ts`'s `failureReasons`
 * literals: INSUFFICIENT_COVERAGE, WRONG_DIRECTION, POOR_GNSS, RATE_TOO_LOW,
 * COVERAGE_GAP, CALIBRATION_OVERRUN) -- NOT the previous bespoke set
 * (ACCURACY_ABOVE_20M / DIRECTION_UNCERTAIN / LOW_SAMPLE_RATE), which the
 * engine never actually produces and so silently fell through to the
 * humanizer below for every real rejection. CANCELLED is also covered:
 * not an engine code, but `SessionController.rejectCalibration()`
 * (`packages/core/src/controller/sessionController.ts`) appends it to a
 * mid-lap cancel's real result, so it's a code this screen can genuinely see.
 */
const REASON_COPY: Record<string, string> = {
  INSUFFICIENT_COVERAGE: "The lap didn't cover enough of the circuit to calibrate confidently.",
  WRONG_DIRECTION: "The app detected you driving the wrong way around the circuit.",
  POOR_GNSS: 'GNSS signal quality was too poor for too much of the lap.',
  RATE_TOO_LOW: 'GNSS updates arrived too infrequently for a confident calibration.',
  COVERAGE_GAP: "There's a gap in the circuit the lap never drove through.",
  CALIBRATION_OVERRUN: 'Calibration ran far longer than a normal lap and was stopped.',
  CANCELLED: 'Calibration was cancelled before it finished.',
};

function explain(reason: string): string {
  return REASON_COPY[reason] ?? reason.replace(/_/g, ' ').toLowerCase();
}

/**
 * D3 (field calibration fix) — short, plain-English labels for the PER-SAMPLE
 * rejection codes `CalibrationEngine.finish()` tallies in `diagnostics.rejectionReasons`
 * (a distinct, larger vocabulary from `REASON_COPY`'s whole-lap failure codes above,
 * sourced from `TelemetryQualityEvaluator`/the matcher's own OFF_CORRIDOR/INVALID_SAMPLE/
 * LOW_QUALITY). Falls through to the same humanized-code format as `explain()` for any
 * code not worth a bespoke label.
 */
const REJECTION_CODE_LABELS: Record<string, string> = {
  OFF_CORRIDOR: 'Outside the learn corridor',
  INVALID_SAMPLE: 'No usable GPS fix',
  LOW_QUALITY: 'Low-quality GPS fix',
  ACCURACY_ABOVE_12M: 'GNSS accuracy above 12 m',
  ACCURACY_ABOVE_25M: 'GNSS accuracy above 25 m',
  ACCURACY_ABOVE_50M: 'GNSS accuracy above 50 m',
  SAMPLE_GAP_ABOVE_1500MS: 'GNSS updates arrived over 1.5 s apart',
  SAMPLE_GAP_ABOVE_3000MS: 'GNSS updates arrived over 3 s apart',
  IMPLIED_SPEED_ABOVE_85MPS: 'Implausible speed between fixes',
  IMPOSSIBLE_JUMP: 'Impossible GPS jump',
  PROGRESS_REGRESSION: 'Position moved backwards unexpectedly',
  MISSING_COORDINATES: 'Fix had no coordinates',
  NON_FINITE_COORDINATES: 'Fix had invalid coordinates',
  NON_FINITE_TIMESTAMP: 'Fix had an invalid timestamp',
  INVALID_ACCURACY: 'Fix reported invalid accuracy',
  DUPLICATE_TIMESTAMP: 'Duplicate GNSS timestamp',
  NON_INCREASING_TIMESTAMP: 'GNSS timestamp went backwards',
};

function humanizeRejectionCode(code: string): string {
  return REJECTION_CODE_LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase();
}

/** Top `limit` rejection reasons by count, highest first. */
function topRejectionReasons(
  reasons: Record<string, number>,
  limit = 3,
): Array<{ reason: string; count: number }> {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

/** "No signal match between X.X km and Y.Y km from start/finish" -- `null` when there's
 * no meaningful gap to report (full coverage, or the engine result predates these
 * additive `uncoveredGapStartM`/`uncoveredGapEndM` diagnostics fields). */
function describeUncoveredGap(startM: number | undefined, endM: number | undefined): string | null {
  if (startM === undefined || endM === undefined || endM <= startM) return null;
  const startKm = (startM / 1_000).toFixed(1);
  const endKm = (endM / 1_000).toFixed(1);
  return `No signal match between ${startKm} km and ${endKm} km from start/finish.`;
}

/** S6 — accepted: confidence + Continue (→ armed, S7); rejected: plain-language reasons + Retry (→ S4). */
export function CalibrationResultScreen({ navigation }: Props): React.JSX.Element {
  const state = useFacadeState(facade);
  const result = state.calibrationResult;

  if (!result) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.container}>
          <Text style={styles.title} maxFontSizeMultiplier={1.3}>
            No calibration result yet.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  const confidencePct = Math.round(result.confidence * 100);
  const coveragePct = Math.round(result.diagnostics.coverageFraction * 100);
  const gapDescription = describeUncoveredGap(
    result.diagnostics.uncoveredGapStartM,
    result.diagnostics.uncoveredGapEndM,
  );
  const topReasons = topRejectionReasons(result.diagnostics.rejectionReasons);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          {result.accepted ? 'Calibration Accepted' : 'Calibration Not Accepted'}
        </Text>

        {result.accepted ? (
          <>
            <View style={styles.confidenceCard}>
              <Text style={styles.confidenceValue} maxFontSizeMultiplier={1.3}>
                {confidencePct}%
              </Text>
              <Text style={styles.confidenceLabel} maxFontSizeMultiplier={1.3}>
                CONFIDENCE
              </Text>
            </View>
            <Pressable
              style={[styles.button, styles.primaryButton]}
              onPress={() => {
                facade.acceptCalibration();
                navigation.replace('ActiveDashboard');
              }}
              accessibilityRole="button"
              accessibilityLabel="Continue, arm session"
            >
              <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
                Continue
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <View style={styles.reasonsCard}>
              {result.failureReasons.length === 0 ? (
                <Text style={styles.reasonText} maxFontSizeMultiplier={1.3}>
                  The calibration didn't meet the confidence bar for an unspecified reason.
                </Text>
              ) : (
                result.failureReasons.map((reason) => (
                  <Text key={reason} style={styles.reasonText} maxFontSizeMultiplier={1.3}>
                    • {explain(reason)}
                  </Text>
                ))
              )}
            </View>

            {/* D3 (field calibration fix) -- what actually happened, in plain English:
                coverage percent, the longest uncovered stretch (if any), and the top
                rejection reasons with counts, so a driver stuck at e.g. 81-90% coverage
                can see WHY rather than just that it failed. */}
            <View style={styles.diagnosticsCard}>
              <Text style={styles.diagnosticsHeading} maxFontSizeMultiplier={1.3}>
                What happened
              </Text>
              <Text style={styles.diagnosticsText} maxFontSizeMultiplier={1.3}>
                Covered {coveragePct}% of the circuit.
              </Text>
              {gapDescription !== null ? (
                <Text style={styles.diagnosticsText} maxFontSizeMultiplier={1.3}>
                  {gapDescription}
                </Text>
              ) : null}
              {topReasons.map(({ reason, count }) => (
                <Text key={reason} style={styles.diagnosticsText} maxFontSizeMultiplier={1.3}>
                  • {humanizeRejectionCode(reason)} ({count} sample{count === 1 ? '' : 's'})
                </Text>
              ))}
            </View>

            <Pressable
              style={[styles.button, styles.primaryButton]}
              onPress={() => {
                facade.rejectCalibration();
                navigation.replace('CalibrationInstructions');
              }}
              accessibilityRole="button"
              accessibilityLabel="Retry calibration"
            >
              <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
                Retry
              </Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { flexGrow: 1, padding: spacing.lg, gap: spacing.lg, justifyContent: 'center' },
  title: { ...typography.title, fontSize: 24, color: colors.textPrimary },
  confidenceCard: { alignItems: 'flex-start', gap: spacing.xs },
  confidenceValue: { ...typography.display, color: colors.success },
  confidenceLabel: { ...typography.label, color: colors.textMuted },
  reasonsCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  reasonText: { ...typography.body, color: colors.textSecondary },
  diagnosticsCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  diagnosticsHeading: { ...typography.label, color: colors.textMuted },
  diagnosticsText: { ...typography.caption, color: colors.textSecondary },
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: colors.onAccent },
});
