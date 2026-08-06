import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import type { DeltaUpdate } from '@circuit/core';
import { colors, typography } from '../theme';
import { formatDeltaSeconds } from '../format';

export interface DeltaDisplayProps {
  delta: DeltaUpdate | null;
  /** Font size in points for the numeric readout; the dashboard uses a very large value here (MUST DO: "biggest element"). */
  fontSize?: number;
  style?: StyleProp<ViewStyle>;
  maxFontSizeMultiplier?: number;
}

/**
 * Dominant live delta readout. Sign convention (contracts.md, binding):
 * negative = faster than reference → GREEN with a leading minus;
 * positive = slower → RED; `display === 'neutral'` (low confidence) → GRAY.
 */
export function DeltaDisplay({
  delta,
  fontSize = 96,
  style,
  maxFontSizeMultiplier = 1.3,
}: DeltaDisplayProps): React.JSX.Element {
  const hasDelta = delta !== null;
  const color = !hasDelta
    ? colors.textMuted
    : delta.display === 'neutral'
      ? colors.neutral
      : delta.display === 'faster'
        ? colors.faster
        : colors.slower;
  const text = hasDelta ? formatDeltaSeconds(delta.deltaMs) : '--.--';
  const spokenSign = hasDelta ? (delta.display === 'faster' ? 'faster' : delta.display === 'slower' ? 'slower' : 'neutral') : 'unavailable';

  return (
    <View style={[styles.container, style]}>
      <Text
        style={[styles.value, { color, fontSize }]}
        accessibilityLabel={`Delta ${text} seconds, ${spokenSign}`}
        accessibilityLiveRegion="polite"
        maxFontSizeMultiplier={maxFontSizeMultiplier}
      >
        {text}
      </Text>
      <Text style={styles.unit} maxFontSizeMultiplier={maxFontSizeMultiplier}>
        seconds vs. reference
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
  },
  value: {
    fontFamily: typography.display.fontFamily,
    fontVariant: ['tabular-nums'],
  },
  unit: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: -4,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
  },
});
