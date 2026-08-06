import type {
  LapRecord,
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
