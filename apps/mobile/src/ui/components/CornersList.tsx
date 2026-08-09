import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Corner } from '@circuit/core';
import { colors, fontFamily, spacing, typography } from '../theme';
import { SeverityChip } from './CoachStrip';

export interface CornersListProps {
  corners: Corner[];
}

function cornerAccessibilityLabel(corner: Corner): string {
  const observed = corner.speedSource === 'observed' ? ', observed apex speed' : '';
  return `Corner ${corner.id}, ${corner.direction}, severity ${corner.severity} of 6, minimum radius ${Math.round(corner.minRadiusM)} meters, advisory speed ${Math.round(corner.advisorySpeedKph)} kilometers per hour${observed}`;
}

function CornerRow({ corner }: { corner: Corner }): React.JSX.Element {
  return (
    <View style={styles.row} accessibilityLabel={cornerAccessibilityLabel(corner)}>
      <Text style={styles.cornerNum} maxFontSizeMultiplier={1.3}>
        C{corner.id}
      </Text>
      <Text style={styles.arrow} maxFontSizeMultiplier={1.3}>
        {corner.direction === 'left' ? '←' : '→'}
      </Text>
      <SeverityChip severity={corner.severity} />
      <Text style={styles.radius} maxFontSizeMultiplier={1.3}>
        {Math.round(corner.minRadiusM)} m
      </Text>
      <View style={styles.speedGroup}>
        <Text style={styles.speed} maxFontSizeMultiplier={1.3}>
          {Math.round(corner.advisorySpeedKph)} km/h
        </Text>
        {corner.speedSource === 'observed' ? (
          <Text style={styles.observedTag} maxFontSizeMultiplier={1.3}>
            OBSERVED
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * CORNERS section (Phase 3 coaching addendum) -- compact, advisory-only
 * corner list for `CircuitDetailScreen`. Read-only display of the SAME
 * `Corner[]` (`session/tmrProfile.ts`'s `TMR_CORNERS`) every `SessionController`
 * this app builds is configured with; never fetched or fabricated here.
 */
export function CornersList({ corners }: CornersListProps): React.JSX.Element {
  return (
    <View>
      {corners.map((corner) => (
        <CornerRow key={corner.id} corner={corner} />
      ))}
      <Text style={styles.disclaimer} maxFontSizeMultiplier={1.3}>
        Corner data is advisory only, derived from track geometry (and, where marked OBSERVED, onboard apex-speed
        samples) — not an official or safety-critical source.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  cornerNum: { ...typography.body, fontFamily: fontFamily.bodySemibold, color: colors.textPrimary, width: 32 },
  arrow: { ...typography.body, color: colors.textSecondary, width: 20, textAlign: 'center' },
  radius: { ...typography.caption, color: colors.textSecondary, width: 60, fontFamily: fontFamily.monoRegular },
  speedGroup: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginLeft: 'auto' },
  speed: { ...typography.caption, color: colors.textPrimary, fontFamily: fontFamily.monoMedium },
  observedTag: { ...typography.label, fontSize: 9, color: colors.textMuted, letterSpacing: 0.5 },
  disclaimer: { ...typography.caption, fontSize: 11, color: colors.textMuted, marginTop: spacing.sm },
});
