import React, { useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import {
  abandonPendingSession,
  facade,
  getLiveCalibrationAttempt,
  settingsStore,
} from '../../session/composition';
import { buildCalibrationReport } from '../../session/calibrationReportViewModel';
import { CalibrationReportCard } from '../components/CalibrationReportCard';
import { useSettings } from '../hooks/useSettings';
import { resolveCalibrationReportStrings } from './calibrationReportStrings';

type Props = NativeStackScreenProps<RootStackParamList, 'CalibrationInstructions'>;

const STEPS = [
  'Drive out onto the circuit and settle into a steady, representative pace.',
  'Complete one full lap without stopping — this "Learn" lap teaches the app your GNSS behavior on this track.',
  'Stay on the racing line; avoid the pit lane during this lap.',
  'Keep the phone mounted and the screen on for the whole lap.',
];

/** S4 — explains the Learn calibration lap; Start Calibration → S5. */
export function CalibrationInstructionsScreen({ navigation }: Props): React.JSX.Element {
  // Ticket P13B item 2 (binding): THIS is where a CANCEL lands. Cancelling a
  // Learn lap replaces this screen (`ActiveCalibrationScreen`'s
  // `confirmCancelExit`), and so does Retry from the result screen -- so the
  // report for the attempt that just failed is shown HERE, unasked, rather
  // than being lost the moment he leaves the calibration screen. A cancel is
  // drawn as the failure the owner asked for it to be.
  const settings = useSettings(settingsStore);
  const reportStrings = resolveCalibrationReportStrings(settings.language);
  const attempt = getLiveCalibrationAttempt();
  const report = attempt === null ? null : buildCalibrationReport(attempt);

  /**
   * Ticket D1 (flow review F1) -- LEAVING THIS SCREEN LEAVES THE SESSION IT
   * SET UP.
   *
   * This screen is the one place `awaitingCalibration` has an exit from:
   * "Start Calibration", right below. A cancelled Learn lap parks the
   * controller there, and every screen BELOW this one in the stack
   * (Preflight, Circuit, the circuit list) is written for a controller that
   * is between sessions -- `selectCircuit()` refuses outright while it is
   * not, which is what stranded the app on an inert circuit list.
   *
   * So the pending session is abandoned when this screen is removed:
   * `abandonPendingSession()` is a no-op unless the controller is in exactly
   * the states nothing else can leave (`awaitingCalibration`/
   * `calibrationReview`), and it REFUSES rather than tearing anything down
   * while a drive is under way -- so the forward paths (push to
   * ActiveCalibration, then replace to ActiveDashboard, then the results
   * screen's own pop back through here) are all unaffected.
   *
   * Fire-and-forget on purpose: navigation must never wait on persistence,
   * and the teardown is ordered on `lifecycleLock` behind anything already
   * running.
   */
  useEffect(
    () =>
      navigation.addListener('beforeRemove', () => {
        void abandonPendingSession().catch((error: unknown) => {
          console.warn('[CalibrationInstructionsScreen] abandoning the pending session failed', error);
        });
      }),
    [navigation],
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Learn Your Line
        </Text>
        {report === null || !report.failure ? null : (
          <CalibrationReportCard report={report} strings={reportStrings} />
        )}
        <Text style={styles.intro} maxFontSizeMultiplier={1.3}>
          Before timing starts, drive one complete steady recognition lap so the app can calibrate to this circuit
          and your GNSS signal.
        </Text>

        <View style={styles.stepsCard}>
          {STEPS.map((step, i) => (
            <View key={step} style={styles.stepRow}>
              <View style={styles.stepBadge}>
                <Text style={styles.stepBadgeText} maxFontSizeMultiplier={1.3}>
                  {i + 1}
                </Text>
              </View>
              <Text style={styles.stepText} maxFontSizeMultiplier={1.3}>
                {step}
              </Text>
            </View>
          ))}
        </View>

        <Pressable
          style={[styles.button, styles.primaryButton]}
          onPress={() => {
            facade.beginCalibration();
            navigation.navigate('ActiveCalibration');
          }}
          accessibilityRole="button"
          accessibilityLabel="Start calibration lap"
        >
          <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
            Start Calibration
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  intro: { ...typography.body, color: colors.textSecondary },
  stepsCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  stepBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeText: { color: colors.onAccent, fontFamily: fontFamily.bodySemibold, fontSize: 13 },
  stepText: { ...typography.body, color: colors.textPrimary, flex: 1 },
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: colors.onAccent },
});
