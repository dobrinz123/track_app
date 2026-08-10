import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Elm327State, TelemetrySample } from '@circuit/core';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { settingsStore, telemetryProvider } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { isTelemetryStripVisible, telemetryStripCoolantTint } from '../../session/telemetryProvider';

/** Fixed slot height (S7 dashboard, MUST DO: "no layout thrash") -- constant regardless of whether the strip is currently showing values, mirroring `CoachStrip.COACH_STRIP_HEIGHT`. */
export const TELEMETRY_STRIP_HEIGHT = 40;

/**
 * S7 dashboard telemetry strip (Telemetry addendum — P4b amendment, binding):
 * "visible ONLY while telemetryEnabled AND the provider state is 'polling';
 * shows at most rpm, throttlePct, coolantC (coolant tinted amber >= 98 C, red
 * >= 105 C)." `ActiveDashboardScreen` reserves `TELEMETRY_STRIP_HEIGHT` of
 * space for this component only while `settings.telemetryEnabled` (mirroring
 * `CoachStrip`'s own slot pattern) -- WITHIN that reservation, this component
 * renders its three values only while the provider is actually `'polling'`,
 * so a connecting/failed adapter mid-session never reflows anything below it,
 * it just shows the same fixed-height empty strip `CoachStrip` shows for "no
 * cue". Muted/premium-dark styling, thin/untested per this repo's house rule
 * -- the visibility rule and coolant tint thresholds it calls into
 * (`isTelemetryStripVisible`/`telemetryStripCoolantTint`, `session/telemetryProvider.ts`)
 * are the actual unit-tested logic.
 */
export function TelemetryStrip(): React.JSX.Element {
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

  return (
    <View
      style={styles.strip}
      accessibilityRole="text"
      accessibilityLabel={
        visible
          ? `Telemetry: ${rpm === null ? 'RPM unknown' : `${Math.round(rpm)} RPM`}, ${
              throttlePct === null ? 'throttle unknown' : `throttle ${Math.round(throttlePct)} percent`
            }, ${coolantC === null ? 'coolant unknown' : `coolant ${Math.round(coolantC)} degrees`}`
          : 'Telemetry not connected'
      }
    >
      {visible ? (
        <>
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
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
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
