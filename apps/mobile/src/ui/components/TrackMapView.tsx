import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import type { LocalPoint } from '@circuit/core';
import { colors, radii } from '../theme';
import {
  decimateCenterline,
  fitCenterline,
  type ContainerFraction,
} from '../../session/trackMapModel';

/**
 * Width : height ratio of the map container -- fixed at ~55% height of width (V3
 * binding design, `ActiveCalibrationScreen`'s "map goes in the empty lower area, fixed
 * height ~55% of width"). Applied via RN's `aspectRatio` style, so the container's
 * height always tracks its own (100%-of-parent) width with no `onLayout` measurement
 * needed.
 */
export const TRACK_MAP_ASPECT_RATIO = 1 / 0.55;

const OUTLINE_DOT_SIZE = 3;
const START_FINISH_TICK_SIZE = 6;
const MARKER_DOT_SIZE = 8;

/** Centers a `size`x`size` square dot on `fraction`, via percentage `left`/`top` plus a
 * matching negative margin (RN has no percentage-based `transform: translate`). */
function dotPosition(fraction: ContainerFraction, size: number): {
  position: 'absolute';
  left: `${number}%`;
  top: `${number}%`;
  width: number;
  height: number;
  borderRadius: number;
  marginLeft: number;
  marginTop: number;
} {
  return {
    position: 'absolute',
    left: `${fraction.xFrac * 100}%`,
    top: `${fraction.yFrac * 100}%`,
    width: size,
    height: size,
    borderRadius: size / 2,
    marginLeft: -size / 2,
    marginTop: -size / 2,
  };
}

/**
 * The ~200-dot circuit outline layer, wrapped in `React.memo` (MUST DO perf
 * constraint: "position dots re-render must not re-render the 200 outline dots"). Its
 * `points` prop is itself memoized by `TrackMapView` against `centerline`'s identity
 * only, so this never re-renders on a raw/matched position update -- only when the
 * circuit itself changes (never, in practice: one bundled circuit per MVP session).
 */
const CenterlineOutline = React.memo(function CenterlineOutline({
  points,
}: {
  points: ContainerFraction[];
}): React.JSX.Element {
  return (
    <>
      {points.map((point, index) => (
        <View key={index} pointerEvents="none" style={[styles.outlineDot, dotPosition(point, OUTLINE_DOT_SIZE)]} />
      ))}
    </>
  );
});

export interface TrackMapViewProps {
  /** Full (undecimated) local-frame centerline -- a stable module-level reference for
   * the app's one bundled circuit, so decimating/fitting it below only ever runs once. */
  centerline: readonly LocalPoint[];
  /** Local-frame point for the start/finish line (distance 0 along the centerline). */
  startFinishLocal: LocalPoint;
  /** Last fed sample's raw (unmatched) local-frame position -- `undefined` until the
   * first sample with a valid track match has been fed this calibration attempt. */
  rawLocal: LocalPoint | undefined;
  /** Last fed sample's matched (projected-onto-centerline) local-frame position -- same
   * availability as `rawLocal`. */
  matchedLocal: LocalPoint | undefined;
  /** Whether the live on-track indicator (V6 live-indicator fix: wide Learn corridor)
   * says on-track -- colors the matched dot green (on-track) or red (off-track). */
  onTrack: boolean;
}

/**
 * V1 binding design: pure `View`-based live track-map for the calibration screen --
 * NO `react-native-svg`, no new deps, same philosophy as `LapDetailScreen`'s
 * `TelemetrySparkline`. Renders the decimated circuit outline, a start/finish tick, the
 * raw GPS dot (amber), and the matched/on-centerline dot (green/red by `onTrack`). A
 * thin line between the raw and matched dots is deliberately NOT drawn -- their
 * proximity (or lack of it) is itself the diagnostic signal.
 */
export function TrackMapView({
  centerline,
  startFinishLocal,
  rawLocal,
  matchedLocal,
  onTrack,
}: TrackMapViewProps): React.JSX.Element {
  // Fit: bounding box computed once, memoized by `centerline`'s own identity (V1
  // binding design). `decimateCenterline`'s ~200-point output is also what the fit is
  // computed from -- close enough to the full centerline's true extent for this
  // diagnostic view, and keeps this a single memoized pipeline.
  const { decimated, fit } = useMemo(() => {
    const decimatedPoints = decimateCenterline(centerline);
    return { decimated: decimatedPoints, fit: fitCenterline(decimatedPoints, TRACK_MAP_ASPECT_RATIO) };
  }, [centerline]);

  const outlineFractions = useMemo(() => decimated.map((point) => fit.project(point)), [decimated, fit]);
  const startFinishFraction = useMemo(() => fit.project(startFinishLocal), [fit, startFinishLocal]);
  const rawFraction = rawLocal === undefined ? undefined : fit.project(rawLocal);
  const matchedFraction = matchedLocal === undefined ? undefined : fit.project(matchedLocal);

  return (
    <View style={styles.container} accessibilityLabel="Live position on the circuit map">
      <CenterlineOutline points={outlineFractions} />
      <View pointerEvents="none" style={[styles.startFinishTick, dotPosition(startFinishFraction, START_FINISH_TICK_SIZE)]} />
      {rawFraction === undefined ? null : (
        <View pointerEvents="none" style={[styles.rawDot, dotPosition(rawFraction, MARKER_DOT_SIZE)]} />
      )}
      {matchedFraction === undefined ? null : (
        <View
          pointerEvents="none"
          style={[
            styles.matchedDot,
            dotPosition(matchedFraction, MARKER_DOT_SIZE),
            { backgroundColor: onTrack ? colors.success : colors.danger },
          ]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: TRACK_MAP_ASPECT_RATIO,
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  outlineDot: { backgroundColor: colors.textMuted },
  startFinishTick: { backgroundColor: colors.accent },
  rawDot: { backgroundColor: colors.accent },
  matchedDot: {},
});
