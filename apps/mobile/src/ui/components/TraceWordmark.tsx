import React, { useCallback, useState } from 'react';
import type { LayoutChangeEvent, StyleProp, TextStyle, ViewStyle } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { fontFamily } from '../theme';

const WORDMARK_TEXT = 'TRACE';

/**
 * Per-letter colors stepping through trace_logo.svg's `amberGrad`
 * (#FF9100 -> #FFC400 -> #FFE57F). Coloring each glyph individually renders
 * IDENTICALLY on iOS, Android, and web — no MaskedView, no platform forks,
 * no invisible-text failure modes.
 */
const LETTER_COLORS = ['#FF9100', '#FFAD00', '#FFC400', '#FFD54F', '#FFE57F'] as const;

/** Soft neon halo behind every glyph, echoing the logo's glowing trace. */
const GLOW = {
  textShadowColor: 'rgba(255, 179, 0, 0.45)',
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: 14,
} as const;

const TELEMETRY_CORE = ['#FFF7C2', '#FFC400', 'rgba(255, 196, 0, 0)'] as const;
const TELEMETRY_HALO = ['rgba(255, 179, 0, 0.35)', 'rgba(255, 179, 0, 0)'] as const;

interface TraceWordmarkProps {
  /** Font size of the "TRACE" glyphs. ~40-44 matches the logo mark's visual weight. */
  size?: number;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}

/**
 * Brand wordmark: "TRACE" in Space Grotesk Bold, glyphs stepped through the
 * logo's amber telemetry gradient with a neon glow and a slight forward lean
 * (speed cue), over a layered glowing telemetry line. Static — no animation.
 */
export const TraceWordmark: React.FC<TraceWordmarkProps> = ({ size = 42, style, textStyle }) => {
  const [glyphWidth, setGlyphWidth] = useState<number | null>(null);

  const handleGlyphLayout = useCallback((event: LayoutChangeEvent) => {
    setGlyphWidth(event.nativeEvent.layout.width);
  }, []);

  return (
    <View style={style} accessibilityRole="header" accessibilityLabel={WORDMARK_TEXT}>
      <View onLayout={handleGlyphLayout} style={styles.glyphRow}>
        {WORDMARK_TEXT.split('').map((letter, i) => (
          <Text
            key={i}
            style={[
              styles.letter,
              GLOW,
              { fontSize: size, color: LETTER_COLORS[i % LETTER_COLORS.length] },
              textStyle,
            ]}
            maxFontSizeMultiplier={1.3}
            accessibilityElementsHidden
            importantForAccessibility="no"
          >
            {letter}
          </Text>
        ))}
      </View>
      {glyphWidth ? (
        <View style={styles.lineStack}>
          <LinearGradient
            colors={TELEMETRY_HALO}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.telemetryHalo, { width: glyphWidth * 0.85 }]}
          />
          <LinearGradient
            colors={TELEMETRY_CORE}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[styles.telemetryCore, { width: glyphWidth * 0.72 }]}
          />
        </View>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  glyphRow: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    // Slight forward lean — motorsport speed cue, matches the logo's slanted T.
    transform: [{ skewX: '-6deg' }],
  },
  letter: {
    fontFamily: fontFamily.displayBold,
    letterSpacing: 4,
  },
  lineStack: {
    marginTop: 7,
    height: 6,
    justifyContent: 'center',
  },
  telemetryHalo: {
    position: 'absolute',
    height: 6,
    borderRadius: 3,
  },
  telemetryCore: {
    height: 2.5,
    borderRadius: 2,
  },
});
