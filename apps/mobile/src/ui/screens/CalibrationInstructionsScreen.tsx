import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { facade } from '../../session/composition';

type Props = NativeStackScreenProps<RootStackParamList, 'CalibrationInstructions'>;

const STEPS = [
  'Drive out onto the circuit and settle into a steady, representative pace.',
  'Complete one full lap without stopping — this "Learn" lap teaches the app your GNSS behavior on this track.',
  'Stay on the racing line; avoid the pit lane during this lap.',
  'Keep the phone mounted and the screen on for the whole lap.',
];

/** S4 — explains the Learn calibration lap; Start Calibration → S5. */
export function CalibrationInstructionsScreen({ navigation }: Props): React.JSX.Element {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Learn Your Line
        </Text>
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
  stepBadgeText: { color: '#06101F', fontWeight: '700', fontSize: 13 },
  stepText: { ...typography.body, color: colors.textPrimary, flex: 1 },
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: '#06101F' },
});
