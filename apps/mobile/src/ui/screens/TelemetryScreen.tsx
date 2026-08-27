import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Elm327State, TelemetryChannelId, TelemetrySample } from '@circuit/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { gForceProvider, settingsStore, telemetryProvider } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { summarizeGForceSamples, type TelemetryProviderDiagnostics } from '../../session/telemetryProvider';
import { formatHexByte, resolveEnetChannelSpecs } from '../../session/enetSettingsValidation';
import { getNetworkInfo, type NetworkInfo } from '../../session/networkInfo';

type Props = NativeStackScreenProps<RootStackParamList, 'Telemetry'>;

type Channel = { id: TelemetryChannelId; label: string; unit: string; decimals: number };

/**
 * The base poll-plan channels `telemetryProvider.ts` always builds every
 * `Elm327Session` with (Telemetry addendum — channel revision), extended by
 * the field revision (2026-08-27, binding): `throttlePct` (PID 0x11) is the
 * throttle PLATE -- the driveway test found it idles at ~14-15% with no
 * pedal input, relabeled "Throttle plate" to avoid reading as pedal
 * position; `accelPedalPct` (PID 0x49) is the new, user-facing "how far is
 * my foot down" channel, labeled "Accelerator pedal". RPM stays on this
 * monitor screen even though it left the dashboard strip -- this is not the
 * strip. latG/longG are NOT in this list -- they are shown separately below
 * (only while the G provider is actually running), never on the driving
 * dashboard.
 */
const BASE_CHANNELS: readonly Channel[] = [
  { id: 'rpm', label: 'Engine RPM', unit: 'rpm', decimals: 0 },
  { id: 'speedKph', label: 'Vehicle speed', unit: 'km/h', decimals: 0 },
  { id: 'throttlePct', label: 'Throttle plate', unit: '%', decimals: 0 },
  { id: 'accelPedalPct', label: 'Accelerator pedal', unit: '%', decimals: 0 },
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
  // ENET auto-discovery addendum (binding): "the app reads its own
  // IPv4/subnet ... and shows it on the telemetry screen". Read once on
  // mount -- `getNetworkInfo()` never throws (web preview / no native module
  // both resolve `null`), so `phoneInfo` simply stays `null` in those cases
  // and the row below reads "unknown" rather than ever erroring the screen.
  const [phoneInfo, setPhoneInfo] = React.useState<NetworkInfo | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void getNetworkInfo().then((info) => {
      if (!cancelled) setPhoneInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Field revision (2026-08-27, binding): "the telemetry monitor shows
  // latG/longG (phone accelerometer) whenever the G provider is running,
  // with their observed rate -- recorded-not-displayed still applies to the
  // DRIVING dashboard, not to the monitor." `gForceProvider` starts/stops
  // with SESSION recording (composition.ts), independent of this screen's
  // own OBD start/stop button -- its samples are timestamped here with
  // `Date.now()` (this screen's OWN observation cadence of the callback
  // firing, not `TelemetrySample.tMonoMs`'s own -- unrelated -- clock domain)
  // and fed to `summarizeGForceSamples` (pure, unit-tested) to infer
  // running/Hz, since `GForceProvider` itself exposes no running-state
  // getter. The 1s ticker re-renders even without a new sample, so a row
  // hides again once the provider actually stops.
  const gSampleTimesRef = React.useRef<{ latG: number[]; longG: number[] }>({ latG: [], longG: [] });
  const [gValues, setGValues] = React.useState<{ latG?: number; longG?: number }>({});
  const [, forceGTick] = React.useState(0);
  React.useEffect(() => {
    const unsubscribeG = gForceProvider.onSample((sample: TelemetrySample) => {
      if (sample.channel !== 'latG' && sample.channel !== 'longG') return;
      const now = Date.now();
      const times = gSampleTimesRef.current[sample.channel];
      times.push(now);
      while (times.length > 0 && now - times[0]! > 2_000) times.shift(); // keep just enough history for the Hz window + stale check.
      setGValues((prev) => ({ ...prev, [sample.channel]: sample.value }));
    });
    const tickTimer = setInterval(() => forceGTick((n) => n + 1), 1_000);
    return () => {
      unsubscribeG();
      clearInterval(tickTimer);
    };
  }, []);
  const latGSummary = summarizeGForceSamples(gSampleTimesRef.current.latG, Date.now());
  const longGSummary = summarizeGForceSamples(gSampleTimesRef.current.longG, Date.now());
  const gForceRunning = latGSummary.running || longGSummary.running;

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
              <View style={styles.channelRow}>
                <Text style={styles.channelLabel} maxFontSizeMultiplier={1.3}>
                  Phone network
                </Text>
                <Text style={styles.channelValue} maxFontSizeMultiplier={1.3}>
                  {phoneInfo === null ? 'unknown' : phoneInfo.ipv4}
                </Text>
              </View>
            </View>
            {isEnet && !RUNNING_STATES.has(state) ? (
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                Join the adapter&apos;s WiFi (MHD_XXXX) first.
              </Text>
            ) : null}

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

            {gForceRunning ? (
              <View style={styles.card} accessibilityLabel="G-force (phone accelerometer)">
                {(
                  [
                    ['latG', 'Lateral G', latGSummary, gValues.latG] as const,
                    ['longG', 'Longitudinal G', longGSummary, gValues.longG] as const,
                  ] as const
                ).map(([id, label, summary, value]) =>
                  !summary.running ? null : (
                    <View key={id} style={styles.channelRow}>
                      <Text style={styles.channelLabel} maxFontSizeMultiplier={1.3}>
                        {label}
                      </Text>
                      <Text style={styles.channelValue} maxFontSizeMultiplier={1.3}>
                        {value === undefined ? '—' : `${value.toFixed(2)} g`}
                      </Text>
                      <Text style={styles.channelHz} maxFontSizeMultiplier={1.3}>
                        {summary.hz.toFixed(1)} Hz
                      </Text>
                    </View>
                  ),
                )}
              </View>
            ) : null}

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
