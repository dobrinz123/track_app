import type {
  LocationSample,
  QualityAssessment,
  QualityLevel,
  TelemetryQualityEvaluator as TelemetryQualityEvaluatorContract,
} from '../contracts';

export interface TelemetryQualityConfig {
  degradedAccuracyM: number;
  unreliableAccuracyM: number;
  invalidAccuracyM: number;
  degradedGapMs: number;
  unreliableGapMs: number;
  unreliableSpeedMps: number;
  invalidSpeedMps: number;
}

export const DEFAULT_TELEMETRY_QUALITY_CONFIG: Readonly<TelemetryQualityConfig> = {
  degradedAccuracyM: 12,
  unreliableAccuracyM: 25,
  invalidAccuracyM: 50,
  degradedGapMs: 1_500,
  unreliableGapMs: 3_000,
  unreliableSpeedMps: 85,
  invalidSpeedMps: 120,
};

const LEVEL_RANK: Record<QualityLevel, number> = {
  good: 0,
  degraded: 1,
  unreliable: 2,
  invalid: 3,
};

const EARTH_RADIUS_M = 6_371_008.8;
const DEG_TO_RAD = Math.PI / 180;

function distanceM(a: LocationSample, b: LocationSample): number {
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const deltaLat = (b.lat - a.lat) * DEG_TO_RAD;
  const deltaLon = (b.lon - a.lon) * DEG_TO_RAD;
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export class TelemetryQualityEvaluator implements TelemetryQualityEvaluatorContract {
  private readonly config: TelemetryQualityConfig;

  constructor(config: Partial<TelemetryQualityConfig> = {}) {
    this.config = { ...DEFAULT_TELEMETRY_QUALITY_CONFIG, ...config };
  }

  assess(sample: LocationSample, prev?: LocationSample): QualityAssessment {
    let level: QualityLevel = 'good';
    const reasons: string[] = [];
    const trigger = (candidate: QualityLevel, reason: string): void => {
      reasons.push(reason);
      if (LEVEL_RANK[candidate] > LEVEL_RANK[level]) level = candidate;
    };

    if (sample.lat === undefined || sample.lon === undefined) {
      trigger('invalid', 'MISSING_COORDINATES');
    } else if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lon)) {
      trigger('invalid', 'NON_FINITE_COORDINATES');
    }
    if (!Number.isFinite(sample.tMono)) trigger('invalid', 'NON_FINITE_TIMESTAMP');

    const accuracy = sample.accuracyM;
    if (accuracy !== undefined) {
      if (!Number.isFinite(accuracy) || accuracy < 0) {
        trigger('invalid', 'INVALID_ACCURACY');
      } else if (accuracy > this.config.invalidAccuracyM) {
        trigger('invalid', 'ACCURACY_ABOVE_50M');
      } else if (accuracy > this.config.unreliableAccuracyM) {
        trigger('unreliable', 'ACCURACY_ABOVE_25M');
      } else if (accuracy > this.config.degradedAccuracyM) {
        trigger('degraded', 'ACCURACY_ABOVE_12M');
      }
    }

    if (prev !== undefined && Number.isFinite(sample.tMono) && Number.isFinite(prev.tMono)) {
      const gapMs = sample.tMono - prev.tMono;
      if (gapMs === 0) trigger('invalid', 'DUPLICATE_TIMESTAMP');
      if (gapMs <= 0) trigger('invalid', 'NON_INCREASING_TIMESTAMP');
      if (gapMs > this.config.unreliableGapMs) {
        trigger('unreliable', 'SAMPLE_GAP_ABOVE_3000MS');
      } else if (gapMs > this.config.degradedGapMs) {
        trigger('degraded', 'SAMPLE_GAP_ABOVE_1500MS');
      }

      if (
        gapMs > 0 &&
        Number.isFinite(sample.lat) &&
        Number.isFinite(sample.lon) &&
        Number.isFinite(prev.lat) &&
        Number.isFinite(prev.lon)
      ) {
        const impliedSpeedMps = distanceM(prev, sample) / (gapMs / 1_000);
        if (impliedSpeedMps > this.config.invalidSpeedMps) {
          trigger('invalid', 'IMPOSSIBLE_JUMP');
        } else if (impliedSpeedMps > this.config.unreliableSpeedMps) {
          trigger('unreliable', 'IMPLIED_SPEED_ABOVE_85MPS');
        }
      }
    }

    return { level, reasons };
  }
}
