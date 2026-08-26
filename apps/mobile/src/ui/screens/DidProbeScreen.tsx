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
  parseUdsResponse,
  SimulatedEnetTransport,
  UDS_NRC,
  type HsfzFrame,
  type ObdTransport,
} from '@circuit/core';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { settingsStore } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';
import { EnetTcpTransport } from '../../session/enetTcpTransport';
import {
  buildDidProbeRequest,
  formatHexByte,
  parseHexByteDraft,
  type DidProbeMode,
} from '../../session/enetSettingsValidation';

type Props = NativeStackScreenProps<RootStackParamList, 'DidProbe'>;

/** One request-timeout budget for the probe -- deliberately fixed (not settings-configurable): a manual, one-off diagnostic tool, not part of the polling engine's own configurable `commandTimeoutMs`. */
const PROBE_TIMEOUT_MS = 3_000;
const MAX_LOG_ENTRIES = 50;

interface ProbeLogEntry {
  id: number;
  atLabel: string;
  mode: DidProbeMode;
  targetAddressHex: string;
  requestHex: string;
  ok: boolean;
  detail: string;
  roundTripMs?: number;
}

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

/**
 * Fires ONE whitelisted UDS request over `transport` and resolves with the
 * raw response frame hex + parsed NRC (if any) once a diagnostic-control
 * response frame arrives (ack/alive-check/status frames are ignored --
 * they're not the answer this probe is waiting for), or rejects on timeout /
 * transport close / a malformed response. Connects and closes the transport
 * itself -- this screen never keeps a connection open between probes, same
 * "no retry, no persistence" spirit as the rest of this dev-only tool.
 */
async function sendOneProbeRequest(
  transport: ObdTransport,
  testerAddress: number,
  targetAddress: number,
  pdu: Uint8Array,
): Promise<{ rawHex: string; nrc?: number; roundTripMs: number }> {
  const startedAtMs = Date.now();
  await transport.connect();
  try {
    return await new Promise<{ rawHex: string; nrc?: number; roundTripMs: number }>((resolve, reject) => {
      let settled = false;
      const parser = new HsfzFrameParser();

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

      const unsubscribeData = transport.onData((chunk) => {
        if (settled) return;
        let frames: HsfzFrame[];
        try {
          frames = parser.push(binaryStringToBytes(chunk));
        } catch {
          return; // A malformed frame here is not this probe's own request/response -- keep waiting for the timeout.
        }
        for (const frame of frames) {
          if (frame.control !== HSFZ_CONTROL.DIAGNOSTIC_REQ_RES) continue; // ack/alive-check/status/etc. -- not the answer.
          const rawHex = bytesToHex(encodeFrame(frame));
          const roundTripMs = Date.now() - startedAtMs;
          try {
            const parsed = parseUdsResponse(frame.payload);
            const nrc = parsed.kind === 'negative' ? parsed.nrc : undefined;
            finish(() => resolve({ rawHex, ...(nrc === undefined ? {} : { nrc }), roundTripMs }));
          } catch (error) {
            finish(() => reject(error instanceof Error ? error : new Error(String(error))));
          }
          return;
        }
      });

      const unsubscribeClose = transport.onClose((error) => {
        finish(() => reject(error ?? new Error('DID probe: transport closed before a response arrived')));
      });

      const frame = encodeFrame({
        control: HSFZ_CONTROL.DIAGNOSTIC_REQ_RES,
        source: testerAddress,
        target: targetAddress,
        payload: pdu,
      });
      transport.send(bytesToBinaryString(frame));
    });
  } finally {
    await transport.close();
  }
}

