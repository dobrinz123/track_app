import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, fontFamily, radii, spacing, typography } from '../theme';

export type StatusBannerVariant = 'info' | 'warning' | 'error' | 'success';

const VARIANT_COLOR: Record<StatusBannerVariant, string> = {
  info: colors.accent,
  warning: colors.warning,
  error: colors.danger,
  success: colors.success,
};

export interface StatusBannerProps {
  variant?: StatusBannerVariant;
  message: string;
}

/**
 * Inline status/error banner. Used instead of modal dialogs — MUST DO: "no
 * modals ever while sessionState==='timing'"; status changes render inline.
 */
export function StatusBanner({ variant = 'info', message }: StatusBannerProps): React.JSX.Element {
  const color = VARIANT_COLOR[variant];
  return (
    <View
      style={[styles.banner, { borderColor: color, backgroundColor: `${color}1A` }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={[styles.text, { color }]} maxFontSizeMultiplier={1.3}>
        {message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  text: {
    ...typography.body,
    fontFamily: fontFamily.bodySemibold,
  },
});
