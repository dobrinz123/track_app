import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { TimeDisplay } from '../components/TimeDisplay';
import { formatDateUtc } from '../format';
import { sessionHistoryStore, settingsStore } from '../../session/composition';
import { resolveSelectedCircuit } from '../../session/circuitCatalog';
import { layoutLabel } from '../data/circuit';
import { useSettings } from '../hooks/useSettings';
import { resolveAnalysisScreenStrings } from './analysisStrings';
// Ticket P5d T4: a learned circuit's sessions are labelled as test loops, so
// this list never presents ad-hoc geometry as a surveyed circuit.
import { resolveTestLoopStrings } from './testLoopStrings';

type Props = NativeStackScreenProps<RootStackParamList, 'SessionHistory'>;

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
            return (
              <View key={session.sessionId} style={styles.sessionCard}>
                <View style={styles.sessionHeader}>
                  <Text style={styles.sessionDate} maxFontSizeMultiplier={1.3}>
                    {formatDateUtc(session.displayDateUtc)}
                  </Text>
                  <Text style={styles.sessionMeta} maxFontSizeMultiplier={1.3}>
                    {learnedCircuit ? `${testLoopStrings.historyLabel} · ` : ''}
                    {session.laps.length} laps · best <TimeDisplayInline ms={bestMs} />
                  </Text>
                </View>
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
  lapChipText: { ...typography.caption, color: colors.textPrimary },
  inlineTime: { fontSize: 13 },
});
