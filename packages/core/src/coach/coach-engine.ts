import type {
  BrakingZone,
  CoachCue,
  CoachEngine as CoachEngineContract,
  Corner,
  TrackMatch,
} from '../contracts';

const DISTANCE_EPSILON_M = 1e-6;

export interface CoachEngineConfig {
  totalLengthM?: number;
  minLeadM?: number;
  leadSeconds?: number;
  minimumConfidence?: number;
  referenceConfidence?: number;
  physicsConfidence?: number;
  cornerAheadConfidence?: number;
}

export const DEFAULT_COACH_ENGINE_CONFIG = Object.freeze({
  minLeadM: 80,
  leadSeconds: 3,
  minimumConfidence: 0.4,
  referenceConfidence: 0.9,
  physicsConfidence: 0.65,
  cornerAheadConfidence: 0.6,
});

interface Candidate {
  corner: Corner;
  kind: CoachCue['kind'];
  distanceToTargetM: number;
  confidence: number;
  targetLap: number;
}

function modulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

function forwardDistance(fromM: number, toM: number, totalLengthM: number): number {
  const distanceM = modulo(toM - fromM, totalLengthM);
  return distanceM < DISTANCE_EPSILON_M || totalLengthM - distanceM < DISTANCE_EPSILON_M
    ? 0
    : distanceM;
}

function finitePositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function unitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function qualityAllowsCue(match: TrackMatch): boolean {
  return match.quality.level === 'good' || match.quality.level === 'degraded';
}

export class CoachEngine implements CoachEngineContract {
  private readonly config: Required<Omit<CoachEngineConfig, 'totalLengthM'>>;
  private totalLengthM: number | undefined;
  private corners: Corner[] = [];
  private zones = new Map<number, BrakingZone>();
  private readonly emitted = new Set<string>();
  private lastLapIndex: number | undefined;

  constructor(config: CoachEngineConfig = {}) {
    this.totalLengthM = config.totalLengthM;
    this.config = {
      minLeadM: config.minLeadM ?? DEFAULT_COACH_ENGINE_CONFIG.minLeadM,
      leadSeconds: config.leadSeconds ?? DEFAULT_COACH_ENGINE_CONFIG.leadSeconds,
      minimumConfidence:
        config.minimumConfidence ?? DEFAULT_COACH_ENGINE_CONFIG.minimumConfidence,
      referenceConfidence:
        config.referenceConfidence ?? DEFAULT_COACH_ENGINE_CONFIG.referenceConfidence,
      physicsConfidence: config.physicsConfidence ?? DEFAULT_COACH_ENGINE_CONFIG.physicsConfidence,
      cornerAheadConfidence:
        config.cornerAheadConfidence ?? DEFAULT_COACH_ENGINE_CONFIG.cornerAheadConfidence,
    };
    if (this.totalLengthM !== undefined && !finitePositive(this.totalLengthM)) {
      throw new RangeError('totalLengthM must be positive and finite');
    }
    if (
      !finitePositive(this.config.minLeadM) ||
      !finitePositive(this.config.leadSeconds) ||
      !unitInterval(this.config.minimumConfidence) ||
      !unitInterval(this.config.referenceConfidence) ||
      !unitInterval(this.config.physicsConfidence) ||
      !unitInterval(this.config.cornerAheadConfidence)
    ) {
      throw new RangeError('CoachEngine config values are out of range');
    }
  }

  configure(corners: Corner[], zones: BrakingZone[]): void {
    this.corners = corners.map((corner) => ({ ...corner }));
    this.zones = new Map(zones.map((zone) => [zone.cornerId, { ...zone }]));
    this.reset();
  }

  reset(): void {
    this.emitted.clear();
    this.lastLapIndex = undefined;
  }

  onMatch(match: TrackMatch, speedMps: number | undefined): CoachCue | null {
    if (!qualityAllowsCue(match) || match.confidence < this.config.minimumConfidence) return null;
    const totalLengthM = this.resolveTotalLength(match);
    if (totalLengthM === undefined) return null;

    const currentLap = Math.floor((match.unwrappedProgressM + DISTANCE_EPSILON_M) / totalLengthM);
    if (this.lastLapIndex === undefined || currentLap > this.lastLapIndex) {
      this.lastLapIndex = currentLap;
      for (const key of this.emitted) {
        const lap = Number(key.slice(0, key.indexOf(':')));
        if (lap < currentLap) this.emitted.delete(key);
      }
    }

    const leadM = Math.max(
      this.config.minLeadM,
      this.config.leadSeconds * (finitePositive(speedMps) ? speedMps : 0),
    );
    const candidates: Candidate[] = [];
    for (const corner of this.corners) {
      const zone = this.zones.get(corner.id);
      const brakeSpanM =
        zone === undefined
          ? 0
          : forwardDistance(zone.brakeStartDistanceM, corner.entryDistanceM, totalLengthM);
      const usableZone =
        zone !== undefined &&
        zone.brakeCueAvailable !== false &&
        brakeSpanM > DISTANCE_EPSILON_M;
      const distanceToEntryM = forwardDistance(
        match.distanceM,
        corner.entryDistanceM,
        totalLengthM,
      );
      const alreadyPastBrakeStart = usableZone && distanceToEntryM < brakeSpanM;
      const kind: CoachCue['kind'] =
        usableZone && !alreadyPastBrakeStart ? 'BRAKE' : 'CORNER_AHEAD';
      const targetDistanceM =
        kind === 'BRAKE' && zone !== undefined
          ? zone.brakeStartDistanceM
          : corner.entryDistanceM;
      const distanceToTargetM = forwardDistance(match.distanceM, targetDistanceM, totalLengthM);
      if (distanceToTargetM > leadM + DISTANCE_EPSILON_M) continue;

      const targetLap = Math.floor(
        (match.unwrappedProgressM + distanceToTargetM + DISTANCE_EPSILON_M) / totalLengthM,
      );
      const key = `${targetLap}:${corner.id}`;
      if (this.emitted.has(key)) continue;
      const sourceConfidence =
        zone === undefined
          ? this.config.cornerAheadConfidence
          : zone.source === 'reference'
            ? this.config.referenceConfidence
            : this.config.physicsConfidence;
      const confidence = Math.min(match.confidence, sourceConfidence);
      if (confidence < this.config.minimumConfidence) continue;
      candidates.push({ corner, kind, distanceToTargetM, confidence, targetLap });
    }

    candidates.sort(
      (left, right) =>
        left.distanceToTargetM - right.distanceToTargetM || left.corner.id - right.corner.id,
    );
    const selected = candidates[0];
    if (selected === undefined) return null;
    this.emitted.add(`${selected.targetLap}:${selected.corner.id}`);
    return {
      kind: selected.kind,
      cornerId: selected.corner.id,
      severity: selected.corner.severity,
      direction: selected.corner.direction,
      distanceToTargetM: Math.max(0, selected.distanceToTargetM),
      advisorySpeedKph: selected.corner.advisorySpeedKph,
      confidence: selected.confidence,
    };
  }

  private resolveTotalLength(match: TrackMatch): number | undefined {
    if (finitePositive(this.totalLengthM)) return this.totalLengthM;
    if (match.progress > DISTANCE_EPSILON_M && finitePositive(match.distanceM)) {
      const inferred = match.distanceM / match.progress;
      if (finitePositive(inferred)) {
        this.totalLengthM = inferred;
        return inferred;
      }
    }
    return undefined;
  }
}
