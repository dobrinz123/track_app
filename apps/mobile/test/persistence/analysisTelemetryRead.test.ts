import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { loadSessionTelemetryByLap, readSessionTelemetryByLap } from '../../src/persistence/telemetryRead';

/**
 * Ticket P5b B2 — the analysis screen reads a WHOLE session's decoded channels
 * in one query, grouped by lap, instead of one query per lap (a 20-lap session
 * would otherwise be 20 round trips before the first pixel).
 */

async function migratedDb(): Promise<SqlDatabase> {
  const db = await createSqlJsDatabase();
  await migrateTelemetrySchema(db);
  return db;
}

async function insertRow(
  db: SqlDatabase,
  sessionId: string,
  lapNumber: number | null,
  tMonoMs: number,
  channel: string,
  value: number,
): Promise<void> {
  await db.runAsync(
    'INSERT INTO telemetry_samples (session_id, lap_number, t_mono_ms, channel, value) VALUES (?, ?, ?, ?, ?)',
    [sessionId, lapNumber, tMonoMs, channel, value],
  );
}

describe('readSessionTelemetryByLap', () => {
  it('groups a session by lap, ordered by time, excluding NULL-lap and other sessions', async () => {
    const db = await migratedDb();
    await insertRow(db, 's1', 2, 300, 'rpm', 3_000);
    await insertRow(db, 's1', 1, 200, 'accelPedalPct', 40);
    await insertRow(db, 's1', 1, 100, 'accelPedalPct', 10);
    await insertRow(db, 's1', null, 50, 'rpm', 900);
    await insertRow(db, 's2', 1, 100, 'rpm', 1_000);

    const byLap = await readSessionTelemetryByLap(db, 's1');

    expect([...byLap.keys()].sort((a, b) => a - b)).toEqual([1, 2]);
    expect(byLap.get(1)).toEqual([
      { channel: 'accelPedalPct', value: 10, tMonoMs: 100 },
      { channel: 'accelPedalPct', value: 40, tMonoMs: 200 },
    ]);
    expect(byLap.get(2)).toEqual([{ channel: 'rpm', value: 3_000, tMonoMs: 300 }]);
  });

  it('returns an empty map for a session with no recorded channels', async () => {
    const db = await migratedDb();
    expect((await readSessionTelemetryByLap(db, 'nothing')).size).toBe(0);
  });

  it('loadSessionTelemetryByLap never rejects: a failed read becomes an empty map', async () => {
    const errors: unknown[] = [];
    const broken = {
      getAllAsync: async () => {
        throw new Error('database is locked');
      },
    } as unknown as SqlDatabase;

    const byLap = await loadSessionTelemetryByLap(broken, 's1', (error) => errors.push(error));
    expect(byLap.size).toBe(0);
    expect(errors).toHaveLength(1);
  });
});
