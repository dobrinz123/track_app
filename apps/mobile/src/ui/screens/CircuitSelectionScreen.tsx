import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { APP_NAME } from '../branding';
import { TraceLogo } from '../components/TraceLogo';
import { circuitCatalog, type CircuitSummary } from '../../session/circuitCatalog';

type Props = NativeStackScreenProps<RootStackParamList, 'CircuitSelection'>;

/**
 * S1 -- multi-circuit-ready selection list, driven by `AppCircuitCatalog`.
 * Only one row exists today (Transilvania Motor Ring), but the screen is
 * built as an N-row list from day one so a future catalog entry needs no
 * layout change. ODbL attribution and the recreational-timing-aid
 * disclaimer live on S2 (Circuit Detail) and Settings > About now, not here.
 */
export function CircuitSelectionScreen({ navigation }: Props): React.JSX.Element {
  const circuits = circuitCatalog.list();

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.brandRow}>
          <TraceLogo size={44} />
          <View style={styles.brandText}>
            <Text style={styles.kicker} maxFontSizeMultiplier={1.3}>
              CIRCUITS
            </Text>
            <Text style={styles.heading} maxFontSizeMultiplier={1.3}>
              {APP_NAME}
            </Text>
          </View>
        </View>

        <View style={styles.list}>
          {circuits.map((circuit, index) => (
            <CircuitRow
              key={circuit.circuitId}
              circuit={circuit}
              bordered={index > 0}
              onPress={() => navigation.navigate('CircuitDetail')}
            />
          ))}
          <View style={[styles.moreRow, circuits.length > 0 && styles.rowBorder]}>
            <Text style={styles.moreText} maxFontSizeMultiplier={1.3}>
              More circuits coming
            </Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function CircuitRow({
  circuit,
  bordered,
  onPress,
}: {
  circuit: CircuitSummary;
  bordered: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const lengthKm = (circuit.lengthM / 1000).toFixed(3);
  return (
    <Pressable
      style={[styles.row, bordered && styles.rowBorder]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${circuit.displayName}, ${circuit.locality}, ${circuit.country}, ${lengthKm} kilometers, ${circuit.layoutId} layout. View circuit details.`}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} maxFontSizeMultiplier={1.3}>
          {circuit.displayName}
        </Text>
        <Text style={styles.rowSubtitle} maxFontSizeMultiplier={1.3}>
          {circuit.locality} · {circuit.country}
        </Text>
        <View style={styles.rowMetaRow}>
          <Text style={styles.rowMeta} maxFontSizeMultiplier={1.3}>
            {lengthKm} km
          </Text>
          <View style={styles.layoutChip}>
            <Text style={styles.layoutChipText} maxFontSizeMultiplier={1.3}>
              {circuit.layoutId}
            </Text>
          </View>
        </View>
      </View>
      <Text style={styles.chevron} maxFontSizeMultiplier={1.3} accessibilityElementsHidden importantForAccessibility="no">
        ›
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    padding: spacing.lg,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  brandText: {
    flex: 1,
  },
  kicker: {
    ...typography.kicker,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  heading: {
    ...typography.title,
    color: colors.textPrimary,
  },
  list: {
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowMain: {
    flex: 1,
  },
  rowTitle: {
    fontFamily: fontFamily.displaySemibold,
    fontSize: 19,
    color: colors.textPrimary,
  },
  rowSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.xs / 2,
  },
  rowMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  rowMeta: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  layoutChip: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  layoutChipText: {
    ...typography.label,
    fontSize: 10,
    color: colors.accent,
  },
  chevron: {
    fontSize: 22,
    color: colors.textMuted,
  },
  moreRow: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  moreText: {
    ...typography.caption,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
