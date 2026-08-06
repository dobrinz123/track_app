import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radii, spacing, typography } from '../theme';

/**
 * Placeholder bundled-fixture names. Wiring these to an actual
 * `ReplayLocationProvider` + `ReplayHarness` run (docs/architecture/contracts.md)
 * is out of scope for this UI-only work package — listed here purely so the
 * dev entry point exists and its purpose is documented.
 */
const PLACEHOLDER_FIXTURES = [
  'tmr-clean-lap-01.jsonl',
  'tmr-degraded-gnss-01.jsonl',
  'tmr-pit-transit-01.jsonl',
];

/** S13 — dev-only (__DEV__ gated): placeholder fixture list; documents replay purpose. Wire-up is a later work package. */
export function DevReplayScreen(): React.JSX.Element {
  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Dev: Replay Fixtures
        </Text>
        <Text style={styles.intro} maxFontSizeMultiplier={1.3}>
          Replay streams a recorded fixture of `LocationSample`s through the production timing pipeline
          (`ReplayHarness`, see docs/architecture/contracts.md) to exercise the app without driving. Not wired up
          yet — this screen only lists what will eventually be selectable, and only ever renders in a __DEV__
          build.
        </Text>

        <Text style={styles.sectionLabel} maxFontSizeMultiplier={1.3}>
          BUNDLED FIXTURES (PLACEHOLDER)
        </Text>
        {PLACEHOLDER_FIXTURES.map((name) => (
          <View key={name} style={styles.fixtureRow}>
            <Text style={styles.fixtureName} maxFontSizeMultiplier={1.3}>
              {name}
            </Text>
            <Text style={styles.fixtureStatus} maxFontSizeMultiplier={1.3}>
              not wired
            </Text>
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { padding: spacing.lg, gap: spacing.md },
  title: { ...typography.title, color: colors.textPrimary },
  intro: { ...typography.caption, color: colors.textSecondary, lineHeight: 18 },
  sectionLabel: { ...typography.label, color: colors.textMuted, letterSpacing: 0.5, marginTop: spacing.sm },
  fixtureRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm,
  },
  fixtureName: { ...typography.body, color: colors.textPrimary, fontFamily: 'monospace' },
  fixtureStatus: { ...typography.caption, color: colors.warning },
});