/**
 * Dev-only (`__DEV__` gated by the route registration, mirrors `DevReplay`)
 * ENET DID/PID probe: the empirical tool for discovering B58/DSC identifiers
 * (contracts.md ENET addendum) by sending ONE request at a time to a target
 * address and reading back the raw response. Every request is built by
 * `enetSettingsValidation.ts`'s `buildDidProbeRequest`, which re-checks the
 * SAME read-only whitelist (`{0x01, 0x22, 0x3E}`) the ENET session engine
 * itself enforces -- "the whitelist error is shown, not bypassed": a rejected
 * request never reaches a transport at all, it just renders inline like any
 * other input error. Talks to the same adapter settings (`enetHost`/
 * `enetPort`/`enetTesterAddress`) and honors `telemetrySimulate` (dev) the
 * same as the telemetry monitor, but owns its OWN one-shot transport --
 * independent of `telemetryProvider`'s continuous polling session, so probing
 * never interferes with (or requires) an active telemetry session.
 */
export function DidProbeScreen(_props: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const [mode, setMode] = React.useState<DidProbeMode>('did');
  const [targetAddressDraft, setTargetAddressDraft] = React.useState(formatHexByte(settings.enetTargetAddress));
  const [requestHexDraft, setRequestHexDraft] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const [error, setErrorText] = React.useState<string | null>(null);
  const [log, setLog] = React.useState<ProbeLogEntry[]>([]);
  const nextLogId = React.useRef(0);

  function appendLog(entry: Omit<ProbeLogEntry, 'id' | 'atLabel'>): void {
    const record: ProbeLogEntry = { ...entry, id: nextLogId.current, atLabel: new Date().toLocaleTimeString() };
    nextLogId.current += 1;
    setLog((prev) => [record, ...prev].slice(0, MAX_LOG_ENTRIES));
  }

  async function send(): Promise<void> {
    setErrorText(null);
    const targetAddress = parseHexByteDraft(targetAddressDraft);
    if (targetAddress === null) {
      setErrorText('Target address: enter a hex byte, 00-FF');
      return;
    }
    const built = buildDidProbeRequest(mode, requestHexDraft);
    if (!built.ok || built.pdu === null) {
      setErrorText(built.error ?? 'Invalid request');
      appendLog({
        mode,
        targetAddressHex: formatHexByte(targetAddress),
        requestHex: requestHexDraft,
        ok: false,
        detail: built.error ?? 'Invalid request',
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

    try {
      const result = await sendOneProbeRequest(transport, settings.enetTesterAddress, targetAddress, built.pdu);
      const detail =
        result.nrc === undefined
          ? `OK: ${result.rawHex}`
          : `NRC ${nrcLabel(result.nrc)} -- raw: ${result.rawHex}`;
      appendLog({
        mode,
        targetAddressHex: formatHexByte(targetAddress),
        requestHex: requestHexDraft,
        ok: true,
        detail,
        roundTripMs: result.roundTripMs,
      });
    } catch (probeError) {
      const message = probeError instanceof Error ? probeError.message : String(probeError);
      setErrorText(message);
      appendLog({
        mode,
        targetAddressHex: formatHexByte(targetAddress),
        requestHex: requestHexDraft,
        ok: false,
        detail: message,
      });
    } finally {
      setSending(false);
    }
  }

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
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
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
              accessibilityLabel="DID probe request hex"
            />
          </View>

          {error === null ? null : (
            <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}

          <Pressable
            style={[styles.button, sending && styles.buttonDisabled]}
            onPress={() => void send()}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel="Send DID probe request"
            accessibilityState={{ disabled: sending }}
          >
            <Text style={styles.buttonText} maxFontSizeMultiplier={1.3}>
              {sending ? 'Sending…' : 'Send'}
            </Text>
          </Pressable>
        </View>

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          LOG (last {MAX_LOG_ENTRIES})
        </Text>
        {log.length === 0 ? (
          <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
            No probes sent yet.
          </Text>
        ) : (
          log.map((entry) => (
            <View key={entry.id} style={styles.logRow}>
              <Text style={styles.logHeader} maxFontSizeMultiplier={1.3}>
                {entry.atLabel} · {entry.mode === 'did' ? '0x22' : '0x01'} {entry.requestHex} → {entry.targetAddressHex}
                {entry.roundTripMs === undefined ? '' : ` · ${entry.roundTripMs}ms`}
              </Text>
              <Text
                style={[styles.logDetail, !entry.ok && styles.logDetailError]}
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
  sectionLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.sm },
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
});
