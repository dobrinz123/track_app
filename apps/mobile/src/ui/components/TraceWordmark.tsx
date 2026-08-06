import React, { useCallback, useState } from 'react';
import type { LayoutChangeEvent, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fontFamily } from '../theme';

/**
 * `@react-native-masked-view/masked-view` ships native platform bindings.
 * Feature-detect it via `require` inside a try/catch (rather than a static
 * `import`) so that an environment where the native module fails to resolve
 * or link at runtime -- most plausibly an unusual web build -- degrades to
 * solid accent-colored text instead of crashing. On every officially
 * supported target (iOS, Android, Expo Go, and react-native-web) this
 * resolves normally and the gradient wordmark renders as designed.
 */
type MaskedViewComponent = React.ComponentType<{
  maskElement: React.ReactElement;
  children?: React.ReactNode;
}>;

let MaskedView: MaskedViewComponent | null = null;
// react-native-web's masked-view support is unreliable (renders children
// unmasked, i.e. invisible text on dark backgrounds) — use the solid-accent
// fallback on web unconditionally; the gradient mask is native-only.
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    MaskedView = require('@react-native-masked-view/masked-view').default as MaskedViewComponent;
  } catch {
    MaskedView = null;
  }
}

const WORDMARK_TEXT = 'TRACE';
/** Matches trace_logo.svg's `amberGrad` -- the logo's glowing telemetry gradient. */
const GRADIENT_COLORS = ['#FF9100', '#FFC400', '#FFE57F'] as const;
/** Amber fading to transparent, echoing the logo's glowing trace apex. */
const TELEMETRY_LINE_COLORS = ['#FFC400', 'rgba(255, 196, 0, 0)'] as const;

interface TraceWordmarkProps {
  /** Font size of the "TRACE" glyphs. ~40-44 matches the logo mark's visual weight. */
  size?: number;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

/**
 * Brand wordmark: "TRACE" set in Space Grotesk Bold with the logo's amber
 * telemetry gradient masked onto the glyphs, plus a thin fading amber line
 * underneath that echoes the logo's glowing trace motif. Static -- no
 * animation.
 */
export const TraceWordmark: React.FC<TraceWordmarkProps> = ({ size = 42, style, textStyle }) => {
  const [glyphWidth, setGlyphWidth] = useState<number | null>(null);

  const handleGlyphLayout = useCallback((event: LayoutChangeEvent) => {
    setGlyphWidth(event.nativeEvent.layout.width);
  }, []);

  const maskText = (
    // Explicit opaque color: the mask uses the alpha channel of this element,
    // so its color must never be affected by theme/inherited styles.
    <Text style={[styles.text, { fontSize: size, color: '#000' }, textStyle]} maxFontSizeMultiplier={1.3}>
      {WORDMARK_TEXT}
    </Text>
  );

  return (
    <View style={style} accessibilityRole="header" accessibilityLabel={WORDMARK_TEXT}>
      <View onLayout={handleGlyphLayout} style={styles.glyphRow}>
        {MaskedView ? (
          <MaskedView maskElement={maskText}>
            <LinearGradient colors={GRADIENT_COLORS} start={{ x: 0, y: 1 }} end={{ x: 1, y: 0 }}>
              <Text
                style={[styles.text, { fontSize: size, opacity: 0 }, textStyle]}
                maxFontSizeMultiplier={1.3}
              >
                {WORDMARK_TEXT}
              </Text>
            </LinearGradient>
          </MaskedView>
        ) : (
          <Text
            style={[styles.text, styles.fallbackText, { fontSize: size }, textStyle]}
            maxFontSizeMultiplier={1.3}
          >
            {WORDMARK_TEXT}
          </Text>
        )}
      </View>
      {glyphWidth ? (
        <LinearGradient
          colors={TELEMETRY_LINE_COLORS}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[styles.telemetryLine, { width: glyphWidth * 0.6 }]}
        />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  glyphRow: {
    alignSelf: 'flex-start',
  },
  text: {
    fontFamily: fontFamily.displayBold,
    letterSpacing: 4,
  },
  fallbackText: {
    color: colors.accent,
  },
  telemetryLine: {
    height: 2.5,
    borderRadius: 2,
    marginTop: 6,
  },
});
