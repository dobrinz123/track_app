import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CoachCue, CornerSeverity } from '@circuit/core';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { formatSpeedShort, formatSpeedSpoken } from '../format';
import { settingsStore } from '../../session/composition';
import { useSettings } from '../hooks/useSettings';

/** Fixed slot height (S7 dashboard, MUST DO: "no layout thrash") -- constant regardless of whether a cue is live, so the strip appearing/disappearing never shifts anything below it. */
export const COACH_STRIP_HEIGHT = 64;

export interface CoachStripProps {
  /** `null` renders the (still fixed-height) empty slot -- no corner currently in range, or engine confidence too low. */
  cue: CoachCue | null;
}

/**
 * Severity 1-6 -> {background, border, text} (M-contrast fix). Every entry
 * is a fully OPAQUE background paired with a text color chosen for >=4.5:1
 * self-contrast -- deliberately no translucent fill (the previous severity
 * 4's `accentDim` composited with whatever strip background sat behind it,
 * which on the amber BRAKE strip read as near-1:1 amber-on-amber) and no
 * light-on-medium-amber pairing (the previous severity 6 read ~2.5:1).
 * Severities 5-6 now use `onAccent` (near-black) DARK TEXT on their amber
 * fills, per the binding design direction. Computed WCAG contrast ratios
 * (relative luminance, both colors from `ui/theme/index.ts`, unaffected by
 * whatever sits behind the chip since its own fill is opaque):
 *   1: textSecondary #9A9AA3 / surface      #121216 -> 6.70:1
 *   2: textSecondary #9A9AA3 / surfaceRaised #1A1A20 -> 6.21:1
 *   3: textPrimary   #F2F2F4 / surfaceRaised #1A1A20 -> 15.49:1
 *   4: accent        #FFB300 / surface      #121216 -> 10.41:1
 *   5: onAccent      #0A0A0C / accent       #FFB300 -> 11.02:1
 *   6: onAccent      #0A0A0C / accentPressed #CC8F00 -> 7.06:1
 * All comfortably clear the 4.5:1 WCAG AA normal-text threshold. Deliberately
 * never `colors.faster`/`colors.slower`/`colors.quality*` (reserved
 * telemetry semantics, contracts.md) and no new palette entries (`ui/theme/
 * index.ts` is out of this ticket's write set).
 */
const SEVERITY_STYLE: Record<CornerSeverity, { bg: string; border: string; text: string }> = {
  1: { bg: colors.surface, border: colors.border, text: colors.textSecondary },
  2: { bg: colors.surfaceRaised, border: colors.border, text: colors.textSecondary },
  3: { bg: colors.surfaceRaised, border: colors.textSecondary, text: colors.textPrimary },
  4: { bg: colors.surface, border: colors.accent, text: colors.accent },
  5: { bg: colors.accent, border: colors.accent, text: colors.onAccent },
  6: { bg: colors.accentPressed, border: colors.accentPressed, text: colors.onAccent },
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

/** Mirrors the strip's own visual copy (F1/F2 fix) so a screen-reader user gets the SAME "advisory, live distance" framing a sighted driver sees, never a bare "Brake now" command. */
function accessibleLabel(cue: CoachCue, units: 'kmh' | 'mph'): string {
  const direction = cue.direction === 'left' ? 'left' : 'right';
  const distance = Math.round(cue.distanceToTargetM);
  if (cue.kind === 'BRAKE') {
    return `Advisory: brake in ${distance} meters. Corner ${cue.cornerId}, ${direction}, severity ${cue.severity} of 6.`;
  }
  const speedText = formatSpeedSpoken(cue.advisorySpeedKph, units);
  return `Advisory: corner ${cue.cornerId} ahead, ${direction}, severity ${cue.severity} of 6, advisory ${speedText}, in ${distance} meters.`;
}

/**
 * S7 dashboard coach strip (Phase 3 coaching addendum). Always the SAME
 * fixed height whether idle or showing a live cue -- MUST DO: "no layout
 * thrash". BRAKE gets a static high-contrast amber fill (no animation loop,
 * per binding design direction); CORNER_AHEAD stays on the neutral surface
 * treatment with the severity chip carrying the emphasis instead.
 *
 * F1/F2 fix: `cue` is now a LIVE value the controller re-emits every match
 * while approaching, so `distance` below is a genuine countdown, not a
 * frozen number -- the kicker reads "BRAKE IN" (never a bare "BRAKE"
 * command) and a small muted "ADVISORY" tag reinforces this is guidance, not
 * an instruction. F5 fix: reads `units` from `settingsStore` directly
 * (`ActiveDashboardScreen.tsx` is outside this ticket's write set) so a
 * driver's mph preference is honored here exactly like everywhere else.
 */
export function CoachStrip({ cue }: CoachStripProps): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const units = settings.units;
  const isBrake = cue?.kind === 'BRAKE';
  return (
    <View
      style={[styles.strip, isBrake ? styles.stripBrake : styles.stripIdle]}
      accessibilityRole="text"
      accessibilityLabel={cue === null ? 'No coaching cue' : accessibleLabel(cue, units)}
      accessibilityLiveRegion="polite"
    >
      {cue === null ? null : (
        <>
          <Text
            style={[styles.advisoryTag, isBrake ? styles.textOnBrakeDim : styles.advisoryTagIdle]}
            maxFontSizeMultiplier={1.2}
          >
            ADVISORY
          </Text>
          <View style={styles.leftGroup}>
            <Text style={[styles.kind, isBrake && styles.textOnBrake]} maxFontSizeMultiplier={1.2}>
              {isBrake ? 'BRAKE IN' : 'CORNER'}
            </Text>
            <Text style={[styles.cornerNumber, isBrake && styles.textOnBrake]} maxFontSizeMultiplier={1.2}>
              {cue.direction === 'left' ? '←' : '→'} C{cue.cornerId}
            </Text>
          </View>
          <SeverityChip severity={cue.severity} />
          <View style={styles.rightGroup}>
            <Text style={[styles.speed, isBrake && styles.textOnBrake]} maxFontSizeMultiplier={1.2}>
              {formatSpeedShort(cue.advisorySpeedKph, units)}
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
  // Out of flex flow (position: absolute is relative to `strip`, RN's
  // default positioned ancestor) so it never affects COACH_STRIP_HEIGHT.
  advisoryTag: {
    position: 'absolute',
    top: 4,
    right: spacing.sm,
    fontSize: 9,
    fontFamily: fontFamily.bodySemibold,
    letterSpacing: 0.5,
  },
  advisoryTagIdle: { color: colors.textSecondary },
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
