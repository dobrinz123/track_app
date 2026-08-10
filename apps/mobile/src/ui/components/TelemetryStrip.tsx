import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Elm327State, TelemetrySample } from '@circuit/core';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { settingsStore, telemetryProvider } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import {
  isTelemetryStripVisible,
  telemetryStripCoolantTint,
  telemetryStripEngineOilTint,
  telemetryStripThirdSlot,
  telemetryStripTransOilTint,
} from '../../session/telemetryProvider';

/** Fixed height of the rendered card ITSELF (S7 dashboard) -- irrelevant to dashboard layout now (H1 fix: absolutely positioned, contributes zero normal-flow height/width to `ActiveDashboardScreen`'s `deltaZone`), still used by this component's own `styles.strip.height`. */
export const TELEMETRY_STRIP_HEIGHT = 40;

/**
 * S7 dashboard telemetry strip (Telemetry addendum — channel revision,
 * binding, SUPERSEDES the P4b amendment's original slot content): "visible
 * ONLY while telemetryEnabled AND the provider state is 'polling'; slots THR
 * | ENG OIL | TRANS OIL -- third slot falls back to COOLANT when transOilC is
 * not configured. RPM and G never on the strip." `ActiveDashboardScreen` now
 * mounts this UNCONDITIONALLY as an absolutely-positioned overlay pinned to
 * the top of `deltaZone` -- this component alone is the single source of
 * truth for whether ANYTHING telemetry-related exists in the tree at all: it
 * renders `null` (no styled card, no border/background, no accessibility
 * node -- M1 fix) whenever `isTelemetryStripVisible` is false, so a
 * connecting/failed/disabled adapter leaves ZERO trace, not even an empty
 * fixed-height placeholder. Muted/premium-dark styling, thin/untested per
 * this repo's house rule -- the visibility rule, tint thresholds, and slot
 * selection it calls into (`session/telemetryProvider.ts`) are the actual
 * unit-tested logic.
 */
export function TelemetryStrip(): React.JSX.Element | null {
  const settings = useSettings(settingsStore);
  const [providerState, setProviderState] = React.useState<Elm327State>('idle');
  const [throttlePct, setThrottlePct] = React.useState<number | null>(null);
  const [engineOilC, setEngineOilC] = React.useState<number | null>(null);
  const [transOilC, setTransOilC] = React.useState<number | null>(null);
  const [coolantC, setCoolantC] = React.useState<number | null>(null);

  React.useEffect(() => {
    // `onStateChange` replays the current state synchronously on subscribe
    // (telemetryProvider.ts's own binding semantics), so this never starts
    // stale even if telemetry was already 'polling' before this component
    // mounted.
    const unsubscribeState = telemetryProvider.onStateChange((state) => setProviderState(state));
    const unsubscribeSample = telemetryProvider.onSample((sample: TelemetrySample) => {
      if (sample.channel === 'throttlePct') setThrottlePct(sample.value);
      else if (sample.channel === 'engineOilC') setEngineOilC(sample.value);
      else if (sample.channel === 'transOilC') setTransOilC(sample.value);
      else if (sample.channel === 'coolantC') setCoolantC(sample.value);
    });
    return () => {
      unsubscribeState();
      unsubscribeSample();
    };
  }, []);

  const visible = isTelemetryStripVisible(settings.telemetryEnabled, providerState);
  const engineOilTint = telemetryStripEngineOilTint(engineOilC);
  const thirdSlot = telemetryStripThirdSlot(settings.transOilPidHex);
  const transOilTint = telemetryStripTransOilTint(transOilC);
  const coolantTint = telemetryStripCoolantTint(coolantC);
  const thirdValue = thirdSlot === 'transOil' ? transOilC : coolantC;
  const thirdTint = thirdSlot === 'transOil' ? transOilTint : coolantTint;

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
      accessibilityLabel={`Telemetry: ${
        throttlePct === null ? 'throttle unknown' : `throttle ${Math.round(throttlePct)} percent`
      }, ${engineOilC === null ? 'engine oil unknown' : `engine oil ${Math.round(engineOilC)} degrees`}, ${
        thirdSlot === 'transOil'
          ? thirdValue === null
            ? 'trans oil unknown'
            : `trans oil ${Math.round(thirdValue)} degrees`
          : thirdValue === null
            ? 'coolant unknown'
            : `coolant ${Math.round(thirdValue)} degrees`
      }`}
    >
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
          ENG OIL
        </Text>
        <Text
          style={[
            styles.value,
            engineOilTint === 'amber' && styles.valueAmber,
            engineOilTint === 'red' && styles.valueRed,
          ]}
          maxFontSizeMultiplier={1.2}
        >
          {engineOilC === null ? '—' : `${Math.round(engineOilC)}°C`}
        </Text>
      </View>
      <View style={styles.item}>
        <Text style={styles.label} maxFontSizeMultiplier={1.2}>
          {thirdSlot === 'transOil' ? 'TRANS OIL' : 'COOLANT'}
        </Text>
        <Text
          style={[styles.value, thirdTint === 'amber' && styles.valueAmber, thirdTint === 'red' && styles.valueRed]}
          maxFontSizeMultiplier={1.2}
        >
          {thirdValue === null ? '—' : `${Math.round(thirdValue)}°C`}
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
