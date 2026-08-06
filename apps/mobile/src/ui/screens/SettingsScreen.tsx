import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { deleteAllStoredUserData, facade, sessionHistoryStore, settingsStore } from '../../session/composition';
import { useFacadeState } from '../hooks/useFacadeState';
import { useSettings } from '../hooks/useSettings';
import type { SpeedUnits } from '../../session/settingsStore';

/** Session states that mean "there is an active session in progress" -- the delete-my-data control is hidden/disabled during all of these so it can never race a live write (M3 fix). */
const ACTIVE_SESSION_STATES = new Set([
  'preflight',
  'awaitingCalibration',
  'calibrating',
  'calibrationReview',
  'armed',
  'outLap',
  'timing',
  'inPit',
  'paused',
]);

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

/** S12 — units, delta deadband, coverage bins (in-memory for now); About/licenses/attribution; delete-my-data (M3 fix). */
export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const facadeState = useFacadeState(facade);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteBanner, setDeleteBanner] = React.useState<'success' | 'error' | null>(null);

  const activeBinPreset =
    Object.entries(COVERAGE_BIN_PRESETS).find(
      ([, thresholds]) => thresholds.length === settings.coverageBins.thresholds.length,
    )?.[0] ?? '4 bins';

  const sessionCount = sessionHistoryStore.listSessions().length;
  const sessionActive = ACTIVE_SESSION_STATES.has(facadeState.sessionState);
  const sessionCountLabel = `${sessionCount} stored session${sessionCount === 1 ? '' : 's'}`;

  function startDeleteConfirm(): void {
    setDeleteBanner(null);
    setConfirmingDelete(true);
  }

  function cancelDeleteConfirm(): void {
    setConfirmingDelete(false);
  }

  async function confirmDelete(): Promise<void> {
    setDeleting(true);
    try {
      const result = await deleteAllStoredUserData();
      setDeleteBanner(result.ok ? 'success' : 'error');
    } catch {
      setDeleteBanner('error');
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

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

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            DATA
          </Text>
          <View style={styles.dataCard}>
            {sessionActive ? (
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                End the current session before deleting stored data.
              </Text>
            ) : !confirmingDelete ? (
              <Pressable
                style={styles.deleteRow}
                onPress={startDeleteConfirm}
                accessibilityRole="button"
                accessibilityLabel={`Delete all my data. ${sessionCountLabel}.`}
              >
                <Text style={styles.deleteRowText} maxFontSizeMultiplier={1.3}>
                  Delete all my data
                </Text>
                <Text style={styles.deleteRowMeta} maxFontSizeMultiplier={1.3}>
                  {sessionCountLabel}
                </Text>
              </Pressable>
            ) : (
              <View style={styles.confirmRow}>
                <Text style={styles.confirmText} maxFontSizeMultiplier={1.3}>
                  Permanently delete {sessionCountLabel}? This cannot be undone.
                </Text>
                <View style={styles.confirmButtonsRow}>
                  <Pressable
                    style={styles.cancelButton}
                    onPress={cancelDeleteConfirm}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel deletion"
                  >
                    <Text style={styles.cancelButtonText} maxFontSizeMultiplier={1.3}>
                      Cancel
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.confirmDeleteButton}
                    onPress={() => void confirmDelete()}
                    disabled={deleting}
                    accessibilityRole="button"
                    accessibilityLabel="Confirm permanent deletion of all my data"
                    accessibilityState={{ disabled: deleting }}
                  >
                    <Text style={styles.confirmDeleteButtonText} maxFontSizeMultiplier={1.3}>
                      {deleting ? 'Deleting…' : 'Tap again to delete'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
            {deleteBanner === 'success' ? (
              <Text style={styles.successBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                All stored data deleted.
              </Text>
            ) : null}
            {deleteBanner === 'error' ? (
              <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                Could not delete data. Please try again.
              </Text>
            ) : null}
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
  dataCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  deleteRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  deleteRowText: { ...typography.body, color: colors.danger, fontWeight: '600' },
  deleteRowMeta: { ...typography.caption, color: colors.textMuted },
  confirmRow: { gap: spacing.sm },
  confirmText: { ...typography.body, color: colors.textPrimary },
  confirmButtonsRow: { flexDirection: 'row', gap: spacing.sm },
  cancelButton: {
    flex: 1,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  cancelButtonText: { ...typography.body, color: colors.textSecondary },
  confirmDeleteButton: {
    flex: 1,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.danger,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  confirmDeleteButtonText: { ...typography.body, color: colors.textPrimary, fontWeight: '700' },
  successBanner: { ...typography.caption, color: colors.success },
  errorBanner: { ...typography.caption, color: colors.danger },
  devButton: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.warning,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  devButtonText: { ...typography.subtitle, color: colors.warning },
});
