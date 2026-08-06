import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { ADVISORY_NOTICE, TRANSILVANIA_MOTOR_RING } from '../data/circuit';
import { discardRecovery, resumeRecovery, subscribeRecovery, type PendingRecovery } from '../../session/composition';

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
  const [recovery, setRecovery] = useState<PendingRecovery | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);

  useEffect(() => subscribeRecovery(setRecovery), []);

  const handleResume = async (): Promise<void> => {
    setRecoveryBusy(true);
    try {
      await resumeRecovery();
      navigation.navigate('ActiveDashboard');
    } finally {
      setRecoveryBusy(false);
    }
  };

  const handleDiscard = async (): Promise<void> => {
    setRecoveryBusy(true);
    try {
      await discardRecovery();
    } finally {
      setRecoveryBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.kicker} maxFontSizeMultiplier={1.3}>
          CIRCUIT
        </Text>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          {circuit.displayName}
        </Text>
        <Text style={styles.subtitle} maxFontSizeMultiplier={1.3}>
          {circuit.locality}, {circuit.county}, {circuit.country}
        </Text>

        {/* ADR-0003 §3 recovery: inline banner (never a modal), only rendered when a checkpoint from an incomplete session is on disk. */}
        {recovery !== null ? (
          <View style={styles.recoveryBanner} accessibilityLiveRegion="polite">
            <Text style={styles.recoveryText} maxFontSizeMultiplier={1.3}>
              Recovered an interrupted session ({recovery.lapCount} lap{recovery.lapCount === 1 ? '' : 's'}). Resume
              driving (a fresh calibration lap is required) or discard it.
            </Text>
            <View style={styles.recoveryActions}>
              <Pressable
                style={[styles.button, styles.secondaryButton, styles.recoveryButton]}
                onPress={() => void handleDiscard()}
                disabled={recoveryBusy}
                accessibilityRole="button"
                accessibilityLabel="Discard recovered session"
              >
                <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
                  Discard
                </Text>
              </Pressable>
              <Pressable
                style={[styles.button, styles.primaryButton, styles.recoveryButton]}
                onPress={() => void handleResume()}
                disabled={recoveryBusy}
                accessibilityRole="button"
                accessibilityLabel="Resume recovered session"
              >
                {recoveryBusy ? (
                  <ActivityIndicator color={colors.onAccent} />
                ) : (
                  <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
                    Resume
                  </Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : null}

        <View style={styles.metaCard}>
          <MetaRow label="Length" value={`${circuit.lengthKm.toFixed(3)} km`} />
          <MetaRow label="Layout" value={circuit.layoutId} />
          <MetaRow label="Direction" value={circuit.direction === 'clockwise' ? 'Clockwise' : 'Counter-clockwise'} />
          <MetaRow label="Opened" value={String(circuit.openedYear)} />
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

        {/* Legal relocation (compliance): ODbL attribution + advisory disclaimer condensed to one small
            muted line here; the full text lives in Settings > About (always reachable). */}
        <Text style={styles.footerText} maxFontSizeMultiplier={1.3}>
          {circuit.osmAttribution} · {ADVISORY_NOTICE}
        </Text>
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
  kicker: {
    ...typography.kicker,
    color: colors.textMuted,
    marginBottom: spacing.xs,
  },
  title: {
    ...typography.title,
    fontSize: 26,
    color: colors.textPrimary,
  },
  subtitle: {
    ...typography.body,
    color: colors.textSecondary,
  },
  recoveryBanner: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: spacing.md,
    gap: spacing.sm,
  },
  recoveryText: { ...typography.body, color: colors.textPrimary },
  recoveryActions: { flexDirection: 'row', gap: spacing.sm },
  recoveryButton: { flex: 1, marginTop: 0 },
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
    fontFamily: fontFamily.bodySemibold,
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
    color: colors.onAccent,
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
  footerText: {
    ...typography.caption,
    fontSize: 11,
    color: colors.textMuted,
    marginTop: spacing.lg,
  },
});
