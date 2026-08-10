import { CORNER_ANALYSIS_VERSION, type Corner } from '../contracts';

import type { ObservedCornerSpeed } from './analyzeCorners';

export interface ObservedSpeedsAsset {
  provenance: {
    source: string;
  };
  observations: ObservedCornerSpeed[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateObservations(
  corners: readonly Corner[],
  observations: readonly ObservedCornerSpeed[],
): void {
  const cornerIds = new Set(corners.map((corner) => corner.id));
  const observedIds = new Set<number>();

  for (const observation of observations) {
    if (
      !Number.isInteger(observation.cornerId) ||
      !cornerIds.has(observation.cornerId)
    ) {
      throw new RangeError(`Observed cornerId ${String(observation.cornerId)} does not exist`);
    }
    if (
      !Number.isFinite(observation.apexSpeedKph) ||
      observation.apexSpeedKph < 20 ||
      observation.apexSpeedKph > 320
    ) {
      throw new RangeError('Observed apexSpeedKph must be between 20 and 320');
    }
    if (typeof observation.source !== 'string' || observation.source.trim().length === 0) {
      throw new TypeError('Observed speed source must be a nonempty string');
    }
    if (observedIds.has(observation.cornerId)) {
      throw new RangeError(`Duplicate observed cornerId ${observation.cornerId}`);
    }
    observedIds.add(observation.cornerId);
  }
}

/** Apply observed apex speeds while retaining a 10% ceiling over model-v2 advice. */
export function applyObservedSpeeds(
  corners: readonly Corner[],
  observations: readonly ObservedCornerSpeed[],
): Corner[] {
  validateObservations(corners, observations);
  const byCornerId = new Map(observations.map((observation) => [observation.cornerId, observation]));

  return corners.map((corner) => {
    const observation = byCornerId.get(corner.id);
    if (observation === undefined) {
      return { ...corner, speedSource: 'model' };
    }
    return {
      ...corner,
      advisorySpeedKph: Math.min(observation.apexSpeedKph, corner.advisorySpeedKph * 1.1),
      speedSource: 'observed',
    };
  });
}

/**
 * Parse and validate an observed-speeds asset against a concrete corner set
 * (M-observed-version fix). Two failure modes that a future corner-analysis
 * change could realistically trigger are DELIBERATELY tolerant (never throw
 * out of a module-init call site like `tmrProfile.ts`'s):
 *
 * - `analysisVersion` mismatch: a `CORNER_ANALYSIS_VERSION` bump can produce
 *   the SAME corner count with different corner identities/positions --
 *   silently applying old observations to the wrong turns would be worse
 *   than applying none. The whole asset is ignored (empty `observations`)
 *   with a `console.warn`.
 * - An unknown `cornerId` (e.g. a corner removed by a geometry/analysis
 *   change): that ONE observation is skipped with a `console.warn`; every
 *   other, still-valid observation in the same asset is still applied.
 *
 * Every other malformation (wrong types, an out-of-range speed, a duplicate
 * ID, a missing `provenance`/`analysisVersion` field) still throws -- those
 * indicate a genuinely corrupted/hand-edited asset file, not an expected
 * consequence of the corner set evolving, and should fail loudly in dev/CI
 * rather than silently drop data.
 */
export function loadObservedSpeedsFromJson(
  json: string,
  corners: readonly Corner[],
): ObservedSpeedsAsset {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed) || !isRecord(parsed.provenance)) {
    throw new TypeError('Observed-speeds asset must contain a provenance block');
  }
  if (typeof parsed.provenance.source !== 'string' || parsed.provenance.source.trim().length === 0) {
    throw new TypeError('Observed-speeds provenance source must be a nonempty string');
  }
  if (!Number.isInteger(parsed.analysisVersion)) {
    throw new TypeError('Observed-speeds asset must contain an integer analysisVersion');
  }
  if (!Array.isArray(parsed.observations)) {
    throw new TypeError('Observed-speeds asset must contain an observations array');
  }

  const provenance = { source: parsed.provenance.source };

  if (parsed.analysisVersion !== CORNER_ANALYSIS_VERSION) {
    console.warn(
      `[observedSpeeds] asset analysisVersion ${String(parsed.analysisVersion)} does not match ` +
        `CORNER_ANALYSIS_VERSION ${CORNER_ANALYSIS_VERSION} -- ignoring all observations (advisory overlay only).`,
    );
    return { provenance, observations: [] };
  }

  const cornerIds = new Set(corners.map((corner) => corner.id));
  const observedIds = new Set<number>();
  const observations: ObservedCornerSpeed[] = [];
  for (const rawValue of parsed.observations) {
    if (!isRecord(rawValue)) throw new TypeError('Observed speed must be an object');
    const observation: ObservedCornerSpeed = {
      cornerId: rawValue.cornerId as number,
      apexSpeedKph: rawValue.apexSpeedKph as number,
      source: rawValue.source as string,
    };
    if (!Number.isInteger(observation.cornerId)) {
      throw new TypeError(`Observed cornerId ${String(observation.cornerId)} is not an integer`);
    }
    if (!cornerIds.has(observation.cornerId)) {
      console.warn(`[observedSpeeds] asset references unknown cornerId ${observation.cornerId} -- skipping.`);
      continue;
    }
    if (
      !Number.isFinite(observation.apexSpeedKph) ||
      observation.apexSpeedKph < 20 ||
      observation.apexSpeedKph > 320
    ) {
      throw new RangeError('Observed apexSpeedKph must be between 20 and 320');
    }
    if (typeof observation.source !== 'string' || observation.source.trim().length === 0) {
      throw new TypeError('Observed speed source must be a nonempty string');
    }
    if (observedIds.has(observation.cornerId)) {
      throw new RangeError(`Duplicate observed cornerId ${observation.cornerId}`);
    }
    observedIds.add(observation.cornerId);
    observations.push(observation);
  }

  return { provenance, observations };
}
