import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  LOCATION_PERMISSION_RATIONALE,
  PRECISE_LOCATION_INSTRUCTIONS,
  requestForegroundLocationPermission,
  runPreflightChecks,
  type PreflightReport,
} from '../../platform';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { StatusBanner } from '../components/StatusBanner';
import { facade } from '../../session/composition';

type Props = NativeStackScreenProps<RootStackParamList, 'Preflight'>;

interface CheckRow {
  label: string;
  pass: boolean;
  detail?: string;
}

function reportToRows(report: PreflightReport): CheckRow[] {
  return [
    { label: 'Location services enabled', pass: report.locationServicesEnabled },
    { label: 'Location permission granted', pass: report.permissionGranted },
    // Only meaningful once permission is granted -- see preflight.ts's
    // evaluatePreflight (reduced-accuracy is a sub-state of a granted
    // permission, not a substitute failure for it).
    ...(report.permissionGranted
      ? [{ label: 'Precise Location on', pass: !report.reducedAccuracy }]
      : []),
    {
      label: 'GNSS fix acquired',
      pass: report.gnssFix.acquired,
      detail: report.gnssFix.accuracyM !== null ? `±${report.gnssFix.accuracyM.toFixed(0)} m` : undefined,
    },
    {
      label: 'Battery sufficient',
      pass: !report.battery.available || !report.battery.criticallyLow,
      detail: report.battery.available ? undefined : 'not reported on this device',
    },
    { label: 'Screen keep-awake available', pass: report.keepAwakeActivatable },
  ];
}

/** Machine-readable failure codes (`preflight.ts`'s `evaluatePreflight`) mapped to plain-language copy. */
const FAILURE_COPY: Record<string, string> = {
  LOCATION_SERVICES_DISABLED: 'Turn on Location Services for this device in system settings.',
  LOCATION_PERMISSION_NOT_GRANTED: 'Grant Circuit Timer permission to use your location.',
  PRECISE_LOCATION_OFF: PRECISE_LOCATION_INSTRUCTIONS,
  GNSS_FIX_TIMEOUT: 'Could not get an accurate GPS fix. Move outdoors, away from tall buildings, and retry.',
  BATTERY_CRITICALLY_LOW: 'Battery is critically low. Charge the device before starting a session.',
  KEEP_AWAKE_UNAVAILABLE: 'This device cannot keep the screen awake during a session.',
};

function explainFailure(reason: string): string {
  return FAILURE_COPY[reason] ?? reason.replace(/_/g, ' ').toLowerCase();
}

/** S3 — runs platform preflight collectors, shows pass/fail per check, retry; on pass → S4. */
export function PreflightScreen({ navigation }: Props): React.JSX.Element {
  const [status, setStatus] = useState<'running' | 'done'>('running');
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [runToken, setRunToken] = useState(0);

  useEffect(() => {
    facade.startPreflight();
  }, []);

  useEffect(() => {
    let cancelled = false;
    // C11 fix: cancels the in-flight GNSS-fix collector's native location
    // subscription on unmount/retry -- `cancelled` alone only suppressed the
    // resulting React state update, it never stopped the native watcher
    // underneath (see `preflight.ts`'s `collectGnssFix`).
    const abortController = new AbortController();
    setStatus('running');
    setReport(null);

    (async () => {
      await requestForegroundLocationPermission();
      const result = await runPreflightChecks(abortController.signal);
      if (!cancelled) {
        setReport(result);
        setStatus('done');
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [runToken]);

  const retry = useCallback(() => setRunToken((n) => n + 1), []);
  const rows = report ? reportToRows(report) : [];

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Preflight Checks
        </Text>
        <Text style={styles.rationale} maxFontSizeMultiplier={1.3}>
          {LOCATION_PERMISSION_RATIONALE}
        </Text>

        {status === 'running' ? (
          <View style={styles.runningRow} accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.runningText} maxFontSizeMultiplier={1.3}>
              Running checks… GNSS fix can take up to 30 seconds outdoors.
            </Text>
          </View>
        ) : null}

        <View style={styles.list}>
          {rows.map((row, index) => (
            <View
              key={row.label}
              style={[styles.row, index > 0 && styles.rowBorder]}
              accessibilityLabel={`${row.label}: ${row.pass ? 'passed' : 'failed'}${row.detail ? `, ${row.detail}` : ''}`}
            >
              <Text style={styles.rowLabel} maxFontSizeMultiplier={1.3}>
                {row.label}
              </Text>
              <View style={styles.rowRight}>
                {row.detail ? (
                  <Text style={styles.rowDetail} maxFontSizeMultiplier={1.3}>
                    {row.detail}
                  </Text>
                ) : null}
                <Text
                  style={[styles.rowBadge, { color: row.pass ? colors.success : colors.danger }]}
                  maxFontSizeMultiplier={1.3}
                >
                  {row.pass ? 'PASS' : 'FAIL'}
                </Text>
              </View>
            </View>
          ))}
        </View>

        {report && !report.pass ? (
          <View style={styles.failuresCard}>
            {report.failures.map((reason) => (
              <Text key={reason} style={styles.failureText} maxFontSizeMultiplier={1.3}>
                • {explainFailure(reason)}
              </Text>
            ))}
          </View>
        ) : null}
        {report && report.pass ? <StatusBanner variant="success" message="All checks passed." /> : null}

        <Pressable
          style={[styles.button, styles.secondaryButton]}
          onPress={retry}
          disabled={status === 'running'}
          accessibilityRole="button"
          accessibilityLabel="Retry preflight checks"
        >
          <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
            Retry
          </Text>
        </Pressable>

        {report?.pass ? (
          <Pressable
            style={[styles.button, styles.primaryButton]}
            onPress={() => navigation.navigate('CalibrationInstructions')}
            accessibilityRole="button"
            accessibilityLabel="Continue to calibration"
          >
            <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
              Continue
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  rationale: { ...typography.caption, color: colors.textSecondary },
  runningRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  runningText: { ...typography.caption, color: colors.textSecondary, flexShrink: 1 },
  list: {
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowLabel: { ...typography.body, color: colors.textPrimary, flexShrink: 1 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  rowDetail: { ...typography.caption, color: colors.textMuted },
  rowBadge: { ...typography.label },
  failuresCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    padding: spacing.md,
    gap: spacing.xs,
  },
  failureText: { ...typography.body, color: colors.textSecondary },
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: colors.onAccent },
  secondaryButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { ...typography.subtitle, color: colors.textPrimary },
});
