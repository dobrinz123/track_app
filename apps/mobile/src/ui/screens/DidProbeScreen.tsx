import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  binaryStringToBytes,
  bytesToBinaryString,
  bytesToHex,
  encodeFrame,
  HSFZ_CONTROL,
  HsfzFrameParser,
  SimulatedEnetTransport,
  UDS_NRC,
  type Elm327State,
  type ObdTransport,
} from '@circuit/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { settingsStore, telemetryProvider } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { EnetTcpTransport } from '../../session/enetTcpTransport';
import { formatHexByte, parseHexByteDraft } from '../../session/enetSettingsValidation';
import { enetAdapterReservation } from '../../session/enetAdapterReservation';
import {
  buildDidProbeRequest,
  correlateDidProbeResponse,
  evaluateDidProbeGating,
  pushDidProbeLogEntry,
  DID_PROBE_LOG_CAP,
  DID_PROBE_STOP_TELEMETRY_MESSAGE,
  type DidProbeLogEntry,
  type DidProbeMode,
  type DidProbeSentRequest,
} from '../../session/didProbe';

type Props = NativeStackScreenProps<RootStackParamList, 'DidProbe'>;

/** One request-timeout budget for the probe -- deliberately fixed (not settings-configurable): a manual, one-off diagnostic tool, not part of the polling engine's own configurable `commandTimeoutMs`. */
const PROBE_TIMEOUT_MS = 3_000;

const NRC_NAMES: Readonly<Record<number, string>> = {
  [UDS_NRC.GENERAL_REJECT]: 'generalReject',
  [UDS_NRC.SERVICE_NOT_SUPPORTED]: 'serviceNotSupported',
  [UDS_NRC.SUB_FUNCTION_NOT_SUPPORTED]: 'subFunctionNotSupported',
  [UDS_NRC.REQUEST_OUT_OF_RANGE]: 'requestOutOfRange',
  [UDS_NRC.RESPONSE_PENDING]: 'responsePending',
};

function nrcLabel(nrc: number): string {
  const name = NRC_NAMES[nrc];
  const hex = `0x${nrc.toString(16).padStart(2, '0').toUpperCase()}`;
  return name === undefined ? hex : `${hex} (${name})`;
}

interface ProbeOutcome {
  status: 'matched' | 'unmatched';
  rawHex: string;
  nrc?: number;
  roundTripMs: number;
}

/**
 * Fires ONE whitelisted UDS request over `transport` and resolves once a
 * diagnostic-control response frame arrives (ack/alive-check/status frames
 * are ignored -- they're not the answer this probe is waiting for), or
 * rejects on timeout / transport close. The frame is correlated to `sent`
 * via `didProbe.ts`'s `correlateDidProbeResponse` (P4e-FIX2 M3, binding):
 * addresses swapped + SID+0x40/0x7F echo + identifier echo -- a frame that
 * fails correlation resolves as `'unmatched'`, NEVER as a match, so the
 * caller can never log a stray/foreign frame as `OK`. Connects and closes
 * the transport itself -- this screen never keeps a connection open between
 * probes, same "no retry, no persistence" spirit as the rest of this
 * dev-only tool.
 */
async function sendOneProbeRequest(
  transport: ObdTransport,
  sent: DidProbeSentRequest,
  pdu: Uint8Array,
): Promise<ProbeOutcome> {
  const startedAtMs = Date.now();
  await transport.connect();
  try {
    return await new Promise<ProbeOutcome>((resolve, reject) => {
      let settled = false;

      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribeData();
        unsubscribeClose();
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new Error(`DID probe timed out after ${PROBE_TIMEOUT_MS}ms (no response)`)));
      }, PROBE_TIMEOUT_MS);

      const parser = new HsfzFrameParser();
      const unsubscribeData = transport.onData((chunk) => {
        if (settled) return;
        let frames: ReturnType<HsfzFrameParser['push']>;
        try {
          frames = parser.push(binaryStringToBytes(chunk));
        } catch {
          return; // A malformed frame here is not this probe's own request/response -- keep waiting for the timeout.
        }
        for (const frame of frames) {
          if (frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) continue; // ack/alive-check/status/etc. -- not the answer.
          const rawHex = bytesToHex(encodeFrame(frame));
          const roundTripMs = Date.now() - startedAtMs;
          const correlation = correlateDidProbeResponse(sent, frame);
          if (correlation.kind === 'matched') {
            finish(() =>
              resolve({ status: 'matched', rawHex, roundTripMs, ...(correlation.nrc === undefined ? {} : { nrc: correlation.nrc }) }),
            );
          } else {
            finish(() => resolve({ status: 'unmatched', rawHex, roundTripMs }));
          }
          return;
        }
      });

      const unsubscribeClose = transport.onClose((error) => {
        finish(() => reject(error ?? new Error('DID probe: transport closed before a response arrived')));
      });

      const frame = encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: sent.testerAddress,
        target: sent.targetAddress,
        payload: pdu,
      });
      transport.send(bytesToBinaryString(frame));
    });
  } finally {
    await transport.close();
  }
}

