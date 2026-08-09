export { createProjection } from './projection';
export {
  polylineCumulative,
  polylineLength,
  projectOntoPolyline,
  unwrapProgress,
} from './polyline';
export type { PolylineProjection, ProjectionHint } from './polyline';
export { crossingDirection, interpolateCrossingTime, segmentIntersection } from './intersection';
export type { SegmentIntersection } from './intersection';
export { curvatureAtDistance, curvatureProfile } from './curvature';
