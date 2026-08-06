import type { LapRecord, ReferenceLap, SectorTime } from '../contracts';

export interface PersonalBestCandidate {
  reference: ReferenceLap;
  lap: LapRecord;
  fullTelemetry: boolean;
  expectedSectorCount?: number;
}

export interface PersonalBestCandidateAliases {
  referenceLap: ReferenceLap;
  lapRecord: LapRecord;
  hasFullTelemetry: boolean;
  expectedSectorCount?: number;
}

export type PersonalBestCandidateInput = PersonalBestCandidate | PersonalBestCandidateAliases;

function unpack(candidate: PersonalBestCandidateInput): PersonalBestCandidate {
  if ('reference' in candidate) return candidate;
  return {
    reference: candidate.referenceLap,
    lap: candidate.lapRecord,
    fullTelemetry: candidate.hasFullTelemetry,
    ...(candidate.expectedSectorCount === undefined
      ? {}
      : { expectedSectorCount: candidate.expectedSectorCount }),
  };
}

function sectorsAreCompleteAndOrdered(
  sectors: readonly SectorTime[],
  durationMs: number,
  expectedCount?: number,
): boolean {
  if (sectors.length === 0 || (expectedCount !== undefined && sectors.length !== expectedCount)) {
    return false;
  }
  let totalMs = 0;
  for (let index = 0; index < sectors.length; index += 1) {
    const sector = sectors[index];
    if (
      sector === undefined ||
      sector.sectorIndex !== index ||
      !Number.isFinite(sector.durationMs) ||
      sector.durationMs < 0
    ) {
      return false;
    }
    totalMs += sector.durationMs;
  }
  return Math.abs(totalMs - durationMs) <= 1;
}

function hasProvenance(reference: ReferenceLap): boolean {
  return (
    reference.circuitId.trim().length > 0 &&
    reference.layoutId.trim().length > 0 &&
    reference.userId.trim().length > 0 &&
    reference.recordedAtUtc.trim().length > 0 &&
    reference.sessionId.trim().length > 0 &&
    reference.appVersion.trim().length > 0 &&
    Number.isFinite(reference.layoutVersion) &&
    Number.isFinite(reference.algorithmVersion) &&
    Number.isFinite(reference.profileSchemaVersion) &&
    Number.isInteger(reference.lapNumber) &&
    reference.lapNumber > 0
  );
}

function hasFullReferenceGrid(reference: ReferenceLap): boolean {
  const { distanceGridM, elapsedMsAtGrid } = reference;
  if (
    distanceGridM.length < 2 ||
    distanceGridM.length !== elapsedMsAtGrid.length ||
    distanceGridM[0] !== 0 ||
    elapsedMsAtGrid[0] !== 0
  ) {
    return false;
  }
  for (let index = 0; index < distanceGridM.length; index += 1) {
    const distanceM = distanceGridM[index];
    const elapsedMs = elapsedMsAtGrid[index];
    if (
      distanceM === undefined ||
      elapsedMs === undefined ||
      !Number.isFinite(distanceM) ||
      !Number.isFinite(elapsedMs)
    ) {
      return false;
    }
    if (index > 0) {
      const previousDistanceM = distanceGridM[index - 1];
      const previousElapsedMs = elapsedMsAtGrid[index - 1];
      if (
        previousDistanceM === undefined ||
        previousElapsedMs === undefined ||
        distanceM <= previousDistanceM ||
        elapsedMs < previousElapsedMs
      ) {
        return false;
      }
    }
  }
  const totalLengthM = distanceGridM[distanceGridM.length - 1] ?? 0;
  const finalElapsedMs = elapsedMsAtGrid[elapsedMsAtGrid.length - 1] ?? 0;
  return totalLengthM > 0 && Math.abs(finalElapsedMs - reference.durationMs) <= 1;
}

export function shouldReplacePb(
  current: ReferenceLap | null,
  candidateInput: PersonalBestCandidateInput,
): boolean {
  const candidate = unpack(candidateInput);
  const { lap, reference } = candidate;
  if (
    current !== null &&
    (current.circuitId !== reference.circuitId ||
      current.layoutId !== reference.layoutId ||
      current.layoutVersion !== reference.layoutVersion)
  ) {
    return false;
  }
  if (!lap.valid) return false;
  if (lap.quality !== 'good' && lap.quality !== 'degraded') return false;
  if (lap.invalidReasons.includes('PIT_TRANSIT')) return false;
  if (!sectorsAreCompleteAndOrdered(lap.sectorTimes, lap.durationMs, candidate.expectedSectorCount)) {
    return false;
  }
  if (current !== null && !(reference.durationMs < current.durationMs)) return false;
  if (!candidate.fullTelemetry || !hasFullReferenceGrid(reference)) return false;
  if (!hasProvenance(reference)) return false;
  return (
    Number.isFinite(lap.durationMs) &&
    lap.durationMs > 0 &&
    Math.abs(reference.durationMs - lap.durationMs) <= 1
  );
}
