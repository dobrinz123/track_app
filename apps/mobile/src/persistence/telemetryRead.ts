import type { SqlDatabase, TelemetryChannelId } from '@circuit/core';

/**
 * Recorded-telemetry read API (Telemetry addendum — P4b amendments, binding).
 * Reads back rows a `TelemetryRecorder` (telemetryRecorder.ts) previously
 * wrote into `telemetry_samples` (telemetrySchema.ts) for a single lap of a
 * single session, and a pure bucketing helper `LapDetailScreen.tsx` uses to
 * turn them into fixed-width sparkline charts.
 */

export interface TelemetrySampleRow {
  tMonoMs: number;
  channel: TelemetryChannelId;
  value: number;
}

interface TelemetrySampleDbRow {
  t_mono_ms: number;
  channel: TelemetryChannelId;
  value: number;
}

/**
 * Reads every `telemetry_samples` row for the given `sessionId` AND
 * `lapNumber` (the 1-based lap number as stored — see telemetrySchema.ts),
 * ordered by `t_mono_ms`. `lap_number` is NULLABLE in the schema (samples
 * recorded before the first lap starts, or whenever the current lap isn't
 * known) — those NULL-lap rows are NOT part of any lap and are never
 * returned here: SQL's `lap_number = ?` comparison against a bound integer
 * already excludes NULL rows on its own (NULL never equals anything), so no
 * extra `IS NOT NULL` guard is needed. Parameterized (both `sessionId` and
 * `lapNumber` are bound values, never interpolated into the SQL string).
 */
export async function readLapTelemetry(
  db: SqlDatabase,
  sessionId: string,
  lapNumber: number,
): Promise<TelemetrySampleRow[]> {
  const rows = await db.getAllAsync<TelemetrySampleDbRow>(
    'SELECT t_mono_ms, channel, value FROM telemetry_samples WHERE session_id = ? AND lap_number = ? ORDER BY t_mono_ms',
    [sessionId, lapNumber],
  );
  return rows.map((row) => ({ tMonoMs: row.t_mono_ms, channel: row.channel, value: row.value }));
}

export interface BucketedTelemetry {
  /** Length always exactly `bucketCount`. `null` for any bucket with zero samples of `channel` in it. */
  buckets: Array<number | null>;
  /** Raw (un-bucketed) minimum value observed for `channel` across `rows`, or `null` when `channel` has no rows. */
  min: number | null;
  /** Raw (un-bucketed) maximum value observed for `channel` across `rows`, or `null` when `channel` has no rows. */
  max: number | null;
}

/**
 * Pure aggregation: divides the LAP's own time span — `[minT, maxT]` across
 * ALL of `rows` (every channel), not just `channel`'s own samples, so that
 * bucket `i` means the same slice of lap time across every channel's chart —
 * into `bucketCount` equal-width buckets and averages `channel`'s samples
 * that land in each. A bucket with no samples of `channel` is `null` (never
 * 0 or interpolated). `min`/`max` are the raw, un-bucketed value range for
 * `channel` (what the UI's min/max labels show) — independent of bucket
 * averaging, so a brief spike is never hidden by it.
 *
 * Degenerate spans (a single sample, or every row sharing the exact same
 * `tMonoMs`) place every `channel` sample into bucket 0 rather than
 * dividing by zero.
 */
export function bucketTelemetry(
  rows: readonly TelemetrySampleRow[],
  channel: TelemetryChannelId,
  bucketCount = 80,
): BucketedTelemetry {
  const channelRows = rows.filter((row) => row.channel === channel);
  if (channelRows.length === 0) {
    return { buckets: new Array<number | null>(bucketCount).fill(null), min: null, max: null };
  }

  let tMin = rows[0]!.tMonoMs;
  let tMax = rows[0]!.tMonoMs;
  for (const row of rows) {
    if (row.tMonoMs < tMin) tMin = row.tMonoMs;
    if (row.tMonoMs > tMax) tMax = row.tMonoMs;
  }
  const span = tMax - tMin;

  const sums = new Array<number>(bucketCount).fill(0);
  const counts = new Array<number>(bucketCount).fill(0);
  let min = channelRows[0]!.value;
  let max = channelRows[0]!.value;

  for (const row of channelRows) {
    if (row.value < min) min = row.value;
    if (row.value > max) max = row.value;

    let index = 0;
    if (span > 0) {
      index = Math.floor(((row.tMonoMs - tMin) / span) * bucketCount);
      if (index < 0) index = 0;
      if (index >= bucketCount) index = bucketCount - 1;
    }
    sums[index]! += row.value;
    counts[index]! += 1;
  }

  const buckets: Array<number | null> = [];
  for (let i = 0; i < bucketCount; i += 1) {
    buckets.push(counts[i]! === 0 ? null : sums[i]! / counts[i]!);
  }

  return { buckets, min, max };
}
