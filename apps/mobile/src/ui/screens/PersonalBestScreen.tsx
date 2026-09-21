import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { TimeDisplay } from '../components/TimeDisplay';
import { QualityPill } from '../components/QualityPill';
import { formatDateUtc } from '../format';
import { resolveSessionCalibrationStatus, sessionHistoryStore, settingsStore } from '../../session/composition';
import { resolveSelectedCircuit } from '../../session/circuitCatalog';
import { layoutLabel } from '../data/circuit';
import { useSettings } from '../hooks/useSettings';
import { pbCalibrationNotice, pbCalibrationProvenanceValue } from '../calibrationNotice';

type Props = NativeStackScreenProps<RootStackParamList, 'PersonalBest'>;

/**
 * Ticket P10B H7-B -- A PB IS A CLAIM ABOUT A TIME, AND IT CARRIES ITS
 * CALIBRATION WITH IT.
 *
 * The reviewer rejected calibration with ten stationary fixes, proceeded,
 * drove two TMR laps, and this screen presented the resulting 92.662 s as a
 * personal best with a quality pill and nothing else: no hint anywhere that
 * the session it came from was never vouched for. A lap time from
 * unvalidated matching may be wrong or may not even be a real lap -- and a
 * PB is the one number the driver will chase all day.
 *
 * The words live in `../calibrationNotice` (pure, and therefore actually
 * tested); this screen resolves the status from `pb.sessionId` -- the
 * session that SET the time is the one whose calibration qualifies it -- and
 * renders them.
 */

/** S11 — personal best details with provenance (date, session), quality flags. Header names the SELECTED circuit (ticket CN-W3), not a hardcoded constant. */
export function PersonalBestScreen({ navigation }: Props): React.JSX.Element {
  const pb = sessionHistoryStore.getPersonalBest();
  const settings = useSettings(settingsStore);
  const selected = resolveSelectedCircuit(settings);
  // Ticket P10B H7-B: resolved from the PB's OWN session id -- the session
  // that set the time is the one whose calibration qualifies it.
  const pbCalibrationStatus = pb === null ? null : resolveSessionCalibrationStatus(pb.sessionId);
  const calibrationNotice = pbCalibrationStatus === null ? null : pbCalibrationNotice(pbCalibrationStatus);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.kicker} maxFontSizeMultiplier={1.3}>
          PB
        </Text>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Personal Best
        </Text>
        <Text style={styles.circuit} maxFontSizeMultiplier={1.3}>
          {/* ticket CN-FIX3b: friendly layout label; the id itself still keys
              the PB lookup this screen reads. */}
          {selected.profile.displayName} · {layoutLabel(selected.profile.layoutId)}
        </Text>

        {!pb ? (
          <Text style={styles.emptyText} maxFontSizeMultiplier={1.3}>
            No personal best recorded yet.
          </Text>
        ) : (
          <>
            <View style={styles.timeCard}>
              <TimeDisplay ms={pb.lap.durationMs} size="display" color={colors.success} />
              <QualityPill quality={pb.lap.quality} />
              {/* Ticket P10B H7-B: beside the time itself, not buried in the
                  provenance card below -- the qualification has to be read
                  by anyone who reads the number. */}
              {calibrationNotice !== null ? (
                <View style={styles.calibrationBlock} accessibilityLabel={calibrationNotice.hint}>
                  <Text
                    style={[
                      styles.calibrationBadge,
                      calibrationNotice.kind === 'unknown' && styles.calibrationBadgeUnknown,
                    ]}
                    maxFontSizeMultiplier={1.3}
                  >
                    {calibrationNotice.badge}
                  </Text>
                  <Text style={styles.calibrationHint} maxFontSizeMultiplier={1.3}>
                    {calibrationNotice.hint}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={styles.provenanceCard}>
              <Text style={styles.provenanceLabel} maxFontSizeMultiplier={1.3}>
                PROVENANCE
              </Text>
              <View style={styles.provenanceRow}>
                <Text style={styles.provenanceKey} maxFontSizeMultiplier={1.3}>
                  Date
                </Text>
                <Text style={styles.provenanceValue} maxFontSizeMultiplier={1.3}>
                  {formatDateUtc(pb.recordedAtUtc)}
                </Text>
              </View>
              <View style={styles.provenanceRow}>
                <Text style={styles.provenanceKey} maxFontSizeMultiplier={1.3}>
                  Calibration
                </Text>
                <Text
                  style={[
                    styles.provenanceValue,
                    pbCalibrationStatus !== 'validated' && styles.provenanceValueFlagged,
                  ]}
                  maxFontSizeMultiplier={1.3}
                >
                  {pbCalibrationProvenanceValue(pbCalibrationStatus ?? 'unknown')}
                </Text>
              </View>
              <View style={styles.provenanceRow}>
                <Text style={styles.provenanceKey} maxFontSizeMultiplier={1.3}>
                  Session
                </Text>
                <Text
                  style={styles.provenanceValueLink}
                  maxFontSizeMultiplier={1.3}
                  onPress={() => navigation.navigate('LapDetail', { sessionId: pb.sessionId, lapNumber: pb.lap.lapNumber })}
                  accessibilityRole="link"
                  accessibilityLabel="View the lap this personal best came from"
                >
                  {pb.sessionId} → Lap {pb.lap.lapNumber}
                </Text>
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  kicker: { ...typography.kicker, color: colors.textMuted },
  title: { ...typography.title, fontSize: 26, color: colors.textPrimary, marginTop: -spacing.xs },
  circuit: { ...typography.body, color: colors.textSecondary },
  emptyText: { ...typography.body, color: colors.textMuted },
  timeCard: { alignItems: 'flex-start', gap: spacing.sm, marginVertical: spacing.md },
  provenanceCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  provenanceLabel: { ...typography.label, color: colors.textMuted },
  provenanceRow: { flexDirection: 'row', justifyContent: 'space-between' },
  provenanceKey: { ...typography.body, color: colors.textSecondary },
  provenanceValue: { ...typography.body, color: colors.textPrimary },
  provenanceValueLink: { ...typography.body, color: colors.accent, textDecorationLine: 'underline' },
  // P10B H7-B: same visual language the results and history screens already
  // use for this fact, so a driver recognises it wherever it appears.
  calibrationBlock: { gap: spacing.xs, marginTop: spacing.xs },
  calibrationBadge: { ...typography.label, color: colors.warning, letterSpacing: 1 },
  calibrationBadgeUnknown: { color: colors.textSecondary },
  calibrationHint: { ...typography.body, color: colors.textSecondary },
  provenanceValueFlagged: { color: colors.warning },
});
