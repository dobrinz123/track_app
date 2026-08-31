import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, spacing, typography } from '../theme';
import type { AnalysisCornerVisual } from '../../session/analysisViewModel';

/**
 * The compact VISUAL of one corner (ticket P5-FIX2 W4, contracts.md R2-2),
 * shared by the post-session Analysis screen and the between-stint Pit view
 * (ticket P5c-FIX1 E13): one line per lap, marked where that lap braked and
 * lifted along the approach to the corner, with its minimum and exit speed as
 * bare figures.
 *
 * Every position, every figure and the spoken line come from the view model —
 * this component owns nothing but pixels. It lives here rather than inside one
 * screen so the two screens cannot drift into drawing one corner differently,
 * exactly as `pitViewModel` reuses `analysisViewModel`'s projection wholesale.
 */
export function CornerVisual({
  visual,
  cleanMark,
  noValue,
}: {
  visual: AnalysisCornerVisual;
  cleanMark: string;
  noValue: string;
}): React.JSX.Element {
  return (
    <View style={styles.visual}>
      <View style={styles.visualHeadRow}>
        <Text style={styles.visualCaption} maxFontSizeMultiplier={1.3}>
          {visual.axisStartLabel}
        </Text>
        <Text style={styles.visualCaption} maxFontSizeMultiplier={1.3}>
          {visual.axisEntryLabel}
        </Text>
      </View>
      {visual.rows.map((row) => (
        <View key={row.lapNumber} style={styles.visualRow} accessible accessibilityLabel={row.a11yLabel}>
          <Text style={styles.visualLap} maxFontSizeMultiplier={1.3}>
            {row.clean ? `${row.lapNumber} · ${cleanMark}` : String(row.lapNumber)}
          </Text>
          <View style={styles.track}>
            {row.marks.map((mark) => (
              <React.Fragment key={mark.kind}>
                {mark.uncertainty === null ? null : (
                  <View
                    style={[
                      styles.markBand,
                      {
                        left: `${Math.max(0, mark.position - mark.uncertainty) * 100}%`,
                        width: `${Math.min(1, mark.uncertainty * 2) * 100}%`,
                      },
                    ]}
                  />
                )}
                <View
                  style={[
                    styles.mark,
                    mark.kind === 'brake' ? styles.markBrake : styles.markLift,
                    { left: `${mark.position * 100}%` },
                  ]}
                />
              </React.Fragment>
            ))}
          </View>
          <View style={styles.figures}>
            <Text style={styles.figure} maxFontSizeMultiplier={1.3}>
              {row.minSpeed ?? noValue}
            </Text>
            <View style={styles.figureBarTrack}>
              <View style={[styles.figureBar, { width: `${(row.minSpeedBar ?? 0) * 100}%` }]} />
            </View>
            <Text style={styles.figure} maxFontSizeMultiplier={1.3}>
              {row.exit ?? noValue}
            </Text>
            <View style={styles.figureBarTrack}>
              <View style={[styles.figureBar, { width: `${(row.exitBar ?? 0) * 100}%` }]} />
            </View>
          </View>
        </View>
      ))}
      <View style={styles.legendRow}>
        <View style={[styles.legendDot, styles.markBrake]} />
        <Text style={styles.visualCaption} maxFontSizeMultiplier={1.3}>
          {visual.brakeLabel}
        </Text>
        <View style={[styles.legendDot, styles.markLift]} />
        <Text style={styles.visualCaption} maxFontSizeMultiplier={1.3}>
          {visual.liftLabel}
        </Text>
        <Text style={[styles.visualCaption, styles.legendSpeed]} maxFontSizeMultiplier={1.3}>
          {visual.speedCaption}
        </Text>
      </View>
    </View>
  );
}

// P5-FIX2 W4: positions come from the view model as 0..1, so every width/left
// here is a percentage of the drawn track.
const styles = StyleSheet.create({
  visual: { marginTop: spacing.sm, gap: spacing.xs },
  visualHeadRow: { flexDirection: 'row', justifyContent: 'space-between' },
  visualCaption: { ...typography.caption, color: colors.textMuted },
  visualRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  visualLap: { ...typography.caption, color: colors.textSecondary, width: 68 },
  track: {
    flex: 1,
    height: 10,
    justifyContent: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  mark: { position: 'absolute', width: 6, height: 10, borderRadius: 3, marginLeft: -3 },
  markBrake: { backgroundColor: colors.accent },
  markLift: { backgroundColor: colors.textMuted },
  markBand: { position: 'absolute', height: 4, borderRadius: 2, backgroundColor: colors.border },
  figures: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, width: 116 },
  figure: { ...typography.caption, color: colors.textSecondary, width: 36, textAlign: 'right' },
  figureBarTrack: { width: 18, height: 4, borderRadius: 2, backgroundColor: colors.surfaceRaised },
  figureBar: { height: 4, borderRadius: 2, backgroundColor: colors.accent },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flexWrap: 'wrap' },
  legendDot: { width: 6, height: 6, borderRadius: 3 },
  legendSpeed: { marginLeft: spacing.sm },
});