/**
 * Dev-only tool, hidden by default (field revision, 2026-08-27, binding: the
 * ROUTE is registered in every build, release included -- only its
 * `SettingsScreen.tsx` entry point is gated on `developerModeEnabled`/
 * `__DEV__`; `DevReplay` remains the one screen still `__DEV__`-only end to
 * end). ENET DID/PID probe: the empirical tool for discovering B58/DSC identifiers
 * (contracts.md ENET addendum) by sending ONE request at a time to a target
 * address and reading back the raw response. Every request is built by
 * `didProbe.ts`'s `buildDidProbeRequest`, which re-checks the SAME read-only
 * whitelist (`{0x01, 0x22, 0x3E}`) the ENET session engine itself enforces --
 * "the whitelist error is shown, not bypassed": a rejected request never
 * reaches a transport at all, it just renders inline like any other input
 * error.
 *
 * P4e-FIX2 H2 fix (binding, "poll plan, probe & robustness amendment"):
 * allowed ONLY while `telemetryEnabled && adapterType === 'enet'` AND the
 * shared `telemetryProvider` is `idle`/`stopped`/`failed` (never while
 * `connecting`/`initializing`/`polling`) -- the MHD adapter accepts one ECU
 * client, so this screen never opens its own connection alongside an active
 * polling session; `evaluateDidProbeGating` (`didProbe.ts`) is the single
 * source of truth for that decision, re-checked both to disable the Send
 * button AND again at the top of `send()` itself (defense in depth against a
 * state change racing the button press). Uses `SimulatedEnetTransport` when
 * `telemetrySimulate` is on (dev only), same as the telemetry monitor.
 */
