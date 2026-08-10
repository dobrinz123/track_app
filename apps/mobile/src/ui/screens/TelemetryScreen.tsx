import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Elm327State, TelemetryChannelId, TelemetrySample } from '@circuit/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { settingsStore, telemetryProvider } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';

type Props = NativeStackScreenProps<RootStackParamList, 'Telemetry'>;

/** The fixed 4-channel poll plan `telemetryProvider.ts` builds every `Elm327Session` with (Telemetry addendum). */
const CHANNELS: readonly { id: TelemetryChannelId; label: string; unit: string; decimals: number }[] = [
  { id: 'rpm', label: 'Engine RPM', unit: 'rpm', decimals: 0 },
  { id: 'speedKph', label: 'Vehicle speed', unit: 'km/h', decimals: 0 },
  { id: 'throttlePct', label: 'Throttle', unit: '%', decimals: 0 },
  { id: 'coolantC', label: 'Coolant temp', unit: '°C', decimals: 0 },
];

const STATE_LABEL: Record<Elm327State, string> = {
  idle: 'NOT CONNECTED',
  connecting: 'CONNECTING…',
  initializing: 'INITIALIZING…',
  polling: 'CONNECTED',
  stopped: 'STOPPED',
  failed: 'CONNECTION FAILED',
};

const STATE_COLOR: Record<Elm327State, string> = {
  idle: colors.textMuted,
  connecting: colors.warning,
  initializing: colors.warning,
  polling: colors.success,
  stopped: colors.textMuted,
  failed: colors.danger,
};

const RUNNING_STATES = new Set<Elm327State>(['connecting', 'initializing', 'polling']);

/**
 * Minimal live-values monitor for the OBD telemetry provider (Telemetry
 * addendum, Phase 4 / P4a). Deliberately LEAN per this ticket's scope: a
 * connection-state line, one row per channel (label + last value + observed
 * Hz), and a start/stop button -- no gauges, no charts, no history (Phase
 * 4b). Talks directly to the `telemetryProvider` singleton
 * (`session/composition.ts`); this screen's start/stop button is independent
 * of session recording (composition.ts's own lifecycle wiring starts/stops
 * the SAME provider around an actual timing session) -- it exists so the
 * adapter/simulator can be checked from Settings without driving a lap.
 */
export function TelemetryScreen(_props: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const [state, setState] = React.useState<Elm327State>('idle');
  const [detail, setDetail] = React.useState<string | undefined>(undefined);
  const [lastValues, setLastValues] = React.useState<Partial<Record<TelemetryChannelId, number>>>({});
  const [observedHz, setObservedHz] = React.useState<Record<string, number>>({});

  React.useEffect(() => {
    const unsubscribeState = telemetryProvider.onStateChange((nextState, nextDetail) => {
      setState(nextState);
      setDetail(nextDetail);
    });
    const unsubscribeSample = telemetryProvider.onSample((sample: TelemetrySample) => {
      setLastValues((prev) => ({ ...prev, [sample.channel]: sample.value }));
      setObservedHz(telemetryProvider.getDiagnostics().observedHzByChannel);
    });
    return () => {
      unsubscribeState();
      unsubscribeSample();
    };
  }, []);

  const running = RUNNING_STATES.has(state);

  function toggleConnection(): void {
    if (running) {
      void telemetryProvider.stop();
    } else {
      telemetryProvider.start();
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Telemetry monitor
        </Text>
        <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
          Advisory, experimental. Read-only OBD data -- never used for lap timing.
        </Text>

        {!settings.telemetryEnabled ? (
          <View style={styles.disabledCard}>
            <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
              Vehicle telemetry is turned off. Enable it in Settings → TELEMETRY (OBD) first.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.stateRow} accessibilityRole="text" accessibilityLabel={`Telemetry: ${STATE_LABEL[state]}`}>
              <View style={[styles.stateDot, { backgroundColor: STATE_COLOR[state] }]} />
              <Text style={[styles.stateText, { color: STATE_COLOR[state] }]} maxFontSizeMultiplier={1.3}>
                {STATE_LABEL[state]}
              </Text>
            </View>
            {detail === undefined ? null : (
              <Text style={styles.detailText} maxFontSizeMultiplier={1.3}>
                {detail}
              </Text>
            )}

            <View style={styles.card}>
              {CHANNELS.map((channel) => {
                const value = lastValues[channel.id];
                const hz = observedHz[channel.id];
                return (
                  <View key={channel.id} style={styles.channelRow}>
                    <Text style={styles.channelLabel} maxFontSizeMultiplier={1.3}>
                      {channel.label}
                    </Text>
                    <Text style={styles.channelValue} maxFontSizeMultiplier={1.3}>
                      {value === undefined ? '—' : `${value.toFixed(channel.decimals)} ${channel.unit}`}
                    </Text>
                    <Text style={styles.channelHz} maxFontSizeMultiplier={1.3}>
                      {hz === undefined || hz === 0 ? '— Hz' : `${hz.toFixed(1)} Hz`}
                    </Text>
                  </View>
                );
              })}
            </View>

            <Pressable
              style={[styles.button, running && styles.buttonStop]}
              onPress={toggleConnection}
              accessibilityRole="button"
              accessibilityLabel={running ? 'Stop telemetry' : 'Start telemetry'}
            >
              <Text style={[styles.buttonText, running && styles.buttonTextStop]} maxFontSizeMultiplier={1.3}>
                {running ? 'Stop' : 'Start'}
              </Text>
            </Pressable>
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
  helperText: { ...typography.caption, color: colors.textMuted },
  disabledCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stateDot: { width: 10, height: 10, borderRadius: 5 },
  stateText: { ...typography.label, letterSpacing: 1 },
  detailText: { ...typography.caption, color: colors.textMuted },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  channelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  channelLabel: { ...typography.body, color: colors.textSecondary, flex: 1 },
  channelValue: {
    ...typography.timeSmall,
    color: colors.textPrimary,
    minWidth: 90,
    textAlign: 'right',
  },
  channelHz: { ...typography.caption, color: colors.textMuted, minWidth: 56, textAlign: 'right' },
  button: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonStop: {
    backgroundColor: colors.surface,
    borderColor: colors.danger,
  },
  buttonText: { ...typography.subtitle, color: colors.onAccent },
  buttonTextStop: { color: colors.danger },
});
