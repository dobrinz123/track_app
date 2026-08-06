import React, { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { CircuitProfile, TelemetryFixture } from '@circuit/core';
import {
  cleanRecognitionLap,
  multiLapSession,
  noisyGpsLap,
  pbImprovementSession,
  pitLaneTransitLap,
  reverseTravelLap,
  signalLossLap,
} from '@circuit/core';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import {
  estimateObservedRateHz,
  getLiveDiagnostics,
  startDevReplaySession,
  useMockFacadeForDevReplay,
  type LiveDiagnosticsSnapshot,
} from '../../session/composition';
import { TMR_CIRCUIT_PROFILE } from '../../session/tmrProfile';

type Props = NativeStackScreenProps<RootStackParamList, 'DevReplay'>;

interface ScenarioDefinition {
  id: string;
  label: string;
  build: (profile: CircuitProfile) => TelemetryFixture;
}

/**
 * Real bundled fixture scenarios from `@circuit/core/fixtures`
 * (`packages/core/src/fixtures/scenarios.ts`) -- each one's
 * `metadata.expectedOutcome` is shown as the row's description so this
 * screen is self-documenting.
 */
const SCENARIOS: ScenarioDefinition[] = [
  { id: 'clean-recognition-lap', label: 'Clean recognition lap', build: (p) => cleanRecognitionLap(p, 901) },
  { id: 'three-laps', label: 'Three timed laps', build: (p) => multiLapSession(p, 3, 902) },
  { id: 'pb-improvement', label: 'PB improvement (3 laps, each faster)', build: (p) => pbImprovementSession(p, 903) },
  { id: 'noisy-gps', label: 'Noisy GPS (8m Gaussian noise)', build: (p) => noisyGpsLap(p, 904) },
  { id: 'signal-loss', label: 'Signal loss (15s gap)', build: (p) => signalLossLap(p, 905) },
  { id: 'reverse-travel', label: 'Reverse travel', build: (p) => reverseTravelLap(p, 906) },
  { id: 'pit-lane-transit', label: 'Pit lane transit', build: (p) => pitLaneTransitLap(p, 907) },
];

/**
 * S13 — dev-only (__DEV__ gated). Lists real bundled fixture scenarios; on
 * selection, drives the ACTUAL production `SessionController` (via
 * `RealSessionFacade`) with a `ReplayLocationProvider` at 10x pace over the
 * fixture's samples, and navigates into the SAME real screens a live session
 * uses (MUST DO #6) -- nothing is duplicated or faked here, this only swaps
 * which `LocationProvider` feeds the one production pipeline. Results land
 * in the real on-device SQLite history. A separate toggle swaps back to the
 * scripted `MockSessionFacade` for pure UI/style iteration.
 */
export function DevReplayScreen({ navigation }: Props): React.JSX.Element {
  const [runningId, setRunningId] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<LiveDiagnosticsSnapshot | null>(null);

  // MUST DO #3 -- read-on-focus + manual refresh only, no polling timer.
  useFocusEffect(
    React.useCallback(() => {
      setDiagnostics(getLiveDiagnostics());
    }, []),
  );

  const runScenario = async (scenario: ScenarioDefinition): Promise<void> => {
    setRunningId(scenario.id);
    try {
      const samples = scenario.build(TMR_CIRCUIT_PROFILE);
      await startDevReplaySession(samples);
      navigation.navigate('CalibrationInstructions');
    } catch (error) {
      Alert.alert('Replay failed to start', error instanceof Error ? error.message : String(error));
    } finally {
      setRunningId(null);
    }
  };

  const runMock = (): void => {
    useMockFacadeForDevReplay();
    navigation.navigate('CalibrationInstructions');
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Dev: Replay Fixtures
        </Text>
        <Text style={styles.intro} maxFontSizeMultiplier={1.3}>
          Runs a real bundled `@circuit/core` fixture through the ACTUAL production `SessionController`, driving the
          real calibration and dashboard screens exactly as a live session would. Results are saved to the real
          on-device SQLite history. __DEV__ only.
        </Text>

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          BUNDLED FIXTURES
        </Text>
        {SCENARIOS.map((scenario) => (
          <Pressable
            key={scenario.id}
            style={styles.fixtureRow}
            disabled={runningId !== null}
            onPress={() => void runScenario(scenario)}
            accessibilityRole="button"
            accessibilityLabel={`Run replay fixture ${scenario.label}`}
          >
            <Text style={styles.fixtureName} maxFontSizeMultiplier={1.3}>
              {scenario.label}
            </Text>
            {runningId === scenario.id ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={styles.fixtureStatus} maxFontSizeMultiplier={1.3}>
                run
              </Text>
            )}
          </Pressable>
        ))}

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          UI-ONLY MODE
        </Text>
        <Pressable
          style={styles.fixtureRow}
          onPress={runMock}
          accessibilityRole="button"
          accessibilityLabel="Use scripted mock facade"
        >
          <Text style={styles.fixtureName} maxFontSizeMultiplier={1.3}>
            Scripted mock (no real pipeline)
          </Text>
          <Text style={styles.fixtureStatus} maxFontSizeMultiplier={1.3}>
            run
          </Text>
        </Pressable>

        <View style={styles.diagnosticsHeaderRow}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            LIVE DIAGNOSTICS (currently active session)
          </Text>
          <Pressable
            onPress={() => setDiagnostics(getLiveDiagnostics())}
            accessibilityRole="button"
            accessibilityLabel="Refresh diagnostics"
          >
            <Text style={styles.refreshText} maxFontSizeMultiplier={1.3}>
              Refresh
            </Text>
          </Pressable>
        </View>
        {diagnostics === null ? (
          <Text style={styles.intro} maxFontSizeMultiplier={1.3}>
            Not available yet.
          </Text>
        ) : (
          <View style={styles.diagnosticsCard}>
            <Text style={styles.diagnosticsRow} maxFontSizeMultiplier={1.3}>
              Observed rate:{' '}
              {diagnostics.gnss === null
                ? 'n/a (replay provider, not live GNSS)'
                : (() => {
                    const hz = estimateObservedRateHz(diagnostics.gnss.sampleIntervalHistogramMs);
                    return hz === null ? 'no samples yet' : `${hz.toFixed(2)} Hz`;
                  })()}
            </Text>
            <Text style={styles.diagnosticsRow} maxFontSizeMultiplier={1.3}>
              Accuracy p50/p95:{' '}
              {diagnostics.gnss === null
                ? 'n/a'
                : `${diagnostics.gnss.accuracyDistributionM.p50M?.toFixed(1) ?? '—'} m / ${diagnostics.gnss.accuracyDistributionM.p95M?.toFixed(1) ?? '—'} m`}
            </Text>
            <Text style={styles.diagnosticsRow} maxFontSizeMultiplier={1.3}>
              Rejected samples: {diagnostics.controller.rejectedSampleCount}
            </Text>
            <Text style={styles.diagnosticsRow} maxFontSizeMultiplier={1.3}>
              Watchdog restarts: {diagnostics.controller.watchRestarts}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  intro: { ...typography.caption, color: colors.textSecondary, lineHeight: 18 },
  sectionLabel: { ...typography.label, color: colors.textMuted, letterSpacing: 0.5, marginTop: spacing.sm },
  fixtureRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  fixtureName: { ...typography.body, color: colors.textPrimary, flexShrink: 1 },
  fixtureStatus: { ...typography.caption, color: colors.accent },
  diagnosticsHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  refreshText: { ...typography.caption, color: colors.accent },
  diagnosticsCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  diagnosticsRow: { ...typography.caption, color: colors.textSecondary },
});
