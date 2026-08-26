import React, { useMemo, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { StyleSheet, Text, View } from 'react-native';
import type { LocalPoint } from '@circuit/core';
import { colors, radii } from '../theme';
import {
  buildOutlineSegments,
  decimateCenterline,
  densifyToSpacing,
  fitCenterlineAutoRotated,
  pointAtLapFraction,
  segmentAngleDeg,
  type ContainerFraction,
  type OutlineJoint,
  type OutlineSegment,
} from '../../session/trackMapModel';

/**
 * Pre-layout fallback width:height ratio for the map container -- used only for the
 * very first render, before `onLayout` (F2) has measured the container's real,
 * parent-given pixel size. The container's ACTUAL on-screen aspect is now decided by
 * `ActiveCalibrationScreen` (P1 fix: content-aspect-driven sizing, clamped to [0.4,
 * 0.75] of width, so the outline's corners stay off the container edges on a narrow
 * phone) -- `TrackMapView` itself just fills whatever box its parent gives it and
 * measures that box's real aspect via `onLayout` for its own `fitCenterlineAutoRotated`
 * call, rather than assuming this fixed ratio.
 */
export const TRACK_MAP_ASPECT_RATIO = 1 / 0.55;

const START_FINISH_TICK_SIZE = 6;
const MARKER_DOT_SIZE = 8;
const CHEVRON_SIZE = 8;
// P2 fix ("choppy" line, user field report): thicker at phone DPI, plus the joint
// dots below round over what used to be a visible notch at every rotated segment's
// join.
const OUTLINE_SEGMENT_HEIGHT = 2.5;

/** F3 densify (to spacing) + F2 decimate targets: the pipeline densifies the source
 * centerline so no segment exceeds `DENSIFY_TARGET_SPACING_M` BEFORE decimating down to
 * at most `OUTLINE_POINT_TARGET` points -- keeps segments short (smooth curves) while
 * capping the connected-outline segment count (`buildOutlineSegments` emits one segment
 * per consecutive pair, so at most `OUTLINE_POINT_TARGET`). */
const DENSIFY_TARGET_SPACING_M = 12;
const OUTLINE_POINT_TARGET = 400;

/** F5: the direction chevron sits at this fraction of the lap's total distance. */
const CHEVRON_LAP_FRACTION = 0.1;

/** Insets `frac` (a `[0,1]` axis fraction) by `radiusPx` of `containerPx`, so a
 * `radiusPx`-radius dot centered on the result never renders past the `[0, containerPx]`
 * boundary (P1 fix: "marker/dot positions subtract their own radius") -- a no-op while
 * `containerPx` is still 0 (pre-`onLayout`; nothing meaningful to clamp against yet). */
function insetFractionByRadius(frac: number, radiusPx: number, containerPx: number): number {
  if (containerPx <= 0) return frac;
  const radiusFrac = radiusPx / containerPx;
  return Math.min(1 - radiusFrac, Math.max(radiusFrac, frac));
}

/** Centers a `size`x`size` square dot on `fraction`, via percentage `left`/`top` plus a
 * matching negative margin (RN has no percentage-based `transform: translate`) --
 * `fraction` is first inset by the dot's own radius (P1 fix) so an edge marker's drawn
 * circle never renders past `containerW`/`containerH`. */
function dotPosition(fraction: ContainerFraction, size: number, containerW: number, containerH: number): {
  position: 'absolute';
  left: `${number}%`;
  top: `${number}%`;
  width: number;
  height: number;
  borderRadius: number;
  marginLeft: number;
  marginTop: number;
} {
  const radius = size / 2;
  const xFrac = insetFractionByRadius(fraction.xFrac, radius, containerW);
  const yFrac = insetFractionByRadius(fraction.yFrac, radius, containerH);
  return {
    position: 'absolute',
    left: `${xFrac * 100}%`,
    top: `${yFrac * 100}%`,
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
 * is itself pixel-precise), `width = lengthPx`, `height = OUTLINE_SEGMENT_HEIGHT`,
 * rotated `angleDeg` around its LEFT-CENTER origin so it sweeps from `(x, y)` toward
 * the next point. */
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

/** Positions a `size`x`size` filled circle centered on a joint's container-pixel
 * `(x, y)` (P2 fix: absolute pixel `left`/`top`, matching `segmentStyle`'s own
 * pixel-not-percent positioning, since joints come from the same pixel-space
 * `buildOutlineSegments` output as the segments they round over). */
function jointStyle(joint: OutlineJoint, size: number): {
  position: 'absolute';
  left: number;
  top: number;
  width: number;
  height: number;
  borderRadius: number;
} {
  return {
    position: 'absolute',
    left: joint.x - size / 2,
    top: joint.y - size / 2,
    width: size,
    height: size,
    borderRadius: size / 2,
  };
}

/**
 * P2 fix ("choppy" line, user field report): a filled circle at every outline vertex,
 * the same diameter as the outline's own line thickness -- rounds over the notch a
 * rotated `OutlineSegment` otherwise leaves at each join, so the connected outline
 * reads as one smooth continuous line instead of faceted 2px segments. Wrapped in
 * `React.memo` and memoized by `TrackMapView` alongside `CenterlineOutline` (same
 * source data, same re-render conditions).
 */
const JointDots = React.memo(function JointDots({ joints }: { joints: OutlineJoint[] }): React.JSX.Element {
  return (
    <>
      {joints.map((joint, index) => (
        <View key={index} pointerEvents="none" style={[styles.outlineSegment, jointStyle(joint, OUTLINE_SEGMENT_HEIGHT)]} />
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
  // Container pixel size, from a ONE-TIME-per-size `onLayout` measurement -- both
  // dimensions now, not just width (F2 needs pixel lengths for segments; P1 needs the
  // REAL measured aspect for `fitCenterlineAutoRotated` below, since `ActiveCalibrationScreen`
  // -- not a fixed constant -- now decides the container's actual on-screen height).
  // Starts at {0, 0} (nothing measured yet); every pixel-dependent memo below is
  // empty/undefined, and `containerAspect` falls back to `TRACK_MAP_ASPECT_RATIO`,
  // until the first layout fires.
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const { width: containerW, height: containerH } = containerSize;
  const containerAspect = containerH > 0 ? containerW / containerH : TRACK_MAP_ASPECT_RATIO;
  const handleLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    setContainerSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  };

  // Fit: F3 densify (to spacing -- short segments through curves) -> F2 decimate (cap
  // the segment count) -> F1 auto-rotate to fit (portrait tracks get their long axis
  // aligned with the container's) against the container's OWN measured aspect (P1 fix).
  // `decimated`/`fit` are recomputed whenever `centerline` OR `containerAspect` changes
  // (V1 binding design keeps this a single memoized pipeline; `containerAspect` is
  // stable across the vast majority of renders since it only changes on a real layout
  // event).
  const { decimated, fit } = useMemo(() => {
    const densified = densifyToSpacing(centerline, DENSIFY_TARGET_SPACING_M);
    const decimatedPoints = decimateCenterline(densified, OUTLINE_POINT_TARGET);
    return { decimated: decimatedPoints, fit: fitCenterlineAutoRotated(decimatedPoints, containerAspect) };
  }, [centerline, containerAspect]);

  const { segments: outlineSegments, joints: outlineJoints } = useMemo(() => {
    if (containerW === 0) return { segments: [], joints: [] };
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
      <JointDots joints={outlineJoints} />
      <View
        pointerEvents="none"
        style={[styles.startFinishTick, dotPosition(startFinishFraction, START_FINISH_TICK_SIZE, containerW, containerH)]}
      />
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
          style={[styles.rawDot, dotPosition(rawFraction, MARKER_DOT_SIZE, containerW, containerH)]}
        />
      )}
      {matchedFraction === undefined ? null : (
        <View
          pointerEvents="none"
          testID="trackmap-matched-dot"
          accessibilityLabel="trackmap-matched-dot"
          style={[
            styles.matchedDot,
            dotPosition(matchedFraction, MARKER_DOT_SIZE, containerW, containerH),
            { backgroundColor: onTrack ? colors.success : colors.danger },
          ]}
        />
      )}
      {/* Legend: the amber RAW-GPS dot legitimately floats OFF the line by the
          live lateral offset -- without naming both dots, that reads as a bug
          (user field feedback). Bottom-left, out of the outline's way. */}
      <View pointerEvents="none" style={styles.legend}>
        <View style={[styles.legendDot, { backgroundColor: colors.accent }]} />
        <Text style={styles.legendText} maxFontSizeMultiplier={1.2}>
          GPS
        </Text>
        <View style={[styles.legendDot, { backgroundColor: onTrack ? colors.success : colors.danger }]} />
        <Text style={styles.legendText} maxFontSizeMultiplier={1.2}>
          On-track position
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // P1 fix: sizing (both dimensions) now comes entirely from the parent
    // (`ActiveCalibrationScreen`'s `mapWrap`, content-aspect-driven) -- this `View`
    // just fills whatever box it's given; `TrackMapView` measures that box's real
    // aspect via `onLayout` instead of assuming a fixed ratio.
    width: '100%',
    height: '100%',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  outlineSegment: { backgroundColor: colors.textMuted },
  legend: {
    position: 'absolute',
    left: 8,
    bottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: { width: 6, height: 6, borderRadius: 3 },
  legendText: { color: colors.textMuted, fontSize: 10 },
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
