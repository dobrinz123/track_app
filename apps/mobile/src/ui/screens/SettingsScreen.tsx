import React from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import {
  deleteAllStoredUserData,
  estimateObservedRateHz,
  facade,
  getLiveDiagnostics,
  sessionHistoryStore,
  settingsStore,
  type LiveDiagnosticsSnapshot,
} from '../../session/composition';
import { useFacadeState } from '../hooks/useFacadeState';
import { useSettings } from '../hooks/useSettings';
import type { AdapterType, SpeedUnits } from '../../session/settingsStore';
import { validateCustomPidHex } from '../../session/customPidValidation';
import {
  formatHexByte,
  parseHexByteDraft,
  validateEnetChannelSpecsJson,
} from '../../session/enetSettingsValidation';

/** Session states that mean "there is an active session in progress" -- the delete-my-data control is hidden/disabled during all of these so it can never race a live write (M3 fix). */
const ACTIVE_SESSION_STATES = new Set([
  'preflight',
  'awaitingCalibration',
  'calibrating',
  'calibrationReview',
  'armed',
  'outLap',
  'timing',
  'inPit',
  'paused',
]);

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

/**
 * F11 fix (WPT3): validates a FULL port-field draft string -- returns the
 * parsed port only if the entire string is a plain 1-65535 integer, `null`
 * otherwise. Rejects partial-numeric garbage (`"123abc"`) that
 * `Number.parseInt` would otherwise silently truncate and accept as `123`.
 * Exported (pure, no React/RN import) so its exact behavior can be pinned by
 * a test -- `SettingsScreen` itself isn't unit-testable in this repo (see
 * `apps/mobile/test/session/settingsPortDraft.test.ts`'s own doc comment).
 */
export function parsePortDraft(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65_535) return null;
  return parsed;
}

/**
 * Telemetry addendum — channel revision (2026-08-11, binding): validates a
 * FULL `transOilPidHex` draft string on blur, same "validate the whole
 * string, not keystroke-by-keystroke" pattern as `parsePortDraft` above.
 * F1 HIGH fix (L1, binding): delegates to `customPidValidation.ts`'s
 * `validateCustomPidHex` -- the SAME whitelist L2 (`buildCustomPids`)
 * re-checks against whatever ends up persisted, so this screen and the
 * provider can never disagree about which requests are safe to send. Kept as
 * a thin wrapper (not re-implemented here) rather than removed, since
 * `commitTransOilPidDraft` below needs the full `{ value, error }` result to
 * show the F1 inline error string -- callers that only need the
 * accept/reject boolean can keep using this.
 */
export function parseHexPidDraft(text: string): string | null {
  const result = validateCustomPidHex(text);
  return result.ok ? result.value : null;
}

const DEADBAND_STEP_MS = 25;
const MIN_DEADBAND_MS = 0;
const MAX_DEADBAND_MS = 500;

const COVERAGE_BIN_PRESETS: Record<string, readonly number[]> = {
  '3 bins': [0.33, 0.66, 1],
  '4 bins': [0.25, 0.5, 0.75, 1],
  '5 bins': [0.2, 0.4, 0.6, 0.8, 1],
};

