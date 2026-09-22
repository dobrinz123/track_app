import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { LapVerdictDecision } from '@circuit/core';

import type { LapVerdictRowModel } from '../../session/lapVerdictViewModel';
import type { LapVerdictStrings } from '../screens/lapVerdictStrings';
import { colors, fontFamily, radii, spacing, typography } from '../theme';

/**
 * Ticket P13B item 1 -- the true/false control, drawn.
 *
 * Deliberately decision-free: every judgement it renders was made by
 * `lapVerdictViewModel.ts` and every word it shows came from
 * `lapVerdictStrings.ts`, both of which vitest executes. This repo has no
 * React Native render harness, so what is NOT testable here is kept to markup
 * and style.
 *
 * Three things the styling is load-bearing for, all from the ticket:
 *
 *  - an UNANSWERED lap looks different from an answered one at a glance (a
 *    dashed amber edge and a "TO DO" badge), because the owner has to see what
 *    he still owes between stints;
 *  - the targets are big (56 pt minimum, full width, one per row), because he
 *    reads this in a helmet, in sunlight, with gloves on;
 *  - the SELECTED answer is filled, not merely outlined, so a tap that
 *    registered cannot be confused with one that did not.
 */
export function LapVerdictControl({
  row,
  strings,
  enabled,
  busy,
  onDecide,
}: {
  row: LapVerdictRowModel;
  strings: LapVerdictStrings;
  /** False when this device cannot store answers -- the buttons are shown disabled, never hidden. */
  enabled: boolean;
  /** A write for THIS lap is in flight. */
  busy: boolean;
  onDecide: (lapNumber: number, decision: LapVerdictDecision) => void;
}): React.JSX.Element {
  const disabled = !enabled || busy;
  return (
    <View
      style={[styles.block, row.answered ? styles.blockAnswered : styles.blockUnanswered]}
      accessibilityLabel={`${strings.question} ${
        row.answered
          ? row.answer === 'agreed'
            ? strings.answeredAgreed
            : strings.answeredDisagreed
          : strings.unanswered
      }`}
    >
      <View style={styles.headerRow}>
        <Text style={styles.question} maxFontSizeMultiplier={1.3}>
          {strings.question}
        </Text>
        {row.unsavedAnswer === undefined ? (
          row.answered ? null : (
            <Text style={styles.todoBadge} maxFontSizeMultiplier={1.3}>
              {strings.unansweredBadge}
            </Text>
          )
        ) : (
          // Ticket P14 H1: an answer that is not on disk gets its own badge,
          // and it OUTRANKS "TO DO" -- the owner has done this lap; what has
          // not happened is the saving of it.
          <Text
            style={row.unsavedAnswer.state === 'failed' ? styles.unsavedBadge : styles.todoBadge}
            maxFontSizeMultiplier={1.3}
          >
            {row.unsavedAnswer.state === 'failed' ? strings.unsavedBadge : strings.pendingBadge}
          </Text>
        )}
      </View>

      <Pressable
        style={[
          styles.button,
          row.answer === 'agreed' ? styles.buttonAgreedSelected : styles.buttonIdle,
          disabled && styles.buttonDisabled,
        ]}
        onPress={() => onDecide(row.lapNumber, 'agreed')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled, selected: row.answer === 'agreed' }}
        accessibilityLabel={strings.agreeButtonA11y(row.lapNumber)}
      >
        <Text
          style={[styles.buttonText, row.answer === 'agreed' && styles.buttonTextSelected]}
          maxFontSizeMultiplier={1.3}
        >
          {strings.agreeButton}
        </Text>
      </Pressable>

      <Pressable
        style={[
          styles.button,
          row.answer === 'disagreed' ? styles.buttonDisagreedSelected : styles.buttonIdle,
          disabled && styles.buttonDisabled,
        ]}
        onPress={() => onDecide(row.lapNumber, 'disagreed')}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled, selected: row.answer === 'disagreed' }}
        accessibilityLabel={strings.disagreeButtonA11y(row.lapNumber)}
      >
        <Text
          style={[styles.buttonText, row.answer === 'disagreed' && styles.buttonTextSelected]}
          maxFontSizeMultiplier={1.3}
        >
          {strings.disagreeButton}
        </Text>
      </Pressable>

      <Text style={styles.state} maxFontSizeMultiplier={1.3}>
        {row.answered
          ? `${row.answer === 'agreed' ? strings.answeredAgreed : strings.answeredDisagreed}${
              row.answerRevision > 1 ? ` (${strings.revised(row.answerRevision)})` : ''
            }`
          : strings.unanswered}
      </Text>
      {/*
        Ticket P14 H1: PERSISTENT, per lap, for as long as the answer is not on
        disk. The transient note under the list was the only warning before,
        and the next tap on any lap wiped it -- so an answer that never reached
        storage went on reading as one that had.
      */}
      {row.unsavedAnswer?.state === 'failed' ? (
        <Text style={styles.unsavedNotice} maxFontSizeMultiplier={1.3}>
          {strings.unsavedNotice}
          {row.unsavedAnswer.detail === undefined ? '' : ` (${row.unsavedAnswer.detail})`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // Ticket P14 H1: louder than the amber "TO DO" -- an answer that did not
  // reach storage is a fault, not an outstanding task.
  unsavedBadge: {
    color: colors.slower,
    fontFamily: fontFamily.bodyMedium,
    fontSize: typography.caption.fontSize,
    letterSpacing: 1,
  },
  unsavedNotice: {
    color: colors.slower,
    fontFamily: fontFamily.bodyRegular,
    fontSize: typography.caption.fontSize,
  },
  block: {
    borderRadius: radii.md,
    borderWidth: 1,
    padding: spacing.sm,
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  // The visible difference the ticket asks for, at a glance and without
  // reading: outstanding work is amber and dashed, done work is quiet.
  blockUnanswered: {
    borderColor: colors.accent,
    borderStyle: 'dashed',
    backgroundColor: colors.surfaceRaised,
  },
  blockAnswered: { borderColor: colors.border, backgroundColor: colors.surface },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.xs },
  question: { ...typography.caption, color: colors.textSecondary, flex: 1 },
  todoBadge: { ...typography.label, color: colors.accent },
  button: {
    minHeight: 56,
    borderRadius: radii.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  buttonIdle: { backgroundColor: colors.surfaceRaised, borderColor: colors.border },
  buttonAgreedSelected: { backgroundColor: colors.success, borderColor: colors.success },
  buttonDisagreedSelected: { backgroundColor: colors.danger, borderColor: colors.danger },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { ...typography.subtitle, color: colors.textPrimary, textAlign: 'center' },
  buttonTextSelected: { color: colors.onAccent, fontFamily: fontFamily.bodySemibold },
  state: { ...typography.caption, color: colors.textMuted },
});
