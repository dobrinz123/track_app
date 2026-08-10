import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { TelemetryChannelId } from '@circuit/core';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { TimeDisplay } from '../components/TimeDisplay';
import { QualityPill } from '../components/QualityPill';
import { sessionHistoryStore, getTelemetryReadDb } from '../../session/composition';
import {
  loadLapTelemetry,
  bucketTelemetry,
  TELEMETRY_CHART_CHANNELS,
  type TelemetrySampleRow,
} from '../../persistence/telemetryRead';

type Props = NativeStackScreenProps<RootStackParamList, 'LapDetail'>;

/**
 * Telemetry addendum — channel revision (2026-08-11, binding): the channels a
 * lap's TELEMETRY section may chart, in display order -- the id/order itself
 * is `telemetryRead.ts`'s exported `TELEMETRY_CHART_CHANNELS` (F5 fix,
 * binding: a pure module `apps/mobile/test/persistence/lapDetailChartChannels.test.ts`
 * imports directly, no copied mirror). Charts render only for whichever of
 * these are actually present in `readLapTelemetry`'s rows for this lap -- a
 * channel with zero samples never shows an empty chart (so `latG`/`longG`
 * simply don't appear for a session recorded without motion data, and
 * `transOilC` simply doesn't appear unless it was configured). Display
 * label/unit/color stay HERE (theme-dependent, UI-only) -- only the id/order
 * moved, since `telemetryRead.ts` (unlike this file) must stay
 * `react-native`-free to remain directly importable by vitest.
 */
const TELEMETRY_CHART_DISPLAY: Readonly<Record<TelemetryChannelId, { label: string; unit: string; color: string }>> =
  {
    speedKph: { label: 'Speed', unit: 'km/h', color: colors.accent },
    rpm: { label: 'RPM', unit: 'rpm', color: colors.textSecondary },
    throttlePct: { label: 'Throttle', unit: '%', color: colors.textMuted },
    latG: { label: 'Lateral G', unit: 'g', color: colors.accent },
    longG: { label: 'Longitudinal G', unit: 'g', color: colors.textSecondary },
    engineOilC: { label: 'Engine oil', unit: '°C', color: colors.warning },
    transOilC: { label: 'Trans oil', unit: '°C', color: colors.danger },
    // Non-chartable channels (never appear in `TELEMETRY_CHART_CHANNELS`, kept only so this Record's type stays exhaustive over the full `TelemetryChannelId` union).
    coolantC: { label: 'Coolant', unit: '°C', color: colors.textMuted },
    intakeC: { label: 'Intake air', unit: '°C', color: colors.textMuted },
    engineLoadPct: { label: 'Engine load', unit: '%', color: colors.textMuted },
  };

/** Thin-bar sparkline for one channel's bucketed lap telemetry. Pure View/Text -- no svg, no new deps (ticket constraint). */
function TelemetrySparkline({
  label,
  unit,
  color,
  buckets,
  min,
  max,
}: {
  label: string;
  unit: string;
  color: string;
  buckets: Array<number | null>;
  min: number | null;
  max: number | null;
}): React.JSX.Element {
  const range = min !== null && max !== null && max > min ? max - min : 1;
  return (
    <View style={styles.sparklineBlock}>
      <View style={styles.sparklineHeaderRow}>
        <Text style={styles.sparklineLabel} maxFontSizeMultiplier={1.3}>
          {label}
        </Text>
        <Text style={styles.sparklineMinMax} maxFontSizeMultiplier={1.3}>
          {min === null || max === null ? '—' : `${formatChannelValue(min)}–${formatChannelValue(max)} ${unit}`}
        </Text>
      </View>
      <View style={styles.barRow}>
        {buckets.map((value, index) => {
          const heightPct = value === null ? 0 : min === null ? 0 : ((value - min) / range) * 100;
          return (
            <View key={index} style={styles.barSlot}>
              {value === null ? null : (
                <View
                  style={[
                    styles.bar,
                    { backgroundColor: color, height: `${Math.max(heightPct, 4)}%` },
                  ]}
                />
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function formatChannelValue(value: number): string {
  return Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1);
}

/** S10 — single lap detail with sector breakdown and quality flags. */
export function LapDetailScreen({ route }: Props): React.JSX.Element {
  const { sessionId, lapNumber } = route.params;
  const session = sessionHistoryStore.getSession(sessionId);
  const lap = session?.laps.find((l) => l.lapNumber === lapNumber) ?? null;

  // Telemetry addendum — P4b amendment (binding): `null` = read not resolved
  // yet ("Loading state: render nothing until the read resolves (no
  // spinner)" -- no `if (!session || !lap) return` short-circuit may sit
  // above this hook, so it stays unconditional on every render). Hooks run
  // before the not-found early return below so their order never depends on
  // whether this sessionId/lapNumber resolves to a real lap.
  const [telemetryRows, setTelemetryRows] = React.useState<TelemetrySampleRow[] | null>(null);

  // M3 fix: `loadLapTelemetry` (persistence/telemetryRead.ts) owns the
  // rejection handling -- a failed SQLite read is warned once and resolved
  // to `[]` (this screen's own "zero rows" branch already hides the
  // TELEMETRY section for that) instead of leaving `telemetryRows` stuck at
  // `null` forever with an unhandled rejection. No retry, no spinner, per
  // the binding "loading state" rule above.
  React.useEffect(() => {
    let cancelled = false;
    setTelemetryRows(null);
    const db = getTelemetryReadDb();
    if (db === null) {
      setTelemetryRows([]);
      return () => {
        cancelled = true;
      };
    }
    void loadLapTelemetry(db, sessionId, lapNumber, () => cancelled).then((rows) => {
      if (rows !== undefined) setTelemetryRows(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, lapNumber]);

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

        {telemetryRows === null || telemetryRows.length === 0 ? null : (
          <>
            <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
              TELEMETRY
            </Text>
            {TELEMETRY_CHART_CHANNELS.filter((id) => telemetryRows.some((r) => r.channel === id)).map((id) => {
              const { buckets, min, max } = bucketTelemetry(telemetryRows, id);
              const display = TELEMETRY_CHART_DISPLAY[id];
              return (
                <TelemetrySparkline
                  key={id}
                  label={display.label}
                  unit={display.unit}
                  color={display.color}
                  buckets={buckets}
                  min={min}
                  max={max}
                />
              );
            })}
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
  sectionLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.sm },
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
  sparklineBlock: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: spacing.xs,
  },
  sparklineHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sparklineLabel: { ...typography.body, color: colors.textPrimary },
  sparklineMinMax: { ...typography.caption, color: colors.textMuted },
  barRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 40,
    gap: 1,
  },
  barSlot: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  bar: { width: '100%', borderTopLeftRadius: 1, borderTopRightRadius: 1 },
});
