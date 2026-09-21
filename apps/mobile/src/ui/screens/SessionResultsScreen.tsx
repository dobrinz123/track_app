import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { LapRecord } from '@circuit/core';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { TimeDisplay } from '../components/TimeDisplay';
import {
  buildRawSessionExport,
  facade,
  getMostRecentSessionId,
  resolveResultsCalibrationStatus,
  settingsStore,
} from '../../session/composition';
import { shareRawSessionExport } from '../../session/rawSessionShare';
import { useFacadeState } from '../hooks/useFacadeState';
import { useSettings } from '../hooks/useSettings';
import { resolveAnalysisScreenStrings } from './analysisStrings';
import { formatDateUtc } from '../format';

type Props = NativeStackScreenProps<RootStackParamList, 'SessionResults'>;

const INVALID_REASON_COPY: Record<string, string> = {
  PIT_TRANSIT: 'Included a pit lane transit.',
  MISSED_SECTOR_GATE: 'Missed a sector timing gate.',
  SHORT_LAP: 'Lap distance was too short to be valid.',
  LOW_QUALITY: 'GNSS quality was too low during this lap.',
};

function explainInvalid(reason: string): string {
  return INVALID_REASON_COPY[reason] ?? reason.replace(/_/g, ' ').toLowerCase();
}

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
 * Ticket P7R E1 — the copy for the raw export, on the screen the driver is
 * standing on the moment a session ends.
 *
 * This is the paddock path. The analysis button below is offered only when
 * the session has laps; this one is offered ALWAYS, because the session with
 * no laps is precisely the one whose data is otherwise stuck on the phone.
 */
const RAW_EXPORT_COPY = {
  button: 'Export raw data',
  buttonA11y: 'Export the raw recorded data of this session',
  busy: 'Exporting…',
  done: 'Raw data shared.',
  written: 'Raw data written to the app cache (no share sheet on this platform).',
  failed: 'Could not export the raw data.',
  missing: 'This session is no longer on the device.',
  unavailable: 'Storage is not ready yet — try again in a moment.',
  noSession: 'No session from this launch to export.',
  /** Said out loud on the screen a zero-lap session lands on, so the driver knows the drive was NOT lost. */
  zeroLapHint:
    'No laps were timed, but the full GPS trace and sensor data were still recorded. Export the raw data to keep them.',
} as const;

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
  // Ticket P7R E1: the raw export needs NO laps -- only a session id.
  const [exporting, setExporting] = React.useState(false);
  const [exportNote, setExportNote] = React.useState<string | null>(null);

  const exportRaw = React.useCallback(async (): Promise<void> => {
    if (exporting) return;
    const sessionId = getMostRecentSessionId();
    if (sessionId === null) {
      setExportNote(RAW_EXPORT_COPY.noSession);
      return;
    }
    setExporting(true);
    setExportNote(null);
    const doc = await buildRawSessionExport(sessionId);
    if (doc === 'session-not-found') {
      setExportNote(RAW_EXPORT_COPY.missing);
    } else if (doc === 'storage-unavailable') {
      setExportNote(RAW_EXPORT_COPY.unavailable);
    } else {
      const outcome = await shareRawSessionExport(doc);
      setExportNote(
        !outcome.ok
          ? RAW_EXPORT_COPY.failed
          : outcome.shared
            ? RAW_EXPORT_COPY.done
            : RAW_EXPORT_COPY.written,
      );
    }
    setExporting(false);
  }, [exporting]);

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
        {laps.length === 0 ? (
          <>
            <Text style={styles.emptyText} maxFontSizeMultiplier={1.3}>
              No laps recorded.
            </Text>
            {/* Ticket P7R E1: the one thing a driver must not conclude from
                "no laps" is that the drive was lost. It was not -- P7M M1
                persists the trace independently of lap detection -- and the
                button below is how it leaves the phone. */}
            <Text style={styles.emptyText} maxFontSizeMultiplier={1.3}>
              {RAW_EXPORT_COPY.zeroLapHint}
            </Text>
          </>
        ) : (
          laps.map((lap) => {
            const isBest = lap.valid && lap.durationMs === bestLapMs;
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
                {!lap.valid ? (
                  <View style={styles.invalidBlock}>
                    <Text style={styles.invalidLabel} maxFontSizeMultiplier={1.3}>
                      INVALID
                    </Text>
                    {lap.invalidReasons.map((r) => (
                      <Text key={r} style={styles.invalidReason} maxFontSizeMultiplier={1.3}>
                        {explainInvalid(r)}
                      </Text>
                    ))}
                  </View>
                ) : null}
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
        {/* Ticket P7R E1: unconditional -- no analysis, no laps required. */}
        <Pressable
          style={[styles.button, styles.secondaryButton, exporting && styles.buttonBusy]}
          onPress={() => {
            void exportRaw();
          }}
          disabled={exporting}
          accessibilityRole="button"
          accessibilityState={{ disabled: exporting }}
          accessibilityLabel={RAW_EXPORT_COPY.buttonA11y}
        >
          <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
            {exporting ? RAW_EXPORT_COPY.busy : RAW_EXPORT_COPY.button}
          </Text>
        </Pressable>
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
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: colors.onAccent },
  secondaryButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { ...typography.subtitle, color: colors.textPrimary },
  buttonBusy: { opacity: 0.6 },
  exportNote: { ...typography.caption, color: colors.textSecondary },
});
