import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { resolveAnalysisScreenStrings } from './analysisStrings';
import { useSettings } from '../hooks/useSettings';
import {
  buildAnalysisScreenState,
  createAnalysisController,
  type AnalysisCornerRow,
  type AnalysisRunResult,
} from '../../session/analysisViewModel';
import { buildAnalysisExportDocument, shareAnalysisExport, shareAnalysisJson } from '../../session/analysisExport';
import { facade, getAnalysisRunner, getTrackdayRecord, settingsStore } from '../../session/composition';

type Props = NativeStackScreenProps<RootStackParamList, 'Analysis'>;

/**
 * S14 — post-session corner analysis (ticket P5b, revised by P5b-FIX1 for
 * contracts.md "Phase 5 REVISION 2" R2-2): the deterministic on-device
 * engine's findings for ONE finished session, in the app's language,
 * observations only, as an INTERACTIVE report — a corner list of names and
 * badges whose rows expand into that corner's per-lap numbers, demonstrated
 * envelope and the engine's own sentence. The long prose exists only in the
 * exported report.
 *
 * This file is a renderer and nothing else. Every decision — what to load, what
 * the engine may be asked, what the driver is told when it cannot be asked,
 * what a row and its detail contain — lives in `session/analysisViewModel.ts`
 * and `session/analysisAssembly.ts`, which vitest imports directly; every
 * visible string is either the ENGINE's own localized report text or a chrome
 * label from `analysisStrings.ts`. Nothing about driving is written here.
 */
export function AnalysisScreen({ route }: Props): React.JSX.Element {
  const { sessionId } = route.params;
  const settings = useSettings(settingsStore);
  const strings = resolveAnalysisScreenStrings(settings.language);

  // P5b-FIX1 C1/C6: ONE shared runner (composition), and a controller that
  // watches the facade so a session starting hides this analysis and a session
  // ending brings it back without leaving the screen.
  const controller = React.useMemo(
    () =>
      createAnalysisController({
        runner: getAnalysisRunner(),
        sessionId,
        subscribeSessionState: (listener) => facade.subscribe((state) => listener(state.sessionState)),
      }),
    [sessionId],
  );
  React.useEffect(() => {
    return () => {
      controller.dispose();
    };
  }, [controller]);

  const [result, setResult] = React.useState<AnalysisRunResult | null>(null);
  const [expanded, setExpanded] = React.useState<number | null>(null);
  const [shareNote, setShareNote] = React.useState<string | null>(null);
  const [sharing, setSharing] = React.useState(false);

  React.useEffect(() => controller.subscribe(setResult), [controller]);

  const state = React.useMemo(
    () =>
      result === null
        ? ({ status: 'loading' } as const)
        : buildAnalysisScreenState(result, settings.language),
    [result, settings.language],
  );

  const share = React.useCallback(
    async (json: boolean) => {
      if (state.status !== 'ready' || sharing) return;
      setSharing(true);
      // Ticket P5c-B D4: the pit suggestions the driver was actually SHOWN and
      // the cue moves applied during this session travel with the report. The
      // journal is per launch, so a session analysed on a later launch exports
      // its observations exactly as before -- never a fabricated record.
      const trackday = getTrackdayRecord(sessionId);
      const doc = buildAnalysisExportDocument(state, {
        generatedAtUtc: new Date().toISOString(),
        trackday: {
          cueUpdates: trackday.cueUpdates,
          pitSuggestions: trackday.shownPitSuggestions,
        },
      });
      const outcome = json ? await shareAnalysisJson(doc) : await shareAnalysisExport(doc);
      setShareNote(
        !outcome.ok ? strings.shareFailed : outcome.shared ? strings.shareDone : strings.shareUnavailable,
      );
      setSharing(false);
    },
    [state, sharing, strings, sessionId],
  );

  if (state.status === 'loading') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <View style={styles.centred}>
          <ActivityIndicator color={colors.accent} />
          <Text style={styles.title} maxFontSizeMultiplier={1.3}>
            {strings.loading}
          </Text>
          <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
            {strings.loadingHint}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  if (state.status !== 'ready') {
    return (
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
        <View style={styles.centred}>
          <Text style={styles.title} maxFontSizeMultiplier={1.3}>
            {strings.screenTitle}
          </Text>
          <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
            {state.message}
          </Text>
          {state.status === 'error' ? (
            <Pressable
              style={[styles.button, styles.secondaryButton]}
              onPress={() => controller.retry()}
              accessibilityRole="button"
              accessibilityLabel={strings.retryA11y}
            >
              <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
                {strings.retry}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </SafeAreaView>
    );
  }

  const { view } = state;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          {view.title}
        </Text>
        <Text style={styles.header} maxFontSizeMultiplier={1.3}>
          {view.header}
        </Text>
        <View style={styles.chipRow}>
          {view.summaryChips.map((chip) => (
            <Chip key={chip} label={chip} />
          ))}
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeText} maxFontSizeMultiplier={1.3}>
            {view.observationsOnly}
          </Text>
        </View>

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          {strings.cornersHeading}
        </Text>
        {view.corners.map((corner) => (
          <CornerCard
            key={corner.cornerId}
            corner={corner}
            expanded={expanded === corner.cornerId}
            onToggle={() =>
              setExpanded((current) => (current === corner.cornerId ? null : corner.cornerId))
            }
            expandLabel={
              expanded === corner.cornerId
                ? strings.collapseCornerA11y(corner.heading)
                : strings.expandCornerA11y(corner.heading)
            }
            cleanMark={strings.cleanLapMark}
            noValue={strings.noValue}
          />
        ))}

        {view.limitationChips.length === 0 ? null : (
          <>
            <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
              {strings.limitationsHeading}
            </Text>
            <View style={styles.chipRow}>
              {view.limitationChips.map((chip) => (
                <Chip key={chip} label={chip} tone="warning" />
              ))}
            </View>
          </>
        )}

        {view.notes.length === 0 ? null : (
          <>
            <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
              {strings.notesHeading}
            </Text>
            {view.notes.map((note, index) => (
              <Text key={index} style={[styles.line, styles.lineWarning]} maxFontSizeMultiplier={1.3}>
                {note}
              </Text>
            ))}
          </>
        )}

        <Text style={styles.disclaimer} maxFontSizeMultiplier={1.3}>
          {view.disclaimer}
        </Text>

        {shareNote === null ? null : (
          <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
            {shareNote}
          </Text>
        )}
        <Pressable
          style={[styles.button, styles.primaryButton, sharing && styles.buttonBusy]}
          onPress={() => void share(false)}
          disabled={sharing}
          accessibilityRole="button"
          accessibilityLabel={strings.shareA11y}
        >
          <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
            {strings.share}
          </Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.secondaryButton, sharing && styles.buttonBusy]}
          onPress={() => void share(true)}
          disabled={sharing}
          accessibilityRole="button"
          accessibilityLabel={strings.shareJsonA11y}
        >
          <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
            {strings.shareJson}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

