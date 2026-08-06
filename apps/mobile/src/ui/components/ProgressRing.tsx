import React from 'react';
import { View } from 'react-native';
import { colors } from '../theme';

const TICK_COUNT = 32;

export interface ProgressRingProps {
  /** 0..1 */
  progress: number;
  size?: number;
  color?: string;
  trackColor?: string;
  children?: React.ReactNode;
  accessibilityLabel?: string;
}

/**
 * Circular progress indicator built from rotated tick marks (no SVG
 * dependency is available to this work package — only the four navigation
 * packages may be added). Simpler and more robust than a clipped-arc
 * technique in pure RN transforms, at the cost of a slightly stepped fill.
 */
export function ProgressRing({
  progress,
  size = 200,
  color = colors.accent,
  trackColor = colors.border,
  children,
  accessibilityLabel,
}: ProgressRingProps): React.JSX.Element {
  const clamped = Math.max(0, Math.min(1, progress));
  const filledCount = Math.round(clamped * TICK_COUNT);
  const radius = size / 2;
  const tickLength = size * 0.1;
  const tickWidth = 4;
  const tickInset = 4;

  const ticks = Array.from({ length: TICK_COUNT }, (_, i) => {
    const filled = i < filledCount;
    const angleDeg = (360 / TICK_COUNT) * i - 90;
    const angleRad = (angleDeg * Math.PI) / 180;
    const trackRadius = radius - tickLength / 2 - tickInset;
    const cx = radius + trackRadius * Math.cos(angleRad);
    const cy = radius + trackRadius * Math.sin(angleRad);
    return (
      <View
        key={i}
        style={{
          position: 'absolute',
          width: tickWidth,
          height: tickLength,
          borderRadius: tickWidth / 2,
          backgroundColor: filled ? color : trackColor,
          left: cx - tickWidth / 2,
          top: cy - tickLength / 2,
          transform: [{ rotate: `${angleDeg + 90}deg` }],
        }}
      />
    );
  });

  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel ?? 'Progress'}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      accessibilityLiveRegion="polite"
    >
      {ticks}
      <View style={{ alignItems: 'center', justifyContent: 'center' }}>{children}</View>
    </View>
  );
}
