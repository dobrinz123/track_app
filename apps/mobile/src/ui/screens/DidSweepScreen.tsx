import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  ENET_SPEC_CHANNELS,
  SimulatedEnetTransport,
  DEFAULT_ENET_DID_SCENARIO,
  type ObdTransport,
  type TelemetryChannelId,
} from '@circuit/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { facade, settingsStore } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { EnetTcpTransport } from '../../session/enetTcpTransport';
import { formatHexByte, mergeEnetChannelSpecJson } from '../../session/enetSettingsValidation';
import { createDidSweepController, type DidSweepSnapshot } from '../../session/didSweepController';

type Props = NativeStackScreenProps<RootStackParamList, 'DidSweep'>;

const ENET_TAG_CHANNELS: readonly TelemetryChannelId[] = [...ENET_SPEC_CHANNELS];

function parseHexRange(text: string): number | null {
  const compact = text.trim().replace(/^0[Xx]/, '');
  if (!/^[0-9A-Fa-f]{1,4}$/.test(compact)) return null;
  const value = Number.parseInt(compact, 16);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
  return value;
}

function formatHexDid(did: number): string {
  return `0x${did.toString(16).toUpperCase().padStart(4, '0')}`;
}

function formatBytesHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/**
 * Dev-only (`__DEV__`-gated route registration, mirrors `DidProbe`/`DevReplay`)
 * DID sweep screen (contracts.md "ENET auto-discovery & DID sweep addendum" +
 * "sweep transport interface & lifecycle amendment", both binding): iterates
 * a configurable DID range, shows live progress and responders, then (after
 * the sweep, or on demand) re-polls the responders found for an observation
 * window and shows heuristic suggestions the user can confirm with one tap
 * ("Tag as <channel>"), writing the resulting spec into `enetChannelSpecsJson`.
 *
 * H1/H2 (binding): the CONTROLLER owns the transport's whole lifecycle
 * (acquire the reservation, open a fresh transport, run, close, release) --
 * this screen supplies only a `transportFactory` (never connects/closes
 * anything itself) and renders `controller`'s own snapshot.
 */
