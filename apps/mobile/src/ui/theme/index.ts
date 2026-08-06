import type { FontVariant } from 'react-native';

/**
 * Restrained, technical, motorsport-telemetry dark theme (WP: UI redesign).
 * Dark is the only theme (MUST DO: "Dark theme default (track use)") --
 * track-side legibility in bright sunlight and at night both favor a single,
 * deliberately high-contrast dark palette over a toggle nobody will use
 * mid-session.
 *
 * Font family name strings below must exactly match the keys passed to
 * `useFonts` in `App.tsx` (expo-font + @expo-google-fonts/*, loaded at the
 * app root behind a splash-gate so the system-font fallback never flashes).
 */
export const fontFamily = {
  displaySemibold: 'SpaceGrotesk_600SemiBold',
  displayBold: 'SpaceGrotesk_700Bold',
  bodyRegular: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemibold: 'Inter_600SemiBold',
  monoRegular: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
  monoSemibold: 'JetBrainsMono_600SemiBold',
  monoBold: 'JetBrainsMono_700Bold',
} as const;

/** Backward-compatible alias: every numeric timing readout uses JetBrains Mono. */
export const monoFontFamily = fontFamily.monoSemibold;

export const colors = {
  background: '#0A0A0C',
  surface: '#121216',
  surfaceRaised: '#1A1A20',
  border: 'rgba(255,255,255,0.08)',
  textPrimary: '#F2F2F4',
  textSecondary: '#9A9AA3',
  textMuted: '#5C5C66',

  // Delta sign convention (contracts.md): negative = faster = GREEN, positive = slower = RED.
  faster: '#00E676',
  slower: '#FF3B30',
  neutral: '#8B96A3',

  // GNSS quality pill -- semantic telemetry colors, reserved (never reused for interactive/accent purposes).
  qualityGood: '#00E676',
  qualityDegraded: '#FF8F00',
  qualityUnreliable: '#FF3B30',
  qualityInvalid: '#5C5C66',

  // Racing amber -- interactive elements, highlights, active states ONLY. Never telemetry meaning.
  accent: '#FFB300',
  accentPressed: '#CC8F00',
  accentDim: 'rgba(255, 179, 0, 0.32)',
  /** Text/icon color for content painted directly on an accent-filled surface. */
  onAccent: '#0A0A0C',

  danger: '#FF3B30',
  // Distinct hue/saturation from `accent` so a warning state is never mistaken for an interactive highlight.
  warning: '#FF8F00',
  success: '#00E676',
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

const tabularNums = ['tabular-nums'] as FontVariant[];

export const typography = {
  // Timing digits -- JetBrains Mono throughout, tabular so digits don't jitter as values change.
  display: { fontSize: 64, fontFamily: fontFamily.monoBold, fontVariant: tabularNums },
  timeLarge: { fontSize: 48, fontFamily: fontFamily.monoSemibold, fontVariant: tabularNums },
  timeMedium: { fontSize: 28, fontFamily: fontFamily.monoSemibold, fontVariant: tabularNums },
  timeSmall: { fontSize: 18, fontFamily: fontFamily.monoMedium, fontVariant: tabularNums },

  // Display/headings -- Space Grotesk.
  kicker: {
    fontSize: 12,
    fontFamily: fontFamily.bodySemibold,
    letterSpacing: 1.2,
    textTransform: 'uppercase' as const,
  },
  title: { fontSize: 30, fontFamily: fontFamily.displayBold },
  subtitle: { fontSize: 17, fontFamily: fontFamily.bodySemibold },

  // Body/UI -- Inter.
  body: { fontSize: 16, fontFamily: fontFamily.bodyRegular },
  caption: { fontSize: 13, fontFamily: fontFamily.bodyRegular },
  // Uppercase micro-labels ("SECTOR", "LAP", "PB").
  label: {
    fontSize: 12,
    fontFamily: fontFamily.bodySemibold,
    letterSpacing: 1.2,
    textTransform: 'uppercase' as const,
  },
};

export const theme = { colors, spacing, radii, typography, fontFamily, monoFontFamily } as const;

export type Theme = typeof theme;
