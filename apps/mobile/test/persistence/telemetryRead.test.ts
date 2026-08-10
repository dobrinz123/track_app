import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { readLapTelemetry, bucketTelemetry, type TelemetrySampleRow } from '../../src/persistence/telemetryRead';

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

describe('readLapTelemetry', () => {
  it('returns only rows matching BOTH session AND lap, ordered by t_mono_ms, excluding NULL-lap and other session/lap rows', async () => {
    const db = await migratedDb();

    // Out-of-order inserts on purpose -- ordering must come from the query, not insertion order.
    await insertRow(db, 's1', 2, 300, 'rpm', 3000);
    await insertRow(db, 's1', 2, 100, 'rpm', 1000);
    await insertRow(db, 's1', 2, 200, 'rpm', 2000);
    // Noise this query must exclude:
    await insertRow(db, 's1', 1, 150, 'rpm', 9999); // wrong lap, same session
    await insertRow(db, 's2', 2, 150, 'rpm', 9999); // wrong session, same lap
    await insertRow(db, 's1', null, 50, 'rpm', 9999); // NULL lap -- not part of any lap

    const rows = await readLapTelemetry(db, 's1', 2);

    expect(rows).toEqual([
      { tMonoMs: 100, channel: 'rpm', value: 1000 },
      { tMonoMs: 200, channel: 'rpm', value: 2000 },
      { tMonoMs: 300, channel: 'rpm', value: 3000 },
    ]);
  });

  it('returns an empty array when no rows match', async () => {
    const db = await migratedDb();
    await insertRow(db, 's1', 1, 100, 'rpm', 1000);
    const rows = await readLapTelemetry(db, 's1', 2);
    expect(rows).toEqual([]);
  });

  it('returns rows across multiple channels for the same session/lap, still ordered by t_mono_ms', async () => {
    const db = await migratedDb();
    await insertRow(db, 's1', 1, 200, 'throttlePct', 50);
    await insertRow(db, 's1', 1, 100, 'speedKph', 80);
    await insertRow(db, 's1', 1, 150, 'rpm', 4000);

    const rows = await readLapTelemetry(db, 's1', 1);
    expect(rows.map((r) => r.channel)).toEqual(['speedKph', 'rpm', 'throttlePct']);
  });
});

describe('bucketTelemetry', () => {
  it('averages correctly on a hand-computed vector (bucketCount=4, evenly spaced times)', () => {
    const rows: TelemetrySampleRow[] = [
      { tMonoMs: 0, channel: 'speedKph', value: 10 },
      { tMonoMs: 100, channel: 'speedKph', value: 20 },
      { tMonoMs: 200, channel: 'speedKph', value: 30 },
      { tMonoMs: 300, channel: 'speedKph', value: 40 },
      { tMonoMs: 400, channel: 'speedKph', value: 50 },
      { tMonoMs: 500, channel: 'speedKph', value: 60 },
      { tMonoMs: 600, channel: 'speedKph', value: 70 },
      { tMonoMs: 700, channel: 'speedKph', value: 80 },
    ];

    const result = bucketTelemetry(rows, 'speedKph', 4);

    expect(result.buckets).toEqual([15, 35, 55, 75]);
    expect(result.min).toBe(10);
    expect(result.max).toBe(80);
  });

  it('leaves buckets with zero samples of the channel as null (empty-bucket handling)', () => {
    const rows: TelemetrySampleRow[] = [
      { tMonoMs: 0, channel: 'rpm', value: 1000 },
      { tMonoMs: 900, channel: 'rpm', value: 9000 },
      // Only the extreme ends have `rpm` samples, so a bucketCount=5 span leaves the middle buckets empty.
    ];

    const result = bucketTelemetry(rows, 'rpm', 5);

    expect(result.buckets).toHaveLength(5);
    expect(result.buckets[0]).toBe(1000);
    expect(result.buckets[1]).toBeNull();
    expect(result.buckets[2]).toBeNull();
    expect(result.buckets[3]).toBeNull();
    expect(result.buckets[4]).toBe(9000);
  });

  it('places a single-sample lap entirely in bucket 0 instead of dividing by zero', () => {
    const rows: TelemetrySampleRow[] = [{ tMonoMs: 50, channel: 'rpm', value: 999 }];

    const result = bucketTelemetry(rows, 'rpm', 10);

    expect(result.buckets).toHaveLength(10);
    expect(result.buckets[0]).toBe(999);
    expect(result.buckets.slice(1).every((b) => b === null)).toBe(true);
    expect(result.min).toBe(999);
    expect(result.max).toBe(999);
  });

  it('honors a custom bucketCount', () => {
    const rows: TelemetrySampleRow[] = [
      { tMonoMs: 0, channel: 'throttlePct', value: 0 },
      { tMonoMs: 1000, channel: 'throttlePct', value: 100 },
    ];

    expect(bucketTelemetry(rows, 'throttlePct', 20).buckets).toHaveLength(20);
    expect(bucketTelemetry(rows, 'throttlePct').buckets).toHaveLength(80); // default
  });

  it('reports the raw (un-bucketed) min/max, not the min/max of bucket averages', () => {
    const rows: TelemetrySampleRow[] = [
      { tMonoMs: 0, channel: 'speedKph', value: 5 },
      { tMonoMs: 1, channel: 'speedKph', value: 200 }, // a spike averaged down within its own bucket
      { tMonoMs: 900, channel: 'speedKph', value: 90 },
    ];

    const result = bucketTelemetry(rows, 'speedKph', 2);

    expect(result.min).toBe(5);
    expect(result.max).toBe(200);
  });

  it('returns all-null buckets and null min/max when the channel has no rows at all', () => {
    const rows: TelemetrySampleRow[] = [{ tMonoMs: 0, channel: 'rpm', value: 1000 }];
    const result = bucketTelemetry(rows, 'speedKph', 6);
    expect(result.buckets).toEqual([null, null, null, null, null, null]);
    expect(result.min).toBeNull();
    expect(result.max).toBeNull();
  });
});
