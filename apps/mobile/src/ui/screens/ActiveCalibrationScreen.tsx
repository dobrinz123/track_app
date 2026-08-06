import React, { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { ProgressRing } from '../components/ProgressRing';
import { LongPressButton } from '../components/LongPressButton';
import { facade } from '../../session/composition';
import { useFacadeState } from '../hooks/useFacadeState';

type Props = NativeStackScreenProps<RootStackParamList, 'ActiveCalibration'>;

/** S5 — live coverage progress ring + on-track indicator; navigates to S6 once a calibration result arrives. */
export function ActiveCalibrationScreen({ navigation }: Props): React.JSX.Element {
  const state = useFacadeState(facade);
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (state.calibrationResult && !navigatedRef.current) {
      navigatedRef.current = true;
      navigation.replace('CalibrationResult');
    }
  }, [navigation, state.calibrationResult]);

  const coverageFraction = state.calibration?.coverageFraction ?? 0;
  const onTrack = state.calibration?.onTrack ?? true;
  const percent = Math.round(coverageFraction * 100);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Calibrating…
        </Text>
        <Text style={styles.subtitle} maxFontSizeMultiplier={1.3}>
          Drive one steady lap
        </Text>

        <View style={styles.ringWrap}>
          <ProgressRing
            progress={coverageFraction}
            size={220}
            accessibilityLabel={`Calibration coverage ${percent} percent`}
          >
            <Text style={styles.percent} maxFontSizeMultiplier={1.3}>
              {percent}%
            </Text>
            <Text style={styles.percentLabel} maxFontSizeMultiplier={1.3}>
              COVERAGE
            </Text>
          </ProgressRing>
        </View>

        <View
          style={[styles.onTrackBadge, { borderColor: onTrack ? colors.success : colors.warning }]}
          accessibilityLabel={onTrack ? 'On track' : 'Off track, move back onto the racing line'}
        >
          <View style={[styles.onTrackDot, { backgroundColor: onTrack ? colors.success : colors.warning }]} />
          <Text
            style={[styles.onTrackText, { color: onTrack ? colors.success : colors.warning }]}
            maxFontSizeMultiplier={1.3}
          >
            {onTrack ? 'ON TRACK' : 'OFF TRACK'}
          </Text>
        </View>

        <View style={styles.cancelWrap}>
          <LongPressButton
            label="Cancel Calibration"
            accessibilityLabel="Cancel calibration, press and hold"
            onLongPressComplete={() => {
              facade.rejectCalibration();
              navigation.replace('CalibrationInstructions');
            }}
            durationMs={1200}
            danger
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg, gap: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary },
  subtitle: { ...typography.body, color: colors.textSecondary },
  ringWrap: { marginVertical: spacing.md },
  percent: { ...typography.timeLarge, color: colors.textPrimary, fontFamily: undefined },
  percentLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.xs },
  onTrackBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  onTrackDot: { width: 10, height: 10, borderRadius: 5, marginRight: spacing.sm },
  onTrackText: { ...typography.label, letterSpacing: 0.5 },
  cancelWrap: { marginTop: spacing.xl, width: '100%' },
});
