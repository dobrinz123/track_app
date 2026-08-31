import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, fontFamily, radii, spacing, typography } from '../theme';
import {
  saveLearnedCircuit,
  settingsStore,
  startTestLoop,
  stopTestLoop,
  subscribeTestLoop,
  testLoopSnapshot,
} from '../../session/composition';
import type { TestLoopSnapshot } from '../../session/testLoopController';
import { useSettings } from '../hooks/useSettings';
import { resolveTestLoopStrings } from './testLoopStrings';

type Props = NativeStackScreenProps<RootStackParamList, 'TestLoop'>;

/**
 * Ticket P5d T2/T6 -- Test Loop mode, reached from the circuit selection
 * screen (NOT from a developer section: learning a track is how an
 * unregistered circuit becomes usable, which is a product feature).
 *
 * The screen is a thin renderer over `TestLoopController`'s snapshot: it
 * starts and stops the learn phase, shows what has been driven so far, shows
 * the banner when lap 1 closes, offers to save the track as a reusable
 * circuit, and hands over to the ordinary session flow. Every sentence it
 * shows comes from `testLoopStrings.ts`.
 */
export function TestLoopScreen({ navigation }: Props): React.JSX.Element {
  const settings = useSettings(settingsStore);
  const strings = resolveTestLoopStrings(settings.language);
  const [snapshot, setSnapshot] = useState<TestLoopSnapshot>(() => testLoopSnapshot());
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => subscribeTestLoop(setSnapshot), []);

  const onStart = (): void => {
    setNotice(null);
    setBusy(true);
    void (async () => {
      try {
        const result = await startTestLoop();
        if (!result.ok) {
          setNotice(result.reason === 'session-active' ? strings.sessionActive : strings.notReady);
        }
      } finally {
        setBusy(false);
      }
    })();
  };

  const onStop = (): void => {
    setBusy(true);
    void (async () => {
      try {
        await stopTestLoop();
      } finally {
        setBusy(false);
      }
    })();
  };

  const onSave = (): void => {
    const learned = snapshot.learned;
    if (learned === null) return;
    if (name.trim().length === 0) {
      setNotice(strings.saveEmptyName);
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const result = await saveLearnedCircuit(learned.circuitId, name.trim());
        setNotice(result.ok ? strings.saved(name.trim()) : strings.saveFailed);
      } finally {
        setBusy(false);
      }
    })();
  };

  const metres = (value: number): string => Math.round(value).toString();

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          {strings.screenTitle}
        </Text>
        <View style={styles.warnCard}>
          <Text style={styles.warnText} maxFontSizeMultiplier={1.3}>
            {strings.intro}
          </Text>
        </View>
        <Text style={styles.body} maxFontSizeMultiplier={1.3}>
          {strings.howItWorks}
        </Text>
        <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
          {strings.cuesOff}
        </Text>

        {snapshot.phase === 'learning' ? (
          <View style={styles.card}>
            <View style={styles.rowCentered}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.cardTitle} maxFontSizeMultiplier={1.3}>
                {strings.learningTitle}
              </Text>
            </View>
            <Text style={styles.mono} maxFontSizeMultiplier={1.3}>
              {strings.travelled(metres(snapshot.travelledM))}
            </Text>
            <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
              {strings.learningHint}
            </Text>
          </View>
        ) : null}

        {snapshot.phase === 'learned' && snapshot.learned !== null ? (
          <View style={styles.successCard}>
            <Text style={styles.cardTitle} maxFontSizeMultiplier={1.3}>
              {strings.learnedBanner(snapshot.learned.cornerCount, metres(snapshot.learned.lengthM))}
            </Text>
            <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
              {strings.learnedHint}
            </Text>
            <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
              {strings.adHocNote}
            </Text>
          </View>
        ) : null}

        {snapshot.phase === 'failed' && snapshot.failure !== null ? (
          <View style={styles.failCard}>
            <Text style={styles.cardTitle} maxFontSizeMultiplier={1.3}>
              {strings.failureTitle}
            </Text>
            <Text style={styles.body} maxFontSizeMultiplier={1.3}>
              {strings.failure[snapshot.failure.reason]}
            </Text>
            <Text style={styles.mono} maxFontSizeMultiplier={1.3}>
              {strings.travelled(metres(snapshot.failure.travelledM))}
            </Text>
          </View>
        ) : null}

        {notice !== null ? (
          <Text style={styles.notice} maxFontSizeMultiplier={1.3}>
            {notice}
          </Text>
        ) : null}

        {snapshot.phase === 'learning' ? (
          <Pressable
            style={[styles.button, styles.secondaryButton, busy && styles.buttonDisabled]}
            onPress={onStop}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={strings.stopA11y}
          >
            <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
              {strings.stop}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.button, styles.primaryButton, busy && styles.buttonDisabled]}
            onPress={onStart}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={strings.startA11y}
          >
            <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
              {snapshot.phase === 'failed' ? strings.tryAgain : strings.start}
            </Text>
          </Pressable>
        )}

        {snapshot.phase === 'learned' ? (
          <>
            <Pressable
              style={[styles.button, styles.primaryButton]}
              onPress={() => navigation.navigate('Preflight')}
              accessibilityRole="button"
              accessibilityLabel={strings.continueA11y}
            >
              <Text style={styles.primaryButtonText} maxFontSizeMultiplier={1.3}>
                {strings.continueToSession}
              </Text>
            </Pressable>

            <View style={styles.card}>
              <Text style={styles.cardTitle} maxFontSizeMultiplier={1.3}>
                {strings.saveTitle}
              </Text>
              <Text style={styles.muted} maxFontSizeMultiplier={1.3}>
                {strings.saveHint}
              </Text>
              <TextInput
                style={styles.input}
                value={name}
                onChangeText={setName}
                editable={!busy}
                autoCorrect={false}
                placeholder={strings.namePlaceholder}
                placeholderTextColor={colors.textMuted}
                accessibilityLabel={strings.namePlaceholder}
              />
              <Pressable
                style={[styles.button, styles.secondaryButton, busy && styles.buttonDisabled]}
                onPress={onSave}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={strings.saveA11y}
              >
                <Text style={styles.secondaryButtonText} maxFontSizeMultiplier={1.3}>
                  {strings.save}
                </Text>
              </Pressable>
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  body: { ...typography.body, color: colors.textPrimary },
  muted: { ...typography.caption, color: colors.textSecondary },
  mono: { fontFamily: fontFamily.monoMedium, fontSize: 15, color: colors.textPrimary },
  notice: { ...typography.body, color: colors.accent },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  successCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.accent,
    padding: spacing.md,
    gap: spacing.sm,
  },
  failCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  warnCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  warnText: { ...typography.body, color: colors.textPrimary },
  cardTitle: { ...typography.subtitle, color: colors.textPrimary },
  rowCentered: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontFamily: fontFamily.bodyRegular,
    fontSize: 16,
  },
  button: { borderRadius: radii.lg, paddingVertical: spacing.md, alignItems: 'center' },
  buttonDisabled: { opacity: 0.5 },
  primaryButton: { backgroundColor: colors.accent },
  primaryButtonText: { ...typography.subtitle, color: colors.onAccent },
  secondaryButton: { borderWidth: 1, borderColor: colors.border },
  secondaryButtonText: { ...typography.subtitle, color: colors.textPrimary },
});
