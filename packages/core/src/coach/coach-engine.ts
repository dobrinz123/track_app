import type {
  BrakingZone,
  CoachCue,
  CoachEngine as CoachEngineContract,
  Corner,
  TrackMatch,
} from '../contracts';

const DISTANCE_EPSILON_M = 1e-6;

/**
 * A corner's own `exitDistanceM` (part of `Corner`, unaffected by a
 * braking-zone refresh) only ever shrinks while genuinely approaching/
 * traversing it, then snaps to nearly a full lap once actually driven past
 * (the next occurrence is next lap). A single-sample INCREASE past this
 * threshold can only be that wrap -- no real GNSS sample-to-sample jitter or
 * plausible speed/sample-rate combination legitimately produces a forward
 * jump this large while still approaching. Deliberately generous (biased
 * toward under- rather than over-detecting "passed"): a missed detection
 * just means the live-distance filter below still excludes the corner once
 * it is genuinely out of `leadM` range, so nothing shows stale; a FALSE
 * detection would wrongly suppress a corner still being approached, which
 * is the failure mode this constant protects against.
 */
const EXIT_JUMP_THRESHOLD_M = 500;

export interface CoachEngineConfig {
  totalLengthM?: number;
  minLeadM?: number;
  leadSeconds?: number;
  minimumConfidence?: number;
  referenceConfidence?: number;
  physicsConfidence?: number;
  cornerAheadConfidence?: number;
  /**
   * Reported `speedMps` is clamped to this ceiling before it feeds the
   * `leadSeconds * speed` lead-distance calculation (M-speed-clamp) -- a
   * transient GNSS speed glitch must never blow the lead window out past a
   * plausible on-track speed. Default 90 m/s (~324 km/h), comfortably above
   * anything TMR-relevant.
   */
  maxLeadSpeedMps?: number;
}

export const DEFAULT_COACH_ENGINE_CONFIG = Object.freeze({
  minLeadM: 80,
  leadSeconds: 3,
  minimumConfidence: 0.4,
  referenceConfidence: 0.9,
  physicsConfidence: 0.65,
  cornerAheadConfidence: 0.6,
  maxLeadSpeedMps: 90,
});

interface Candidate {
  corner: Corner;
  kind: CoachCue['kind'];
  distanceToTargetM: number;
  confidence: number;
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

/**
 * Advisory-only (contracts.md's Coaching addendum) live braking/corner cue
 * engine. `onMatch` is STATELESS with respect to "already shown": as long as
 * a corner's target point stays within the lead window it is re-selected
 * and re-emitted EVERY call with a freshly recomputed `distanceToTargetM` --
 * a true countdown, not a one-shot flag (F1/F2 binding fix). The only
 * per-lap memory kept is `completedThisLap`, a defensive guard (keyed by the
 * corner's own, zone-independent `exitDistanceM`) against a corner already
 * driven past reappearing as a candidate later in the SAME lap -- see
 * `EXIT_JUMP_THRESHOLD_M`'s doc comment. `configure()`'s `preserveEmitted`
 * option carries that guard across a mid-lap braking-zone refresh (a new PB
 * landing) instead of wiping it.
 */
export class CoachEngine implements CoachEngineContract {
  private readonly config: Required<Omit<CoachEngineConfig, 'totalLengthM'>>;
  private totalLengthM: number | undefined;
  private corners: Corner[] = [];
  private zones = new Map<number, BrakingZone>();
  /** `lap:cornerId` keys already confirmed driven past this lap (see class doc comment) -- never re-candidates regardless of live distance. */
  private readonly completedThisLap = new Set<number>();
  /** Last observed forward-distance-to-exit per corner THIS lap, used only to detect the pass-jump described above. */
  private readonly lastExitDistanceByCorner = new Map<number, number>();
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
      maxLeadSpeedMps: config.maxLeadSpeedMps ?? DEFAULT_COACH_ENGINE_CONFIG.maxLeadSpeedMps,
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
      !unitInterval(this.config.cornerAheadConfidence) ||
      !finitePositive(this.config.maxLeadSpeedMps)
    ) {
      throw new RangeError('CoachEngine config values are out of range');
    }
  }

  configure(corners: Corner[], zones: BrakingZone[], options?: { preserveEmitted?: boolean }): void {
    this.corners = corners.map((corner) => ({ ...corner }));
    this.zones = new Map(zones.map((zone) => [zone.cornerId, { ...zone }]));
    if (options?.preserveEmitted === true) return;
    this.reset();
  }

  reset(): void {
    this.completedThisLap.clear();
    this.lastExitDistanceByCorner.clear();
    this.lastLapIndex = undefined;
  }

  onMatch(match: TrackMatch, speedMps: number | undefined): CoachCue | null {
    if (!qualityAllowsCue(match) || match.confidence < this.config.minimumConfidence) return null;
    const totalLengthM = this.resolveTotalLength(match);
    if (totalLengthM === undefined) return null;

    const currentLap = Math.floor((match.unwrappedProgressM + DISTANCE_EPSILON_M) / totalLengthM);
    if (this.lastLapIndex === undefined || currentLap > this.lastLapIndex) {
      this.lastLapIndex = currentLap;
      this.completedThisLap.clear();
      this.lastExitDistanceByCorner.clear();
    }

    const cappedSpeedMps = finitePositive(speedMps)
      ? Math.min(speedMps, this.config.maxLeadSpeedMps)
      : 0;
    const leadM = Math.max(this.config.minLeadM, this.config.leadSeconds * cappedSpeedMps);
    const candidates: Candidate[] = [];
    for (const corner of this.corners) {
      // Defensive "driven past" guard, independent of zone/target geometry
      // (see class + EXIT_JUMP_THRESHOLD_M doc comments).
      const distanceToExitM = forwardDistance(match.distanceM, corner.exitDistanceM, totalLengthM);
      const previousExitDistanceM = this.lastExitDistanceByCorner.get(corner.id);
      if (
        previousExitDistanceM !== undefined &&
        distanceToExitM - previousExitDistanceM > EXIT_JUMP_THRESHOLD_M
      ) {
        this.completedThisLap.add(corner.id);
      }
      this.lastExitDistanceByCorner.set(corner.id, distanceToExitM);
      if (this.completedThisLap.has(corner.id)) continue;

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
      // Reaching (or passing) the target itself immediately ends this
      // corner's cue this lap (F1/F2: "target passed") -- forwardDistance's
      // own epsilon collapse already treats an exact hit as 0, and anything
      // beyond the lead window is excluded by the check below regardless.
      if (distanceToTargetM > leadM + DISTANCE_EPSILON_M) continue;

      const sourceConfidence =
        zone === undefined
          ? this.config.cornerAheadConfidence
          : zone.source === 'reference'
            ? this.config.referenceConfidence
            : this.config.physicsConfidence;
      const confidence = Math.min(match.confidence, sourceConfidence);
      if (confidence < this.config.minimumConfidence) continue;
      candidates.push({ corner, kind, distanceToTargetM, confidence });
    }

    candidates.sort(
      (left, right) =>
        left.distanceToTargetM - right.distanceToTargetM || left.corner.id - right.corner.id,
    );
    const selected = candidates[0];
    if (selected === undefined) return null;
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