export function DidProbeScreen(props: Props): React.JSX.Element {
  const { navigation } = props;
  const settings = useSettings(settingsStore);
  const [providerState, setProviderState] = React.useState<Elm327State>('idle');
  const [mode, setMode] = React.useState<DidProbeMode>('did');
  const [targetAddressDraft, setTargetAddressDraft] = React.useState(formatHexByte(settings.enetTargetAddress));
  const [requestHexDraft, setRequestHexDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [error, setErrorText] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<DidProbeLogEntry[]>([]);
  const nextLogId = React.useRef(0);

  React.useEffect(() => {
    // `onStateChange` replays the current state synchronously on subscribe
    // (telemetryProvider.ts's own binding semantics) -- gating is correct
    // from the very first render, not just after the next transition.
    return telemetryProvider.onStateChange((state) => setProviderState(state));
  }, []);

  const gating = evaluateDidProbeGating({
    telemetryEnabled: settings.telemetryEnabled,
    adapterType: settings.adapterType,
    providerState,
  });

  function appendLog(entry: Omit<DidProbeLogEntry, 'id' | 'atEpochMs'>): void {
    const record: DidProbeLogEntry = { ...entry, id: nextLogId.current, atEpochMs: Date.now() };
    nextLogId.current += 1;
    setLog((prev) => pushDidProbeLogEntry(prev, record));
  }

  async function send(): Promise<void> {
    setErrorText(null);
    // Re-check gating here (not just the disabled Send button) -- a state
    // change (e.g. telemetry starting to poll) racing the button press must
    // never let a probe through.
    if (!gating.allowed) {
      setErrorText(gating.message);
      return;
    }
    const targetAddress = parseHexByteDraft(targetAddressDraft);
    if (targetAddress === null) {
      setErrorText('Target address: enter a hex byte, 00-FF');
      return;
    }
    const built = buildDidProbeRequest(mode, requestHexDraft);
    if (!built.ok || built.pdu === null || built.sid === null || built.identifier === null) {
      setErrorText(built.error ?? 'Invalid request');
      appendLog({
        mode,
        targetAddressHex: formatHexByte(targetAddress),
        requestHex: requestHexDraft,
        status: 'error',
        detail: built.error ?? 'Invalid request',
      });
      return;
    }

    // P4e-FIX3 H2 fix (binding): the ATOMIC enforcement of the adapter's
    // one-ECU-client rule -- `gating.allowed` above is a UI-level snapshot
    // (the provider's state at last render) with a race window a provider
    // retry can slip through; `tryAcquire` is the single arbiter both this
    // screen and `telemetryProvider.ts` actually check right before opening
    // a socket. Refused with the SAME message the state-based gating shows.
    // P4e-FIX4 (binding): `tryAcquire` now returns this ONE request's own
    // token (or `null`) -- stored locally and passed back to `release`
    // below, never a bare owner string, so a stale token can never release
    // a claim a NEWER acquisition (this screen's own next probe, or the
    // provider) now holds.
    const reservationToken = enetAdapterReservation.tryAcquire('probe');
    if (reservationToken === null) {
      setErrorText(DID_PROBE_STOP_TELEMETRY_MESSAGE);
      appendLog({
        mode,
        targetAddressHex: formatHexByte(targetAddress),
        requestHex: requestHexDraft,
        status: 'error',
        detail: DID_PROBE_STOP_TELEMETRY_MESSAGE,
      });
      return;
    }

    setSending(true);
    // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
    const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : false;
    const transport: ObdTransport =
      settings.telemetrySimulate && isDev
        ? new SimulatedEnetTransport({
            monotonicNow: () => Date.now(),
            testerAddress: settings.enetTesterAddress,
            targetAddress,
          })
        : new EnetTcpTransport({ host: settings.enetHost, port: settings.enetPort });

    const sent: DidProbeSentRequest = {
      mode,
      sid: built.sid,
      identifier: built.identifier,
      testerAddress: settings.enetTesterAddress,
      targetAddress,
    };

    try {
      const result = await sendOneProbeRequest(transport, sent, built.pdu);
      if (result.status === 'unmatched') {
        appendLog({
          mode,
          targetAddressHex: formatHexByte(targetAddress),
          requestHex: requestHexDraft,
          status: 'unmatched',
          detail: `UNMATCHED (addresses/SID/identifier did not correlate) -- raw: ${result.rawHex}`,
          roundTripMs: result.roundTripMs,
        });
      } else {
        const detail =
          result.nrc === undefined ? `OK: ${result.rawHex}` : `NRC ${nrcLabel(result.nrc)} -- raw: ${result.rawHex}`;
        appendLog({
          mode,
          targetAddressHex: formatHexByte(targetAddress),
          requestHex: requestHexDraft,
          status: 'ok',
          detail,
          roundTripMs: result.roundTripMs,
        });
      }
    } catch (probeError) {
      const message = probeError instanceof Error ? probeError.message : String(probeError);
      setErrorText(message);
      appendLog({
        mode,
        targetAddressHex: formatHexByte(targetAddress),
        requestHex: requestHexDraft,
        status: 'error',
        detail: message,
      });
    } finally {
      // Held for the duration of ONE request (socket open -> close), per
      // the binding spec -- released via THIS request's own token,
      // regardless of outcome, so the NEXT probe (or the provider) can
      // acquire it immediately after.
      enetAdapterReservation.release(reservationToken);
      setSending(false);
    }
  }

  const sendDisabled = sending || !gating.allowed;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          DID probe (ENET)
        </Text>
        <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
          Dev-only. Sends ONE request at a time to discover empirical DID/PID identifiers. Only read services
          {' '}0x01 (OBD PID), 0x22 (ReadDataByIdentifier) and 0x3E (TesterPresent) can ever be sent -- anything
          else is refused, not bypassed.
        </Text>

        <Pressable
          style={styles.sweepLinkRow}
          onPress={() => navigation.navigate('DidSweep')}
          accessibilityRole="button"
          accessibilityLabel="Open ENET DID sweep"
        >
          <Text style={styles.sweepLinkText} maxFontSizeMultiplier={1.3}>
            Sweep a DID range instead →
          </Text>
        </Pressable>

        {gating.allowed ? null : (
          <View style={styles.disabledCard}>
            <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
              {gating.message}
            </Text>
          </View>
        )}

        <View style={styles.card}>
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
              Target address (hex)
            </Text>
            <TextInput
              style={styles.fieldInput}
              value={targetAddressDraft}
              onChangeText={setTargetAddressDraft}
              placeholder="12"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              editable={gating.allowed}
              accessibilityLabel="DID probe target address, hex byte"
            />
          </View>

          <View style={styles.segmented}>
            {(
              [
                { label: '0x22 DID', value: 'did' as const },
                { label: '0x01 PID', value: 'obd01' as const },
              ]
            ).map((opt) => {
              const active = opt.value === mode;
              return (
                <Pressable
                  key={opt.value}
                  style={[styles.segment, active && styles.segmentActive]}
                  onPress={() => setMode(opt.value)}
                  disabled={!gating.allowed}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, disabled: !gating.allowed }}
                  accessibilityLabel={`Probe mode: ${opt.label}${active ? ', selected' : ''}`}
                >
                  <Text style={[styles.segmentText, active && styles.segmentTextActive]} maxFontSizeMultiplier={1.3}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
              {mode === 'did' ? 'DID (4 hex chars)' : 'PID (2 hex chars)'}
            </Text>
            <TextInput
              style={styles.fieldInput}
              value={requestHexDraft}
              onChangeText={setRequestHexDraft}
              placeholder={mode === 'did' ? '1E0C' : '0C'}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="characters"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              editable={gating.allowed}
              accessibilityLabel="DID probe request hex"
            />
          </View>

          {error === null ? null : (
            <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}

          <Pressable
            style={[styles.button, sendDisabled && styles.buttonDisabled]}
            onPress={() => void send()}
            disabled={sendDisabled}
            accessibilityRole="button"
            accessibilityLabel="Send DID probe request"
            accessibilityState={{ disabled: sendDisabled }}
          >
            <Text style={styles.buttonText} maxFontSizeMultiplier={1.3}>
              {sending ? 'Sending…' : 'Send'}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          LOG (last {DID_PROBE_LOG_CAP})
        </Text>
        {log.length === 0 ? (
          <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
            No probes sent yet.
          </Text>
        ) : (
          log.map((entry) => (
            <View key={entry.id} style={styles.logRow}>
              <Text style={styles.logHeader} maxFontSizeMultiplier={1.3}>
                {new Date(entry.atEpochMs).toLocaleTimeString()} · {entry.mode === 'did' ? '0x22' : '0x01'}{' '}
                {entry.requestHex} → {entry.targetAddressHex}
                {entry.roundTripMs === undefined ? '' : ` · ${entry.roundTripMs}ms`}
              </Text>
              <Text
                style={[
                  styles.logDetail,
                  entry.status === 'error' && styles.logDetailError,
                  entry.status === 'unmatched' && styles.logDetailUnmatched,
                ]}
                maxFontSizeMultiplier={1.3}
              >
                {entry.detail}
              </Text>
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  helperText: { ...typography.caption, color: colors.textMuted, lineHeight: 18 },
  sweepLinkRow: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  sweepLinkText: { ...typography.body, color: colors.accent, fontFamily: fontFamily.bodySemibold },
  sectionLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.sm },
  disabledCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.warning,
    padding: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
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
    minWidth: 110,
    textAlign: 'right',
  },
  segmented: { flexDirection: 'row', gap: spacing.sm },
  segment: {
    flex: 1,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  segmentText: { ...typography.body, color: colors.textSecondary },
  segmentTextActive: { color: colors.onAccent, fontFamily: fontFamily.bodySemibold },
  errorBanner: { ...typography.caption, color: colors.danger },
  button: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.accent,
    backgroundColor: colors.accent,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { ...typography.subtitle, color: colors.onAccent },
  logRow: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
    gap: 2,
  },
  logHeader: { ...typography.caption, color: colors.textMuted, fontFamily: fontFamily.monoSemibold },
  logDetail: { ...typography.caption, color: colors.textSecondary },
  logDetailError: { color: colors.danger },
  logDetailUnmatched: { color: colors.warning },
});
