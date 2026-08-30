import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { resolveAnalysisScreenStrings } from './analysisStrings';
import { useSettings } from '../hooks/useSettings';
import { useFacadeState } from '../hooks/useFacadeState';
import {
  buildAnalysisScreenState,
  createAnalysisRunner,
  sessionIsActive,
  type AnalysisRunResult,
} from '../../session/analysisViewModel';
import { createAnalysisSessionLoader } from '../../session/analysisSessionLoader';
import { buildAnalysisExportDocument, shareAnalysisExport, shareAnalysisJson } from '../../session/analysisExport';
import { circuitCatalog } from '../../session/circuitCatalog';
import {
  facade,
  getSessionRepository,
  getTelemetryReadDb,
  sessionHistoryStore,
  settingsStore,
} from '../../session/composition';
import { loadSessionTelemetryByLap } from '../../persistence/telemetryRead';

type Props = NativeStackScreenProps<RootStackParamList, 'Analysis'>;

/**
 * S14 — post-session corner analysis (ticket P5b, contracts.md "Phase 5
 * REVISION"): the deterministic on-device engine's report for ONE finished
 * session, in the app's language, observations only.
 *
 * This file is a renderer and nothing else. Every decision — what to load, what
 * the engine may be asked, what the driver is told when it cannot be asked,
 * how a corner row reads — lives in `session/analysisViewModel.ts` and
 * `session/analysisAssembly.ts`, which vitest imports directly; every visible
 * string is either the ENGINE's own localized report text or a chrome label
 * from `analysisStrings.ts`. Nothing about driving is written here.
 */
