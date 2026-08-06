import { Platform } from 'react-native';

/**
 * Dark-first motorsport theme. Dark is the only theme for now (MUST DO:
 * "Dark theme default (track use)") — track-side legibility in bright
 * sunlight and at night both favor a single, deliberately high-contrast
 * dark palette over a toggle nobody will use mid-session.
 */
export const colors = {
  background: '#0A0D10',
  surface: '#14181D',
  surfaceRaised: '#1C2128',
  border: '#2A313A',
  textPrimary: '#F5F7FA',
  textSecondary: '#A9B4C0',
  textMuted: '#6B7684',

  // Delta sign convention (contracts.md): negative = faster = GREEN, positive = slower = RED.
  faster: '#22D07A',
  slower: '#FF4D4F',
  neutral: '#8B96A3',

  // GNSS quality pill.
  qualityGood: '#22D07A',
  qualityDegraded: '#F5B93D',
  qualityUnreliable: '#FF4D4F',
  qualityInvalid: '#6B7684',

  accent: '#3E8CFF',
  danger: '#FF4D4F',
  warning: '#F5B93D',
  success: '#22D07A',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  sm: 8,
  md: 14,
  lg: 20,
  pill: 999,
} as const;

/** Monospaced family for all numeric timing readouts — no digit jitter as values change. */
export const monoFontFamily = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

export const typography = {
  display: { fontSize: 64, fontWeight: '700' as const, fontFamily: monoFontFamily },
  timeLarge: { fontSize: 48, fontWeight: '600' as const, fontFamily: monoFontFamily },
  timeMedium: { fontSize: 28, fontWeight: '600' as const, fontFamily: monoFontFamily },
  timeSmall: { fontSize: 18, fontWeight: '500' as const, fontFamily: monoFontFamily },
  title: { fontSize: 24, fontWeight: '700' as const },
  subtitle: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 16, fontWeight: '400' as const },
  caption: { fontSize: 13, fontWeight: '400' as const },
  label: { fontSize: 13, fontWeight: '700' as const },
};

export const theme = { colors, spacing, radii, typography, monoFontFamily } as const;

export type Theme = typeof theme;
