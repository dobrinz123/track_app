import { describe, expect, it } from 'vitest';

import {
  InMemorySessionRepository,
  type LapRecord,
  type LocalSessionRepository,
} from '@circuit/core';

import { createLapVerdictStore } from '../../src/session/lapVerdictStore';

/**
 * Ticket P12 item A -- the app-side half of "did the app get this lap right?".
 *
 * The store's job is small and its failure modes are the dangerous ones: an
 * answer that appears to be kept and is not, and an unreadable store that
 * reads afterwards as a session nobody judged.
 */

function lap(lapNumber: number, valid: boolean, invalidReasons: string[] = []): LapRecord {
  return {
    lapNumber,
    tStart: 0,
    tEnd: 90_000,
    durationMs: 90_000,
    sectorTimes: [],
    valid,
    invalidReasons,
    quality: valid ? 'good' : 'degraded',
  };
}

const laps = [lap(1, true), lap(2, false, ['PIT_TRANSIT']), lap(3, true)];

/**
 * An explicit pass-through over a repository instance.
 *
 * Spreading the instance would NOT do: its methods live on the prototype, so
 * `{ ...repo }` is an object with no methods at all -- which would make every
 * assertion below pass for the wrong reason.
 */
function delegate(repository: InMemorySessionRepository): LocalSessionRepository {
  return {
    saveCheckpoint: (id, snapshot, records) => repository.saveCheckpoint(id, snapshot, records),
    loadCheckpoint: (id) => repository.loadCheckpoint(id),
    saveSession: (summary) => repository.saveSession(summary),
    listSessions: (userId, circuitId) => repository.listSessions(userId, circuitId),
    saveTelemetry: (id, lapNumber, samples) => repository.saveTelemetry(id, lapNumber, samples),
    saveTelemetryBatch: (id, entries) => repository.saveTelemetryBatch(id, entries),
    loadTelemetry: (id, lapNumber) => repository.loadTelemetry(id, lapNumber),
    saveLapValidityVerdict: (verdict) => repository.saveLapValidityVerdict(verdict),
    listLapValidityVerdicts: (id) => repository.listLapValidityVerdicts(id),
    saveCalibrationAttempt: (record) => repository.saveCalibrationAttempt(record),
    listCalibrationAttempts: (id) => repository.listCalibrationAttempts(id),
    getReferenceLap: (userId, circuitId, layoutId, layoutVersion) =>
      repository.getReferenceLap(userId, circuitId, layoutId, layoutVersion),
    putReferenceLap: (ref) => repository.putReferenceLap(ref),
    deleteUserData: (userId) => repository.deleteUserData(userId),
  };
}

describe('createLapVerdictStore', () => {
  it('stores an answer, and reads it back after a refresh from a fresh store', async () => {
    const repository = new InMemorySessionRepository();
    const store = createLapVerdictStore({ repository: () => repository, onError: () => undefined });

    const outcome = await store.recordVerdict({
      sessionId: 's1',
      lap: laps[1]!,
      decision: 'disagreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
      note: 'never went near the pits',
    });
    expect(outcome.state).toBe('stored');
    expect(outcome.verdict?.answer).toBe('disagreed');
    expect(outcome.verdict?.appInvalidReasons).toEqual(['PIT_TRANSIT']);

    // The durability claim: a brand-new store over the same repository.
    const reopened = createLapVerdictStore({ repository: () => repository, onError: () => undefined });
    expect(await reopened.refresh('s1')).toBe(true);
    const merged = reopened.forSession('s1', laps);
    expect(merged.map((v) => [v.lapNumber, v.answer])).toEqual([
      [1, 'unanswered'],
      [2, 'disagreed'],
      [3, 'unanswered'],
    ]);
    expect(reopened.summary('s1', laps)).toEqual({ agreed: 0, disagreed: 1, unanswered: 2 });
  });

  it('a re-answer replaces the row and bumps the revision', async () => {
    const repository = new InMemorySessionRepository();
    const store = createLapVerdictStore({ repository: () => repository, onError: () => undefined });
    await store.recordVerdict({
      sessionId: 's1',
      lap: laps[0]!,
      decision: 'agreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
    });
    const second = await store.recordVerdict({
      sessionId: 's1',
      lap: laps[0]!,
      decision: 'disagreed',
      answeredAtUtc: '2026-09-22T10:05:00.000Z',
    });
    expect(second.verdict?.answerRevision).toBe(2);
    expect(await repository.listLapValidityVerdicts('s1')).toHaveLength(1);
    expect(store.stored('s1')[0]!.answer).toBe('disagreed');
  });

  it('reports UNSUPPORTED -- and caches nothing -- when the store cannot record a verdict', async () => {
    const repository = new InMemorySessionRepository();
    const stripped = delegate(repository);
    delete stripped.saveLapValidityVerdict;
    delete stripped.listLapValidityVerdicts;
    const store = createLapVerdictStore({ repository: () => stripped, onError: () => undefined });

    expect(store.support()).toBe('unsupported');
    const outcome = await store.recordVerdict({
      sessionId: 's1',
      lap: laps[0]!,
      decision: 'agreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
    });
    expect(outcome.state).toBe('unsupported');
    expect(outcome.verdict).toBeNull();
    // THE POINT: an answer this device cannot store must never read back
    // afterwards as though it had been.
    expect(store.stored('s1')).toEqual([]);
    expect(await store.refresh('s1')).toBe(false);
  });

  it('reports FAILED when the write throws -- the answer is not silently presented as kept', async () => {
    const repository = new InMemorySessionRepository();
    const failing: LocalSessionRepository = {
      ...delegate(repository),
      saveLapValidityVerdict: () => Promise.reject(new Error('disk full')),
    };
    const errors: string[] = [];
    const store = createLapVerdictStore({
      repository: () => failing,
      onError: (message) => errors.push(message),
    });

    const outcome = await store.recordVerdict({
      sessionId: 's1',
      lap: laps[0]!,
      decision: 'agreed',
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
    });
    expect(outcome.state).toBe('failed');
    expect(outcome.detail).toContain('disk full');
    expect(errors).toHaveLength(1);
    // Nothing reached storage, and a refresh says so.
    expect(await repository.listLapValidityVerdicts('s1')).toEqual([]);
  });

  it('is a no-op-but-honest before bootstrap has built a repository', async () => {
    const store = createLapVerdictStore({ repository: () => null, onError: () => undefined });
    expect(store.support()).toBe('unsupported');
    expect(await store.refresh('s1')).toBe(false);
    expect(store.forSession('s1', laps).map((v) => v.answer)).toEqual([
      'unanswered',
      'unanswered',
      'unanswered',
    ]);
  });
});
