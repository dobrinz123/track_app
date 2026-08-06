import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { TimeDisplay } from '../components/TimeDisplay';
import { QualityPill } from '../components/QualityPill';
import { sessionHistoryStore } from '../../session/composition';

type Props = NativeStackScreenProps<RootStackParamList, 'LapDetail'>;

/** S10 — single lap detail with sector breakdown and quality flags. */
export function LapDetailScreen({ route }: Props): React.JSX.Element {
  const { sessionId, lapNumber } = route.params;
  const session = sessionHistoryStore.getSession(sessionId);
  const lap = session?.laps.find((l) => l.lapNumber === lapNumber) ?? null;

  if (!session || !lap) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.container}>
          <Text style={styles.title} maxFontSizeMultiplier={1.3}>
            Lap not found.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Lap {lap.lapNumber}
        </Text>
        <View style={styles.headerRow}>
          <TimeDisplay ms={lap.durationMs} size="large" color={lap.valid ? colors.textPrimary : colors.danger} />
          <QualityPill quality={lap.quality} />
        </View>

        {!lap.valid ? (
          <View style={styles.invalidBlock} accessibilityLabel="This lap is invalid">
            <Text style={styles.invalidLabel} maxFontSizeMultiplier={1.3}>
              INVALID
            </Text>
            {lap.invalidReasons.map((r) => (
              <Text key={r} style={styles.invalidReason} maxFontSizeMultiplier={1.3}>
                {r.replace(/_/g, ' ').toLowerCase()}
              </Text>
            ))}
          </View>
        ) : null}

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          SECTOR BREAKDOWN
        </Text>
        {lap.sectorTimes.map((s) => (
          <View key={s.sectorIndex} style={styles.sectorRow}>
            <Text style={styles.sectorLabel} maxFontSizeMultiplier={1.3}>
              Sector {s.sectorIndex + 1}
            </Text>
            <View style={styles.sectorRight}>
              <TimeDisplay ms={s.durationMs} size="small" />
              <QualityPill quality={s.quality} compact />
            </View>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  invalidBlock: {
    backgroundColor: `${colors.danger}1A`,
    borderColor: colors.danger,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  invalidLabel: { ...typography.label, color: colors.danger },
  invalidReason: { ...typography.caption, color: colors.textSecondary },
  sectionLabel: { ...typography.label, color: colors.textMuted, letterSpacing: 0.5, marginTop: spacing.sm },
  sectorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  sectorLabel: { ...typography.body, color: colors.textPrimary },
  sectorRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
});
