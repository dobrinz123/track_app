import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { ADVISORY_NOTICE, circuitDisplayData, layoutLabel, statusLabel } from '../data/circuit';
import { StatusBanner } from '../components/StatusBanner';
import { CornersList } from '../components/CornersList';
import { circuitCatalog } from '../../session/circuitCatalog';
import { TMR_CIRCUIT_PROFILE } from '../../session/tmrProfile';
import {
  discardRecovery,
  resumeRecovery,
  retryBootstrap,
  subscribeBootstrapState,
  subscribeRecovery,
  subscribeRecoveryNotice,
  type BootstrapState,
  type PendingRecovery,
} from '../../session/composition';

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

/** S2 — circuit metadata + provenance + entry points to session/history/settings. Renders the circuit named by `route.params.circuitId` (ticket CN-W3) via the bundled catalog -- never a per-circuit hardcoded constant. */
export function CircuitDetailScreen({ navigation, route }: Props): React.JSX.Element {
  // Defensive fallback to TMR only: `route.params.circuitId` always names a
  // bundled circuit in real navigation (CircuitSelectionScreen only ever
  // passes a real catalog row's own id), matching `resolveSelectedCircuit`'s
  // own "unknown id -> TMR" contract elsewhere.
  const entry = circuitCatalog.get(route.params.circuitId) ?? circuitCatalog.get(TMR_CIRCUIT_PROFILE.circuitId)!;
  const circuit = circuitDisplayData(entry.profile);
  const [recovery, setRecovery] = useState<PendingRecovery | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  // C2 fix: "Start Session" stays disabled (with an inline note, or an error
  // banner on failure) until composition.ts's async bootstrap actually
  // finishes -- previously nothing gated it, so starting a session during a
  // slow/failed bootstrap could drive a live scripted mock with no
  // persistence and no visible error.
  const [bootstrapState, setBootstrapState] = useState<BootstrapState>('pending');
  const [retryBusy, setRetryBusy] = useState(false);
  // F5 fix: a lastError-style notice for a recovery that turned out to be
  // unresumable (its checkpoint vanished between bootstrap's read and the
  // resume attempt) -- distinct from the `recovery` banner above, which only
  // ever reflects a checkpoint bootstrap can currently see.
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);

  useEffect(() => subscribeRecovery(setRecovery), []);
  useEffect(() => subscribeBootstrapState(setBootstrapState), []);
  useEffect(() => subscribeRecoveryNotice(setRecoveryNotice), []);

  // F3 fix: retries the async bootstrap sequence from a clean slate without
  // requiring a full app restart -- `retryBootstrap()` itself flips
  // `bootstrapState` back to 'pending' for the duration of the attempt.
  const handleRetryBootstrap = async (): Promise<void> => {
    setRetryBusy(true);
    try {
      await retryBootstrap();
    } catch {
      // `bootstrapState` already reflects 'failed' via its own subscription;
      // nothing further to do here.
    } finally {
      setRetryBusy(false);
    }
  };

  // N1 fix (ticket CN-FIX3): the recovery carries its own circuit, so the
  // banner can name it. Falls back to the raw id only if a catalog build ever
  // dropped that circuit (bootstrap already refuses to offer a recovery for
  // an unbundled circuit, so this is defensive).
  const recoveryCircuitName =
    recovery === null ? '' : (circuitCatalog.get(recovery.circuitId)?.profile.displayName ?? recovery.circuitId);

  const handleResume = async (): Promise<void> => {
    setRecoveryBusy(true);
    try {
      // F5 nav fix: navigate only when a session actually resumed -- a
      // vanished-checkpoint abort resolves false and shows its own notice.
      const resumed = await resumeRecovery();
      if (resumed) navigation.navigate('ActiveDashboard');
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
          {circuit.locality}
          {circuit.extras.county !== undefined ? `, ${circuit.extras.county}` : ''}, {circuit.country}
        </Text>

        {/* Bootstrap failure (C2 fix): inline banner (never a modal) -- Start Session stays disabled below regardless. F3 fix: gains an inline Retry button (retryBootstrap()) so a transient failure doesn't require a full app restart. */}
        {bootstrapState === 'failed' ? (
          <View style={styles.recoveryBanner} accessibilityLiveRegion="polite">
            <Text style={styles.recoveryText} maxFontSizeMultiplier={1.3}>
              Couldn't prepare local session storage.
            </Text>
            <Pressable
              style={[styles.button, styles.primaryButton, styles.recoveryButton]}
              onPress={() => void handleRetryBootstrap()}
              disabled={retryBusy}
              accessibilityRole="button"
              accessibilityLabel="Retry preparing session storage"
            >
              {retryBusy ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
                  Retry
                </Text>
              )}
            </Pressable>
          </View>
        ) : null}

        {/* F5 fix: a recovery that turned out to be unresumable (its checkpoint vanished on disk). */}
        {recoveryNotice !== null ? <StatusBanner variant="error" message={recoveryNotice} /> : null}

        {/* ADR-0003 §3 recovery: inline banner (never a modal), only rendered when a checkpoint from an incomplete session is on disk. */}
        {recovery !== null ? (
          <View style={styles.recoveryBanner} accessibilityLiveRegion="polite">
            <Text style={styles.recoveryText} maxFontSizeMultiplier={1.3}>
              {/* C10 fix: resume does NOT require a fresh calibration -- it arms
                  directly off the stored reference lap (SessionController.start('session')).
                  N1 fix (ticket CN-FIX3, binding): the banner NAMES the circuit the
                  interrupted session actually ran on -- it is global (it shows on
                  every circuit's detail screen), and Resume always continues on that
                  circuit, not on whatever is selected right now. */}
              Recovered an interrupted session on {recoveryCircuitName} ({recovery.lapCount} lap
              {recovery.lapCount === 1 ? '' : 's'}). Resume continues it on {recoveryCircuitName}; lap{' '}
              {recovery.lapCount} was invalidated. Or discard it.
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
          {/* ticket CN-FIX3b: the friendly label -- the raw `layoutId` stays
              the storage/catalog key everywhere else (see `layoutLabel()`). */}
          <MetaRow label="Layout" value={layoutLabel(circuit.layoutId)} />
          <MetaRow label="Direction" value={circuit.direction === 'clockwise' ? 'Clockwise' : 'Counter-clockwise'} />
          {/* L2 fix (ticket CN-FIX2, binding): renders the raw status via the
              neutral `statusLabel()` helper -- never a bespoke "Official"
              label (contracts.md: no render branch may ever display
              "Official" as a status). */}
          <MetaRow label="Geometry" value={statusLabel(circuit.geometryStatus)} />
          <MetaRow label="Sectors" value={statusLabel(circuit.sectorStatus)} />
          {circuit.extras.openedYear !== undefined ? (
            <MetaRow label="Opened" value={String(circuit.extras.openedYear)} />
          ) : null}
        </View>

        <Text style={styles.sectionKicker} maxFontSizeMultiplier={1.3}>
          CORNERS
        </Text>
        <CornersList corners={entry.corners} />

        <Pressable
          style={[styles.button, styles.primaryButton, bootstrapState !== 'ready' && styles.buttonDisabled]}
          onPress={() => navigation.navigate('Preflight')}
          disabled={bootstrapState !== 'ready'}
          accessibilityRole="button"
          accessibilityLabel="Start session"
          accessibilityState={{ disabled: bootstrapState !== 'ready' }}
        >
          <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
            Start Session
          </Text>
        </Pressable>
        {bootstrapState === 'pending' ? (
          <Text style={styles.footerText} maxFontSizeMultiplier={1.3}>
            Preparing session data…
          </Text>
        ) : null}

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

        {/* Provenance (ticket CN-W3): built from the profile's own `source` +
            first `confidenceNotes` sentence -- never claims "official". */}
        <Text style={styles.footerText} maxFontSizeMultiplier={1.3}>
          {circuit.provenanceText}
        </Text>

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
  sectionKicker: {
    ...typography.kicker,
    color: colors.textMuted,
    marginTop: spacing.sm,
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
  buttonDisabled: {
    opacity: 0.5,
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
