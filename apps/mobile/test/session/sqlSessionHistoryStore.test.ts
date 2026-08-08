import { describe, expect, it } from 'vitest';
import { SqlSessionRepository, type LapRecord, type ReferenceLap, type SessionSummary } from '@circuit/core';
import { SqlSessionHistoryStore } from '../../src/session/sqlSessionHistoryStore';
import { TMR_CIRCUIT_PROFILE } from '../../src/session/tmrProfile';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

const CIRCUIT_ID = TMR_CIRCUIT_PROFILE.circuitId;
const LAYOUT_ID = TMR_CIRCUIT_PROFILE.layoutId;
const LAYOUT_VERSION = TMR_CIRCUIT_PROFILE.layoutVersion;
const USER_ID = 'driver-1';

function lap(lapNumber: number, durationMs: number): LapRecord {
  const third = Math.round(durationMs / 3);
  return {
    lapNumber,
    tStart: 0,
    tEnd: durationMs,
    durationMs,
    sectorTimes: [
      { sectorIndex: 0, durationMs: third, quality: 'good' },
      { sectorIndex: 1, durationMs: third, quality: 'good' },
      { sectorIndex: 2, durationMs: durationMs - 2 * third, quality: 'good' },
    ],
    valid: true,
    invalidReasons: [],
    quality: 'good',
  };
}

function summary(sessionId: string, startedAtUtc: string, laps: LapRecord[]): SessionSummary {
  return {
    sessionId,
    circuitId: CIRCUIT_ID,
    layoutId: LAYOUT_ID,
    layoutVersion: LAYOUT_VERSION,
    startedAtUtc,
    laps,
    userId: USER_ID,
  };
}

async function newStore(): Promise<{ repository: SqlSessionRepository; store: SqlSessionHistoryStore }> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);
  const store = new SqlSessionHistoryStore(repository, USER_ID, CIRCUIT_ID, LAYOUT_ID, LAYOUT_VERSION);
  return { repository, store };
}

describe('SqlSessionHistoryStore (against SqlSessionRepository/sql.js)', () => {
  it('empty-state: no sessions saved yet -> empty list, no session, no PB', async () => {
    const { store } = await newStore();
    await store.refresh();
    expect(store.listSessions()).toEqual([]);
    expect(store.getSession('nope')).toBeNull();
    expect(store.getPersonalBest()).toBeNull();
  });

  it('refresh() lists sessions newest-first by startedAtUtc and getSession() retrieves full lap detail', async () => {
    const { repository, store } = await newStore();
    await repository.saveSession(summary('s-old', '2026-01-01T00:00:00.000Z', [lap(1, 90_000)]));
    await repository.saveSession(
      summary('s-new', '2026-02-01T00:00:00.000Z', [lap(1, 88_000), lap(2, 87_500)]),
    );

    await store.refresh();

    const sessions = store.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['s-new', 's-old']);

    const detail = store.getSession('s-new');
    expect(detail).not.toBeNull();
    expect(detail!.laps).toHaveLength(2);
    expect(detail!.laps[1]!.durationMs).toBe(87_500);
    expect(detail!.circuitId).toBe(CIRCUIT_ID);
    expect(detail!.layoutId).toBe(LAYOUT_ID);

    expect(store.getSession('does-not-exist')).toBeNull();
  });

  it('filters out sessions saved under a different layoutId/layoutVersion (stale layout)', async () => {
    const { repository, store } = await newStore();
    await repository.saveSession(summary('s-match', '2026-01-01T00:00:00.000Z', [lap(1, 90_000)]));
    await repository.saveSession({
      ...summary('s-other-layout', '2026-01-02T00:00:00.000Z', [lap(1, 90_000)]),
      layoutId: 'reverse',
    });
    await repository.saveSession({
      ...summary('s-other-version', '2026-01-03T00:00:00.000Z', [lap(1, 90_000)]),
      layoutVersion: LAYOUT_VERSION + 1,
    });

    await store.refresh();

    expect(store.listSessions().map((s) => s.sessionId)).toEqual(['s-match']);
  });

  it('getPersonalBest() resolves the real lap from the cached session that produced it', async () => {
    const { repository, store } = await newStore();
    await repository.saveSession(summary('s1', '2026-01-01T00:00:00.000Z', [lap(1, 90_000), lap(2, 85_123)]));
    const ref: ReferenceLap = {
      circuitId: CIRCUIT_ID,
      layoutId: LAYOUT_ID,
      layoutVersion: LAYOUT_VERSION,
      userId: USER_ID,
      durationMs: 85_123,
      sectorTimes: [
        { sectorIndex: 0, durationMs: 28_000, quality: 'good' },
        { sectorIndex: 1, durationMs: 28_000, quality: 'good' },
        { sectorIndex: 2, durationMs: 29_123, quality: 'good' },
      ],
      recordedAtUtc: '2026-01-01T00:05:00.000Z',
      sessionId: 's1',
      lapNumber: 2,
      distanceGridM: [0, TMR_CIRCUIT_PROFILE.totalLengthM],
      elapsedMsAtGrid: [0, 85_123],
      gnssQualitySummary: { level: 'good', reasons: [] },
      appVersion: 'apps-mobile-test',
      algorithmVersion: 1,
      profileSchemaVersion: TMR_CIRCUIT_PROFILE.schemaVersion,
    };
    await repository.putReferenceLap(ref);

    await store.refresh();

    const pb = store.getPersonalBest();
    expect(pb).not.toBeNull();
    expect(pb!.sessionId).toBe('s1');
    expect(pb!.lap.lapNumber).toBe(2);
    expect(pb!.lap.durationMs).toBe(85_123);
    expect(pb!.recordedAtUtc).toBe(ref.recordedAtUtc);
  });

  it('getPersonalBest() falls back to a synthetic lap built from the reference when its originating session is not cached', async () => {
    const { repository, store } = await newStore();
    // Deliberately no matching session saved for 'ghost-session'.
    const ref: ReferenceLap = {
      circuitId: CIRCUIT_ID,
      layoutId: LAYOUT_ID,
      layoutVersion: LAYOUT_VERSION,
      userId: USER_ID,
      durationMs: 80_000,
      sectorTimes: [{ sectorIndex: 0, durationMs: 80_000, quality: 'good' }],
      recordedAtUtc: '2026-01-01T00:00:00.000Z',
      sessionId: 'ghost-session',
      lapNumber: 1,
      distanceGridM: [0, TMR_CIRCUIT_PROFILE.totalLengthM],
      elapsedMsAtGrid: [0, 80_000],
      gnssQualitySummary: { level: 'good', reasons: [] },
      appVersion: 'apps-mobile-test',
      algorithmVersion: 1,
      profileSchemaVersion: TMR_CIRCUIT_PROFILE.schemaVersion,
    };
    await repository.putReferenceLap(ref);

    await store.refresh();

    const pb = store.getPersonalBest();
    expect(pb).not.toBeNull();
    expect(pb!.sessionId).toBe('ghost-session');
    expect(pb!.lap.lapNumber).toBe(1);
    expect(pb!.lap.durationMs).toBe(80_000);
    expect(pb!.lap.tStart).toBe(0);
    expect(pb!.lap.tEnd).toBe(80_000);
    expect(pb!.lap.valid).toBe(true);
    expect(pb!.lap.invalidReasons).toEqual([]);
  });
});
