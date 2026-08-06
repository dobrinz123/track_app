import type {
  CircuitProfile,
  CrossingEvent,
  Gate,
  LapRecord,
  LapTimingEngine as LapTimingEngineContract,
  QualityLevel,
  SectorTime,
} from '../contracts';

export interface LapTimingProfile {
  totalLengthM: CircuitProfile['totalLengthM'];
  startFinishGate: CircuitProfile['startFinishGate'];
  sectorGates: CircuitProfile['sectorGates'];
}

export interface LapTimingEngineConfig {
  minLapMs?: number;
  lowQualityWindowMs?: number;
  reverseTravelThresholdM?: number;
  /**
   * Lap number the NEXT lap started by this engine will be assigned
   * (default 1, matching every prior fresh-session behavior exactly).
   * Additive, MUST DO #5: `SessionController.restoreFromCheckpoint` sets
   * this to `maxRestoredLapNumber + 1` so recovered sessions don't renumber
   * their next lap back to 1 and collide with restored history.
   */
  initialLapNumber?: number;
}

interface SectorGateSpec {
  id: string;
  startsSectorIndex: number;
}

interface ActiveLap {
  lapNumber: number;
  tStart: number;
  startProgressM: number;
  lastEventTime: number;
  lastSectorTime: number;
  currentSectorIndex: number;
  sectorQuality: QualityLevel;
  quality: QualityLevel;
  lowQualitySince: number | null;
  maxProgressM: number;
  observedSectorIds: string[];
  sectorTimes: SectorTime[];
  invalidReasons: Set<string>;
}

const DEFAULT_MIN_LAP_MS = 60_000;
const DEFAULT_LOW_QUALITY_WINDOW_MS = 10_000;
const DEFAULT_REVERSE_TRAVEL_THRESHOLD_M = 30;

const QUALITY_RANK: Record<QualityLevel, number> = {
  good: 0,
  degraded: 1,
  unreliable: 2,
  invalid: 3,
};

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function worstQuality(a: QualityLevel, b: QualityLevel): QualityLevel {
  return QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b;
}

function isLowQuality(quality: QualityLevel): boolean {
  return quality === 'unreliable' || quality === 'invalid';
}

function sectorSpec(gate: Gate, order: number): SectorGateSpec {
  return {
    id: gate.id,
    startsSectorIndex: gate.sectorIndex ?? order + 1,
  };
}

export class LapTimingEngine implements LapTimingEngineContract {
  private readonly totalLengthM: number;
  private readonly startFinishGateId: string;
  private readonly sectors: readonly SectorGateSpec[];
  private readonly sectorById: ReadonlyMap<string, SectorGateSpec>;
  private readonly minLapMs: number;
  private readonly lowQualityWindowMs: number;
  private readonly reverseTravelThresholdM: number;
  private readonly initialLapNumber: number;
  private activeLap: ActiveLap | null = null;
  private nextLapNumber: number;

  constructor(profile: LapTimingProfile, config: LapTimingEngineConfig = {}) {
    this.totalLengthM = positiveFinite(profile.totalLengthM, 'totalLengthM');
    this.startFinishGateId = profile.startFinishGate.id;
    this.sectors = profile.sectorGates.map(sectorSpec);
    this.sectorById = new Map(this.sectors.map((sector) => [sector.id, sector] as const));
    if (this.sectorById.size !== this.sectors.length) {
      throw new RangeError('sector gate ids must be unique');
    }
    this.minLapMs = nonNegativeFinite(config.minLapMs ?? DEFAULT_MIN_LAP_MS, 'minLapMs');
    this.lowQualityWindowMs = nonNegativeFinite(
      config.lowQualityWindowMs ?? DEFAULT_LOW_QUALITY_WINDOW_MS,
      'lowQualityWindowMs',
    );
    this.reverseTravelThresholdM = nonNegativeFinite(
      config.reverseTravelThresholdM ?? DEFAULT_REVERSE_TRAVEL_THRESHOLD_M,
      'reverseTravelThresholdM',
    );
    this.initialLapNumber = positiveFinite(config.initialLapNumber ?? 1, 'initialLapNumber');
    this.nextLapNumber = this.initialLapNumber;
  }

  reset(): void {
    this.activeLap = null;
    this.nextLapNumber = this.initialLapNumber;
  }

  markInvalid(reason: string): void {
    if (this.activeLap !== null) this.activeLap.invalidReasons.add(reason);
  }

  onCrossing(event: CrossingEvent, currentQuality: QualityLevel, inPit: boolean): LapRecord | null {
    if (event.direction !== 'forward') return null;
    if (!Number.isFinite(event.tCross) || !Number.isFinite(event.lapDistanceM)) return null;

    if (this.activeLap === null) {
      if (this.isStartFinish(event)) this.startLap(event, currentQuality, inPit);
      return null;
    }

    const lap = this.activeLap;
    if (event.tCross < lap.lastEventTime) return null;
    if (this.isStartFinish(event) && event.tCross <= lap.tStart) return null;

    this.observe(lap, event, currentQuality, inPit);

    if (this.isStartFinish(event)) {
      const completed = this.completeLap(lap, event);
      this.startLap(event, currentQuality, inPit);
      return completed;
    }

    if (event.kind === 'sector') this.recordSectorCrossing(lap, event, currentQuality);
    return null;
  }