function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  labelPrefix,
}: {
  options: readonly { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  labelPrefix: string;
}): React.JSX.Element {
  return (
    <View style={styles.segmented}>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            style={[styles.segment, active && styles.segmentActive]}
            onPress={() => onChange(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${labelPrefix}: ${opt.label}${active ? ', selected' : ''}`}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]} maxFontSizeMultiplier={1.3}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** One label/value row in the DIAGNOSTICS section (MUST DO #3). */
function DiagnosticsRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.diagnosticsRow}>
      <Text style={styles.diagnosticsLabel} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
      <Text style={styles.diagnosticsValue} maxFontSizeMultiplier={1.3}>
        {value}
      </Text>
    </View>
  );
}

/** S12 — units, delta deadband, coverage bins (in-memory for now); About/licenses/attribution; delete-my-data (M3 fix). */
export function SettingsScreen({ navigation }: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const facadeState = useFacadeState(facade);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteBanner, setDeleteBanner] = React.useState<'success' | 'error' | null>(null);
  // M3 fix (ticket CN-FIX2): `deleteAllStoredUserData()`'s aggregate error
  // text (which bundled circuits rejected, if any) -- `null` on success or
  // when the call itself threw before producing a result.
  const [deleteErrorText, setDeleteErrorText] = React.useState<string | null>(null);
  /** CN-FIX5: the delete was REFUSED (a live session / an active dev replay), not attempted-and-failed -- the banner then names the condition instead of prompting a retry. */
  const [deleteRefused, setDeleteRefused] = React.useState(false);
  const [diagnostics, setDiagnostics] = React.useState<LiveDiagnosticsSnapshot | null>(null);

  // F11 fix (WPT3): a local string draft, distinct from the committed
  // `settings.adapterPort` number -- lets the field hold in-progress/empty
  // text while typing, and validates the WHOLE string only on blur/submit
  // (previously every keystroke ran `parseInt` immediately, so pasting
  // "123abc" silently committed 123, and an in-progress empty field snapped
  // back on every keystroke instead of just on blur).
  const [portDraft, setPortDraft] = React.useState(String(settings.adapterPort));
  const lastCommittedPort = React.useRef(settings.adapterPort);
  React.useEffect(() => {
    if (settings.adapterPort !== lastCommittedPort.current) {
      lastCommittedPort.current = settings.adapterPort;
      setPortDraft(String(settings.adapterPort));
    }
  }, [settings.adapterPort]);

  function commitPortDraft(): void {
    const parsed = parsePortDraft(portDraft);
    if (parsed !== null) {
      lastCommittedPort.current = parsed;
      settingsStore.update({ adapterPort: parsed });
      setPortDraft(String(parsed));
    } else {
      setPortDraft(String(lastCommittedPort.current));
    }
  }

  // Channel revision: same draft/blur pattern as the port field above --
  // holds in-progress text while typing, validates the WHOLE string only on
  // blur/submit via `parseHexPidDraft`.
  const [transOilPidDraft, setTransOilPidDraft] = React.useState(settings.transOilPidHex);
  const lastCommittedTransOilPid = React.useRef(settings.transOilPidHex);
  // F1 HIGH fix (L1, binding): non-null exactly while the current draft was
  // last rejected -- shown inline below the field as
  // `CUSTOM_PID_VALIDATION_ERROR` ("Only read services 21/22 allowed").
  // Cleared as soon as the user edits the field again (`onChangeText` below)
  // or the next commit succeeds.
  const [transOilPidError, setTransOilPidError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (settings.transOilPidHex !== lastCommittedTransOilPid.current) {
      lastCommittedTransOilPid.current = settings.transOilPidHex;
      setTransOilPidDraft(settings.transOilPidHex);
    }
  }, [settings.transOilPidHex]);

  function commitTransOilPidDraft(): void {
    const result = validateCustomPidHex(transOilPidDraft);
    if (result.ok) {
      lastCommittedTransOilPid.current = result.value;
      settingsStore.update({ transOilPidHex: result.value });
      setTransOilPidDraft(result.value);
      setTransOilPidError(null);
    } else {
      // F1 fix: unlike the port field, the invalid text is left in place
      // (not snapped back) so the user can see and correct exactly what they
      // typed, alongside the inline error below the field.
      setTransOilPidError(result.error);
    }
  }

  // ENET telemetry addendum (Phase 4e, binding): SAME draft/blur pattern as
  // the ELM327 port field above, one draft per validated ENET field --
  // `enetHost` is free text (no format validation, same as `adapterHost`
  // above, committed on every keystroke) so it has no draft of its own.
  const [enetPortDraft, setEnetPortDraft] = React.useState(String(settings.enetPort));
  const lastCommittedEnetPort = React.useRef(settings.enetPort);
  React.useEffect(() => {
    if (settings.enetPort !== lastCommittedEnetPort.current) {
      lastCommittedEnetPort.current = settings.enetPort;
      setEnetPortDraft(String(settings.enetPort));
    }
  }, [settings.enetPort]);

  function commitEnetPortDraft(): void {
    const parsed = parsePortDraft(enetPortDraft);
    if (parsed !== null) {
      lastCommittedEnetPort.current = parsed;
      settingsStore.update({ enetPort: parsed });
      setEnetPortDraft(String(parsed));
    } else {
      setEnetPortDraft(String(lastCommittedEnetPort.current));
    }
  }

  const [enetTesterAddressDraft, setEnetTesterAddressDraft] = React.useState(formatHexByte(settings.enetTesterAddress));
  const lastCommittedEnetTesterAddress = React.useRef(settings.enetTesterAddress);
  React.useEffect(() => {
    if (settings.enetTesterAddress !== lastCommittedEnetTesterAddress.current) {
      lastCommittedEnetTesterAddress.current = settings.enetTesterAddress;
      setEnetTesterAddressDraft(formatHexByte(settings.enetTesterAddress));
    }
  }, [settings.enetTesterAddress]);

  function commitEnetTesterAddressDraft(): void {
    const parsed = parseHexByteDraft(enetTesterAddressDraft);
    if (parsed !== null) {
      lastCommittedEnetTesterAddress.current = parsed;
      settingsStore.update({ enetTesterAddress: parsed });
      setEnetTesterAddressDraft(formatHexByte(parsed));
    } else {
      setEnetTesterAddressDraft(formatHexByte(lastCommittedEnetTesterAddress.current));
    }
  }

  const [enetTargetAddressDraft, setEnetTargetAddressDraft] = React.useState(formatHexByte(settings.enetTargetAddress));
  const lastCommittedEnetTargetAddress = React.useRef(settings.enetTargetAddress);
  React.useEffect(() => {
    if (settings.enetTargetAddress !== lastCommittedEnetTargetAddress.current) {
      lastCommittedEnetTargetAddress.current = settings.enetTargetAddress;
      setEnetTargetAddressDraft(formatHexByte(settings.enetTargetAddress));
    }
  }, [settings.enetTargetAddress]);

  function commitEnetTargetAddressDraft(): void {
    const parsed = parseHexByteDraft(enetTargetAddressDraft);
    if (parsed !== null) {
      lastCommittedEnetTargetAddress.current = parsed;
      settingsStore.update({ enetTargetAddress: parsed });
      setEnetTargetAddressDraft(formatHexByte(parsed));
    } else {
      setEnetTargetAddressDraft(formatHexByte(lastCommittedEnetTargetAddress.current));
    }
  }

  // Channel-specs JSON: same "invalid text stays in place, inline error below
  // the field" pattern as `transOilPidDraft` above -- a syntactically valid
  // draft is committed as-is (verbatim, not re-serialized) even when
  // `validateEnetChannelSpecsJson` reports per-entry warnings (those are
  // shown too, but never block the commit -- matching `validateEnetChannelSpecs`'s
  // own "drop bad entries, don't reject the whole list" model).
  const [enetChannelSpecsDraft, setEnetChannelSpecsDraft] = React.useState(settings.enetChannelSpecsJson);
  const lastCommittedEnetChannelSpecs = React.useRef(settings.enetChannelSpecsJson);
  const [enetChannelSpecsError, setEnetChannelSpecsError] = React.useState<string | null>(null);
  const [enetChannelSpecsWarnings, setEnetChannelSpecsWarnings] = React.useState<readonly string[]>([]);
  React.useEffect(() => {
    if (settings.enetChannelSpecsJson !== lastCommittedEnetChannelSpecs.current) {
      lastCommittedEnetChannelSpecs.current = settings.enetChannelSpecsJson;
      setEnetChannelSpecsDraft(settings.enetChannelSpecsJson);
    }
  }, [settings.enetChannelSpecsJson]);

  function commitEnetChannelSpecsDraft(): void {
    const result = validateEnetChannelSpecsJson(enetChannelSpecsDraft);
    if (result.ok) {
      lastCommittedEnetChannelSpecs.current = enetChannelSpecsDraft;
      settingsStore.update({ enetChannelSpecsJson: enetChannelSpecsDraft });
      setEnetChannelSpecsError(null);
      setEnetChannelSpecsWarnings(result.warnings);
    } else {
      setEnetChannelSpecsError(result.error);
      setEnetChannelSpecsWarnings([]);
    }
  }

  // MUST DO #3 -- read-on-focus + manual refresh only, never a polling
  // timer, so this adds no background work while a session is timing.
  useFocusEffect(
    React.useCallback(() => {
      setDiagnostics(getLiveDiagnostics());
    }, []),
  );

  const activeBinPreset =
    Object.entries(COVERAGE_BIN_PRESETS).find(
      ([, thresholds]) => thresholds.length === settings.coverageBins.thresholds.length,
    )?.[0] ?? '4 bins';

  const sessionCount = sessionHistoryStore.listSessions().length;
  const sessionActive = ACTIVE_SESSION_STATES.has(facadeState.sessionState);
  const sessionCountLabel = `${sessionCount} stored session${sessionCount === 1 ? '' : 's'}`;

  function startDeleteConfirm(): void {
    setDeleteBanner(null);
    setConfirmingDelete(true);
  }

  function cancelDeleteConfirm(): void {
    setConfirmingDelete(false);
  }

  async function confirmDelete(): Promise<void> {
    setDeleting(true);
    try {
      const result = await deleteAllStoredUserData();
      setDeleteBanner(result.ok ? 'success' : 'error');
      setDeleteErrorText(result.ok ? null : result.errorText);
      setDeleteRefused(!result.ok && result.reason !== undefined);
    } catch {
      setDeleteBanner('error');
      setDeleteErrorText(null);
      setDeleteRefused(false);
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Settings
        </Text>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            UNITS
          </Text>
          <SegmentedControl<SpeedUnits>
            labelPrefix="Speed units"
            value={settings.units}
            onChange={(units) => settingsStore.update({ units })}
            options={[
              { label: 'km/h', value: 'kmh' },
              { label: 'mph', value: 'mph' },
            ]}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            DELTA DEADBAND
          </Text>
          <View style={styles.stepperRow}>
            <Pressable
              style={styles.stepperButton}
              onPress={() =>
                settingsStore.update({ deltaDeadbandMs: Math.max(MIN_DEADBAND_MS, settings.deltaDeadbandMs - DEADBAND_STEP_MS) })
              }
              accessibilityRole="button"
              accessibilityLabel="Decrease delta deadband"
            >
              <Text style={styles.stepperButtonText} maxFontSizeMultiplier={1.3}>
                −
              </Text>
            </Pressable>
            <Text style={styles.stepperValue} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
              {settings.deltaDeadbandMs} ms
            </Text>
            <Pressable
              style={styles.stepperButton}
              onPress={() =>
                settingsStore.update({ deltaDeadbandMs: Math.min(MAX_DEADBAND_MS, settings.deltaDeadbandMs + DEADBAND_STEP_MS) })
              }
              accessibilityRole="button"
              accessibilityLabel="Increase delta deadband"
            >
              <Text style={styles.stepperButtonText} maxFontSizeMultiplier={1.3}>
                +
              </Text>
            </Pressable>
          </View>
          <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
            Delta shows neutral (gray) when the live gap is within this many milliseconds of the reference.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            COACHING
          </Text>
          <View style={styles.toggleRow}>
            <View style={styles.toggleTextGroup}>
              <Text style={styles.toggleTitle} maxFontSizeMultiplier={1.3}>
                Corner coaching
              </Text>
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                Advisory brake and corner cues on the driving dashboard and circuit screen. Not an official or
                safety-critical source.
              </Text>
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                Changes during an active session take effect at your next session.
              </Text>
            </View>
            <Switch
              value={settings.coachingEnabled}
              onValueChange={(value) => settingsStore.update({ coachingEnabled: value })}
              trackColor={{ false: colors.border, true: colors.accentDim }}
              thumbColor={settings.coachingEnabled ? colors.accent : colors.textMuted}
              accessibilityRole="switch"
              accessibilityLabel="Corner coaching"
              accessibilityState={{ checked: settings.coachingEnabled }}
            />
          </View>
          {settings.coachingEnabled ? (
            <View style={styles.toggleRow}>
              <View style={styles.toggleTextGroup}>
                <Text style={styles.toggleTitle} maxFontSizeMultiplier={1.3}>
                  Voice cues
                </Text>
                <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                  Short "Brake" / "Brake hard" / "Lift" callouts before a corner -- clear and quick even at speed.
                  Uses a premium voice pack when installed, your device's voice otherwise.
                </Text>
              </View>
              <Switch
                value={settings.voiceCoachEnabled}
                onValueChange={(value) => settingsStore.update({ voiceCoachEnabled: value })}
                trackColor={{ false: colors.border, true: colors.accentDim }}
                thumbColor={settings.voiceCoachEnabled ? colors.accent : colors.textMuted}
                accessibilityRole="switch"
                accessibilityLabel="Voice coaching cues"
                accessibilityState={{ checked: settings.voiceCoachEnabled }}
              />
            </View>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            TELEMETRY (OBD)
          </Text>
          <View style={styles.toggleRow}>
            <View style={styles.toggleTextGroup}>
              <Text style={styles.toggleTitle} maxFontSizeMultiplier={1.3}>
                Vehicle telemetry
              </Text>
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                Advisory, experimental: reads engine RPM, speed, throttle, engine oil, and coolant temperature
                from a WiFi OBD-II adapter on your local network. Strictly read-only -- never used for lap
                timing or safety decisions.
              </Text>
            </View>
            <Switch
              value={settings.telemetryEnabled}
              onValueChange={(value) => settingsStore.update({ telemetryEnabled: value })}
              trackColor={{ false: colors.border, true: colors.accentDim }}
              thumbColor={settings.telemetryEnabled ? colors.accent : colors.textMuted}
              accessibilityRole="switch"
              accessibilityLabel="Vehicle telemetry"
              accessibilityState={{ checked: settings.telemetryEnabled }}
            />
          </View>
          {settings.telemetryEnabled ? (
            <>
              <SegmentedControl<AdapterType>
                labelPrefix="Adapter type"
                value={settings.adapterType}
                onChange={(adapterType) => settingsStore.update({ adapterType })}
                options={[
                  { label: 'ELM327', value: 'elm327' },
                  { label: 'ENET (BMW)', value: 'enet' },
                ]}
              />

              {settings.adapterType === 'elm327' ? (
                <>
                  <View style={styles.fieldRow}>
                    <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                      Adapter host
                    </Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={settings.adapterHost}
                      onChangeText={(text) => settingsStore.update({ adapterHost: text })}
                      placeholder="192.168.0.10"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="numbers-and-punctuation"
                      accessibilityLabel="Telemetry adapter host"
                    />
                  </View>
                  <View style={styles.fieldRow}>
                    <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                      Adapter port
                    </Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={portDraft}
                      onChangeText={setPortDraft}
                      onBlur={commitPortDraft}
                      onSubmitEditing={commitPortDraft}
                      placeholder="35000"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="number-pad"
                      accessibilityLabel="Telemetry adapter port"
                    />
                  </View>
                  <View style={styles.fieldRow}>
                    <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                      Trans oil PID (hex)
                    </Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={transOilPidDraft}
                      onChangeText={(text) => {
                        setTransOilPidDraft(text);
                        if (transOilPidError !== null) setTransOilPidError(null);
                      }}
                      onBlur={commitTransOilPidDraft}
                      onSubmitEditing={commitTransOilPidDraft}
                      placeholder="disabled"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      keyboardType="numbers-and-punctuation"
                      accessibilityLabel="Transmission oil temperature PID, hex"
                    />
                  </View>
                  {transOilPidError === null ? null : (
                    <Text
                      style={styles.errorBanner}
                      maxFontSizeMultiplier={1.3}
                      accessibilityLiveRegion="polite"
                    >
                      {transOilPidError}
                    </Text>
                  )}
                  <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                    Advanced, vehicle-specific: read-only requests only (services 21/22). No standard PID exists for
                    transmission oil temperature -- enter your vehicle's raw hex request to enable the reading, or
                    leave blank to disable it. Advisory only -- consult your vehicle's documentation.
                  </Text>
                </>
              ) : (
                <>
                  <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                    BMW ENET (HSFZ over WiFi/TCP), advisory and experimental like every telemetry channel above.
                    Close the MHD app first -- the adapter allows one ECU client at a time.
                  </Text>
                  <View style={styles.fieldRow}>
                    <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                      Adapter host
                    </Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={settings.enetHost}
                      onChangeText={(text) => settingsStore.update({ enetHost: text })}
                      placeholder="read from adapter's web UI"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="numbers-and-punctuation"
                      accessibilityLabel="ENET adapter host"
                    />
                  </View>
                  <View style={styles.fieldRow}>
                    <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                      Adapter port
                    </Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={enetPortDraft}
                      onChangeText={setEnetPortDraft}
                      onBlur={commitEnetPortDraft}
                      onSubmitEditing={commitEnetPortDraft}
                      placeholder="6801"
                      placeholderTextColor={colors.textMuted}
                      keyboardType="number-pad"
                      accessibilityLabel="ENET adapter port"
                    />
                  </View>
                  <View style={styles.fieldRow}>
                    <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                      Tester address (hex)
                    </Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={enetTesterAddressDraft}
                      onChangeText={setEnetTesterAddressDraft}
                      onBlur={commitEnetTesterAddressDraft}
                      onSubmitEditing={commitEnetTesterAddressDraft}
                      placeholder="F4"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      keyboardType="numbers-and-punctuation"
                      accessibilityLabel="ENET tester address, hex byte"
                    />
                  </View>
                  <View style={styles.fieldRow}>
                    <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                      Target address (hex)
                    </Text>
                    <TextInput
                      style={styles.fieldInput}
                      value={enetTargetAddressDraft}
                      onChangeText={setEnetTargetAddressDraft}
                      onBlur={commitEnetTargetAddressDraft}
                      onSubmitEditing={commitEnetTargetAddressDraft}
                      placeholder="12"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      keyboardType="numbers-and-punctuation"
                      accessibilityLabel="ENET target address, hex byte"
                    />
                  </View>
                  <View style={styles.fieldColumn}>
                    <Text style={styles.fieldLabel} maxFontSizeMultiplier={1.3}>
                      Channel specs (JSON, advanced)
                    </Text>
                    <TextInput
                      style={styles.multilineInput}
                      value={enetChannelSpecsDraft}
                      onChangeText={(text) => {
                        setEnetChannelSpecsDraft(text);
                        if (enetChannelSpecsError !== null) setEnetChannelSpecsError(null);
                      }}
                      onBlur={commitEnetChannelSpecsDraft}
                      placeholder="blank = built-in defaults"
                      placeholderTextColor={colors.textMuted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      multiline
                      numberOfLines={4}
                      accessibilityLabel="ENET channel specs, JSON"
                    />
                  </View>
                  {enetChannelSpecsError === null ? null : (
                    <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                      {enetChannelSpecsError}
                    </Text>
                  )}
                  {enetChannelSpecsWarnings.length === 0 ? null : (
                    <Text style={styles.warningBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                      {enetChannelSpecsWarnings.join('; ')}
                    </Text>
                  )}
                  <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                    Advanced, vehicle-specific: a JSON array of channel requests (obd01 PID or mode-22 DID, with
                    provenance for any DID entry). Leave blank to use the built-in defaults.
                  </Text>
                </>
              )}

              {
                // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
                __DEV__ ? (
                <View style={styles.toggleRow}>
                  <View style={styles.toggleTextGroup}>
                    <Text style={styles.toggleTitle} maxFontSizeMultiplier={1.3}>
                      Simulate adapter (dev)
                    </Text>
                    <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                      Uses a scripted in-app vehicle model instead of a real adapter -- development only. Applies to
                      whichever adapter type is selected above.
                    </Text>
                  </View>
                  <Switch
                    value={settings.telemetrySimulate}
                    onValueChange={(value) => settingsStore.update({ telemetrySimulate: value })}
                    trackColor={{ false: colors.border, true: colors.accentDim }}
                    thumbColor={settings.telemetrySimulate ? colors.accent : colors.textMuted}
                    accessibilityRole="switch"
                    accessibilityLabel="Simulate telemetry adapter"
                    accessibilityState={{ checked: settings.telemetrySimulate }}
                  />
                </View>
              ) : null}
              <Pressable
                style={styles.telemetryLinkRow}
                onPress={() => navigation.navigate('Telemetry')}
                accessibilityRole="button"
                accessibilityLabel="Open telemetry monitor"
              >
                <Text style={styles.telemetryLinkText} maxFontSizeMultiplier={1.3}>
                  Open telemetry monitor
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            COVERAGE BINS
          </Text>
          <SegmentedControl<string>
            labelPrefix="Calibration coverage bins"
            value={activeBinPreset}
            onChange={(key) => settingsStore.update({ coverageBins: { thresholds: COVERAGE_BIN_PRESETS[key]! } })}
            options={Object.keys(COVERAGE_BIN_PRESETS).map((k) => ({ label: k, value: k }))}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            ABOUT
          </Text>
          <View style={styles.aboutCard}>
            <Text style={styles.aboutText} maxFontSizeMultiplier={1.3}>
              Circuit geometry data © OpenStreetMap contributors, available under the Open Database License (ODbL)
              1.0. Start/finish and sector boundaries are app-defined, not official.
            </Text>
            <Text style={styles.aboutText} maxFontSizeMultiplier={1.3}>
              This app is a recreational timing aid, not an official or certified timing system. Do not rely on it
              for competitive scoring or safety-critical decisions.
            </Text>
            <Text style={styles.aboutSubLabel} maxFontSizeMultiplier={1.3}>
              Third-party software
            </Text>
            <Text style={styles.aboutText} maxFontSizeMultiplier={1.3}>
              Built with Expo, React Native, and React Navigation, each under their respective open-source licenses.
            </Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
            DATA
          </Text>
          <View style={styles.dataCard}>
            {sessionActive ? (
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                End the current session before deleting stored data.
              </Text>
            ) : !confirmingDelete ? (
              <Pressable
                style={styles.deleteRow}
                onPress={startDeleteConfirm}
                accessibilityRole="button"
                accessibilityLabel={`Delete all my data. ${sessionCountLabel}.`}
              >
                <Text style={styles.deleteRowText} maxFontSizeMultiplier={1.3}>
                  Delete all my data
                </Text>
                <Text style={styles.deleteRowMeta} maxFontSizeMultiplier={1.3}>
                  {sessionCountLabel}
                </Text>
              </Pressable>
            ) : (
              <View style={styles.confirmRow}>
                <Text style={styles.confirmText} maxFontSizeMultiplier={1.3}>
                  Permanently delete {sessionCountLabel}? This cannot be undone.
                </Text>
                <View style={styles.confirmButtonsRow}>
                  <Pressable
                    style={styles.cancelButton}
                    onPress={cancelDeleteConfirm}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel deletion"
                  >
                    <Text style={styles.cancelButtonText} maxFontSizeMultiplier={1.3}>
                      Cancel
                    </Text>
                  </Pressable>
                  <Pressable
                    style={styles.confirmDeleteButton}
                    onPress={() => void confirmDelete()}
                    disabled={deleting}
                    accessibilityRole="button"
                    accessibilityLabel="Confirm permanent deletion of all my data"
                    accessibilityState={{ disabled: deleting }}
                  >
                    <Text style={styles.confirmDeleteButtonText} maxFontSizeMultiplier={1.3}>
                      {deleting ? 'Deleting…' : 'Tap again to delete'}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
            {deleteBanner === 'success' ? (
              <Text style={styles.successBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                All stored data deleted.
              </Text>
            ) : null}
            {deleteBanner === 'error' ? (
              <Text style={styles.errorBanner} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">
                {/* CN-FIX5: a REFUSAL (`reason` set -- a live session or a dev
                    replay) is not a failure to retry: it names the fixed
                    condition to clear first. Genuine failures keep the
                    retry prompt. */}
                {deleteRefused && deleteErrorText !== null
                  ? `Nothing was deleted: ${deleteErrorText}.`
                  : deleteErrorText !== null
                    ? `Could not delete all data (${deleteErrorText}). Please try again.`
                    : 'Could not delete data. Please try again.'}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.diagnosticsHeaderRow}>
            <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
              DIAGNOSTICS
            </Text>
            <Pressable
              onPress={() => setDiagnostics(getLiveDiagnostics())}
              accessibilityRole="button"
              accessibilityLabel="Refresh diagnostics"
            >
              <Text style={styles.refreshText} maxFontSizeMultiplier={1.3}>
                Refresh
              </Text>
            </Pressable>
          </View>
          <View style={styles.aboutCard}>
            {diagnostics === null ? (
              <Text style={styles.helperText} maxFontSizeMultiplier={1.3}>
                Not available yet.
              </Text>
            ) : (
              <>
                <DiagnosticsRow
                  label="Observed GNSS rate"
                  value={
                    diagnostics.gnss === null
                      ? 'n/a (not the live GNSS session)'
                      : (() => {
                          const hz = estimateObservedRateHz(diagnostics.gnss.sampleIntervalHistogramMs);
                          return hz === null ? 'no samples yet' : `${hz.toFixed(2)} Hz`;
                        })()
                  }
                />
                <DiagnosticsRow
                  label="Accuracy p50 / p95"
                  value={
                    diagnostics.gnss === null
                      ? 'n/a'
                      : diagnostics.gnss.accuracyDistributionM.sampleCount === 0
                        ? 'no samples yet'
                        : `${diagnostics.gnss.accuracyDistributionM.p50M?.toFixed(1) ?? '—'} m / ${diagnostics.gnss.accuracyDistributionM.p95M?.toFixed(1) ?? '—'} m`
                  }
                />
                <DiagnosticsRow label="Rejected samples" value={String(diagnostics.controller.rejectedSampleCount)} />
                <DiagnosticsRow label="Watchdog restarts" value={String(diagnostics.controller.watchRestarts)} />
                <DiagnosticsRow
                  label="Reduced accuracy (iOS)"
                  value={diagnostics.gnss === null ? 'n/a' : diagnostics.gnss.reducedAccuracy ? 'yes' : 'no'}
                />
              </>
            )}
          </View>
        </View>

        {
          // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
          __DEV__ ? (
          <Pressable
            style={styles.devButton}
            onPress={() => navigation.navigate('DevReplay')}
            accessibilityRole="button"
            accessibilityLabel="Open developer replay tools"
          >
            <Text style={styles.devButtonText} maxFontSizeMultiplier={1.3}>
              Dev: Replay Fixtures
            </Text>
          </Pressable>
        ) : null}
        {
          // eslint-disable-next-line no-undef -- `__DEV__` is a React Native global (see react-native/src/types/globals.d.ts); not covered by this project's flat eslint config globals.
          __DEV__ ? (
          <Pressable
            style={styles.devButton}
            onPress={() => navigation.navigate('DidProbe')}
            accessibilityRole="button"
            accessibilityLabel="Open ENET DID probe"
          >
            <Text style={styles.devButtonText} maxFontSizeMultiplier={1.3}>
              Dev: DID Probe (ENET)
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary },
  section: { gap: spacing.sm },
  sectionLabel: { ...typography.label, color: colors.textMuted },
  segmented: { flexDirection: 'row', gap: spacing.sm },
  segment: {
    flex: 1,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  segmentActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  segmentText: { ...typography.body, color: colors.textSecondary },
  segmentTextActive: { color: colors.onAccent, fontFamily: fontFamily.bodySemibold },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepperButton: {
    width: 44,
    height: 44,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonText: { ...typography.title, color: colors.textPrimary },
  stepperValue: { ...typography.timeSmall, color: colors.textPrimary, minWidth: 90, textAlign: 'center' },
  helperText: { ...typography.caption, color: colors.textMuted },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  toggleTextGroup: { flex: 1, gap: 2 },
  toggleTitle: { ...typography.body, color: colors.textPrimary, fontFamily: fontFamily.bodySemibold },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md },
  fieldLabel: { ...typography.body, color: colors.textSecondary },
  fieldInput: {
    ...typography.body,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    minWidth: 140,
    textAlign: 'right',
  },
  fieldColumn: { gap: spacing.xs },
  multilineInput: {
    ...typography.caption,
    color: colors.textPrimary,
    fontFamily: fontFamily.monoSemibold,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    minHeight: 88,
    textAlignVertical: 'top',
  },
  warningBanner: { ...typography.caption, color: colors.warning },
  telemetryLinkRow: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  telemetryLinkText: { ...typography.body, color: colors.accent, fontFamily: fontFamily.bodySemibold },
  aboutCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  aboutText: { ...typography.caption, color: colors.textSecondary, lineHeight: 18 },
  aboutSubLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.xs },
  diagnosticsHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  refreshText: { ...typography.caption, color: colors.accent },
  diagnosticsRow: { flexDirection: 'row', justifyContent: 'space-between' },
  diagnosticsLabel: { ...typography.caption, color: colors.textMuted },
  diagnosticsValue: { ...typography.caption, color: colors.textPrimary },
  dataCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  deleteRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  deleteRowText: { ...typography.body, color: colors.danger, fontFamily: fontFamily.bodySemibold },
  deleteRowMeta: { ...typography.caption, color: colors.textMuted },
  confirmRow: { gap: spacing.sm },
  confirmText: { ...typography.body, color: colors.textPrimary },
  confirmButtonsRow: { flexDirection: 'row', gap: spacing.sm },
  cancelButton: {
    flex: 1,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  cancelButtonText: { ...typography.body, color: colors.textSecondary },
  confirmDeleteButton: {
    flex: 1,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.danger,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  confirmDeleteButtonText: { ...typography.body, color: colors.textPrimary, fontFamily: fontFamily.bodySemibold },
  successBanner: { ...typography.caption, color: colors.success },
  errorBanner: { ...typography.caption, color: colors.danger },
  devButton: {
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.warning,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  devButtonText: { ...typography.subtitle, color: colors.warning },
});