export function DidSweepScreen(_props: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const [fromDraft, setFromDraft] = React.useState('0000');
  const [toDraft, setToDraft] = React.useState('FFFF');
  const [observationWindowDraft, setObservationWindowDraft] = React.useState('60');
  const [rangeError, setRangeError] = React.useState<string | null>(null);
  const [snapshot, setSnapshot] = React.useState<DidSweepSnapshot | null>(null);
  const [tagPickerDid, setTagPickerDid] = React.useState<number | null>(null);
  const [tagBanner, setTagBanner] = React.useState<string | null>(null);

  const settingsRef = React.useRef(settings);
  settingsRef.current = settings;

  // M3 (binding): "pass GNSS speed context if a live speed source exists in
  // the app" -- `facade`'s `speedKph` is already computed every match tick
  // (cheap, no new subscription cost this screen introduces beyond one
  // `facade.subscribe`), so it is wired here rather than omitted. Collected
  // ONLY while an observation is actually running (cleared at each
  // `startObservation()`), read by the controller exactly once when the
  // observation phase finishes.
  //
  // P4f-FIX5 (binding, after Codex P4f-REV5): samples are buffered as RAW
  // wall-clock instants (`Date.now()`), NOT pre-converted to an elapsed time
  // -- the controller's `onObservationStarted` callback (below) supplies the
  // REAL anchor (the moment its core observation loop actually begins, AFTER
  // the transport finishes connecting), which arrives strictly LATER than
  // this ref is reset at the tap (`handleStartObservation`). Anchoring at the
  // tap instead (the REV5 defect) offset every GNSS sample by the connection
  // delay relative to the DID series' own (post-connect) relative `tMs` --
  // `gnssSpeedContext()` does the actual re-basing once the anchor is known,
  // dropping any sample that landed before it (no corresponding DID-relative
  // instant exists for those).
  const gnssSpeedSamplesRef = React.useRef<Array<{ wallClockMs: number; v: number }>>([]);
  const observingRef = React.useRef(false);
  const observationAnchorWallClockMsRef = React.useRef<number | null>(null);

  React.useEffect(
    () =>
      facade.subscribe((state) => {
        if (!observingRef.current || state.speedKph === null) return;
        gnssSpeedSamplesRef.current.push({ wallClockMs: Date.now(), v: state.speedKph });
      }),
    [],
  );

  const controllerRef = React.useRef<ReturnType<typeof createDidSweepController> | null>(null);

  function ensureController(): ReturnType<typeof createDidSweepController> {
    if (controllerRef.current !== null) return controllerRef.current;
    // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
    const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;
    const controller = createDidSweepController({
      // H1/H2 (binding): a FRESH transport per `start()`/observation-from-
      // terminal-state -- this factory is called by the controller itself,
      // never invoked (or connected/closed) here.
      transportFactory: (): ObdTransport => {
        const current = settingsRef.current;
        return current.telemetrySimulate && isDev
          ? new SimulatedEnetTransport({
              monotonicNow: () => Date.now(),
              scenario: DEFAULT_ENET_DID_SCENARIO,
              testerAddress: current.enetTesterAddress,
              targetAddress: current.enetTargetAddress,
            })
          : new EnetTcpTransport({ host: current.enetHost, port: current.enetPort });
      },
      testerAddress: settingsRef.current.enetTesterAddress,
      targetAddress: settingsRef.current.enetTargetAddress,
      clock: { now: () => Date.now() },
      // P4f-FIX5 (binding): the REAL anchor -- fired once the core
      // observation loop actually begins (post-connect), in the SAME
      // wall-clock domain `Date.now()` (above) already uses for GNSS
      // samples.
      onObservationStarted: (anchor) => {
        observationAnchorWallClockMsRef.current = anchor.wallClockMs;
      },
      gnssSpeedContext: () => {
        const anchor = observationAnchorWallClockMsRef.current;
        if (anchor === null) return { gnssSpeedKph: [] }; // the loop never actually started (e.g. connect failed) -- nothing valid to offer.
        return {
          gnssSpeedKph: gnssSpeedSamplesRef.current
            .map((sample) => ({ tMs: sample.wallClockMs - anchor, v: sample.v }))
            .filter((sample) => sample.tMs >= 0), // drop samples collected before the anchor (the tap-to-connect gap) -- no corresponding DID-relative instant exists for them.
        };
      },
    });
    controllerRef.current = controller;
    controller.subscribe((next) => {
      observingRef.current = next.phase === 'observing';
      setSnapshot(next);
    });
    return controller;
  }

  React.useEffect(
    () => () => {
      // Unmount cleanup: stop() closes the transport and releases the
      // reservation on every path (idempotent if already idle/stopped).
      controllerRef.current?.stop();
    },
    [],
  );

  function handleStart(): void {
    setRangeError(null);
    setTagBanner(null);
    const from = parseHexRange(fromDraft);
    const to = parseHexRange(toDraft);
    if (from === null || to === null) {
      setRangeError('Enter hex DIDs, 0000-FFFF, for both From and To');
      return;
    }
    ensureController().start({ from, to });
  }

  function handleStop(): void {
    controllerRef.current?.stop();
  }

  function handleStartObservation(): void {
    const seconds = Number.parseInt(observationWindowDraft, 10);
    const windowMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
    gnssSpeedSamplesRef.current = [];
    // P4f-FIX5 (binding): NOT `Date.now()` here (the REV5 defect) -- the real
    // anchor arrives later, via `onObservationStarted`, once the core loop
    // actually begins post-connect. `null` until then; any GNSS sample
    // collected in the meantime is buffered (raw wall-clock) and re-based
    // once the anchor lands.
    observationAnchorWallClockMsRef.current = null;
    controllerRef.current?.startObservation(windowMs);
  }

  function confirmTag(did: number, channel: TelemetryChannelId): void {
    const controller = controllerRef.current;
    if (controller === null) return;
    const spec = controller.buildTaggedSpec(did, channel, new Date().toISOString().slice(0, 10));
    if (spec === null) {
      setTagBanner(`Could not build a spec for ${formatHexDid(did)}.`);
      return;
    }
    const merged = mergeEnetChannelSpecJson(settingsStore.getSettings().enetChannelSpecsJson, spec);
    settingsStore.update({ enetChannelSpecsJson: merged });
    setTagBanner(`Tagged ${formatHexDid(did)} as ${channel}.`);
    setTagPickerDid(null);
  }

  const phase = snapshot?.phase ?? 'idle';
  const running = phase === 'sweeping' || phase === 'paused';
  const observing = phase === 'observing';
  const canStart = phase === 'idle' || phase === 'stopped' || phase === 'sweepComplete' || phase === 'observationComplete';
  const totalNrc = Object.values(snapshot?.nrcCounts ?? {}).reduce((sum, n) => sum + n, 0);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          DID sweep (ENET)
        </Text>
        <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
          Dev-only. Sweeps a DID range with one 0x22 request at a time, then re-polls responders to suggest a
          channel/decode. No suggestion is ever applied without your confirmation.
        </Text>

        <View style={styles.card}>
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
              From (hex)
            </Text>
            <TextInput
              style={styles.fieldInput}
              value={fromDraft}
              onChangeText={setFromDraft}
              editable={canStart}
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              accessibilityLabel="Sweep range start, hex DID"
            />
          </View>
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
              To (hex)
            </Text>
            <TextInput
              style={styles.fieldInput}
              value={toDraft}
              onChangeText={setToDraft}
              editable={canStart}
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              accessibilityLabel="Sweep range end, hex DID"
            />
          </View>
          {rangeError === null ? null : (
            <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
              {rangeError}
            </Text>
          )}
          {snapshot?.error == null ? null : (
            <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
              {snapshot.error}
            </Text>
          )}

          <View style={styles.buttonRow}>
            {canStart ? (
              <Pressable style={styles.button} onPress={handleStart} accessibilityRole="button" accessibilityLabel="Start sweep">
                <Text style={styles.buttonText} maxFontSizeMultiplier={1.3}>
                  Start
                </Text>
              </Pressable>
            ) : (
              <>
                {phase === 'sweeping' ? (
                  <Pressable style={styles.buttonSecondary} onPress={() => controllerRef.current?.pause()} accessibilityRole="button" accessibilityLabel="Pause sweep">
                    <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                      Pause
                    </Text>
                  </Pressable>
                ) : null}
                {phase === 'paused' ? (
                  <Pressable style={styles.button} onPress={() => controllerRef.current?.resume()} accessibilityRole="button" accessibilityLabel="Resume sweep">
                    <Text style={styles.buttonText} maxFontSizeMultiplier={1.3}>
                      Resume
                    </Text>
                  </Pressable>
                ) : null}
                <Pressable style={styles.buttonDanger} onPress={handleStop} accessibilityRole="button" accessibilityLabel="Stop sweep">
                  <Text style={styles.buttonDangerText} maxFontSizeMultiplier={1.3}>
                    Stop
                  </Text>
                </Pressable>
              </>
            )}
          </View>
        </View>

        {snapshot === null ? null : (
          <View style={styles.card}>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel} maxFontSizeMultiplier={1.3}>
                {phase.toUpperCase()}
              </Text>
              {snapshot.progress === null ? null : (
                <Text style={styles.progressValue} maxFontSizeMultiplier={1.3} numberOfLines={2}>
                  {formatHexDid(snapshot.progress.did)} · {snapshot.progress.index}/{snapshot.progress.total} ·{' '}
                  {snapshot.progress.reqPerSec.toFixed(1)} req/s
                </Text>
              )}
            </View>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel} maxFontSizeMultiplier={1.3}>
                Responders
              </Text>
              <Text style={styles.progressValue} maxFontSizeMultiplier={1.3}>
                {snapshot.responders.length}
              </Text>
            </View>
            <View style={styles.progressRow}>
              <Text style={styles.progressLabel} maxFontSizeMultiplier={1.3}>
                NRC / timeouts
              </Text>
              <Text style={styles.progressValue} maxFontSizeMultiplier={1.3}>
                {totalNrc} / {snapshot.timeouts}
              </Text>
            </View>
          </View>
        )}

        {snapshot === null || snapshot.responders.length === 0 ? null : (
          <View style={styles.card}>
            <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
              RESPONDERS
            </Text>
            {snapshot.responders.map((responder) => (
              <View key={responder.did} style={styles.responderRow}>
                <Text style={styles.responderDid} maxFontSizeMultiplier={1.3}>
                  {formatHexDid(responder.did)}
                </Text>
                <Text style={styles.responderRaw} maxFontSizeMultiplier={1.3}>
                  {formatBytesHex(responder.raw)}
                </Text>
              </View>
            ))}

            {(phase === 'sweepComplete' || phase === 'paused' || phase === 'stopped' || phase === 'observationComplete') && !observing ? (
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                  Observe window (s)
                </Text>
                <TextInput
                  style={styles.fieldInputSmall}
                  value={observationWindowDraft}
                  onChangeText={setObservationWindowDraft}
                  keyboardType="number-pad"
                  accessibilityLabel="Observation window, seconds"
                />
              </View>
            ) : null}
            {(phase === 'sweepComplete' || phase === 'paused' || phase === 'stopped' || phase === 'observationComplete') && !observing ? (
              <Pressable style={styles.buttonSecondary} onPress={handleStartObservation} accessibilityRole="button" accessibilityLabel="Start observation">
                <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                  Start observation
                </Text>
              </Pressable>
            ) : null}
            {observing ? (
              <>
                <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                  Observing… {(snapshot.observationElapsedMs / 1_000).toFixed(0)}s
                  {snapshot.observationCadenceDegraded ? ' · cadence degraded (too many responders for ~1 Hz each)' : ''}
                </Text>
                <Pressable
                  style={styles.buttonDanger}
                  onPress={() => controllerRef.current?.stopObservationEarly()}
                  accessibilityRole="button"
                  accessibilityLabel="Stop observation now"
                >
                  <Text style={styles.buttonDangerText} maxFontSizeMultiplier={1.3}>
                    Stop observation now
                  </Text>
                </Pressable>
              </>
            ) : null}
          </View>
        )}

        {snapshot === null || snapshot.suggestions.length === 0 ? null : (
          <View style={styles.card}>
            <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
              SUGGESTIONS
            </Text>
            {tagBanner === null ? null : (
              <Text style={styles.successBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                {tagBanner}
              </Text>
            )}
            {snapshot.suggestions.map((suggestion) => (
              <View key={suggestion.did} style={styles.suggestionRow}>
                <Text style={styles.responderDid} maxFontSizeMultiplier={1.3}>
                  {formatHexDid(suggestion.did)} — {suggestion.kind} ({(suggestion.confidence * 100).toFixed(0)}%,{' '}
                  {suggestion.decode})
                </Text>
                <Text style={styles.rationaleText} maxFontSizeMultiplier={1.3}>
                  {suggestion.rationale}
                </Text>
                {tagPickerDid === suggestion.did ? (
                  <View style={styles.channelPickerRow}>
                    {ENET_TAG_CHANNELS.map((channel) => (
                      <Pressable
                        key={channel}
                        style={styles.channelChip}
                        onPress={() => confirmTag(suggestion.did, channel)}
                        accessibilityRole="button"
                        accessibilityLabel={`Tag ${formatHexDid(suggestion.did)} as ${channel}`}
                      >
                        <Text style={styles.channelChipText} maxFontSizeMultiplier={1.3}>
                          {channel}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <Pressable
                    style={styles.buttonSecondary}
                    onPress={() => setTagPickerDid(suggestion.did)}
                    accessibilityRole="button"
                    accessibilityLabel={`Tag ${formatHexDid(suggestion.did)} as a channel`}
                  >
                    <Text style={styles.buttonSecondaryText} maxFontSizeMultiplier={1.3}>
                      Tag as…
                    </Text>
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        )}

        <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
          Adapter:{' '}
          {settings.telemetrySimulate
            ? 'simulated'
            : `${settings.enetHost || '(no host)'} · tester 0x${formatHexByte(settings.enetTesterAddress)} → target 0x${formatHexByte(settings.enetTargetAddress)}`}
        </Text>
        <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
          Speed-like suggestions use GNSS speed from the current driving session when one is active; otherwise
          that shape simply won't score confidently.
        </Text>
        {running || observing ? (
          <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
            The adapter is reserved for this sweep (single-client rule) -- stop it before using telemetry or the DID probe.
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  helperText: { ...typography.caption, color: colors.textMuted, lineHeight: 18 },
  sectionLabel: { ...typography.label, color: colors.textMuted },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  fieldLabel: { ...typography.body, color: colors.textSecondary, flexShrink: 1 },
  fieldInput: {
    ...typography.body,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    minWidth: 90,
    textAlign: 'right',
  },
  fieldInputSmall: {
    ...typography.body,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.background,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    minWidth: 64,
    textAlign: 'right',
  },
  errorBanner: { ...typography.caption, color: colors.danger },
  successBanner: { ...typography.caption, color: colors.success },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  button: {
    flex: 1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  buttonText: { ...typography.body, color: colors.onAccent, fontFamily: fontFamily.bodySemibold },
  buttonSecondary: {
    flex: 1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  buttonSecondaryText: { ...typography.body, color: colors.textSecondary },
  buttonDanger: {
    flex: 1,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  buttonDangerText: { ...typography.body, color: colors.danger, fontFamily: fontFamily.bodySemibold },
  // L 360pt (binding, Codex P4f-REV2 Low finding): the progress VALUE text
  // (e.g. "0xFFFF · 65536/65536 · 123.4 req/s") is the longest string this
  // screen renders in a padded row next to a label -- `flexShrink: 1` lets it
  // shrink/wrap instead of forcing the row wider than a 360pt screen; the
  // label side keeps its own `flexShrink: 1` too (both sides may need room).
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, flexWrap: 'wrap' },
  progressLabel: { ...typography.caption, color: colors.textMuted, flexShrink: 1 },
  progressValue: {
    ...typography.caption,
    color: colors.textPrimary,
    fontFamily: fontFamily.monoSemibold,
    textAlign: 'right',
    flexShrink: 1,
    flexGrow: 0,
  },
  responderRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  responderDid: { ...typography.body, color: colors.textPrimary, fontFamily: fontFamily.monoSemibold },
  responderRaw: { ...typography.caption, color: colors.textSecondary, fontFamily: fontFamily.monoSemibold, textAlign: 'right', flexShrink: 1 },
  suggestionRow: { gap: spacing.xs, paddingVertical: spacing.xs },
  rationaleText: { ...typography.caption, color: colors.textMuted },
  channelPickerRow: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap' },
  channelChip: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  channelChipText: { ...typography.caption, color: colors.accent },
});