  currentLap(): {
    lapNumber: number;
    elapsedMs: (nowMono: number) => number;
    sectorIndex: number;
  } | null {
    const lap = this.activeLap;
    if (lap === null) return null;
    return {
      lapNumber: lap.lapNumber,
      elapsedMs: (nowMono: number) => Math.max(0, nowMono - lap.tStart),
      sectorIndex: lap.currentSectorIndex,
    };
  }

  private isStartFinish(event: CrossingEvent): boolean {
    return event.kind === 'startFinish' && event.gateId === this.startFinishGateId;
  }

  private startLap(event: CrossingEvent, quality: QualityLevel, inPit: boolean): void {
    const invalidReasons = new Set<string>();
    if (inPit) invalidReasons.add('PIT_TRANSIT');
    this.activeLap = {
      lapNumber: this.nextLapNumber,
      tStart: event.tCross,
      startProgressM: event.lapDistanceM,
      lastEventTime: event.tCross,
      lastSectorTime: event.tCross,
      currentSectorIndex: 0,
      sectorQuality: quality,
      quality,
      lowQualitySince: isLowQuality(quality) ? event.tCross : null,
      maxProgressM: event.lapDistanceM,
      observedSectorIds: [],
      sectorTimes: [],
      invalidReasons,
    };
    this.nextLapNumber += 1;
  }

  private observe(
    lap: ActiveLap,
    event: CrossingEvent,
    quality: QualityLevel,
    inPit: boolean,
  ): void {
    lap.lastEventTime = event.tCross;
    lap.quality = worstQuality(lap.quality, quality);
    lap.sectorQuality = worstQuality(lap.sectorQuality, quality);
    if (inPit) lap.invalidReasons.add('PIT_TRANSIT');

    if (isLowQuality(quality)) {
      lap.lowQualitySince ??= event.tCross;
      this.checkLowQualityWindow(lap, event.tCross);
    } else if (lap.lowQualitySince !== null) {
      this.checkLowQualityWindow(lap, event.tCross);
      lap.lowQualitySince = null;
    }

    if (lap.maxProgressM - event.lapDistanceM > this.reverseTravelThresholdM) {
      lap.invalidReasons.add('REVERSE_TRAVEL');
    }
    lap.maxProgressM = Math.max(lap.maxProgressM, event.lapDistanceM);
  }

  private checkLowQualityWindow(lap: ActiveLap, atTime: number): void {
    if (lap.lowQualitySince !== null && atTime - lap.lowQualitySince > this.lowQualityWindowMs) {
      lap.invalidReasons.add('LOW_QUALITY');
    }
  }

  private recordSectorCrossing(
    lap: ActiveLap,
    event: CrossingEvent,
    currentQuality: QualityLevel,
  ): void {
    const spec = this.sectorById.get(event.gateId);
    lap.observedSectorIds.push(event.gateId);
    lap.sectorTimes.push({
      sectorIndex: lap.currentSectorIndex,
      durationMs: event.tCross - lap.lastSectorTime,
      quality: lap.sectorQuality,
    });
    lap.lastSectorTime = event.tCross;
    lap.sectorQuality = currentQuality;
    if (spec !== undefined) lap.currentSectorIndex = spec.startsSectorIndex;
  }

  private completeLap(lap: ActiveLap, event: CrossingEvent): LapRecord {
    this.checkLowQualityWindow(lap, event.tCross);
    lap.sectorTimes.push({
      sectorIndex: lap.currentSectorIndex,
      durationMs: event.tCross - lap.lastSectorTime,
      quality: lap.sectorQuality,
    });

    const expectedIds = this.sectors.map((sector) => sector.id);
    const counts = new Map<string, number>();
    for (const id of lap.observedSectorIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const uniqueObservedIds = lap.observedSectorIds.filter(
      (id, index, ids) => ids.indexOf(id) === index,
    );
    const missingOrOutOfOrder =
      uniqueObservedIds.length !== expectedIds.length ||
      uniqueObservedIds.some((id, index) => id !== expectedIds[index]);
    if (missingOrOutOfOrder) lap.invalidReasons.add('MISSED_SECTOR_GATE');
    if ([...counts.values()].some((count) => count > 1)) {
      lap.invalidReasons.add('DUPLICATE_SECTOR_GATE');
    }

    const durationMs = event.tCross - lap.tStart;
    const distanceProgressedM = event.lapDistanceM - lap.startProgressM;
    if (durationMs < this.minLapMs || distanceProgressedM < this.totalLengthM * 0.9) {
      lap.invalidReasons.add('SHORT_LAP');
    }

    return {
      lapNumber: lap.lapNumber,
      tStart: lap.tStart,
      tEnd: event.tCross,
      durationMs,
      sectorTimes: lap.sectorTimes,
      valid: lap.invalidReasons.size === 0,
      invalidReasons: [...lap.invalidReasons],
      quality: lap.quality,
    };
  }
}