/** One compact label. Every chip's text comes from the view model. */
function Chip({ label, tone }: { label: string; tone?: 'warning' }): React.JSX.Element {
  return (
    <View style={[styles.chip, tone === 'warning' && styles.chipWarning]}>
      <Text style={styles.chipText} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </View>
  );
}

/**
 * The compact VISUAL of one corner (ticket P5-FIX2 W4, contracts.md R2-2): one
 * line per lap, marked where that lap braked and lifted along the approach to
 * the corner, with its minimum and exit speed as bare figures.
 *
 * Every position, every figure and the spoken line come from the view model —
 * this component owns nothing but pixels.
 */
function CornerVisual({
  visual,
  cleanMark,
  noValue,
}: {
  visual: NonNullable<AnalysisCornerRow['detail']['visual']>;
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

/**
 * A corner row: the engine's name plus the view model's badges. Tapping it
 * reveals that corner's per-lap numbers, the compact visual of where it braked
 * and lifted, and its demonstrated envelope (contracts.md R2-2). The engine's
 * full sentences are deliberately NOT here: they travel in the exported report
 * (ticket P5-FIX2 W4, Codex P5-REV finding 16).
 */
function CornerCard({
  corner,
  expanded,
  onToggle,
  expandLabel,
  cleanMark,
  noValue,
}: {
  corner: AnalysisCornerRow;
  expanded: boolean;
  onToggle: () => void;
  expandLabel: string;
  cleanMark: string;
  noValue: string;
}): React.JSX.Element {
  const columns = corner.detail.columns;
  return (
    <Pressable
      style={styles.cornerCard}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={expandLabel}
      accessibilityState={{ expanded }}
    >
      <View style={styles.cornerHeaderRow}>
        <Text style={styles.cornerHeading} maxFontSizeMultiplier={1.3}>
          {corner.heading}
        </Text>
      </View>
      <View style={styles.chipRow}>
        {corner.badges.map((badge) => (
          <Chip key={badge} label={badge} />
        ))}
      </View>
      {!expanded ? null : (
        <View style={styles.detail}>
          <View style={styles.detailRow}>
            <Text style={[styles.detailCell, styles.detailHead]} maxFontSizeMultiplier={1.3}>
              {columns.lap}
            </Text>
            <Text style={[styles.detailCell, styles.detailHead]} maxFontSizeMultiplier={1.3}>
              {columns.brake}
            </Text>
            <Text style={[styles.detailCell, styles.detailHead]} maxFontSizeMultiplier={1.3}>
              {columns.lift}
            </Text>
            <Text style={[styles.detailCell, styles.detailHead]} maxFontSizeMultiplier={1.3}>
              {columns.minSpeed}
            </Text>
            <Text style={[styles.detailCell, styles.detailHead]} maxFontSizeMultiplier={1.3}>
              {columns.exit}
            </Text>
            <Text style={[styles.detailCell, styles.detailHead]} maxFontSizeMultiplier={1.3}>
              {columns.peakDecel}
            </Text>
            <Text style={[styles.detailCell, styles.detailHead]} maxFontSizeMultiplier={1.3}>
              {columns.latG}
            </Text>
          </View>
          {corner.detail.perLap.map((lap) => (
            <View key={lap.lapNumber} style={styles.detailRow}>
              <Text style={styles.detailCell} maxFontSizeMultiplier={1.3}>
                {lap.clean ? `${lap.lapNumber} · ${cleanMark}` : String(lap.lapNumber)}
              </Text>
              <Text style={styles.detailCell} maxFontSizeMultiplier={1.3}>
                {lap.brake}
              </Text>
              <Text style={styles.detailCell} maxFontSizeMultiplier={1.3}>
                {lap.lift}
              </Text>
              <Text style={styles.detailCell} maxFontSizeMultiplier={1.3}>
                {lap.minSpeed}
              </Text>
              <Text style={styles.detailCell} maxFontSizeMultiplier={1.3}>
                {lap.exit}
              </Text>
              <Text style={styles.detailCell} maxFontSizeMultiplier={1.3}>
                {lap.peakDecel}
              </Text>
              <Text style={styles.detailCell} maxFontSizeMultiplier={1.3}>
                {lap.latG}
              </Text>
            </View>
          ))}
          {corner.detail.visual === null ? null : (
            <CornerVisual
              visual={corner.detail.visual}
              cleanMark={cleanMark}
              noValue={noValue}
            />
          )}
          {corner.detail.envelopeLine === null ? null : (
            <Text style={styles.envelope} maxFontSizeMultiplier={1.3}>
              {corner.detail.envelopeLine}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  centred: { flex: 1, padding: spacing.lg, gap: spacing.md, justifyContent: 'center' },
  title: { ...typography.title, color: colors.textPrimary },
  header: { ...typography.subtitle, color: colors.textPrimary },
  muted: { ...typography.body, color: colors.textMuted },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  badgeText: { ...typography.caption, color: colors.textSecondary },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  chipWarning: { borderColor: colors.warning },
  chipText: { ...typography.caption, color: colors.textSecondary },
  sectionLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.sm },
  line: { ...typography.body, color: colors.textSecondary },
  lineWarning: { color: colors.warning },
  cornerCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  cornerHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cornerHeading: { ...typography.subtitle, color: colors.textPrimary, fontFamily: fontFamily.bodySemibold },
  // P5-FIX2 W4: the compact per-lap visual. Positions come from the view model
  // as 0..1, so every width/left here is a percentage of the drawn track.
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
  detail: { marginTop: spacing.sm, gap: spacing.xs },
  detailRow: { flexDirection: 'row', gap: spacing.xs },
  detailCell: { ...typography.caption, color: colors.textSecondary, flex: 1 },
  detailHead: { color: colors.textMuted },
  envelope: { ...typography.caption, color: colors.textPrimary },
  disclaimer: { ...typography.caption, color: colors.textMuted, marginTop: spacing.sm },
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  buttonBusy: { opacity: 0.6 },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: colors.onAccent },
  secondaryButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { ...typography.subtitle, color: colors.textPrimary },
});
