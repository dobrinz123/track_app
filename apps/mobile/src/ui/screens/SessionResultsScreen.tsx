import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { LapRecord, LapValidityVerdict, LapVerdictDecision } from '@circuit/core';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { TimeDisplay } from '../components/TimeDisplay';
import {
  buildSessionReport,
  facade,
  getLapVerdicts,
  getUnsavedLapVerdicts,
  getMostRecentSessionId,
  lapVerdictSupport,
  recordLapValidityVerdict,
  refreshLapVerdicts,
  resolveResultsCalibrationStatus,
  settingsStore,
} from '../../session/composition';
import { shareSessionReport } from '../../session/sessionReportShare';
import {
  buildLapVerdictRows,
  summarizeLapVerdictRows,
  verdictControlEnabled,
  verdictTapFeedback,
} from '../../session/lapVerdictViewModel';
import type { UnsavedLapVerdict } from '../../session/lapVerdictStore';
import { LapVerdictControl } from '../components/LapVerdictControl';
import { useFacadeState } from '../hooks/useFacadeState';
import { useSettings } from '../hooks/useSettings';
import { resolveAnalysisScreenStrings } from './analysisStrings';
import { resolveLapVerdictStrings } from './lapVerdictStrings';
import { resolveSessionReportStrings } from './sessionReportStrings';
import { formatDateUtc } from '../format';
import { explainInvalidReason as explainInvalid } from './invalidReasonCopy';

type Props = NativeStackScreenProps<RootStackParamList, 'SessionResults'>;

function sectorBests(laps: readonly LapRecord[]): (number | null)[] {
  const bests: (number | null)[] = [null, null, null];
  for (const lap of laps) {
    if (!lap.valid) continue;
    for (const s of lap.sectorTimes) {
      const current = bests[s.sectorIndex];
      if (current === null || s.durationMs < current) bests[s.sectorIndex] = s.durationMs;
    }
  }
  return bests;
}

/**
 * Ticket P13B item 3 (binding) -- ONE TAP, replacing ticket P7R E1's raw
 * export on this screen.
 *
 * Not an addition: a SUBSTITUTION. The session report embeds the raw export
 * document whole (`sessionReport.ts`), so two buttons here would offer the
 * driver a format choice between a file and a strict subset of the same file
 * -- which is exactly the menu the owner asked not to be given. The control
 * count on this screen is unchanged; only what the one export button produces
 * is.
 *
 * Still offered unconditionally, for P7R E1's original reason: the analysis
 * button needs laps, this does not, and the session with no laps is precisely
 * the one whose data is otherwise stuck on the phone.
 */

/**
 * Ticket P10A H7 (binding) -- THIS SCREEN USED TO LIE BY OMISSION.
 *
 * End a session that was driven past a REJECTED calibration and this screen
 * showed lap times, sector bests and, quite possibly, "NEW PERSONAL BEST",
 * with nothing anywhere saying the matching had never been vouched for. No
 * crash, no lost data -- it simply presented unverified times as results.
 * The dashboard carried the marker while driving and history carried it
 * afterwards; the one screen the driver actually stands on when the session
 * ends carried nothing.
 *
 * Three-valued, because two values cannot tell "we know it was accepted"
 * from "we cannot say" -- and the second must never be drawn as the first.
 * The notice is therefore shown for `'unknown'` too, quieter but present.
 */
const CALIBRATION_COPY = {
  unvalidated: {
    badge: 'CALIBRATION NOT VALIDATED',
    hint: 'This session ran past a rejected calibration. Its lap and sector times may be wrong or missing. The raw GPS and sensor data below are unaffected.',
  },
  unknown: {
    badge: 'CALIBRATION UNKNOWN',
    hint: 'No record of whether this session\u2019s calibration was validated. Treat its lap and sector times as unverified.',
  },
} as const;

/** Ticket P10A H3: the recording either got everything down or it did not, and the driver is told which while they are still standing next to the car. */
function recordingNotice(unwritten: number): string {
  return `INCOMPLETE RECORDING — ${String(unwritten)} captured GPS fix(es) could not be written to storage and are not in this session. Export the raw data now.`;
}

