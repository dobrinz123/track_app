import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { TraceLogo } from '../components/TraceLogo';
import { TraceWordmark } from '../components/TraceWordmark';
import { circuitCatalog, type CircuitSummary } from '../../session/circuitCatalog';
import { selectCircuit, settingsStore } from '../../session/composition';
import { layoutLabel } from '../data/circuit';
import { useSettings } from '../hooks/useSettings';
import { resolveTestLoopStrings, type TestLoopStrings } from './testLoopStrings';

type Props = NativeStackScreenProps<RootStackParamList, 'CircuitSelection'>;

/**
 * S1 -- multi-circuit-ready selection list, driven by `AppCircuitCatalog`.
 * The screen is built as an N-row list so a new catalog entry needs no
 * layout change. ODbL attribution and the recreational-timing-aid
 * disclaimer live on S2 (Circuit Detail) and Settings > About now, not here.
 */
export function CircuitSelectionScreen({ navigation }: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const testLoopStrings = resolveTestLoopStrings(settings.language);
  const circuits = circuitCatalog.list();
  // H1 fix (ticket CN-FIX2, binding): `selectCircuit()` now awaits bootstrap
  // internally, so a tap during a slow cold-launch can take a moment to
  // settle -- every row disables while ANY selection is in flight, and the
  // tapped row shows a spinner in place of its chevron, instead of allowing
  // a second tap to queue behind the first with no visible feedback.
  const [selectingId, setSelectingId] = useState<string | null>(null);

  const handlePress = (circuitId: string): void => {
    if (selectingId !== null) return;
    setSelectingId(circuitId);
    void (async () => {
      try {
        // Ticket CN-W3 (H1/H2 fixes, ticket CN-FIX2): persist the selection
        // (and rebuild the per-circuit history store) BEFORE navigating, so
        // CircuitDetail/History/PB already reflect the tapped circuit the
        // instant they mount. `selectCircuit()` only ever refuses
        // (`{ ok: false, reason: 'SESSION_ACTIVE' }`) while a session is
        // genuinely live -- unreachable from this screen in normal use, but
        // navigation is skipped (and a warning logged) rather than assumed
        // to have succeeded.
        const result = await selectCircuit(circuitId);
        if (!result.ok) {
          console.warn(`[CircuitSelectionScreen] selectCircuit refused: ${result.reason ?? 'unknown reason'}`);
          return;
        }
        navigation.navigate('CircuitDetail', { circuitId });
      } catch (error) {
        console.warn('[CircuitSelectionScreen] selectCircuit failed', error);
      } finally {
        setSelectingId(null);
      }
    })();
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.brandRow}>
          <TraceLogo size={56} />
          <View style={styles.brandText}>
            <Text style={styles.kicker} maxFontSizeMultiplier={1.3}>
              CIRCUITS
            </Text>
            <TraceWordmark size={40} style={styles.wordmark} />
          </View>
        </View>

        <View style={styles.list}>
          {circuits.map((circuit, index) => (
            <CircuitRow
              key={circuit.circuitId}
              circuit={circuit}
              bordered={index > 0}
              disabled={selectingId !== null}
              busy={selectingId === circuit.circuitId}
              learnedLabel={testLoopStrings.learnedLabel}
              onPress={() => handlePress(circuit.circuitId)}
            />
          ))}
          {
            // Ticket P5d T2/T6 (binding, user decision): learning a track is a
            // first-class way to get a circuit, so its entry point sits HERE,
            // under the circuits, with no developer gate of any kind.
          }
          <Pressable
            style={[styles.row, styles.rowBorder, selectingId !== null && styles.rowDisabled]}
            onPress={() => navigation.navigate('TestLoop')}
            disabled={selectingId !== null}
            accessibilityRole="button"
            accessibilityLabel={testLoopStrings.entryA11y}
          >
            <View style={styles.rowMain}>
              <Text style={styles.rowTitle} maxFontSizeMultiplier={1.3}>
                {testLoopStrings.entryTitle}
              </Text>
              <Text style={styles.rowSubtitle} maxFontSizeMultiplier={1.3}>
                {testLoopStrings.entrySubtitle}
              </Text>
            </View>
            <Text
              style={styles.chevron}
              maxFontSizeMultiplier={1.3}
              accessibilityElementsHidden
              importantForAccessibility="no"
            >
              ›
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function CircuitRow({
  circuit,
  bordered,
  disabled,
  busy,
  learnedLabel,
  onPress,
}: {
  circuit: CircuitSummary;
  bordered: boolean;
  disabled: boolean;
  busy: boolean;
  /** Ticket P5d T6: the label a LEARNED circuit carries, in the app's language. */
  learnedLabel: TestLoopStrings['learnedLabel'];
  onPress: () => void;
}): React.JSX.Element {
  const lengthKm = (circuit.lengthM / 1000).toFixed(3);
  const learned = circuit.origin === 'learned';
  // ticket CN-FIX3b: the chip and the spoken label both read the friendly
  // layout label; `circuit.layoutId` itself (the catalog/storage key) is
  // untouched.
  const layout = layoutLabel(circuit.layoutId);
  return (
    <Pressable
      style={[styles.row, bordered && styles.rowBorder, disabled && styles.rowDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
      accessibilityLabel={`${circuit.displayName}, ${learned ? learnedLabel : `${circuit.locality}, ${circuit.country}`}, ${lengthKm} kilometers, ${layout}. View circuit details.`}
    >
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} maxFontSizeMultiplier={1.3}>
          {circuit.displayName}
        </Text>
        <Text style={styles.rowSubtitle} maxFontSizeMultiplier={1.3}>
          {learned ? learnedLabel : `${circuit.locality} · ${circuit.country}`}
        </Text>
        <View style={styles.rowMetaRow}>
          <Text style={styles.rowMeta} maxFontSizeMultiplier={1.3}>
            {lengthKm} km
          </Text>
          <View style={styles.layoutChip}>
            <Text style={styles.layoutChipText} maxFontSizeMultiplier={1.3}>
              {layout}
            </Text>
          </View>
        </View>
      </View>
      {busy ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <Text
          style={styles.chevron}
          maxFontSizeMultiplier={1.3}
          accessibilityElementsHidden
          importantForAccessibility="no"
        >
          ›
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    padding: spacing.lg,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.xl,
  },
  brandText: {
    flex: 1,
    justifyContent: 'center',
  },
  kicker: {
    ...typography.kicker,
    color: colors.textMuted,
    marginBottom: spacing.xs / 2,
  },
  wordmark: {
    alignSelf: 'flex-start',
  },
  list: {
    borderRadius: radii.md,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  rowMain: {
    flex: 1,
  },
  rowTitle: {
    fontFamily: fontFamily.displaySemibold,
    fontSize: 19,
    color: colors.textPrimary,
  },
  rowSubtitle: {
    ...typography.body,
    color: colors.textSecondary,
    marginTop: spacing.xs / 2,
  },
  rowMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  rowMeta: {
    fontFamily: fontFamily.monoMedium,
    fontSize: 13,
    color: colors.textSecondary,
  },
  layoutChip: {
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  layoutChipText: {
    ...typography.label,
    fontSize: 10,
    color: colors.accent,
  },
  chevron: {
    fontSize: 22,
    color: colors.textMuted,
  },
  moreRow: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  moreText: {
    ...typography.caption,
    color: colors.textMuted,
    fontStyle: 'italic',
  },
});
