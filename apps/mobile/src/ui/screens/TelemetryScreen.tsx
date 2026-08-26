import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Elm327State, TelemetryChannelId, TelemetrySample } from '@circuit/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { settingsStore, telemetryProvider } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { type TelemetryProviderDiagnostics } from '../../session/telemetryProvider';
import { formatHexByte, resolveEnetChannelSpecs } from '../../session/enetSettingsValidation';

type Props = NativeStackScreenProps<RootStackParamList, 'Telemetry'>;

type Channel = { id: TelemetryChannelId; label: string; unit: string; decimals: number };

/** The base poll-plan channels `telemetryProvider.ts` always builds every `Elm327Session` with (Telemetry addendum — channel revision). RPM stays on this monitor screen even though it left the dashboard strip -- this is not the strip. latG/longG are analysis-only (LapDetailScreen) and never shown here. */
const BASE_CHANNELS: readonly Channel[] = [
  { id: 'rpm', label: 'Engine RPM', unit: 'rpm', decimals: 0 },
  { id: 'speedKph', label: 'Vehicle speed', unit: 'km/h', decimals: 0 },
  { id: 'throttlePct', label: 'Throttle', unit: '%', decimals: 0 },
  { id: 'engineOilC', label: 'Engine oil temp', unit: '°C', decimals: 0 },
  { id: 'coolantC', label: 'Coolant temp', unit: '°C', decimals: 0 },
];

const TRANS_OIL_CHANNEL: Channel = { id: 'transOilC', label: 'Trans oil temp', unit: '°C', decimals: 0 };

/** ENET telemetry addendum: channels a `did`-mode custom channel spec could name that never appear in the ELM327 `BASE_CHANNELS`/`TRANS_OIL_CHANNEL` set above (every ENET/OBD-eligible channel except the device-sensor `latG`/`longG`, which `@circuit/core`'s `NON_ENET_CHANNELS` already refuses at the spec-validation layer). */
const ENET_EXTRA_CHANNELS: readonly Channel[] = [
  { id: 'intakeC', label: 'Intake air temp', unit: '°C', decimals: 0 },
  { id: 'engineLoadPct', label: 'Engine load', unit: '%', decimals: 0 },
];

const CHANNEL_META: ReadonlyMap<TelemetryChannelId, Channel> = new Map(
  [...BASE_CHANNELS, TRANS_OIL_CHANNEL, ...ENET_EXTRA_CHANNELS].map((channel) => [channel.id, channel]),
);

function channelMeta(id: TelemetryChannelId): Channel {
  return CHANNEL_META.get(id) ?? { id, label: id, unit: '', decimals: 0 };
}

/** `transOilC` only appears once the user has configured its custom PID -- an unconfigured channel is never polled at all (`telemetryProvider.ts`'s `buildPollPlan`), so showing its row unconditionally would just be a permanent dash. */
function channelsFor(transOilPidHex: string): readonly Channel[] {
  return transOilPidHex.trim() === '' ? BASE_CHANNELS : [...BASE_CHANNELS, TRANS_OIL_CHANNEL];
}

/**
 * ENET telemetry addendum: the channel list this monitor shows for the ENET
 * adapter. Once a session has produced diagnostics, the ACTUAL supported +
 * unsupported channel sets (`EnetDiagnostics`) are authoritative -- they
 * reflect what the real ECU answered, including anything discovered
 * UNSUPPORTED at runtime. Before that (no session run yet), falls back to the
 * configured channel specs themselves (`resolveEnetChannelSpecs`) so the
 * screen isn't empty before the first `start()`.
 */
function enetChannelsFor(
  enetChannelSpecsJson: string,
  diagnostics: TelemetryProviderDiagnostics | null,
): readonly TelemetryChannelId[] {
  if (diagnostics?.supportedChannels !== undefined || diagnostics?.unsupportedChannels !== undefined) {
    return [...(diagnostics?.supportedChannels ?? []), ...(diagnostics?.unsupportedChannels ?? [])];
  }
  return resolveEnetChannelSpecs(enetChannelSpecsJson).map((spec) => spec.channel);
}

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

function formatNrc(nrc: number): string {
  return `0x${nrc.toString(16).padStart(2, '0').toUpperCase()}`;
}

/**
 * Minimal live-values monitor for the OBD telemetry provider (Telemetry
 * addendum, Phase 4 / P4a; ENET telemetry addendum, Phase 4e). Deliberately
 * LEAN per this ticket's scope: a connection-state line, one row per channel
 * (label + last value + observed Hz, or UNSUPPORTED + NRC for an ENET channel
 * the ECU has refused), and a start/stop button -- no gauges, no charts, no
 * history (Phase 4b). For the ENET adapter, also shows the adapter type,
 * target address, ack-latency p50/p95, and frames tx/rx (`EnetDiagnostics`).
 * Talks directly to the `telemetryProvider` singleton (`session/composition.ts`);
 * this screen's start/stop button is independent of session recording
 * (composition.ts's own lifecycle wiring starts/stops the SAME provider
 * around an actual timing session) -- it exists so the adapter/simulator can
 * be checked from Settings without driving a lap.
 */
