import React, { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { TraceLogo } from '../components/TraceLogo';
import { TraceWordmark } from '../components/TraceWordmark';
import { StatusBanner } from '../components/StatusBanner';
import { circuitCatalog, type CircuitSummary } from '../../session/circuitCatalog';
import {
  abandonPendingSession,
  pendingSessionStage,
  selectCircuit,
  settingsStore,
} from '../../session/composition';
import { layoutLabel } from '../data/circuit';
import { useSettings } from '../hooks/useSettings';
import { resolveTestLoopStrings, type TestLoopStrings } from './testLoopStrings';

type Props = NativeStackScreenProps<RootStackParamList, 'CircuitSelection'>;

/**
 * Ticket D1 (flow review, §0) -- EVERY REFUSAL A DRIVER CAN CAUSE REACHES THE
 * DRIVER.
 *
 * `selectCircuit()` refuses with `{ ok:false, reason:'SESSION_ACTIVE' }` while
 * the controller is not between sessions. This screen used to answer that with
 * `console.warn` and a bare `return`: the row greyed out, the spinner ran for
 * an instant, and nothing else happened -- no banner, no toast, no navigation.
 * Since circuit selection is the initial route and the ONLY door to Detail,
 * Preflight, History and Settings, a driver who reached a refusing state (by
 * cancelling the Learn lap and backing out, which the owner's test protocol
 * asks him to do deliberately) was left tapping inert rows with no way out but
 * a force-quit.
 *
 * So the refusal is now stated, and it comes with the specific way out:
 * a session that was only ever being SET UP can be ended from right here,
 * and one that is genuinely being DRIVEN sends the driver back to the screen
 * that owns it.
 */
interface SelectionBlock {
  message: string;
  action: 'abandon' | 'toDashboard' | 'toCalibration' | 'retry';
  actionLabel: string;
}

const BLOCK_SETUP: SelectionBlock = {
  message:
    'A session is still open from a Learn lap that was cancelled. Nothing was recorded on it. Close it to pick a circuit.',
  action: 'abandon',
  actionLabel: 'Close it',
};

const BLOCK_DRIVING: SelectionBlock = {
  message:
    'A session is running, so the circuit cannot be changed. Finish it on the timing screen first.',
  action: 'toDashboard',
  actionLabel: 'Back to the session',
};

const BLOCK_CALIBRATING: SelectionBlock = {
  message:
    'A Learn lap is running, so the circuit cannot be changed. Finish or cancel it first.',
  action: 'toCalibration',
  actionLabel: 'Back to the Learn lap',
};

const BLOCK_UNKNOWN: SelectionBlock = {
  message: 'That circuit could not be selected just now.',
  action: 'retry',
  actionLabel: 'Try again',
};

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
  // Ticket D1: the refusal the driver can actually cause, in words, with the
  // control that resolves it. `null` whenever nothing is in the way.
  const [block, setBlock] = useState<SelectionBlock | null>(null);
  const [blockBusy, setBlockBusy] = useState(false);
  const [lastRefusedId, setLastRefusedId] = useState<string | null>(null);

  const select = async (circuitId: string): Promise<void> => {
    // Ticket CN-W3 (H1/H2 fixes, ticket CN-FIX2): persist the selection
    // (and rebuild the per-circuit history store) BEFORE navigating, so
    // CircuitDetail/History/PB already reflect the tapped circuit the
    // instant they mount.
    const result = await selectCircuit(circuitId);
    if (!result.ok) {
      // Ticket D1: stated, never logged and dropped. Which way out is offered
      // depends on what is actually holding the app.
      const stage = pendingSessionStage();
      setLastRefusedId(circuitId);
      setBlock(
        stage === 'setup'
          ? BLOCK_SETUP
          : stage === 'calibrating'
            ? BLOCK_CALIBRATING
            : stage === 'driving'
              ? BLOCK_DRIVING
              : BLOCK_UNKNOWN,
      );
      return;
    }
    setBlock(null);
    setLastRefusedId(null);
    navigation.navigate('CircuitDetail', { circuitId });
  };

  const handlePress = (circuitId: string): void => {
    if (selectingId !== null) return;
    setSelectingId(circuitId);
    void (async () => {
      try {
        await select(circuitId);
      } catch (error) {
        console.warn('[CircuitSelectionScreen] selectCircuit failed', error);
        setLastRefusedId(circuitId);
        setBlock(BLOCK_UNKNOWN);
      } finally {
        setSelectingId(null);
      }
    })();
  };

  const handleBlockAction = (): void => {
    const current = block;
    if (current === null || blockBusy) return;
    if (current.action === 'toDashboard') {
      navigation.navigate('ActiveDashboard');
      return;
    }
    if (current.action === 'toCalibration') {
      navigation.navigate('ActiveCalibration');
      return;
    }
    setBlockBusy(true);
    void (async () => {
      try {
        if (current.action === 'abandon') {
          const outcome = await abandonPendingSession();
          if (!outcome.ok) {
            // It became a real drive between the refusal and this tap.
            setBlock(BLOCK_DRIVING);
            return;
          }
        }
        setBlock(null);
        // Carry the driver through to what they originally tapped.
        if (lastRefusedId !== null) await select(lastRefusedId);
      } catch (error) {
        console.warn('[CircuitSelectionScreen] clearing the blocked selection failed', error);
        setBlock(BLOCK_UNKNOWN);
      } finally {
        setBlockBusy(false);
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

        {/* Ticket D1: the refusal, and the control that resolves it. */}
        {block !== null ? (
          <View style={styles.blockCard} accessibilityLiveRegion="polite">
            <StatusBanner variant="error" message={block.message} />
            <Pressable
              style={[styles.blockButton, blockBusy && styles.rowDisabled]}
              onPress={handleBlockAction}
              disabled={blockBusy}
              accessibilityRole="button"
              accessibilityLabel={block.actionLabel}
              accessibilityState={{ disabled: blockBusy, busy: blockBusy }}
            >
              {blockBusy ? (
                <ActivityIndicator color={colors.onAccent} />
              ) : (
                <Text style={styles.blockButtonText} maxFontSizeMultiplier={1.3}>
                  {block.actionLabel}
                </Text>
              )}
            </Pressable>
          </View>
        ) : null}

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
  // Ticket D1: the blocked-selection card.
  blockCard: {
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  blockButton: {
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.accent,
  },
  blockButtonText: {
    ...typography.subtitle,
    color: colors.onAccent,
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
