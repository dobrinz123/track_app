import React, { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useKeepAwake } from 'expo-keep-awake';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { colors, radii, spacing, typography } from '../theme';
import { ProgressRing } from '../components/ProgressRing';
import { LongPressButton } from '../components/LongPressButton';
import { StatusBanner } from '../components/StatusBanner';
import { facade } from '../../session/composition';
import { TMR_CIRCUIT_PROFILE, TMR_RUNTIME_PROFILE } from '../../session/tmrProfile';
import { useFacadeState } from '../hooks/useFacadeState';
import { TrackMapView } from '../components/TrackMapView';
import { fitCenterlineAutoRotated } from '../../session/trackMapModel';

type Props = NativeStackScreenProps<RootStackParamList, 'ActiveCalibration'>;

/** P1 fix (map container containment): the fraction of the map container's own WIDTH
 * its height is clamped to -- prevents an extreme track aspect (near-square, or very
 * elongated even after F1 auto-rotation) from producing a container so tall or so short
 * it clips against other screen content or reads as a sliver. */
const MAP_HEIGHT_MIN_FRACTION_OF_WIDTH = 0.4;
const MAP_HEIGHT_MAX_FRACTION_OF_WIDTH = 0.75;

/** S5 — live coverage progress ring + on-track indicator; navigates to S6 once a calibration result arrives. */
export function ActiveCalibrationScreen({ navigation }: Props): React.JSX.Element {
  // C9 fix: the mandatory Learn lap happens here, before ActiveDashboardScreen's
  // own useKeepAwake() ever mounts -- without this, a short iOS Auto-Lock can
  // lock the screen mid-calibration and stall/invalidate the Learn lap.
  useKeepAwake();
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

  // V2/V3 track-map plumbing: additive fields on `state.calibration`, present once a
  // sample with a valid track match has been fed this calibration attempt.
  const lateralM = state.calibration?.lateralM;
  const distanceM = state.calibration?.distanceM;
  const rawLocal =
    state.calibration?.rawLocalX !== undefined && state.calibration?.rawLocalY !== undefined
      ? { e: state.calibration.rawLocalX, n: state.calibration.rawLocalY }
      : undefined;
  const matchedLocal =
    state.calibration?.matchedLocalX !== undefined && state.calibration?.matchedLocalY !== undefined
      ? { e: state.calibration.matchedLocalX, n: state.calibration.matchedLocalY }
      : undefined;
  const offsetOverCorridor = lateralM !== undefined && Math.abs(lateralM) > TMR_CIRCUIT_PROFILE.corridorWidthM;

  // P1 fix (map containment on a phone screen): size the map container itself, rather
  // than letting `TrackMapView` assume a fixed width:height ratio -- width is the
  // screen width minus this screen's own standard horizontal padding (`spacing.lg` on
  // both sides via `styles.container`, as today), height is derived from the circuit's
  // own post-auto-rotate content aspect (`contentAspect`, P1 fix on `trackMapModel`)
  // so a portrait-after-rotation-to-landscape track fits without cropping, clamped to
  // [0.4, 0.75] of the width as a sane floor/ceiling for an extreme aspect. The
  // `containerAspect` passed in here (1) is a placeholder -- `contentAspect` is the
  // input points' own natural aspect and does not depend on it.
  const mapContentAspect = useMemo(
    () => fitCenterlineAutoRotated(TMR_RUNTIME_PROFILE.centerline, 1).contentAspect,
    [],
  );
  const windowWidth = useWindowDimensions().width;
  const mapWidth = windowWidth - spacing.lg * 2;
  const mapHeight = Math.min(
    MAP_HEIGHT_MAX_FRACTION_OF_WIDTH * mapWidth,
    Math.max(MAP_HEIGHT_MIN_FRACTION_OF_WIDTH * mapWidth, mapWidth / mapContentAspect),
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <View style={styles.container}>
        <Text style={styles.title} maxFontSizeMultiplier={1.3}>
          Calibrating…
        </Text>
        <Text style={styles.subtitle} maxFontSizeMultiplier={1.3}>
          Drive one steady lap
        </Text>

        {/* C7 fix: a failed async command (e.g. GNSS start failure) surfaces
            here inline -- never a modal. */}
        {state.lastError !== null ? <StatusBanner variant="error" message={state.lastError} /> : null}

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

        {/* V3 binding design: live track-map + offset/position info row, diagnosing
            OSM-centerline mismatches on-site (field context: "off track" while the
            driver was actually on the circuit). */}
        <View style={styles.infoRow}>
          <Text
            style={[styles.infoText, offsetOverCorridor && styles.infoTextAlert]}
            maxFontSizeMultiplier={1.3}
          >
            {lateralM === undefined ? 'Offset: — m' : `Offset: ${Math.abs(lateralM).toFixed(1)} m`}
          </Text>
          <Text style={styles.infoText} maxFontSizeMultiplier={1.3}>
            {distanceM === undefined ? 'Position: — km' : `Position: ${(distanceM / 1_000).toFixed(1)} km`}
          </Text>
        </View>
        <View style={[styles.mapWrap, { width: mapWidth, height: mapHeight }]}>
          <TrackMapView
            centerline={TMR_RUNTIME_PROFILE.centerline}
            startFinishLocal={TMR_RUNTIME_PROFILE.startFinishGate.a}
            rawLocal={rawLocal}
            matchedLocal={matchedLocal}
            onTrack={onTrack}
          />
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
  container: { flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.lg },
  title: { ...typography.title, fontSize: 26, color: colors.textPrimary },
  subtitle: { ...typography.body, color: colors.textSecondary },
  // The ring itself is a circular graphic, not text content -- kept centered as a widget
  // while the surrounding headings/badge/button stay left-aligned per the layout language.
  ringWrap: { alignSelf: 'center', marginVertical: spacing.md },
  percent: { ...typography.timeLarge, color: colors.textPrimary },
  percentLabel: { ...typography.label, color: colors.textMuted, marginTop: spacing.xs },
  onTrackBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  onTrackDot: { width: 10, height: 10, borderRadius: 5, marginRight: spacing.sm },
  onTrackText: { ...typography.label },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
  infoText: { ...typography.caption, color: colors.textSecondary },
  infoTextAlert: { color: colors.danger },
  // Explicit pixel size set inline per-render (P1 fix, above) -- `width: '100%'` here
  // is just the pre-computation fallback for the very first paint.
  mapWrap: { width: '100%' },
  cancelWrap: { marginTop: spacing.xl, width: '100%' },
});
