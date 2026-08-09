import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CoachCue, CornerSeverity } from '@circuit/core';
import { colors, fontFamily, radii, spacing, typography } from '../theme';

/** Fixed slot height (S7 dashboard, MUST DO: "no layout thrash") -- constant regardless of whether a cue is live, so the strip appearing/disappearing never shifts anything below it. */
export const COACH_STRIP_HEIGHT = 64;

export interface CoachStripProps {
  /** `null` renders the (still fixed-height) empty slot -- no corner currently in range, or engine confidence too low. */
  cue: CoachCue | null;
}

/**
 * Severity 1-6 -> {background, border, text}, using ONLY existing theme
 * tokens (no new palette entries -- `ui/theme/index.ts` is out of this
 * ticket's write set). Ramps from muted gray (1) through amber (4) to a
 * bright, high-contrast amber fill (6) -- deliberately never `colors.faster`/
 * `colors.slower`/`colors.quality*` (reserved telemetry semantics, contracts.md).
 */
const SEVERITY_STYLE: Record<CornerSeverity, { bg: string; border: string; text: string }> = {
  1: { bg: colors.surface, border: colors.border, text: colors.textMuted },
  2: { bg: colors.surface, border: colors.border, text: colors.textSecondary },
  3: { bg: colors.surfaceRaised, border: colors.textSecondary, text: colors.textSecondary },
  4: { bg: colors.accentDim, border: colors.accent, text: colors.accent },
  5: { bg: colors.accent, border: colors.accent, text: colors.onAccent },
  6: { bg: colors.accentPressed, border: colors.accentPressed, text: colors.textPrimary },
};

/** Shared severity chip -- also used by `CornersList` (CircuitDetailScreen) so both surfaces render the same 1-6 scale identically. */
export function SeverityChip({ severity }: { severity: CornerSeverity }): React.JSX.Element {
  const s = SEVERITY_STYLE[severity];
  return (
    <View
      style={[styles.severityChip, { backgroundColor: s.bg, borderColor: s.border }]}
      accessibilityLabel={`Severity ${severity} of 6`}
    >
      <Text style={[styles.severityText, { color: s.text }]} maxFontSizeMultiplier={1.2}>
        {severity}
      </Text>
    </View>
  );
}

function accessibleLabel(cue: CoachCue): string {
  const direction = cue.direction === 'left' ? 'left' : 'right';
  const speed = Math.round(cue.advisorySpeedKph);
  const distance = Math.round(cue.distanceToTargetM);
  const prefix = cue.kind === 'BRAKE' ? 'Brake now' : 'Corner ahead';
  return `${prefix}, corner ${cue.cornerId}, ${direction}, severity ${cue.severity} of 6, advisory ${speed} kilometers per hour, in ${distance} meters. Advisory only.`;
}

/**
 * S7 dashboard coach strip (Phase 3 coaching addendum). Always the SAME
 * fixed height whether idle or showing a live cue -- MUST DO: "no layout
 * thrash". BRAKE gets a static high-contrast amber fill (no animation loop,
 * per binding design direction); CORNER_AHEAD stays on the neutral surface
 * treatment with the severity chip carrying the emphasis instead.
 */
export function CoachStrip({ cue }: CoachStripProps): React.JSX.Element {
  const isBrake = cue?.kind === 'BRAKE';
  return (
    <View
      style={[styles.strip, isBrake ? styles.stripBrake : styles.stripIdle]}
      accessibilityRole="text"
      accessibilityLabel={cue === null ? 'No coaching cue' : accessibleLabel(cue)}
      accessibilityLiveRegion="polite"
    >
      {cue === null ? null : (
        <>
          <View style={styles.leftGroup}>
            <Text style={[styles.kind, isBrake && styles.textOnBrake]} maxFontSizeMultiplier={1.2}>
              {isBrake ? 'BRAKE' : 'CORNER'}
            </Text>
            <Text style={[styles.cornerNumber, isBrake && styles.textOnBrake]} maxFontSizeMultiplier={1.2}>
              {cue.direction === 'left' ? '←' : '→'} C{cue.cornerId}
            </Text>
          </View>
          <SeverityChip severity={cue.severity} />
          <View style={styles.rightGroup}>
            <Text style={[styles.speed, isBrake && styles.textOnBrake]} maxFontSizeMultiplier={1.2}>
              {Math.round(cue.advisorySpeedKph)} km/h
            </Text>
            <Text style={[styles.distance, isBrake && styles.textOnBrakeDim]} maxFontSizeMultiplier={1.2}>
              {Math.round(cue.distanceToTargetM)} m
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    height: COACH_STRIP_HEIGHT,
    borderRadius: radii.md,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.sm,
  },
  stripIdle: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  stripBrake: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  leftGroup: { flexShrink: 1 },
  kind: { ...typography.label, color: colors.textSecondary, letterSpacing: 1 },
  cornerNumber: { ...typography.subtitle, color: colors.textPrimary },
  textOnBrake: { color: colors.onAccent },
  textOnBrakeDim: { color: colors.onAccent, opacity: 0.75 },
  severityChip: {
    borderRadius: radii.sm,
    borderWidth: 1,
    minWidth: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  severityText: { ...typography.label, fontFamily: fontFamily.monoSemibold },
  rightGroup: { marginLeft: 'auto', alignItems: 'flex-end' },
  speed: { ...typography.timeSmall, color: colors.textPrimary, fontFamily: fontFamily.monoSemibold },
  distance: { ...typography.caption, color: colors.textSecondary, fontFamily: fontFamily.monoRegular },
});
