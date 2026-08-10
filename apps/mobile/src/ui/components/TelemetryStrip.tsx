import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Elm327State, TelemetrySample } from '@circuit/core';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { settingsStore, telemetryProvider } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { isTelemetryStripVisible, telemetryStripCoolantTint } from '../../session/telemetryProvider';

/** Fixed height of the rendered card ITSELF (S7 dashboard) -- irrelevant to dashboard layout now (H1 fix: absolutely positioned, contributes zero normal-flow height/width to `ActiveDashboardScreen`'s `deltaZone`), still used by this component's own `styles.strip.height`. */
export const TELEMETRY_STRIP_HEIGHT = 40;

/**
 * S7 dashboard telemetry strip (Telemetry addendum — P4b amendment, binding,
 * H1/M1 fix -- SUPERSEDES the original "fixed slot" design): "visible ONLY
 * while telemetryEnabled AND the provider state is 'polling'; shows at most
 * rpm, throttlePct, coolantC (coolant tinted amber >= 98 C, red >= 105 C)."
 * `ActiveDashboardScreen` now mounts this UNCONDITIONALLY as an
 * absolutely-positioned overlay pinned to the top of `deltaZone` -- this
 * component alone is the single source of truth for whether ANYTHING
 * telemetry-related exists in the tree at all: it renders `null` (no styled
 * card, no border/background, no accessibility node -- M1 fix) whenever
 * `isTelemetryStripVisible` is false, so a connecting/failed/disabled adapter
 * leaves ZERO trace, not even an empty fixed-height placeholder. Muted/
 * premium-dark styling, thin/untested per this repo's house rule -- the
 * visibility rule and coolant tint thresholds it calls into
 * (`isTelemetryStripVisible`/`telemetryStripCoolantTint`, `session/telemetryProvider.ts`)
 * are the actual unit-tested logic.
 */
export function TelemetryStrip(): React.JSX.Element | null {
  const settings = useSettings(settingsStore);
  const [providerState, setProviderState] = React.useState<Elm327State>('idle');
  const [rpm, setRpm] = React.useState<number | null>(null);
  const [throttlePct, setThrottlePct] = React.useState<number | null>(null);
  const [coolantC, setCoolantC] = React.useState<number | null>(null);

  React.useEffect(() => {
    // `onStateChange` replays the current state synchronously on subscribe
    // (telemetryProvider.ts's own binding semantics), so this never starts
    // stale even if telemetry was already 'polling' before this component
    // mounted.
    const unsubscribeState = telemetryProvider.onStateChange((state) => setProviderState(state));
    const unsubscribeSample = telemetryProvider.onSample((sample: TelemetrySample) => {
      if (sample.channel === 'rpm') setRpm(sample.value);
      else if (sample.channel === 'throttlePct') setThrottlePct(sample.value);
      else if (sample.channel === 'coolantC') setCoolantC(sample.value);
    });
    return () => {
      unsubscribeState();
      unsubscribeSample();
    };
  }, []);

  const visible = isTelemetryStripVisible(settings.telemetryEnabled, providerState);
  const tint = telemetryStripCoolantTint(coolantC);

  // M1 fix (binding: visible ONLY while enabled AND polling): no styled
  // card, no border/background, no accessibility node at all when not
  // visible -- hooks above still ran unconditionally (rules of hooks), but
  // nothing about a disabled/connecting/failed adapter is observable in the
  // tree. Combined with H1's absolute positioning in `ActiveDashboardScreen`,
  // this is the ONLY gate: there is no outer reservation left to hide inside.
  if (!visible) return null;

  return (
    <View
      style={styles.strip}
      accessibilityRole="text"
      accessibilityLabel={`Telemetry: ${rpm === null ? 'RPM unknown' : `${Math.round(rpm)} RPM`}, ${
        throttlePct === null ? 'throttle unknown' : `throttle ${Math.round(throttlePct)} percent`
      }, ${coolantC === null ? 'coolant unknown' : `coolant ${Math.round(coolantC)} degrees`}`}
    >
      <View style={styles.item}>
        <Text style={styles.label} maxFontSizeMultiplier={1.2}>
          RPM
        </Text>
        <Text style={styles.value} maxFontSizeMultiplier={1.2}>
          {rpm === null ? '—' : Math.round(rpm)}
        </Text>
      </View>
      <View style={styles.item}>
        <Text style={styles.label} maxFontSizeMultiplier={1.2}>
          THR
        </Text>
        <Text style={styles.value} maxFontSizeMultiplier={1.2}>
          {throttlePct === null ? '—' : `${Math.round(throttlePct)}%`}
        </Text>
      </View>
      <View style={styles.item}>
        <Text style={styles.label} maxFontSizeMultiplier={1.2}>
          COOLANT
        </Text>
        <Text
          style={[styles.value, tint === 'amber' && styles.valueAmber, tint === 'red' && styles.valueRed]}
          maxFontSizeMultiplier={1.2}
        >
          {coolantC === null ? '—' : `${Math.round(coolantC)}°C`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    // H1 fix (binding, SUPERSEDES the original "fixed slot" design): out of
    // flow entirely -- pinned to the top of `ActiveDashboardScreen`'s
    // `deltaZone` (its nearest positioned ancestor; React Native Views
    // default to `position: 'relative'`), spanning its full width. Zero
    // normal-flow height/gap contribution, so it can never reflow or occlude
    // `DeltaDisplay`'s own centering or any timing element below it.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: TELEMETRY_STRIP_HEIGHT,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
  },
  item: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.xs },
  label: { ...typography.label, color: colors.textMuted, letterSpacing: 1 },
  value: { ...typography.timeSmall, color: colors.textPrimary, fontFamily: fontFamily.monoSemibold },
  valueAmber: { color: colors.warning },
  valueRed: { color: colors.danger },
});