export function AnalysisScreen({ route }: Props): React.JSX.Element {
  const { sessionId } = route.params;
  const settings = useSettings(settingsStore);
  const strings = resolveAnalysisScreenStrings(settings.language);
  const facadeState = useFacadeState(facade);

  // The runner is asked at RUN time whether a session is live, so a screen left
  // open when a new session starts cannot analyse over it.
  const sessionStateRef = React.useRef(facadeState.sessionState);
  sessionStateRef.current = facadeState.sessionState;

  const runner = React.useMemo(
    () =>
      createAnalysisRunner({
        isSessionActive: () => sessionIsActive(sessionStateRef.current),
        loadSession: createAnalysisSessionLoader({
          getSession: (id) => sessionHistoryStore.getSession(id),
          getCircuit: (id) => circuitCatalog.get(id),
          loadLapGnss: async (id, lapNumber) =>
            (await getSessionRepository()?.loadTelemetry(id, lapNumber)) ?? [],
          loadSessionChannels: async (id) => {
            const db = getTelemetryReadDb();
            return db === null ? new Map() : await loadSessionTelemetryByLap(db, id);
          },
        }),
      }),
    [],
  );

  const [result, setResult] = React.useState<AnalysisRunResult | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [shareNote, setShareNote] = React.useState<string | null>(null);
  const [sharing, setSharing] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setResult(null);
    void runner.run(sessionId).then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [runner, sessionId, attempt]);

  const state = React.useMemo(
    () =>
      result === null
        ? ({ status: 'loading' } as const)
        : buildAnalysisScreenState(result, settings.language),
    [result, settings.language],
  );

  const share = React.useCallback(
    async (json: boolean) => {
      if (state.status !== 'ready' || sharing) return;
      setSharing(true);
      const doc = buildAnalysisExportDocument(state, { generatedAtUtc: new Date().toISOString() });
      const outcome = json ? await shareAnalysisJson(doc) : await shareAnalysisExport(doc);
      setShareNote(
        !outcome.ok ? strings.shareFailed : outcome.shared ? strings.shareDone : strings.shareUnavailable,
      );
      setSharing(false);
    },
    [state, sharing, strings],
  );

  if (state.status === 'loading') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <View style={styles.centred}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.title} maxFontSizeMultiplier={1.3}>
            {strings.loading}
          </Text>
          <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
            {strings.loadingHint}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (state.status !== 'ready') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <View style={styles.centred}>
          <Text style={styles.title} maxFontSizeMultiplier={1.3}>
            {strings.screenTitle}
          </Text>
          <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
            {state.message}
          </Text>
          {state.status === 'error' ? (
            <Pressable
              style={[styles.button, styles.secondaryButton]}
              onPress={() => setAttempt((value) => value + 1)}
              accessibilityRole="button"
              accessibilityLabel={strings.retryA11y}
            >
              <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
                {strings.retry}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  const { view } = state;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          {view.title}
        </Text>
        <Text style={styles.header} maxFontSizeMultiplier={1.3}>
          {view.header}
        </Text>
        <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
          {view.subtitle}
        </Text>
        <View style={styles.badge}>
          <Text style={styles.badgeText} maxFontSizeMultiplier={1.3}>
            {view.observationsOnly}
          </Text>
        </View>

        <Section lines={view.overview} />
        <Section lines={view.limitations} tone="warning" />
        <Section lines={view.notes} tone="warning" />
        <Section lines={view.timeLoss} />
        <Section lines={view.consistency} />
        <Section lines={view.sectors} />

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          {strings.cornersHeading}
        </Text>
        {view.corners.map((corner) => (
          <View key={corner.cornerId} style={styles.cornerCard}>
            <View style={styles.cornerHeaderRow}>
              <Text style={styles.cornerHeading} maxFontSizeMultiplier={1.3}>
                {corner.heading}
              </Text>
              {corner.timeLossLabel === null ? null : (
                <Text style={styles.cornerBadge} maxFontSizeMultiplier={1.3}>
                  {corner.timeLossLabel}
                </Text>
              )}
            </View>
            {corner.lines.map((line, index) => (
              <Text key={index} style={styles.line} maxFontSizeMultiplier={1.3}>
                {line}
              </Text>
            ))}
          </View>
        ))}

        <Text style={styles.disclaimer} maxFontSizeMultiplier={1.3}>
          {view.disclaimer}
        </Text>

        {shareNote === null ? null : (
          <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
            {shareNote}
          </Text>
        )}
        <Pressable
          style={[styles.button, styles.primaryButton, sharing && styles.buttonBusy]}
          onPress={() => void share(false)}
          disabled={sharing}
          accessibilityRole="button"
          accessibilityLabel={strings.shareA11y}
        >
          <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
            {strings.share}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.secondaryButton, sharing && styles.buttonBusy]}
          onPress={() => void share(true)}
          disabled={sharing}
          accessibilityRole="button"
          accessibilityLabel={strings.shareJsonA11y}
        >
          <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
            {strings.shareJson}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

/** One block of the engine's own lines; renders nothing when the engine had none. */
function Section({ lines, tone }: { lines: string[]; tone?: 'warning' }): React.JSX.Element | null {
  if (lines.length === 0) return null;
  return (
    <View style={styles.sectionCard}>
      {lines.map((line, index) => (
        <Text
          key={index}
          style={[styles.line, tone === 'warning' && styles.lineWarning]}
          maxFontSizeMultiplier={1.3}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  centred: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: 'center' },
  title: { ...typography.title, color: colors.textPrimary },
  header: { ...typography.subtitle, color: colors.textPrimary },
  muted: { ...typography.body, color: colors.textMuted },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  badgeText: { ...typography.caption, color: colors.textSecondary },
  sectionCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  sectionLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.sm },
  line: { ...typography.body, color: colors.textSecondary },
  lineWarning: { color: colors.warning },
  cornerCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  cornerHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cornerHeading: { ...typography.subtitle, color: colors.textPrimary, fontFamily: fontFamily.bodySemibold },
  cornerBadge: { ...typography.caption, color: colors.slower },
  disclaimer: { ...typography.caption, color: colors.textMuted, marginTop: spacing.sm },
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  buttonBusy: { opacity: 0.6 },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: colors.onAccent },
  secondaryButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { ...typography.subtitle, color: colors.textPrimary },
});