export function TelemetryScreen(_props: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const [state, setState] = React.useState<Elm327State>('idle');
  const [detail, setDetail] = React.useState<string | undefined>(undefined);
  const [lastValues, setLastValues] = React.useState<Partial<Record<TelemetryChannelId, number>>>({});
  const [diagnostics, setDiagnostics] = React.useState<TelemetryProviderDiagnostics>(() =>
    telemetryProvider.getDiagnostics(),
  );

  React.useEffect(() => {
    const unsubscribeState = telemetryProvider.onStateChange((nextState, nextDetail) => {
      setState(nextState);
      setDetail(nextDetail);
      setDiagnostics(telemetryProvider.getDiagnostics());
    });
    const unsubscribeSample = telemetryProvider.onSample((sample: TelemetrySample) => {
      setLastValues((prev) => ({ ...prev, [sample.channel]: sample.value }));
      setDiagnostics(telemetryProvider.getDiagnostics());
    });
    return () => {
      unsubscribeState();
      unsubscribeSample();
    };
  }, []);

  const running = RUNNING_STATES.has(state);
  const isEnet = settings.adapterType === 'enet';
  const channelIds = isEnet
    ? enetChannelsFor(settings.enetChannelSpecsJson, diagnostics)
    : channelsFor(settings.transOilPidHex).map((channel) => channel.id);
  const unsupportedSet = new Set(diagnostics.unsupportedChannels ?? []);

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
              <View style={styles.channelRow}>
                <Text style={styles.channelLabel} maxFontSizeMultiplier={1.3}>
                  Adapter
                </Text>
                <Text style={styles.channelValue} maxFontSizeMultiplier={1.3}>
                  {isEnet ? 'ENET (BMW)' : 'ELM327'}
                </Text>
              </View>
              {isEnet ? (
                <View style={styles.channelRow}>
                  <Text style={styles.channelLabel} maxFontSizeMultiplier={1.3}>
                    Target address
                  </Text>
                  <Text style={styles.channelValue} maxFontSizeMultiplier={1.3}>
                    0x{formatHexByte(diagnostics.enetTargetAddress ?? settings.enetTargetAddress)}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={styles.card}>
              {channelIds.map((id) => {
                const channel = channelMeta(id);
                const value = lastValues[id];
                const hz = diagnostics.observedHzByChannel[id];
                const unsupported = isEnet && unsupportedSet.has(id);
                const nrc = diagnostics.lastNrcByChannel?.[id];
                return (
                  <View key={id} style={styles.channelRow}>
                    <Text style={styles.channelLabel} maxFontSizeMultiplier={1.3}>
                      {channel.label}
                    </Text>
                    {unsupported ? (
                      <Text style={styles.channelUnsupported} maxFontSizeMultiplier={1.3}>
                        UNSUPPORTED{nrc === undefined ? '' : ` (NRC ${formatNrc(nrc)})`}
                      </Text>
                    ) : (
                      <>
                        <Text style={styles.channelValue} maxFontSizeMultiplier={1.3}>
                          {value === undefined ? '—' : `${value.toFixed(channel.decimals)} ${channel.unit}`}
                        </Text>
                        <Text style={styles.channelHz} maxFontSizeMultiplier={1.3}>
                          {hz === undefined || hz === 0 ? '— Hz' : `${hz.toFixed(1)} Hz`}
                        </Text>
                      </>
                    )}
                  </View>
                );
              })}
            </View>

            {isEnet ? (
              <View style={styles.card}>
                <View style={styles.channelRow}>
                  <Text style={styles.channelLabel} maxFontSizeMultiplier={1.3}>
                    Ack latency p50 / p95
                  </Text>
                  <Text style={styles.channelValue} maxFontSizeMultiplier={1.3}>
                    {diagnostics.ackLatencyMsP50 === undefined
                      ? '—'
                      : `${diagnostics.ackLatencyMsP50.toFixed(0)} / ${(diagnostics.ackLatencyMsP95 ?? 0).toFixed(0)} ms`}
                  </Text>
                </View>
                <View style={styles.channelRow}>
                  <Text style={styles.channelLabel} maxFontSizeMultiplier={1.3}>
                    Frames tx / rx
                  </Text>
                  <Text style={styles.channelValue} maxFontSizeMultiplier={1.3}>
                    {(diagnostics.framesTx ?? 0)} / {(diagnostics.framesRx ?? 0)}
                  </Text>
                </View>
              </View>
            ) : null}

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
  channelUnsupported: { ...typography.caption, color: colors.warning, textAlign: 'right', flexShrink: 1 },
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
