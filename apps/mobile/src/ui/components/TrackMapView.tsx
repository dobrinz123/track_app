import React, { useMemo, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { StyleSheet, View } from 'react-native';
import type { LocalPoint } from '@circuit/core';
import { colors, radii } from '../theme';
import {
  buildOutlineSegments,
  decimateCenterline,
  densifyCenterline,
  fitCenterlineAutoRotated,
  pointAtLapFraction,
  segmentAngleDeg,
  type ContainerFraction,
  type OutlineSegment,
} from '../../session/trackMapModel';

/**
 * Width : height ratio of the map container -- fixed at ~55% height of width (V3
 * binding design, `ActiveCalibrationScreen`'s "map goes in the empty lower area, fixed
 * height ~55% of width"). Applied via RN's `aspectRatio` style, so the container's
 * height always tracks its own (100%-of-parent) width with no LAYOUT dependency for
 * SIZING. `TrackMapView` still reads its own measured width via `onLayout` (F2) --
 * purely to turn `ContainerFraction`s into pixel-precise outline-segment lengths, never
 * to size the container itself.
 */
export const TRACK_MAP_ASPECT_RATIO = 1 / 0.55;

const START_FINISH_TICK_SIZE = 6;
const MARKER_DOT_SIZE = 8;
const CHEVRON_SIZE = 8;
const OUTLINE_SEGMENT_HEIGHT = 2;

/** F3 densify + F2 decimate targets: the pipeline densifies a sparse (<250-point)
 * source centerline to ~2x its point count BEFORE decimating down to at most this many
 * points -- keeps segments short (smooth curves) while capping the connected-outline
 * segment count (`buildOutlineSegments` emits one segment per consecutive pair, so at
 * most `OUTLINE_POINT_TARGET - 1`). */
const OUTLINE_POINT_TARGET = 250;

/** F5: the direction chevron sits at this fraction of the lap's total distance. */
const CHEVRON_LAP_FRACTION = 0.1;

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

/** Centers a `size`x`size` element on `fraction` via percentage `left`/`top` plus a
 * matching negative margin, WITHOUT touching `width`/`height`/`borderRadius` -- unlike
 * `dotPosition`, so it composes safely with a shape (F5's triangular chevron) that sets
 * its own `width: 0` / `height: 0` / CSS-triangle borders in `styles.chevron`. */
function centerPosition(fraction: ContainerFraction, size: number): {
  position: 'absolute';
  left: `${number}%`;
  top: `${number}%`;
  marginLeft: number;
  marginTop: number;
} {
  return {
    position: 'absolute',
    left: `${fraction.xFrac * 100}%`,
    top: `${fraction.yFrac * 100}%`,
    marginLeft: -size / 2,
    marginTop: -size / 2,
  };
}

/** Positions a thin, `lengthPx`-long segment `View` per F2's design: absolute
 * `left`/`top` at the segment's start (container pixels, not percent -- segment length
 * is itself pixel-precise), `width = lengthPx`, `height = 2`, rotated `angleDeg` around
 * its LEFT-CENTER origin so it sweeps from `(x, y)` toward the next point. */
function segmentStyle(segment: OutlineSegment): {
  position: 'absolute';
  left: number;
  top: number;
  width: number;
  height: number;
  transform: [{ rotate: string }];
  transformOrigin: string;
} {
  return {
    position: 'absolute',
    left: segment.x,
    top: segment.y,
    width: segment.lengthPx,
    height: OUTLINE_SEGMENT_HEIGHT,
    transform: [{ rotate: `${segment.angleDeg}deg` }],
    transformOrigin: 'left center',
  };
}

/**
 * F2 connected circuit outline (replaces the old dot-cloud), wrapped in `React.memo`
 * (MUST DO perf constraint: outline re-render must not follow every raw/matched
 * position update). Its `segments` prop is itself memoized by `TrackMapView` against
 * `centerline`'s/the container's own pixel width, so this never re-renders on a
 * raw/matched marker update -- only when the circuit or container size actually
 * changes.
 */
const CenterlineOutline = React.memo(function CenterlineOutline({
  segments,
}: {
  segments: OutlineSegment[];
}): React.JSX.Element {
  return (
    <>
      {segments.map((segment, index) => (
        <View key={index} pointerEvents="none" style={[styles.outlineSegment, segmentStyle(segment)]} />
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
  // Container pixel width, from a ONE-TIME-per-size `onLayout` measurement (F2 needs it:
  // connected-outline segment lengths are pixel lengths, not percentages). Height always
  // derives from it via the fixed `TRACK_MAP_ASPECT_RATIO`, so a resize (rare -- device
  // rotation) still updates both together. Starts at 0 (nothing measured yet); every
  // pixel-dependent memo below is empty/undefined until the first layout fires.
  const [containerW, setContainerW] = useState(0);
  const containerH = containerW / TRACK_MAP_ASPECT_RATIO;
  const handleLayout = (event: LayoutChangeEvent): void => {
    const width = event.nativeEvent.layout.width;
    setContainerW((prev) => (prev === width ? prev : width));
  };

  // Fit: F3 densify (short segments through curves) -> F2 decimate (cap the segment
  // count) -> F1 auto-rotate to fit (portrait tracks get their long axis aligned with
  // the container's), computed once per `centerline` identity (V1 binding design) --
  // close enough to the full centerline's true extent for this diagnostic view, and
  // keeps this a single memoized pipeline.
  const { decimated, fit } = useMemo(() => {
    const densified = densifyCenterline(centerline, OUTLINE_POINT_TARGET);
    const decimatedPoints = decimateCenterline(densified, OUTLINE_POINT_TARGET);
    return { decimated: decimatedPoints, fit: fitCenterlineAutoRotated(decimatedPoints, TRACK_MAP_ASPECT_RATIO) };
  }, [centerline]);

  const outlineSegments = useMemo(() => {
    if (containerW === 0) return [];
    const fractions = decimated.map((point) => fit.project(point));
    return buildOutlineSegments(fractions, containerW, containerH);
  }, [decimated, fit, containerW, containerH]);

  const startFinishFraction = useMemo(() => fit.project(startFinishLocal), [fit, startFinishLocal]);
  const rawFraction = rawLocal === undefined ? undefined : fit.project(rawLocal);
  const matchedFraction = matchedLocal === undefined ? undefined : fit.project(matchedLocal);

  // F5: a tiny direction chevron at 10% of the lap's total distance -- its on-screen
  // angle comes from projecting TWO nearby lap-distance points through the same `fit`
  // and measuring their screen-space direction (`segmentAngleDeg`), so it stays correct
  // under F1's auto-rotation exactly like the outline segments do.
  const chevron = useMemo(() => {
    if (containerW === 0) return undefined;
    const lap = pointAtLapFraction(centerline, CHEVRON_LAP_FRACTION);
    if (lap === undefined) return undefined;
    const from = fit.project(lap.point);
    const to = fit.project(lap.aheadPoint);
    return { fraction: from, angleDeg: segmentAngleDeg(from, to, containerW, containerH) };
  }, [centerline, fit, containerW, containerH]);

  return (
    <View style={styles.container} accessibilityLabel="Live position on the circuit map" onLayout={handleLayout}>
      <CenterlineOutline segments={outlineSegments} />
      <View pointerEvents="none" style={[styles.startFinishTick, dotPosition(startFinishFraction, START_FINISH_TICK_SIZE)]} />
      {chevron === undefined ? null : (
        <View
          pointerEvents="none"
          style={[
            styles.chevron,
            centerPosition(chevron.fraction, CHEVRON_SIZE),
            // A CSS-triangle `View` (transparent left/right borders, solid bottom
            // border) points UP by default -- +90deg turns "up" into "along +x"
            // (`angleDeg`'s own zero direction), then `angleDeg` rotates it the rest
            // of the way to the actual direction of travel.
            { transform: [{ rotate: `${chevron.angleDeg + 90}deg` }] },
          ]}
        />
      )}
      {rawFraction === undefined ? null : (
        <View
          pointerEvents="none"
          testID="trackmap-raw-dot"
          accessibilityLabel="trackmap-raw-dot"
          style={[styles.rawDot, dotPosition(rawFraction, MARKER_DOT_SIZE)]}
        />
      )}
      {matchedFraction === undefined ? null : (
        <View
          pointerEvents="none"
          testID="trackmap-matched-dot"
          accessibilityLabel="trackmap-matched-dot"
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
  outlineSegment: { backgroundColor: colors.textMuted },
  startFinishTick: { backgroundColor: colors.accent },
  rawDot: { backgroundColor: colors.accent },
  matchedDot: {},
  // F5 chevron: a CSS-triangle `View` (zero width/height, transparent left/right
  // borders, solid bottom border) -- muted color per the design (a diagnostic hint, not
  // a focal marker like the raw/matched dots).
  chevron: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderLeftWidth: CHEVRON_SIZE / 2,
    borderRightWidth: CHEVRON_SIZE / 2,
    borderBottomWidth: CHEVRON_SIZE,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: colors.textMuted,
    borderRadius: 0,
  },
});
