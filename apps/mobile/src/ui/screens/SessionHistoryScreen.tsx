import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { TimeDisplay } from '../components/TimeDisplay';
import { formatDateUtc } from '../format';
import {
  buildSessionReport,
  getLapVerdictSummary,
  refreshLapVerdicts,
  resolveSessionCalibrationStatus,
  sessionHistoryStore,
  sessionUnwrittenSampleCount,
  settingsStore,
} from '../../session/composition';
import { shareSessionReport } from '../../session/sessionReportShare';
import { resolveLapVerdictStrings } from './lapVerdictStrings';
import { resolveSessionReportStrings } from './sessionReportStrings';
import { resolveSelectedCircuit } from '../../session/circuitCatalog';
import { layoutLabel } from '../data/circuit';
import { useSettings } from '../hooks/useSettings';
import { resolveAnalysisScreenStrings } from './analysisStrings';
// Ticket P5d T4: a learned circuit's sessions are labelled as test loops, so
// this list never presents ad-hoc geometry as a surveyed circuit.
import { resolveTestLoopStrings } from './testLoopStrings';

type Props = NativeStackScreenProps<RootStackParamList, 'SessionHistory'>;

/**
 * The per-row honesty labels. The EXPORT copy moved out to
 * `sessionReportStrings.ts` in ticket P13B (it is RO/EN now, and shared with
 * `SessionResultsScreen`); what stays here is the set of warnings this list is
 * the only place to show.
 */
const ROW_COPY = {
  /** Ticket P7R E2: the honest label on a session run past a rejected calibration. */
  uncalibrated: 'UNCALIBRATED',
  uncalibratedHint: 'Started without a validated calibration — lap times may be unreliable.',
  /**
   * Ticket P10A H6: the device holds no statement either way. Shown, not
   * omitted -- an omitted calibration line reads as "calibrated", and that
   * is a claim an unreadable provenance is not entitled to make.
   */
  unknownCalibration: 'CALIBRATION UNKNOWN',
  unknownCalibrationHint:
    'No record of whether this session’s calibration was validated — treat its lap times as unverified.',
  /** Ticket P10A H3: the trace on disk is shorter than the drive. */
  incompleteTrace: (missing: number): string =>
    `INCOMPLETE RECORDING — ${String(missing)} GPS fix(es) could not be saved.`,
} as const;

