import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { CalibrationReportModel } from '../../session/calibrationReportViewModel';
import type { CalibrationReportStrings } from '../screens/calibrationReportStrings';
import { colors, radii, spacing, typography } from '../theme';

/**
 * Ticket P13B item 2 -- the automatic calibration report, drawn.
 *
 * Shown WITHOUT being asked for wherever a Learn lap can have failed. Every
 * sentence comes from `calibrationReportStrings.ts` and every figure from
 * `calibrationReportViewModel.ts`; this file holds no prose and makes no
 * decision except which palette a failure gets.
 *
 * A cancelled attempt is drawn exactly like a rejected one, in the warning
 * palette, under a heading that calls it a failure -- the owner asked for a
 * cancel to be treated as an error, and a quieter styling for it would be this
 * file quietly disagreeing with him.
 */
export function CalibrationReportCard({
  report,
  strings,
}: {
  report: CalibrationReportModel;
  strings: CalibrationReportStrings;
}): React.JSX.Element {
  const heading = strings.outcomeHeading[report.outcome];
  return (
    <View
      style={[styles.card, report.failure ? styles.cardFailure : styles.cardOk]}
      accessibilityLabel={strings.a11y(heading)}
    >
      <Text style={styles.title} maxFontSizeMultiplier={1.3}>
        {strings.title}
      </Text>
      <Text
        style={[styles.heading, report.failure ? styles.headingFailure : styles.headingOk]}
        maxFontSizeMultiplier={1.3}
      >
        {heading}
      </Text>

      {report.figures.map((figure) => (
        <Text key={figure.key} style={styles.line} maxFontSizeMultiplier={1.3}>
          {strings.figure(figure)}
        </Text>
      ))}

      {report.forceFinished ? (
        <Text style={styles.line} maxFontSizeMultiplier={1.3}>
          {strings.forceFinished}
        </Text>
      ) : null}

      <Text style={styles.reassurance} maxFontSizeMultiplier={1.3}>
        {strings.dataStillRecorded}
      </Text>

      {report.explanation.length === 0 ? null : (
        <>
          <Text style={styles.detailHeading} maxFontSizeMultiplier={1.3}>
            {strings.detailHeading}
          </Text>
          {report.explanation.map((line, index) => (
            <Text key={`${String(index)}-${line.slice(0, 24)}`} style={styles.detail} maxFontSizeMultiplier={1.3}>
              {'• '}
              {line}
            </Text>
          ))}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radii.md, borderWidth: 1, padding: spacing.md, gap: spacing.xs },
  cardFailure: { backgroundColor: `${colors.warning}1A`, borderColor: colors.warning },
  cardOk: { backgroundColor: colors.surface, borderColor: colors.border },
  title: { ...typography.label, color: colors.textMuted },
  heading: { ...typography.subtitle },
  headingFailure: { color: colors.warning },
  headingOk: { color: colors.success },
  line: { ...typography.body, color: colors.textSecondary },
  reassurance: { ...typography.caption, color: colors.textMuted },
  detailHeading: { ...typography.label, color: colors.textMuted, marginTop: spacing.xs },
  detail: { ...typography.caption, color: colors.textSecondary },
});
