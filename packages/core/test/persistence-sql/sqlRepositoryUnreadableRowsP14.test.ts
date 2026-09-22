import { describe, expect, it } from 'vitest';

import { SqlSessionRepository } from '../../src/persistence-sql';
import { createSqlJsDatabase } from './sqlJsDatabase';

/**
 * Ticket P14 H5 (Codex P13 round, sqlSessionRepository.ts:55) -- AN UNREADABLE
 * ROW IS NOT AN ABSENT ROW.
 *
 * `parsePayloads` skipped a payload that would not parse, which is the right
 * trade (one corrupt answer must not cost the rest), but it told NOBODY. Both
 * list methods therefore returned `[]` for a table full of unreadable rows,
 * and every reader above them -- the report's availability rows above all --
 * classified an inaccessible record as `empty`: "we looked, there was nothing".
 *
 * The repository now reports WHAT IT COULD NOT READ alongside what it could.
 */
async function repositoryWithCorruptRows(): Promise<SqlSessionRepository> {
  const db = await createSqlJsDatabase();
  const repository = await SqlSessionRepository.create(db);

  // One good verdict row and two rows whose payload is not JSON at all -- the
  // shape a half-written row or a truncated database file leaves behind.
  await repository.saveLapValidityVerdict({
    sessionId: 's1',
    lapNumber: 1,
    answer: 'agreed',
    answerRevision: 1,
    answeredAtUtc: '2026-09-22T10:00:00.000Z',
    appValid: true,
    appInvalidReasons: [],
  });
  await db.runAsync('INSERT OR REPLACE INTO lap_verdicts (sessionId, lapNumber, payload) VALUES (?, ?, ?)', [
    's1',
    2,
    '{not json',
  ]);
  await db.runAsync('INSERT OR REPLACE INTO lap_verdicts (sessionId, lapNumber, payload) VALUES (?, ?, ?)', [
    's1',
    3,
    '',
  ]);
  await db.runAsync(
    'INSERT OR REPLACE INTO calibration_attempts (attemptId, sessionId, startedAtUtc, payload) VALUES (?, ?, ?, ?)',
    ['a1', 's1', '2026-09-22T09:00:00.000Z', '{truncated'],
  );
  return repository;
}

describe('P14 H5 -- unreadable stored rows are counted, never silently dropped', () => {
  it('reports the readable verdicts AND how many rows could not be read', async () => {
    const repository = await repositoryWithCorruptRows();

    const read = await repository.listLapValidityVerdictsWithDiagnostics('s1');
    expect(read.records).toHaveLength(1);
    expect(read.records[0]!.lapNumber).toBe(1);
    // THE POINT: two rows exist that this device cannot read. A caller that
    // sees only `records` would report one answered lap and two unanswered
    // ones, which is a claim about the owner rather than about the storage.
    expect(read.unreadableCount).toBe(2);
  });

  it('reports unreadable calibration attempts rather than "none were made"', async () => {
    const repository = await repositoryWithCorruptRows();

    const read = await repository.listCalibrationAttemptsWithDiagnostics('s1');
    expect(read.records).toHaveLength(0);
    expect(read.unreadableCount).toBe(1);
    // The old call still answers with what it could read, unchanged -- the
    // diagnostics are additive, not a replacement.
    expect(await repository.listCalibrationAttempts('s1')).toHaveLength(0);
  });

  it('reports zero unreadable rows when every row parses', async () => {
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    await repository.saveLapValidityVerdict({
      sessionId: 's2',
      lapNumber: 1,
      answer: 'disagreed',
      answerRevision: 1,
      answeredAtUtc: '2026-09-22T10:00:00.000Z',
      appValid: false,
      appInvalidReasons: ['PAUSE_GAP'],
    });

    const read = await repository.listLapValidityVerdictsWithDiagnostics('s2');
    expect(read.records).toHaveLength(1);
    expect(read.unreadableCount).toBe(0);
    // An EMPTY session is genuinely empty: zero records, zero unreadable.
    const other = await repository.listLapValidityVerdictsWithDiagnostics('s3');
    expect(other).toEqual({ records: [], unreadableCount: 0 });
  });
});
