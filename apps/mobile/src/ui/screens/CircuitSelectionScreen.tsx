import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { ADVISORY_NOTICE, TRANSILVANIA_MOTOR_RING } from '../data/circuit';

type Props = NativeStackScreenProps<RootStackParamList, 'CircuitSelection'>;

/** S1 — single-card circuit selection. */
export function CircuitSelectionScreen({ navigation }: Props): React.JSX.Element {
  const circuit = TRANSILVANIA_MOTOR_RING;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.container}>
        <Text style={styles.heading} maxFontSizeMultiplier={1.3}>
          Circuit Timer
        </Text>

        <Pressable
          style={styles.card}
          onPress={() => navigation.navigate('CircuitDetail')}
          accessibilityRole="button"
          accessibilityLabel={`${circuit.displayName}, ${circuit.locality}, ${circuit.lengthKm} kilometers, main layout. View circuit details.`}
        >
          <Text style={styles.cardTitle} maxFontSizeMultiplier={1.3}>
            {circuit.displayName}
          </Text>
          <Text style={styles.cardSubtitle} maxFontSizeMultiplier={1.3}>
            {circuit.locality} · {circuit.country}
          </Text>
          <View style={styles.cardMetaRow}>
            <Text style={styles.cardMeta} maxFontSizeMultiplier={1.3}>
              {circuit.lengthKm.toFixed(3)} km
            </Text>
            <Text style={styles.cardMetaDot}>•</Text>
            <Text style={styles.cardMeta} maxFontSizeMultiplier={1.3}>
              Layout: {circuit.layoutId}
            </Text>
          </View>
        </Pressable>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText} maxFontSizeMultiplier={1.3}>
          {circuit.osmAttribution}
        </Text>
        <Text style={styles.advisoryText} maxFontSizeMultiplier={1.3}>
          {ADVISORY_NOTICE}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    padding: spacing.lg,
    justifyContent: 'center',
  },
  heading: {
    ...typography.title,
    color: colors.textPrimary,
    marginBottom: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  cardTitle: {
    ...typography.title,
    color: colors.textPrimary,
  },
  cardSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.xs,
  },
  cardMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  cardMeta: {
    ...typography.subtitle,
    color: colors.accent,
  },
  cardMetaDot: {
    color: colors.textMuted,
  },
  footer: {
    padding: spacing.lg,
    gap: spacing.xs,
  },
  footerText: {
    ...typography.caption,
    color: colors.textMuted,
  },
  advisoryText: {
    ...typography.caption,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
