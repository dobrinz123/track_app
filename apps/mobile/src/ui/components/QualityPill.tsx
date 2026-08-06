import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { QualityLevel } from '@circuit/core';
import { colors, radii, spacing, typography } from '../theme';

const LABEL: Record<QualityLevel, string> = {
  good: 'GNSS GOOD',
  degraded: 'GNSS DEGRADED',
  unreliable: 'GNSS UNRELIABLE',
  invalid: 'NO GNSS',
};

const COLOR: Record<QualityLevel, string> = {
  good: colors.qualityGood,
  degraded: colors.qualityDegraded,
  unreliable: colors.qualityUnreliable,
  invalid: colors.qualityInvalid,
};

export interface QualityPillProps {
  quality: QualityLevel;
  compact?: boolean;
}

/** Color-coded GNSS quality indicator: good=green, degraded=amber, unreliable=red, invalid=gray. */
export function QualityPill({ quality, compact = false }: QualityPillProps): React.JSX.Element {
  const color = COLOR[quality];
  return (
    <View
      style={[styles.pill, compact && styles.pillCompact, { borderColor: color, backgroundColor: `${color}22` }]}
      accessibilityRole="text"
      accessibilityLabel={LABEL[quality]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, compact && styles.labelCompact, { color }]} maxFontSizeMultiplier={1.3}>
        {LABEL[quality]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    alignSelf: 'flex-start',
  },
  pillCompact: {
    paddingHorizontal: spacing.xs,
    paddingVertical: 3,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: spacing.xs,
  },
  label: {
    ...typography.label,
  },
  labelCompact: {
    fontSize: 11,
  },
});
