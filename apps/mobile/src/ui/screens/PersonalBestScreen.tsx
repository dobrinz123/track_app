import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { TimeDisplay } from '../components/TimeDisplay';
import { QualityPill } from '../components/QualityPill';
import { formatDateUtc } from '../format';
import { sessionHistoryStore } from '../../session/composition';
import { TRANSILVANIA_MOTOR_RING } from '../data/circuit';

type Props = NativeStackScreenProps<RootStackParamList, 'PersonalBest'>;

/** S11 — personal best details with provenance (date, session), quality flags. */
export function PersonalBestScreen({ navigation }: Props): React.JSX.Element {
  const pb = sessionHistoryStore.getPersonalBest();

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Personal Best
        </Text>
        <Text style={styles.circuit} maxFontSizeMultiplier={1.3}>
          {TRANSILVANIA_MOTOR_RING.displayName} · {TRANSILVANIA_MOTOR_RING.layoutId}
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
  title: { ...typography.title, color: colors.textPrimary },
  circuit: { ...typography.body, color: colors.textSecondary },
  emptyText: { ...typography.body, color: colors.textMuted },
  timeCard: { alignItems: 'center', gap: spacing.sm, marginVertical: spacing.md },
  provenanceCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  provenanceLabel: { ...typography.label, color: colors.textMuted, letterSpacing: 0.5 },
  provenanceRow: { flexDirection: 'row', justifyContent: 'space-between' },
  provenanceKey: { ...typography.body, color: colors.textSecondary },
  provenanceValue: { ...typography.body, color: colors.textPrimary },
  provenanceValueLink: { ...typography.body, color: colors.accent, textDecorationLine: 'underline' },
});
