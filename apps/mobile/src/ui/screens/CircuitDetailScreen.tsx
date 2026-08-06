import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { ADVISORY_NOTICE, TRANSILVANIA_MOTOR_RING } from '../data/circuit';

type Props = NativeStackScreenProps<RootStackParamList, 'CircuitDetail'>;

function MetaRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
      <Text style={styles.metaValue} maxFontSizeMultiplier={1.3}>
        {value}
      </Text>
    </View>
  );
}

/** S2 — circuit metadata + provenance + entry points to session/history/settings. */
export function CircuitDetailScreen({ navigation }: Props): React.JSX.Element {
  const circuit = TRANSILVANIA_MOTOR_RING;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          {circuit.displayName}
        </Text>
        <Text style={styles.subtitle} maxFontSizeMultiplier={1.3}>
          {circuit.locality}, {circuit.county}, {circuit.country}
        </Text>

        <View style={styles.metaCard}>
          <MetaRow label="Length" value={`${circuit.lengthKm.toFixed(3)} km`} />
          <MetaRow label="Layout" value={circuit.layoutId} />
          <MetaRow label="Direction" value={circuit.direction === 'clockwise' ? 'Clockwise' : 'Counter-clockwise'} />
          <MetaRow label="Opened" value={String(circuit.openedYear)} />
        </View>

        <View style={styles.provenanceCard}>
          <Text style={styles.provenanceLabel} maxFontSizeMultiplier={1.3}>
            GEOMETRY PROVENANCE
          </Text>
          <Text style={styles.provenanceText} maxFontSizeMultiplier={1.3}>
            {circuit.geometryProvenance}
          </Text>
        </View>

        <Pressable
          style={[styles.button, styles.primaryButton]}
          onPress={() => navigation.navigate('Preflight')}
          accessibilityRole="button"
          accessibilityLabel="Start session"
        >
          <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
            Start Session
          </Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.secondaryButton]}
          onPress={() => navigation.navigate('SessionHistory')}
          accessibilityRole="button"
          accessibilityLabel="Session history"
        >
          <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
            Session History
          </Text>
        </Pressable>

        <Pressable
          style={[styles.button, styles.secondaryButton]}
          onPress={() => navigation.navigate('Settings')}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
            Settings
          </Text>
        </Pressable>

        <View style={styles.footer}>
          <Text style={styles.footerText} maxFontSizeMultiplier={1.3}>
            {circuit.osmAttribution}
          </Text>
          <Text style={styles.advisoryText} maxFontSizeMultiplier={1.3}>
            {ADVISORY_NOTICE}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: {
    ...typography.title,
    color: colors.textPrimary,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
  },
  metaCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  metaLabel: {
    ...typography.body,
    color: colors.textSecondary,
  },
  metaValue: {
    ...typography.body,
    color: colors.textPrimary,
    fontWeight: '600',
  },
  provenanceCard: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  provenanceLabel: {
    ...typography.label,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  provenanceText: {
    ...typography.caption,
    color: colors.textSecondary,
    lineHeight: 18,
  },
  button: {
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  primaryButton: {
    backgroundColor: colors.accent,
  },
  primaryButtonText: {
    ...typography.subtitle,
    color: '#06101F',
  },
  secondaryButton: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  secondaryButtonText: {
    ...typography.subtitle,
    color: colors.textPrimary,
  },
  footer: {
    marginTop: spacing.lg,
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
