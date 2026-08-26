import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import {
  estimateObservedRateHz,
  getLiveDiagnostics,
  restoreProductionFacade,
  selectCircuit,
  startDevReplaySession,
  useMockFacadeForDevReplay,
  type LiveDiagnosticsSnapshot,
} from '../../session/composition';
import { circuitCatalog } from '../../session/circuitCatalog';
import { DEV_REPLAY_SCENARIOS, type DevReplayScenario } from '../../session/devReplayScenarios';

type Props = NativeStackScreenProps<RootStackParamList, 'DevReplay'>;

/**
 * Real bundled fixture scenarios from `@circuit/core/fixtures`
 * (`packages/core/src/fixtures/scenarios.ts` + `motorpark-scenarios.ts`),
 * defined in `../../session/devReplayScenarios.ts` -- each one's
 * `metadata.expectedOutcome` is shown as the row's description so this
 * screen is self-documenting. Each scenario names its own `circuitId`; the
 * profile it runs against is resolved from the real bundled `circuitCatalog`
 * (ticket CN-W2) rather than hardcoded to one circuit.
 */
const SCENARIOS: DevReplayScenario[] = DEV_REPLAY_SCENARIOS;

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

  // C6 fix: restores the production facade/controller on unmount, so an
  // unfinished replay never keeps its provider/watchdog running (or keeps
  // driving `facade`) once this screen goes away.
  useEffect(() => {
    return () => {
      void restoreProductionFacade();
    };
  }, []);

  const runScenario = async (scenario: DevReplayScenario): Promise<void> => {
    setRunningId(scenario.id);
    try {
      const circuit = circuitCatalog.get(scenario.circuitId);
      if (circuit === null) {
        throw new Error(`No bundled circuit found for circuitId "${scenario.circuitId}"`);
      }
      // C6 fix: restore production (disposing any still-active replay
      // controller) before building a new one, every time -- not just on
      // unmount -- so switching straight from one fixture to another never
      // leaves the previous replay's provider/watchdog running. Run BEFORE
      // `selectCircuit()` below so its own H2 session-active check reads the
      // (by-then idle/terminal) production controller, not a still-live
      // PREVIOUS replay controller mid-transition.
      await restoreProductionFacade();
      // M2 fix (ticket CN-FIX2, binding, dev-only path): select the
      // fixture's OWN circuit through the real `selectCircuit()` before
      // starting the replay -- previously this screen built a
      // scenario-matched replay `SessionController` without ever updating
      // the app's selected circuit, so `ActiveCalibrationScreen`'s track map
      // (which derives centerline/S-F/corridor width from the SELECTION, not
      // the replay controller) kept showing whichever circuit was selected
      // before, while History/PB/Detail also disagreed with the replay. A
      // refusal (`SESSION_ACTIVE` -- a genuine live session is running,
      // vanishingly rare for this dev-only screen but not impossible) aborts
      // the run with a visible alert instead of silently driving a replay
      // controller the rest of the app's selection-derived UI won't agree
      // with.
      const selection = await selectCircuit(scenario.circuitId);
      if (!selection.ok) {
        Alert.alert(
          'Replay blocked',
          'A session is currently active on the selected circuit -- cannot switch circuits until it ends.',
        );
        return;
      }
      const samples = scenario.build(circuit.profile);
      await startDevReplaySession(samples, {
        circuitProfile: circuit.profile,
        runtimeProfile: circuit.runtime,
      });
      navigation.navigate('CalibrationInstructions');
    } catch (error) {
      Alert.alert('Replay failed to start', error instanceof Error ? error.message : String(error));
    } finally {
      setRunningId(null);
    }
  };

  const runMock = async (): Promise<void> => {
    await restoreProductionFacade();
    await useMockFacadeForDevReplay();
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
          onPress={() => void runMock()}
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
  sectionLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.sm },
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