/** S9 — list of stored sessions (mock data via session store for now) with drill-down into lap detail. Header names the SELECTED circuit (ticket CN-W3): `sessionHistoryStore` is already rebuilt per-circuit by `selectCircuit()`, so its own listings already reflect this. */
export function SessionHistoryScreen({ navigation }: Props): React.JSX.Element {
  const sessions = sessionHistoryStore.listSessions();
  const pb = sessionHistoryStore.getPersonalBest();
  const settings = useSettings(settingsStore);
  const selected = resolveSelectedCircuit(settings);
  // Ticket P5b B1 (binding): every stored session -- of EITHER circuit -- can be
  // analysed from here. Ordinary product surface, no developer gate.
  const analysisStrings = resolveAnalysisScreenStrings(settings.language);
  const testLoopStrings = resolveTestLoopStrings(settings.language);
  const learnedCircuit = selected.profile.geometryStatus === 'ad-hoc';
  // P5d-FIX6: a learned circuit is shown by the NAME the driver gave it; the
  // generic label is only the fallback for one that was never named.
  const learnedRowLabel = selected.profile.displayName.trim() || testLoopStrings.historyLabel;
  const reportStrings = resolveSessionReportStrings(settings.language);
  const verdictStrings = resolveLapVerdictStrings(settings.language);
  // Ticket P7R E1, kept by P13B: one in-flight export at a time, and its
  // outcome reported against the session it belonged to -- a driver who taps
  // twice must not see the first result attributed to the second row.
  const [exportingSessionId, setExportingSessionId] = React.useState<string | null>(null);
  const [exportNote, setExportNote] = React.useState<{ sessionId: string; text: string } | null>(null);

  // Ticket P13B item 1: how much of the verdict check is done, per session.
  // `getLapVerdictSummary` reads a synchronous cache, so every listed session
  // is refreshed once here -- without this the list would report every lap as
  // unanswered, which is the one wrong answer that looks like a real one.
  const sessionIds = sessions.map((session) => session.sessionId).join(',');
  const [verdictsLoaded, setVerdictsLoaded] = React.useState(0);
  React.useEffect(() => {
    let cancelled = false;
    const ids = sessionIds.length === 0 ? [] : sessionIds.split(',');
    void Promise.all(ids.map((id) => refreshLapVerdicts(id))).then(() => {
      if (!cancelled) setVerdictsLoaded((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionIds]);

  const exportReport = React.useCallback(async (sessionId: string): Promise<void> => {
    if (exportingSessionId !== null) return;
    setExportingSessionId(sessionId);
    setExportNote(null);
    const doc = await buildSessionReport(sessionId);
    if (doc === 'session-not-found') {
      setExportNote({ sessionId, text: reportStrings.missing });
    } else if (doc === 'storage-unavailable') {
      setExportNote({ sessionId, text: reportStrings.storageUnavailable });
    } else {
      const outcome = await shareSessionReport(doc);
      setExportNote({
        sessionId,
        text: !outcome.ok
          ? reportStrings.failed
          : outcome.shared
            ? reportStrings.shared
            : reportStrings.written,
      });
    }
    setExportingSessionId(null);
  }, [exportingSessionId, reportStrings]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Session History
        </Text>
        <Text style={styles.circuit} maxFontSizeMultiplier={1.3}>
          {/* ticket CN-FIX3b: friendly layout label; the id itself still keys
              this store's own per-circuit history/PB lookups. */}
          {selected.profile.displayName} ·{' '}
          {learnedCircuit ? testLoopStrings.learnedLabel : layoutLabel(selected.profile.layoutId)}
        </Text>

        {pb ? (
          <Pressable
            style={styles.pbCard}
            onPress={() => navigation.navigate('PersonalBest')}
            accessibilityRole="button"
            accessibilityLabel="View personal best details"
          >
            <Text style={styles.pbLabel} maxFontSizeMultiplier={1.3}>
              PERSONAL BEST
            </Text>
            <TimeDisplay ms={pb.lap.durationMs} size="medium" color={colors.success} />
          </Pressable>
        ) : null}

        {sessions.length === 0 ? (
          <Text style={styles.emptyText} maxFontSizeMultiplier={1.3}>
            No sessions recorded yet.
          </Text>
        ) : (
          sessions.map((session) => {
            const validLaps = session.laps.filter((l) => l.valid);
            const bestMs = validLaps.length > 0 ? Math.min(...validLaps.map((l) => l.durationMs)) : null;
            // Ticket P10A H6: three-valued. `'unknown'` gets its own,
            // quieter notice -- never silence, which would read as validated.
            const calibrationStatus = resolveSessionCalibrationStatus(session.sessionId);
            const unwritten = sessionUnwrittenSampleCount(session.sessionId) ?? 0;
            const note = exportNote?.sessionId === session.sessionId ? exportNote.text : null;
            // `verdictsLoaded` is read here purely to re-derive after the
            // refresh above resolves; the counts themselves come from the
            // store's cache, which is the only authority on them.
            void verdictsLoaded;
            const verdictCounts = getLapVerdictSummary(session.sessionId);
            return (
              <View key={session.sessionId} style={styles.sessionCard}>
                <View style={styles.sessionHeader}>
                  <Text style={styles.sessionDate} maxFontSizeMultiplier={1.3}>
                    {formatDateUtc(session.displayDateUtc)}
                  </Text>
                  <Text style={styles.sessionMeta} maxFontSizeMultiplier={1.3}>
                    {learnedCircuit ? `${learnedRowLabel} · ` : ''}
                    {session.laps.length} laps · best <TimeDisplayInline ms={bestMs} />
                  </Text>
                </View>
                {/* Ticket P7R E2: a session run past a rejected calibration is
                    never presented as an ordinary one. */}
                {calibrationStatus === 'unvalidated' ? (
                  <View style={styles.uncalibratedBlock} accessibilityLabel={ROW_COPY.uncalibratedHint}>
                    <Text style={styles.uncalibratedBadge} maxFontSizeMultiplier={1.3}>
                      {ROW_COPY.uncalibrated}
                    </Text>
                    <Text style={styles.uncalibratedHint} maxFontSizeMultiplier={1.3}>
                      {ROW_COPY.uncalibratedHint}
                    </Text>
                  </View>
                ) : calibrationStatus === 'unknown' ? (
                  <View
                    style={styles.uncalibratedBlock}
                    accessibilityLabel={ROW_COPY.unknownCalibrationHint}
                  >
                    <Text style={styles.unknownCalibrationBadge} maxFontSizeMultiplier={1.3}>
                      {ROW_COPY.unknownCalibration}
                    </Text>
                    <Text style={styles.uncalibratedHint} maxFontSizeMultiplier={1.3}>
                      {ROW_COPY.unknownCalibrationHint}
                    </Text>
                  </View>
                ) : null}
                {/* Ticket P10A H3: a short trace says so here, where the
                    export button that would hand it over also lives. */}
                {unwritten > 0 ? (
                  <Text
                    style={styles.incompleteTrace}
                    maxFontSizeMultiplier={1.3}
                    accessibilityLabel={ROW_COPY.incompleteTrace(unwritten)}
                  >
                    {ROW_COPY.incompleteTrace(unwritten)}
                  </Text>
                ) : null}
                {/* Ticket P13B item 1: the counts, on the row he taps to open
                    a lap -- so he can see which session still owes answers
                    without opening every one of them. */}
                {session.laps.length === 0 ? null : (
                  <Text
                    style={[
                      styles.verdictSummary,
                      verdictCounts.unanswered === 0 && styles.verdictSummaryDone,
                    ]}
                    maxFontSizeMultiplier={1.3}
                    accessibilityLabel={verdictStrings.summaryA11y(verdictCounts)}
                  >
                    {verdictStrings.sectionHeading} {verdictCounts.unanswered === 0
                      ? verdictStrings.summaryComplete
                      : verdictStrings.summary(verdictCounts)}
                  </Text>
                )}
                <View style={styles.lapChipsRow}>
                  {session.laps.map((lap) => (
                    <Pressable
                      key={lap.lapNumber}
                      style={[styles.lapChip, !lap.valid && styles.lapChipInvalid]}
                      onPress={() => navigation.navigate('LapDetail', { sessionId: session.sessionId, lapNumber: lap.lapNumber })}
                      accessibilityRole="button"
                      accessibilityLabel={`Lap ${lap.lapNumber}, ${lap.valid ? 'valid' : 'invalid'}, view detail`}
                    >
                      <Text style={styles.lapChipText} maxFontSizeMultiplier={1.3}>
                        L{lap.lapNumber}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.actionRow}>
                  {/* Ticket P7R E1: the analysis entry point needs laps to
                      have anything to say; the raw export beside it does not,
                      and is offered for EVERY session for exactly that
                      reason. A zero-lap session is listed here (the stored
                      row has no lap join) and this is how its drive leaves
                      the phone. */}
                  <Pressable
                    style={styles.analysisButton}
                    onPress={() => navigation.navigate('Analysis', { sessionId: session.sessionId })}
                    accessibilityRole="button"
                    accessibilityLabel={analysisStrings.entryButtonA11y(formatDateUtc(session.displayDateUtc))}
                  >
                    <Text style={styles.analysisButtonText} maxFontSizeMultiplier={1.3}>
                      {analysisStrings.entryButton}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[styles.exportButton, exportingSessionId !== null && styles.exportButtonBusy]}
                    onPress={() => {
                      void exportReport(session.sessionId);
                    }}
                    disabled={exportingSessionId !== null}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: exportingSessionId !== null }}
                    accessibilityLabel={reportStrings.buttonA11y(formatDateUtc(session.displayDateUtc))}
                  >
                    <Text style={styles.exportButtonText} maxFontSizeMultiplier={1.3}>
                      {exportingSessionId === session.sessionId
                        ? reportStrings.busy
                        : reportStrings.button}
                    </Text>
                  </Pressable>
                </View>
                {note === null ? null : (
                  <Text style={styles.exportNote} maxFontSizeMultiplier={1.3}>
                    {note}
                  </Text>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

/** Inline plain-text time (no live region needed for a static list). */
function TimeDisplayInline({ ms }: { ms: number | null }): React.JSX.Element {
  return <TimeDisplay ms={ms} size="small" style={styles.inlineTime} maxFontSizeMultiplier={1.3} />;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  circuit: { ...typography.body, color: colors.textSecondary },
  pbCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.success,
    padding: spacing.md,
    gap: spacing.xs,
  },
  pbLabel: { ...typography.label, color: colors.textMuted },
  emptyText: { ...typography.body, color: colors.textMuted },
  sessionCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sessionHeader: { gap: 2 },
  sessionDate: { ...typography.subtitle, color: colors.textPrimary },
  sessionMeta: { ...typography.caption, color: colors.textSecondary },
  lapChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  lapChip: {
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  lapChipInvalid: { borderColor: colors.danger },
  analysisButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  analysisButtonText: { ...typography.caption, color: colors.accent },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, alignItems: 'center' },
  exportButton: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceRaised,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  exportButtonBusy: { opacity: 0.6 },
  exportButtonText: { ...typography.caption, color: colors.textPrimary },
  exportNote: { ...typography.caption, color: colors.textSecondary },
  verdictSummary: { ...typography.caption, color: colors.accent },
  verdictSummaryDone: { color: colors.success },
  uncalibratedBlock: { gap: 2 },
  uncalibratedBadge: { ...typography.label, color: colors.warning },
  uncalibratedHint: { ...typography.caption, color: colors.textSecondary },
  unknownCalibrationBadge: { ...typography.label, color: colors.textMuted },
  incompleteTrace: { ...typography.caption, color: colors.warning },
  lapChipText: { ...typography.caption, color: colors.textPrimary },
  inlineTime: { fontSize: 13 },
});
