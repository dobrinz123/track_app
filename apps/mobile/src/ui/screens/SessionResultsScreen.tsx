import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { LapRecord } from '@circuit/core';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { TimeDisplay } from '../components/TimeDisplay';
import { facade } from '../../session/composition';
import { useFacadeState } from '../hooks/useFacadeState';

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

/** S8 — post-session results: lap list, sector bests, PB badge. */
export function SessionResultsScreen({ navigation }: Props): React.JSX.Element {
  const state = useFacadeState(facade);
  const laps = state.laps;
  const validLaps = laps.filter((l) => l.valid);
  const bestLapMs = validLaps.length > 0 ? Math.min(...validLaps.map((l) => l.durationMs)) : null;
  const isNewPb = bestLapMs !== null && state.pbMs === bestLapMs;
  const bests = sectorBests(laps);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Session Results
        </Text>

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
          <Text style={styles.emptyText} maxFontSizeMultiplier={1.3}>
            No laps recorded.
          </Text>
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

        <Pressable
          style={[styles.button, styles.primaryButton]}
          onPress={() => navigation.navigate('SessionHistory')}
          accessibilityRole="button"
          accessibilityLabel="View session history"
        >
          <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
            Session History
          </Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.secondaryButton]}
          onPress={() => navigation.navigate('CircuitDetail')}
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
});
