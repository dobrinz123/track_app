import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import { resolvePitScreenStrings } from './trackdayStrings';
import { useSettings } from '../hooks/useSettings';
import { buildPitViewState, type PitCornerRow, type PitViewState } from '../../session/pitViewModel';
import { getActiveStintContext, getStintCoach, settingsStore } from '../../session/composition';

type Props = NativeStackScreenProps<RootStackParamList, 'PitView'>;

/**
 * S15 — the BETWEEN-STINT view (ticket P5c-B D3, contracts.md R2-3b): opened
 * from the driving dashboard while the car is stopped, it shows the corners
 * costing the most time over the laps already driven, each expanding into that
 * corner's per-lap numbers, and — only when the driver opted in — the bounded
 * suggestion for it, every one citing the lap of THIS outing that proved it.
 *
 * A renderer and nothing else. What is read, what may be suggested, and what
 * the driver is told when nothing may be, all live in
 * `session/pitViewModel.ts` + `session/stintCoaching.ts`, which vitest imports
 * directly; every visible string is either the ENGINE's own localised sentence
 * or a chrome label from `trackdayStrings.ts`. Read-only over the recorded
 * laps: opening this screen never touches the running session.
 */
export function PitViewScreen({ navigation }: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const strings = resolvePitScreenStrings(settings.language);
  const [state, setState] = React.useState<PitViewState | { status: 'loading' }>({
    status: 'loading',
  });
  const [expanded, setExpanded] = React.useState<number | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    const context = getActiveStintContext();
    if (context === null) {
      setState({ status: 'unavailable', reason: 'no-session', message: strings.noSession });
      return () => {
        cancelled = true;
      };
    }
    setState({ status: 'loading' });
    void getStintCoach()
      .openPitView(context.sessionId, context.completedLapCount)
      .then((outcome) => {
        if (cancelled) return;
        setState(
          buildPitViewState({
            run: outcome.run,
            suggestions: outcome.suggestions,
            cueUpdates: outcome.cueUpdates,
            language: settings.language,
          }),
        );
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: strings.failed });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, settings.language, strings]);

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
          <Pressable
            style={[styles.button, styles.secondaryButton]}
            onPress={() => setAttempt((value) => value + 1)}
            accessibilityRole="button"
            accessibilityLabel={strings.retryA11y}
          >
            <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
              {strings.retry}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.primaryButton]}
            onPress={() => navigation.goBack()}
            accessibilityRole="button"
            accessibilityLabel={strings.closeA11y}
          >
            <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
              {strings.close}
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const view = state.view;
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.header} maxFontSizeMultiplier={1.3}>
          {view.header}
        </Text>
        <View style={styles.chipRow}>
          {view.summaryChips.map((chip) => (
            <Chip key={chip} label={chip} />
          ))}
        </View>

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          {view.focusHeading}
        </Text>
        <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
          {view.statusLine}
        </Text>
        {view.corners.map((corner) => (
          <PitCornerCard
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
          />
        ))}

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          {view.cueUpdatesHeading}
        </Text>
        {view.cueUpdateLines.length === 0 ? (
          <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
            {view.noCueUpdates}
          </Text>
        ) : (
          view.cueUpdateLines.map((line, index) => (
            <Text key={index} style={styles.line} maxFontSizeMultiplier={1.3}>
              {line}
            </Text>
          ))
        )}

        {view.notes.map((note, index) => (
          <Text key={index} style={styles.muted} maxFontSizeMultiplier={1.3}>
            {note}
          </Text>
        ))}

        <Text style={styles.disclaimer} maxFontSizeMultiplier={1.3}>
          {view.disclaimer}
        </Text>
        <Pressable
          style={[styles.button, styles.primaryButton]}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={strings.closeA11y}
        >
          <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
            {strings.close}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

function Chip({ label }: { label: string }): React.JSX.Element {
  return (
    <View style={styles.chip}>
      <Text style={styles.chipText} maxFontSizeMultiplier={1.3}>
        {label}
      </Text>
    </View>
  );
}

/**
 * One focus corner: name, badges, and — expanded — the per-lap numbers, this
 * corner's bounded suggestion(s) and any cue that has moved here this outing.
 */
function PitCornerCard({
  corner,
  expanded,
  onToggle,
  expandLabel,
}: {
  corner: PitCornerRow;
  expanded: boolean;
  onToggle: () => void;
  expandLabel: string;
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
      <Text style={styles.cornerHeading} maxFontSizeMultiplier={1.3}>
        {corner.heading}
      </Text>
      <View style={styles.chipRow}>
        {corner.badges.map((badge) => (
          <Chip key={badge} label={badge} />
        ))}
      </View>
      {corner.suggestions.map((line, index) => (
        <Text key={`s${index}`} style={styles.suggestion} maxFontSizeMultiplier={1.3}>
          {line}
        </Text>
      ))}
      {corner.cueUpdates.map((line, index) => (
        <Text key={`c${index}`} style={styles.line} maxFontSizeMultiplier={1.3}>
          {line}
        </Text>
      ))}
      {!expanded ? null : (
        <View style={styles.detail}>
          <View style={styles.detailRow}>
            {[columns.lap, columns.brake, columns.lift, columns.minSpeed, columns.exit].map(
              (label) => (
                <Text
                  key={label}
                  style={[styles.detailCell, styles.detailHead]}
                  maxFontSizeMultiplier={1.3}
                >
                  {label}
                </Text>
              ),
            )}
          </View>
          {corner.detail.perLap.map((lap) => (
            <View key={lap.lapNumber} style={styles.detailRow}>
              <Text style={styles.detailCell} maxFontSizeMultiplier={1.3}>
                {String(lap.lapNumber)}
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
            </View>
          ))}
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  chipText: { ...typography.caption, color: colors.textSecondary },
  sectionLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.sm },
  line: { ...typography.body, color: colors.textSecondary },
  suggestion: { ...typography.body, color: colors.textPrimary },
  cornerCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  cornerHeading: {
    ...typography.subtitle,
    color: colors.textPrimary,
    fontFamily: fontFamily.bodySemibold,
  },
  detail: { marginTop: spacing.sm, gap: spacing.xs },
  detailRow: { flexDirection: 'row', gap: spacing.xs },
  detailCell: { ...typography.caption, color: colors.textSecondary, flex: 1 },
  detailHead: { color: colors.textMuted },
  envelope: { ...typography.caption, color: colors.textPrimary },
  disclaimer: { ...typography.caption, color: colors.textMuted, marginTop: spacing.sm },
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: colors.onAccent },
  secondaryButton: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { ...typography.subtitle, color: colors.textPrimary },
});
