import React, { useEffect, useRef, useState } from 'react';
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
  runDevReplayScenario,
  useMockFacadeForDevReplay,
  type LiveDiagnosticsSnapshot,
} from '../../session/composition';
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
  /**
   * N5 fix (contracts.md's lifecycle lock amendment, binding, ticket
   * CN-FIX3): this screen's run generation. Bumped when a new fixture is
   * tapped and on unmount -- `runDevReplayScenario()` reads it through
   * `isCancelled` and aborts (installing nothing, navigating nowhere) as soon
   * as the run it belongs to is stale.
   */
  const runGeneration = useRef(0);

  // MUST DO #3 -- read-on-focus + manual refresh only, no polling timer.
  useFocusEffect(
    React.useCallback(() => {
      setDiagnostics(getLiveDiagnostics());
    }, []),
  );

  // C6 fix: restores the production facade/controller on unmount, so an
  // unfinished replay never keeps its provider/watchdog running (or keeps
  // driving `facade`) once this screen goes away. N5 fix: the generation bump
  // cancels any scenario still in flight, and the restore itself queues on
  // the SAME lifecycle lock that scenario holds -- so it can only run after
  // the scenario has finished (and, being cancelled, installed nothing).
  useEffect(() => {
    return () => {
      runGeneration.current += 1;
      void restoreProductionFacade();
    };
  }, []);

  const runScenario = async (scenario: DevReplayScenario): Promise<void> => {
    // N5 fix: this run's identity. Any EARLIER run still in flight is stale
    // from here on and will abort at its next `isCancelled()` check.
    runGeneration.current += 1;
    const generation = runGeneration.current;
    setRunningId(scenario.id);
    try {
      // N5 fix (binding): restore -> select -> start is now ONE
      // `lifecycleLock` section inside composition.ts
      // (`runDevReplayScenario`), instead of three separately-locked calls an
      // unmount cleanup could complete between. The screen contributes only
      // the cancellation signal.
      const result = await runDevReplayScenario(scenario, () => runGeneration.current !== generation);
      if (result.reason === 'CANCELLED') return;
      if (result.reason === 'UNKNOWN_CIRCUIT') {
        throw new Error(`No bundled circuit found for circuitId "${scenario.circuitId}"`);
      }
      if (!result.ok) {
        // `SESSION_ACTIVE` -- a genuine live session is running (vanishingly
        // rare for this dev-only screen, but not impossible). Abort visibly
        // rather than silently driving a replay the rest of the app's
        // selection-derived UI won't agree with.
        Alert.alert(
          'Replay blocked',
          'A session is currently active on the selected circuit -- cannot switch circuits until it ends.',
        );
        return;
      }
      navigation.navigate('CalibrationInstructions');
    } catch (error) {
      Alert.alert('Replay failed to start', error instanceof Error ? error.message : String(error));
    } finally {
      if (runGeneration.current === generation) setRunningId(null);
    }
  };

  const runMock = async (): Promise<void> => {
    // N5 fix: same generation bump -- switching to the scripted mock cancels
    // any fixture scenario still in flight.
    runGeneration.current += 1;
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
