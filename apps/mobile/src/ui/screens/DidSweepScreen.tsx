import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  binaryStringToBytes,
  bytesToBinaryString,
  encodeFrame,
  ENET_SPEC_CHANNELS,
  HSFZ_CONTROL,
  HsfzFrameParser,
  SimulatedEnetTransport,
  DEFAULT_ENET_DID_SCENARIO,
  type ObdTransport,
  type TelemetryChannelId,
} from '@circuit/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { settingsStore } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { EnetTcpTransport } from '../../session/enetTcpTransport';
import { formatHexByte, mergeEnetChannelSpecJson } from '../../session/enetSettingsValidation';
import { createDidSweepController, type DidSweepSnapshot } from '../../session/didSweepController';

type Props = NativeStackScreenProps<RootStackParamList, 'DidSweep'>;

/** Per-request timeout for the sweep's own raw send/wait primitive -- matches `@circuit/core`'s own `runDidSweep` default (`requestTimeoutMs`, 1000ms) so a stalling ECU never wedges past what the runner itself already bounds each attempt to. */
const RAW_REQUEST_TIMEOUT_MS = 1_000;

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
 * Low-level raw send/wait primitive over an ALREADY-CONNECTED transport --
 * frames `pdu` as one HSFZ diagnostic request and resolves with the first
 * correlated diagnostic-response frame's raw UDS payload bytes, or
 * `'timeout'`. Passed DIRECTLY as `didSweepController.ts`'s `sendRequest`
 * (the controller/core do all the parsing/correlation-by-DID/0x78 handling --
 * this function only correlates by ADDRESS, same as `DidProbeScreen.tsx`'s
 * own `sendOneProbeRequest`). Simplification (documented, dev-tool-only): a
 * 0x78-triggered re-call re-sends `pdu` on the wire rather than merely
 * extending a still-in-flight listener -- harmless for a read-only service,
 * simpler than threading in-flight state across independent calls.
 */
function sendRawUdsRequest(
  transport: ObdTransport,
  testerAddress: number,
  targetAddress: number,
): (pdu: Uint8Array) => Promise<Uint8Array | 'timeout'> {
  return (pdu: Uint8Array): Promise<Uint8Array | 'timeout'> =>
    new Promise((resolve) => {
      let settled = false;
      const parser = new HsfzFrameParser();

      const finish = (value: Uint8Array | 'timeout'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeData();
        unsubscribeClose();
        resolve(value);
      };

      const timer = setTimeout(() => finish('timeout'), RAW_REQUEST_TIMEOUT_MS);

      const unsubscribeData = transport.onData((chunk) => {
        if (settled) return;
        let frames: ReturnType<HsfzFrameParser['push']>;
        try {
          frames = parser.push(binaryStringToBytes(chunk));
        } catch {
          return;
        }
        for (const frame of frames) {
          if (frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) continue; // ack/alive-check/status -- not the answer.
          if (frame.source !== targetAddress || frame.target !== testerAddress) continue; // not addressed to/from us.
          finish(frame.payload);
          return;
        }
      });

      const unsubscribeClose = transport.onClose(() => finish('timeout'));

      try {
        const frame = encodeFrame({ control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES, source: testerAddress, target: targetAddress, payload: pdu });
        transport.send(bytesToBinaryString(frame));
      } catch {
        finish('timeout');
      }
    });
}

