import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { settingsStore } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import type { SpeedUnits } from '../../session/settingsStore';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

const DEADBAND_STEP_MS = 25;
const MIN_DEADBAND_MS = 0;
const MAX_DEADBAND_MS = 500;

const COVERAGE_BIN_PRESETS: Record<string, readonly number[]> = {
  '3 bins': [0.33, 0.66, 1],
  '4 bins': [0.25, 0.5, 0.75, 1],
  '5 bins': [0.2, 0.4, 0.6, 0.8, 1],
};

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  labelPrefix,
}: {
  options: readonly { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  labelPrefix: string;
}): React.JSX.Element {
  return (
    <View style={styles.segmented}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            style={[styles.segment, active && styles.segmentActive]}
            onPress={() => onChange(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${labelPrefix}: ${opt.label}${active ? ', selected' : ''}`}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]} maxFontSizeMultiplier={1.3}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** S12 — units, delta deadband, coverage bins (in-memory for now); About/licenses/attribution. */
export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);

  const activeBinPreset =
    Object.entries(COVERAGE_BIN_PRESETS).find(
      ([, thresholds]) => thresholds.length === settings.coverageBins.thresholds.length,
    )?.[0] ?? '4 bins';

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Settings
        </Text>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            UNITS
          </Text>
          <SegmentedControl<SpeedUnits>
            labelPrefix="Speed units"
            value={settings.units}
            onChange={(units) => settingsStore.update({ units })}
            options={[
              { label: 'km/h', value: 'kmh' },
              { label: 'mph', value: 'mph' },
            ]}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            DELTA DEADBAND
          </Text>
          <View style={styles.stepperRow}>
            <Pressable
              style={styles.stepperButton}
              onPress={() =>
                settingsStore.update({ deltaDeadbandMs: Math.max(MIN_DEADBAND_MS, settings.deltaDeadbandMs - DEADBAND_STEP_MS) })
              }
              accessibilityRole="button"
              accessibilityLabel="Decrease delta deadband"
            >
              <Text style={styles.stepperButtonText} maxFontSizeMultiplier={1.3}>
                −
              </Text>
            </Pressable>
            <Text style={styles.stepperValue} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
              {settings.deltaDeadbandMs} ms
            </Text>
            <Pressable
              style={styles.stepperButton}
              onPress={() =>
                settingsStore.update({ deltaDeadbandMs: Math.min(MAX_DEADBAND_MS, settings.deltaDeadbandMs + DEADBAND_STEP_MS) })
              }
              accessibilityRole="button"
              accessibilityLabel="Increase delta deadband"
            >
              <Text style={styles.stepperButtonText} maxFontSizeMultiplier={1.3}>
                +
              </Text>
            </Pressable>
          </View>
          <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
            Delta shows neutral (gray) when the live gap is within this many milliseconds of the reference.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            COVERAGE BINS
          </Text>
          <SegmentedControl<string>
            labelPrefix="Calibration coverage bins"
            value={activeBinPreset}
            onChange={(key) => settingsStore.update({ coverageBins: { thresholds: COVERAGE_BIN_PRESETS[key]! } })}
            options={Object.keys(COVERAGE_BIN_PRESETS).map((k) => ({ label: k, value: k }))}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            ABOUT
          </Text>
          <View style={styles.aboutCard}>
            <Text style={styles.aboutText} maxFontSizeMultiplier={1.3}>
              Circuit geometry data © OpenStreetMap contributors, available under the Open Database License (ODbL)
              1.0. Start/finish and sector boundaries are app-defined, not official.
            </Text>
            <Text style={styles.aboutText} maxFontSizeMultiplier={1.3}>
              This app is a recreational timing aid, not an official or certified timing system. Do not rely on it
              for competitive scoring or safety-critical decisions.
            </Text>
            <Text style={styles.aboutSubLabel} maxFontSizeMultiplier={1.3}>
              Third-party software
            </Text>
            <Text style={styles.aboutText} maxFontSizeMultiplier={1.3}>
              Built with Expo, React Native, and React Navigation, each under their respective open-source licenses.
            </Text>
          </View>
        </View>

        {
          // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
          __DEV__ ? (
          <Pressable
            style={styles.devButton}
            onPress={() => navigation.navigate('DevReplay')}
            accessibilityRole="button"
            accessibilityLabel="Open developer replay tools"
          >
            <Text style={styles.devButtonText} maxFontSizeMultiplier={1.3}>
              Dev: Replay Fixtures
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary },
  section: { gap: spacing.sm },
  sectionLabel: { ...typography.label, color: colors.textMuted, letterSpacing: 0.5 },
  segmented: { flexDirection: 'row', gap: spacing.sm },
  segment: {
    flex: 1,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  segmentText: { ...typography.body, color: colors.textSecondary },
  segmentTextActive: { color: '#06101F', fontWeight: '700' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepperButton: {
    width: 44,
    height: 44,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonText: { ...typography.title, color: colors.textPrimary },
  stepperValue: { ...typography.timeSmall, color: colors.textPrimary, minWidth: 90, textAlign: 'center' },
  helperText: { ...typography.caption, color: colors.textMuted },
  aboutCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  aboutText: { ...typography.caption, color: colors.textSecondary, lineHeight: 18 },
  aboutSubLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.xs },
  devButton: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.warning,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  devButtonText: { ...typography.subtitle, color: colors.warning },
});
