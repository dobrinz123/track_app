import React from 'react';
import { StyleSheet, Text, type StyleProp, type TextStyle } from 'react-native';
import { colors, typography } from '../theme';
import { formatLapTime } from '../format';

export type TimeDisplaySize = 'display' | 'large' | 'medium' | 'small';

const SIZE_STYLE: Record<TimeDisplaySize, TextStyle> = {
  display: typography.display,
  large: typography.timeLarge,
  medium: typography.timeMedium,
  small: typography.timeSmall,
};

export interface TimeDisplayProps {
  /** Milliseconds; `null` renders the placeholder `--:--.---`. */
  ms: number | null;
  size?: TimeDisplaySize;
  color?: string;
  style?: StyleProp<TextStyle>;
  /** Accessible label; defaults to a spoken-friendly rendering of the value. */
  accessibilityLabel?: string;
  /** Marks this value as a live region for screen readers (e.g. the dashboard's current lap clock). */
  live?: boolean;
  /**
   * RN font scaling is capped here because the dashboard's fixed-height
   * layout (MUST DO: "NO scrolling") would clip or overlap at larger system
   * font sizes; verified tolerable up to 1.3x per the accessibility MUST DO.
   */
  maxFontSizeMultiplier?: number;
}

/** Monospaced lap/session time readout, formatted `mm:ss.mmm`. */
export function TimeDisplay({
  ms,
  size = 'medium',
  color = colors.textPrimary,
  style,
  accessibilityLabel,
  live = false,
  maxFontSizeMultiplier = 1.3,
}: TimeDisplayProps): React.JSX.Element {
  const text = formatLapTime(ms);
  return (
    <Text
      style={[styles.base, SIZE_STYLE[size], { color }, style]}
      accessibilityLabel={accessibilityLabel ?? `Time ${text}`}
      accessibilityLiveRegion={live ? 'polite' : 'none'}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
    >
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  base: {
    fontVariant: ['tabular-nums'],
  },
});