/** S8 — post-session results: lap list, sector bests, PB badge. */
export function SessionResultsScreen({ navigation }: Props): React.JSX.Element {
  const state = useFacadeState(facade);
  const laps = state.laps;
  const validLaps = laps.filter((l) => l.valid);
  const bestLapMs = validLaps.length > 0 ? Math.min(...validLaps.map((l) => l.durationMs)) : null;
  const isNewPb = bestLapMs !== null && state.pbMs === bestLapMs;
  const bests = sectorBests(laps);
  // Ticket P5b B1 (binding): the post-session analysis entry point. Ordinary
  // product surface -- no developer gate. Offered only once the session that
  // just ended actually has stored laps to analyse.
  const settings = useSettings(settingsStore);
  const analysisStrings = resolveAnalysisScreenStrings(settings.language);
  const analysableSessionId = laps.length > 0 ? getMostRecentSessionId() : null;
  // Ticket P10A H7: the DURABLE status of the session that just ended, not
  // only the live one. `facade` still holds the just-finished session's
  // state here, and the stored record is consulted as well so a resumed or
  // rebuilt controller can never downgrade a stored `'unvalidated'` to
  // `'unknown'` -- the more specific of the two wins, and `'validated'`
  // requires BOTH to say so.
  const calibrationStatus = resolveResultsCalibrationStatus(
    state.calibrationStatus,
    getMostRecentSessionId(),
  );
  const calibrationNotice =
    calibrationStatus === 'validated' ? null : CALIBRATION_COPY[calibrationStatus];
  const unwritten = state.recording.unwrittenSampleCount;
  const reportStrings = resolveSessionReportStrings(settings.language);
  const verdictStrings = resolveLapVerdictStrings(settings.language);
  // Ticket P13B item 3: the export needs NO laps -- only a session id.
  const [exporting, setExporting] = React.useState(false);
  const [exportNote, setExportNote] = React.useState<string | null>(null);

  // Ticket P13B item 1: the owner's answers for the session that just ended.
  // Held in state and re-read from the store after every tap, so what he sees
  // is what the store holds rather than what this screen hoped it would.
  const sessionId = getMostRecentSessionId();
  const [verdicts, setVerdicts] = React.useState<LapValidityVerdict[]>([]);
  // Ticket P14 H1: answers that did not reach storage, held beside the stored
  // ones and never folded into them.
  const [unsavedVerdicts, setUnsavedVerdicts] = React.useState<readonly UnsavedLapVerdict[]>([]);
  const [verdictBusyLap, setVerdictBusyLap] = React.useState<number | null>(null);
  const [verdictNote, setVerdictNote] = React.useState<{ text: string; error: boolean } | null>(null);
  const verdictsEnabled = verdictControlEnabled(lapVerdictSupport());

  React.useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    void refreshLapVerdicts(sessionId).then(() => {
      if (!cancelled) {
        setVerdicts(getLapVerdicts(sessionId));
        setUnsavedVerdicts(getUnsavedLapVerdicts(sessionId));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const decide = React.useCallback(
    async (lapNumber: number, decision: LapVerdictDecision): Promise<void> => {
      if (sessionId === null || verdictBusyLap !== null) return;
      setVerdictBusyLap(lapNumber);
      setVerdictNote(null);
      const outcome = await recordLapValidityVerdict({ sessionId, lapNumber, decision });
      const feedback = verdictTapFeedback(outcome);
      // Ticket P14 H1: two reads, because there are two facts. `getLapVerdicts`
      // is what STORAGE holds; `getUnsavedLapVerdicts` is what the owner
      // answered and storage refused. The row draws both, and the "NOT SAVED"
      // badge stays on that lap until the answer actually lands -- unlike the
      // note below, which the next tap clears.
      setVerdicts(getLapVerdicts(sessionId));
      setUnsavedVerdicts(getUnsavedLapVerdicts(sessionId));
      setVerdictNote({
        text:
          feedback.key === 'saved'
            ? verdictStrings.saved
            : feedback.key === 'saveUnsupported'
              ? verdictStrings.saveUnsupported
              : verdictStrings.saveFailed,
        error: feedback.tone === 'error',
      });
      setVerdictBusyLap(null);
    },
    [sessionId, verdictBusyLap, verdictStrings],
  );

  const verdictRows = buildLapVerdictRows(laps, verdicts, unsavedVerdicts);
  const verdictCounts = summarizeLapVerdictRows(verdictRows);
  const verdictRowByLap = new Map(verdictRows.map((row) => [row.lapNumber, row]));

  const exportReport = React.useCallback(async (): Promise<void> => {
    if (exporting) return;
    const id = getMostRecentSessionId();
    if (id === null) {
      setExportNote(reportStrings.noSession);
      return;
    }
    setExporting(true);
    setExportNote(null);
    const doc = await buildSessionReport(id);
    if (doc === 'session-not-found') {
      setExportNote(reportStrings.missing);
    } else if (doc === 'storage-unavailable') {
      setExportNote(reportStrings.storageUnavailable);
    } else {
      const outcome = await shareSessionReport(doc);
      setExportNote(
        !outcome.ok
          ? reportStrings.failed
          : outcome.shared
            ? reportStrings.shared
            : reportStrings.written,
      );
    }
    setExporting(false);
  }, [exporting, reportStrings]);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Session Results
        </Text>

        {/* Ticket P10A H7: ABOVE the PB badge and the times, because it
            qualifies every number under it. */}
        {calibrationNotice === null ? null : (
          <View
            style={[
              styles.calibrationBlock,
              calibrationStatus === 'unvalidated'
                ? styles.calibrationBlockWarning
                : styles.calibrationBlockUnknown,
            ]}
            accessibilityLabel={`${calibrationNotice.badge}. ${calibrationNotice.hint}`}
          >
            <Text
              style={[
                styles.calibrationBadge,
                calibrationStatus === 'unvalidated'
                  ? styles.calibrationBadgeWarning
                  : styles.calibrationBadgeUnknown,
              ]}
              maxFontSizeMultiplier={1.3}
            >
              {calibrationNotice.badge}
            </Text>
            <Text style={styles.calibrationHint} maxFontSizeMultiplier={1.3}>
              {calibrationNotice.hint}
            </Text>
          </View>
        )}

        {/* Ticket P10A H3: a partial trace is never silent. */}
        {unwritten > 0 ? (
          <View
            style={[styles.calibrationBlock, styles.calibrationBlockWarning]}
            accessibilityLabel={recordingNotice(unwritten)}
          >
            <Text style={[styles.calibrationBadge, styles.calibrationBadgeWarning]} maxFontSizeMultiplier={1.3}>
              {recordingNotice(unwritten)}
            </Text>
          </View>
        ) : null}

        {isNewPb ? (
          <View style={styles.pbBadge} accessibilityLabel="New personal best set this session">
            <Text style={styles.pbBadgeText} maxFontSizeMultiplier={1.3}>
              NEW PERSONAL BEST
            </Text>
          </View>
        ) : null}

        <View style={styles.sectorBestsCard}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            SECTOR BESTS
          </Text>
          <View style={styles.sectorBestsRow}>
            {bests.map((ms, i) => (
              <View key={i} style={styles.sectorBestItem}>
                <Text style={styles.sectorBestLabel} maxFontSizeMultiplier={1.3}>
                  S{i + 1}
                </Text>
                <TimeDisplay ms={ms} size="small" />
              </View>
            ))}
          </View>
        </View>

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          LAPS
        </Text>
        {/* Ticket P13B item 1: the counts where he is working -- how much of
            the check is done, and how much is still owed. */}
        {laps.length === 0 ? null : (
          <View style={styles.verdictSummaryRow} accessibilityLabel={verdictStrings.summaryA11y(verdictCounts)}>
            <Text style={styles.verdictSummaryLabel} maxFontSizeMultiplier={1.3}>
              {verdictStrings.sectionHeading}
            </Text>
            <Text
              style={[
                styles.verdictSummaryValue,
                verdictCounts.unanswered === 0 && styles.verdictSummaryDone,
              ]}
              maxFontSizeMultiplier={1.3}
            >
              {verdictCounts.unanswered === 0
                ? verdictStrings.summaryComplete
                : verdictStrings.summary(verdictCounts)}
            </Text>
            <Text style={styles.verdictHint} maxFontSizeMultiplier={1.3}>
              {verdictStrings.questionHint}
            </Text>
            {verdictsEnabled ? null : (
              <Text style={styles.verdictError} maxFontSizeMultiplier={1.3}>
                {verdictStrings.unsupportedNotice}
              </Text>
            )}
            {verdictNote === null ? null : (
              <Text
                style={verdictNote.error ? styles.verdictError : styles.verdictOk}
                maxFontSizeMultiplier={1.3}
              >
                {verdictNote.text}
              </Text>
            )}
          </View>
        )}
        {laps.length === 0 ? (
          <>
            <Text style={styles.emptyText} maxFontSizeMultiplier={1.3}>
              No laps recorded.
            </Text>
            <Text style={styles.emptyText} maxFontSizeMultiplier={1.3}>
              {verdictStrings.noLaps}
            </Text>
            {/* Ticket P7R E1, kept verbatim in P13B: the one thing a driver
                must not conclude from "no laps" is that the drive was lost.
                It was not -- P7M M1 persists the trace independently of lap
                detection -- and the button below is how it leaves the phone. */}
            <Text style={styles.emptyText} maxFontSizeMultiplier={1.3}>
              {reportStrings.zeroLapHint}
            </Text>
          </>
        ) : (
          laps.map((lap) => {
            const isBest = lap.valid && lap.durationMs === bestLapMs;
            const row = verdictRowByLap.get(lap.lapNumber);
            return (
              <View
                key={lap.lapNumber}
                style={[styles.lapRow, isBest && styles.lapRowBest]}
                accessibilityLabel={`Lap ${lap.lapNumber}, ${lap.valid ? 'valid' : 'invalid'}${isBest ? ', best lap' : ''}`}
              >
                <View style={styles.lapRowHeader}>
                  <Text style={styles.lapNumber} maxFontSizeMultiplier={1.3}>
                    Lap {lap.lapNumber}
                  </Text>
                  <TimeDisplay ms={lap.durationMs} size="small" color={isBest ? colors.success : colors.textPrimary} />
                </View>
                {/* Ticket P13B item 1: the app's OWN call, stated on every lap
                    -- valid ones included. Before this only invalid laps said
                    anything, so there was nothing to agree or disagree with on
                    a lap the app thought was fine. */}
                <Text
                  style={[styles.appVerdict, lap.valid ? styles.appVerdictValid : styles.appVerdictInvalid]}
                  maxFontSizeMultiplier={1.3}
                >
                  {lap.valid ? verdictStrings.appVerdictValid : verdictStrings.appVerdictInvalid}
                </Text>
                {!lap.valid ? (
                  <View style={styles.invalidBlock}>
                    <Text style={styles.invalidLabel} maxFontSizeMultiplier={1.3}>
                      {verdictStrings.appReasonsHeading}
                    </Text>
                    {lap.invalidReasons.length === 0 ? (
                      <Text style={styles.invalidReason} maxFontSizeMultiplier={1.3}>
                        {verdictStrings.appReasonsNone}
                      </Text>
                    ) : (
                      lap.invalidReasons.map((r) => (
                        <Text key={r} style={styles.invalidReason} maxFontSizeMultiplier={1.3}>
                          {explainInvalid(r)}
                        </Text>
                      ))
                    )}
                  </View>
                ) : null}
                {row === undefined ? null : (
                  <LapVerdictControl
                    row={row}
                    strings={verdictStrings}
                    enabled={verdictsEnabled && sessionId !== null}
                    busy={verdictBusyLap === lap.lapNumber}
                    onDecide={(lapNumber, decision) => {
                      void decide(lapNumber, decision);
                    }}
                  />
                )}
              </View>
            );
          })
        )}

        {analysableSessionId === null ? null : (
          <Pressable
            style={[styles.button, styles.primaryButton]}
            onPress={() => navigation.navigate('Analysis', { sessionId: analysableSessionId })}
            accessibilityRole="button"
            accessibilityLabel={analysisStrings.entryButtonA11y(formatDateUtc(new Date().toISOString()))}
          >
            <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
              {analysisStrings.entryButton}
            </Text>
          </Pressable>
        )}
        {/* Ticket P13B item 3: ONE tap, unconditional -- no analysis, no laps
            required, no format choice. */}
        <Pressable
          style={[styles.button, styles.secondaryButton, exporting && styles.buttonBusy]}
          onPress={() => {
            void exportReport();
          }}
          disabled={exporting}
          accessibilityRole="button"
          accessibilityState={{ disabled: exporting }}
          accessibilityLabel={reportStrings.buttonA11y(formatDateUtc(new Date().toISOString()))}
        >
          <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
            {exporting ? reportStrings.busy : reportStrings.button}
          </Text>
        </Pressable>
        <Text style={styles.exportNote} maxFontSizeMultiplier={1.3}>
          {reportStrings.contains}
        </Text>
        {exportNote === null ? null : (
          <Text style={styles.exportNote} maxFontSizeMultiplier={1.3}>
            {exportNote}
          </Text>
        )}
        <Pressable
          style={[styles.button, styles.secondaryButton]}
          onPress={() => navigation.navigate('SessionHistory')}
          accessibilityRole="button"
          accessibilityLabel="View session history"
        >
          <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
            Session History
          </Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.secondaryButton]}
          // Ticket CN-W3: `CircuitDetail` now requires `circuitId` (navigation/types.ts) --
          // pass the currently selected circuit's id (unaffected by the fact that a
          // session just ended, since the selection never changes mid-session).
          onPress={() => navigation.navigate('CircuitDetail', { circuitId: settingsStore.getSettings().selectedCircuitId })}
          accessibilityRole="button"
          accessibilityLabel="Back to circuit"
        >
          <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
            Back to Circuit
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
  pbBadge: {
    alignSelf: 'flex-start',
    backgroundColor: `${colors.success}22`,
    borderColor: colors.success,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  pbBadgeText: { ...typography.label, color: colors.success },
  calibrationBlock: {
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing.md,
    gap: spacing.xs,
  },
  calibrationBlockWarning: { backgroundColor: `${colors.warning}1A`, borderColor: colors.warning },
  calibrationBlockUnknown: { backgroundColor: colors.surface, borderColor: colors.border },
  calibrationBadge: { ...typography.label },
  calibrationBadgeWarning: { color: colors.warning },
  calibrationBadgeUnknown: { color: colors.textMuted },
  calibrationHint: { ...typography.caption, color: colors.textSecondary },
  sectionLabel: { ...typography.label, color: colors.textMuted },
  sectorBestsCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  sectorBestsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  sectorBestItem: { alignItems: 'flex-start' },
  sectorBestLabel: { ...typography.caption, color: colors.textSecondary, marginBottom: spacing.xs },
  emptyText: { ...typography.body, color: colors.textMuted },
  lapRow: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  lapRowBest: { borderColor: colors.success },
  lapRowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lapNumber: { ...typography.body, color: colors.textPrimary, fontFamily: fontFamily.bodySemibold },
  invalidBlock: { marginTop: spacing.xs },
  invalidLabel: { ...typography.label, color: colors.danger },
  invalidReason: { ...typography.caption, color: colors.textSecondary },
  appVerdict: { ...typography.caption, marginTop: spacing.xs },
  appVerdictValid: { color: colors.success },
  appVerdictInvalid: { color: colors.danger },
  verdictSummaryRow: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  verdictSummaryLabel: { ...typography.label, color: colors.textMuted },
  verdictSummaryValue: { ...typography.subtitle, color: colors.accent },
  verdictSummaryDone: { color: colors.success },
  verdictHint: { ...typography.caption, color: colors.textSecondary },
  verdictOk: { ...typography.caption, color: colors.success },
  verdictError: { ...typography.label, color: colors.danger },
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: colors.onAccent },
  secondaryButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { ...typography.subtitle, color: colors.textPrimary },
  buttonBusy: { opacity: 0.6 },
  exportNote: { ...typography.caption, color: colors.textSecondary },
});
