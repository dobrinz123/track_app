import type { Corner } from '../contracts';

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

/** Parse and validate an observed-speeds asset against a concrete corner set. */
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
  if (!Array.isArray(parsed.observations)) {
    throw new TypeError('Observed-speeds asset must contain an observations array');
  }

  const observations: ObservedCornerSpeed[] = parsed.observations.map((value) => {
    if (!isRecord(value)) throw new TypeError('Observed speed must be an object');
    return {
      cornerId: value.cornerId as number,
      apexSpeedKph: value.apexSpeedKph as number,
      source: value.source as string,
    };
  });
  validateObservations(corners, observations);

  return {
    provenance: { source: parsed.provenance.source },
    observations,
  };
}
