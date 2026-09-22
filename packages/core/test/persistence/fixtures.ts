import type {
  CalibrationAttemptRecord,
  LapRecord,
  LapValidityVerdict,
  LocationSample,
  ReferenceLap,
  SessionMachineSnapshot,
  SessionSummary,
} from '../../src/contracts';

export function makeReferenceLap(overrides: Partial<ReferenceLap> = {}): ReferenceLap {
  return {
    circuitId: 'circuit-a',
    layoutId: 'layout-1',
    layoutVersion: 1,
    userId: 'user-1',
    durationMs: 90_000,
    sectorTimes: [
      { sectorIndex: 0, durationMs: 30_000, quality: 'good' },
      { sectorIndex: 1, durationMs: 60_000, quality: 'good' },
    ],
    recordedAtUtc: '2024-01-01T00:00:00.000Z',
    sessionId: 'session-1',
    lapNumber: 1,
    distanceGridM: [0, 100, 200],
    elapsedMsAtGrid: [0, 30_000, 90_000],
    gnssQualitySummary: { level: 'good', reasons: [] },
    appVersion: '1.0.0',
    algorithmVersion: 1,
    profileSchemaVersion: 1,
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<SessionMachineSnapshot> = {}): SessionMachineSnapshot {
  return {
    state: 'timing',
    lapNumber: 1,
    context: { foo: 'bar', count: 3 },
    ...overrides,
  };
}

export function makeLapRecord(overrides: Partial<LapRecord> = {}): LapRecord {
  return {
    lapNumber: 1,
    tStart: 0,
    tEnd: 90_000,
    durationMs: 90_000,
    sectorTimes: [{ sectorIndex: 0, durationMs: 90_000, quality: 'good' }],
    valid: true,
    invalidReasons: [],
    quality: 'good',
    ...overrides,
  };
}

export function makeSessionSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-1',
    circuitId: 'circuit-a',
    layoutId: 'layout-1',
    layoutVersion: 1,
    startedAtUtc: '2024-01-01T00:00:00.000Z',
    laps: [makeLapRecord()],
    userId: 'user-1',
    ...overrides,
  };
}

export function makeLocationSample(overrides: Partial<LocationSample> = {}): LocationSample {
  return {
    tMono: 1000,
    lat: 45.0,
    lon: 25.0,
    source: 'gnss',
    ...overrides,
  };
}

/** Ticket P12 item A: the owner's verdict on one lap's app-side validity call. */
export function makeLapVerdict(overrides: Partial<LapValidityVerdict> = {}): LapValidityVerdict {
  return {
    sessionId: 'session-1',
    lapNumber: 1,
    appValid: true,
    appInvalidReasons: [],
    answer: 'agreed',
    answeredAtUtc: '2026-09-22T09:00:00.000Z',
    answerRevision: 1,
    ...overrides,
  };
}

/** Ticket P12 item B: one Learn lap's durable record. */
export function makeCalibrationAttempt(
  overrides: Partial<CalibrationAttemptRecord> = {},
): CalibrationAttemptRecord {
  return {
    schemaVersion: 1,
    attemptId: 'attempt-1',
    sessionId: 'session-1',
    circuitId: 'circuit-a',
    layoutId: 'layout-1',
    layoutVersion: 1,
    startedAtUtc: '2026-09-22T09:00:00.000Z',
    updatedAtUtc: '2026-09-22T09:03:00.000Z',
    endedAtUtc: '2026-09-22T09:03:00.000Z',
    durationMs: 180_000,
    outcome: 'rejected',
    concluded: true,
    reachedCompletionThreshold: true,
    forceFinished: false,
    result: null,
    coverageFraction: 0.83,
    uncoveredGap: { startM: 1_200, endM: 1_500, lengthM: 300 },
    samplesFed: 180,
    samplesAccepted: 150,
    samplesRejected: 30,
    rejectionReasons: { OFF_CORRIDOR: 30 },
    thresholds: {
      corridorWidthM: 12,
      coverageBinM: 25,
      completeCoverageFraction: 0.98,
      minCoverageFraction: 0.85,
      maxUncoveredGapM: 250,
      minObservedRateHz: 0.5,
      maxRejectedFraction: 0.5,
    },
    explanation: ['INSUFFICIENT_COVERAGE: only 83% of the centerline was observed; the bar is 85%.'],
    ...overrides,
  };
}
