import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { facade } from '../../session/composition';
import { useFacadeState } from '../hooks/useFacadeState';

type Props = NativeStackScreenProps<RootStackParamList, 'CalibrationResult'>;

/** Maps machine-readable failure/rejection reason codes to plain language. */
const REASON_COPY: Record<string, string> = {
  ACCURACY_ABOVE_20M: 'GNSS accuracy was worse than 20 meters for part of the lap.',
  INSUFFICIENT_COVERAGE: "The lap didn't cover enough of the circuit to calibrate confidently.",
  DIRECTION_UNCERTAIN: "The app couldn't confidently determine which direction you drove.",
  LOW_SAMPLE_RATE: 'GNSS updates arrived too infrequently for a confident calibration.',
};

function explain(reason: string): string {
  return REASON_COPY[reason] ?? reason.replace(/_/g, ' ').toLowerCase();
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
  title: { ...typography.title, color: colors.textPrimary, textAlign: 'center' },
  confidenceCard: { alignItems: 'center', gap: spacing.xs },
  confidenceValue: { ...typography.display, color: colors.success, fontFamily: undefined },
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
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: '#06101F' },
});
