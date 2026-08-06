import React, { useCallback, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../theme';

export interface LongPressButtonProps {
  label: string;
  /** Announced to screen readers; should explain what a long press does. */
  accessibilityLabel: string;
  onLongPressComplete: () => void;
  durationMs?: number;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * Generic press-and-hold button with a visible fill progress, used anywhere
 * a control must resist accidental single taps (MUST DO on S7: End Session
 * only via a 2s long-press). Not screen-specific — pass any label/handler.
 *
 * A screen-reader `activate` accessibility action is also wired so
 * VoiceOver/TalkBack users (who cannot reliably time a physical long-press)
 * can trigger the same action via their assistive-tech gesture, instead of
 * being locked out of the control entirely.
 */
export function LongPressButton({
  label,
  accessibilityLabel,
  onLongPressComplete,
  durationMs = 2000,
  danger = false,
  disabled = false,
}: LongPressButtonProps): React.JSX.Element {
  const progress = useRef(new Animated.Value(0)).current;
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [holding, setHolding] = useState(false);

  const clear = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    animationRef.current?.stop();
    progress.setValue(0);
    setHolding(false);
  }, [progress]);

  const start = useCallback(() => {
    if (disabled) return;
    setHolding(true);
    progress.setValue(0);
    animationRef.current = Animated.timing(progress, {
      toValue: 1,
      duration: durationMs,
      useNativeDriver: false,
    });
    animationRef.current.start();
    timeoutRef.current = setTimeout(() => {
      clear();
      onLongPressComplete();
    }, durationMs);
  }, [clear, disabled, durationMs, onLongPressComplete, progress]);

  const color = danger ? colors.danger : colors.accent;

  return (
    <Pressable
      onPressIn={start}
      onPressOut={clear}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={`Press and hold for ${Math.round(durationMs / 1000)} seconds`}
      accessibilityState={{ disabled, busy: holding }}
      accessibilityActions={[{ name: 'activate', label }]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'activate') onLongPressComplete();
      }}
      style={[styles.button, { borderColor: color }, disabled && styles.disabled]}
    >
      <View style={StyleSheet.absoluteFill}>
        <Animated.View
          style={[
            styles.fill,
            {
              backgroundColor: color,
              width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            },
          ]}
        />
      </View>
      <Text style={[styles.label, { color }]} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderWidth: 2,
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  disabled: {
    opacity: 0.4,
  },
  fill: {
    height: '100%',
    opacity: 0.28,
  },
  label: {
    ...typography.subtitle,
    letterSpacing: 0.5,
  },
});