/**
 * Dev-only (`__DEV__`-gated route registration, mirrors `DidProbe`/`DevReplay`)
 * DID sweep screen (contracts.md "ENET auto-discovery & DID sweep addendum",
 * binding): iterates a configurable DID range, shows live progress and
 * responders, then (after the sweep, or on demand) re-polls the responders
 * found for an observation window and shows heuristic suggestions the user
 * can confirm with one tap ("Tag as <channel>"), writing the resulting spec
 * into `enetChannelSpecsJson`. All state-machine logic lives in
 * `didSweepController.ts` (pure, tested without RN) -- this screen is I/O
 * glue: opens ONE transport for the whole run (real `EnetTcpTransport`, or
 * `SimulatedEnetTransport` scripted with the DID sweep's own scenario when
 * `telemetrySimulate` is on) and a raw send/wait primitive
 * (`sendRawUdsRequest`) passed straight to the controller.
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

  const transportRef = React.useRef<ObdTransport | null>(null);
  const controllerRef = React.useRef<ReturnType<typeof createDidSweepController> | null>(null);
  const unsubscribeRef = React.useRef<(() => void) | null>(null);

  React.useEffect(
    () => () => {
      // Unmount cleanup: stop a still-running sweep/observation (releases the
      // reservation) and close whatever transport this screen opened.
      controllerRef.current?.stop();
      unsubscribeRef.current?.();
      void transportRef.current?.close();
    },
    [],
  );

  function ensureController(): ReturnType<typeof createDidSweepController> {
    if (controllerRef.current !== null) return controllerRef.current;
    // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
    const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;
    const transport: ObdTransport =
      settings.telemetrySimulate && isDev
        ? new SimulatedEnetTransport({
            monotonicNow: () => Date.now(),
            scenario: DEFAULT_ENET_DID_SCENARIO,
            testerAddress: settings.enetTesterAddress,
            targetAddress: settings.enetTargetAddress,
          })
        : new EnetTcpTransport({ host: settings.enetHost, port: settings.enetPort });
    transportRef.current = transport;

    const controller = createDidSweepController({
      sendRequest: sendRawUdsRequest(transport, settings.enetTesterAddress, settings.enetTargetAddress),
      clock: { now: () => Date.now() },
    });
    controllerRef.current = controller;
    unsubscribeRef.current = controller.subscribe(setSnapshot);
    return controller;
  }

  async function handleStart(): Promise<void> {
    setRangeError(null);
    setTagBanner(null);
    const from = parseHexRange(fromDraft);
    const to = parseHexRange(toDraft);
    if (from === null || to === null) {
      setRangeError('Enter hex DIDs, 0000-FFFF, for both From and To');
      return;
    }
    const controller = ensureController();
    try {
      await transportRef.current?.connect();
    } catch (error) {
      setRangeError(error instanceof Error ? error.message : String(error));
      // The transport (a one-shot `EnetTcpTransport`) cannot be reused after a
      // failed connect() -- clear the refs so the next "Start" tap builds a
      // genuinely fresh transport/controller instead of retrying a dead one.
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      controllerRef.current = null;
      transportRef.current = null;
      return;
    }
    controller.start({ from, to });
  }

  async function handleStop(): Promise<void> {
    controllerRef.current?.stop();
    await transportRef.current?.close();
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    controllerRef.current = null;
    transportRef.current = null;
  }

  function handleStartObservation(): void {
    const seconds = Number.parseInt(observationWindowDraft, 10);
    const windowMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : undefined;
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
  const canStart = phase === 'idle' || phase === 'stopped' || phase === 'sweepComplete';
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
              <Pressable style={styles.button} onPress={() => void handleStart()} accessibilityRole="button" accessibilityLabel="Start sweep">
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
                <Pressable style={styles.buttonDanger} onPress={() => void handleStop()} accessibilityRole="button" accessibilityLabel="Stop sweep">
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
                <Text style={styles.progressValue} maxFontSizeMultiplier={1.3}>
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
                NRC / timeouts / unmatched
              </Text>
              <Text style={styles.progressValue} maxFontSizeMultiplier={1.3}>
                {totalNrc} / {snapshot.timeouts} / {snapshot.unmatched}
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

            {(phase === 'sweepComplete' || phase === 'paused' || phase === 'stopped') && !observing ? (
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
            {(phase === 'sweepComplete' || phase === 'paused' || phase === 'stopped') && !observing ? (
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
  progressRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  progressLabel: { ...typography.caption, color: colors.textMuted, flexShrink: 1 },
  progressValue: { ...typography.caption, color: colors.textPrimary, fontFamily: fontFamily.monoSemibold, textAlign: 'right' },
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
