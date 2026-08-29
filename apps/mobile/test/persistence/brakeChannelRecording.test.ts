import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { TelemetryRecorder } from '../../src/persistence/telemetryRecorder';
import { readLapTelemetry, TELEMETRY_CHART_CHANNELS } from '../../src/persistence/telemetryRead';

/**
 * Ticket P4l-FIX1 F1 (binding): brake samples land in the session recording
 * "like the other channels". The `telemetry_samples` table stores `channel`
 * as free TEXT, so this is additive by construction -- no DDL change and no
 * schema-version bump -- but that is exactly the claim worth pinning: a
 * `brakeSwitch` sample handed to the recorder must round-trip out of the lap
 * read path, and the lap detail screen must be willing to chart it.
 */
async function migratedDb(): Promise<SqlDatabase> {
  const db = await createSqlJsDatabase();
  await migrateTelemetrySchema(db);
  return db;
}

describe('P4l-FIX1 F1: brake channels in the session recording', () => {
  it('records and reads back brakeSwitch/brakePct samples for a lap', async () => {
    const db = await migratedDb();
    const recorder = new TelemetryRecorder(db, 'session-1');

    recorder.record({ channel: 'brakeSwitch', value: 0, tMonoMs: 100 }, 1);
    recorder.record({ channel: 'brakeSwitch', value: 100, tMonoMs: 200 }, 1);
    recorder.record({ channel: 'brakePct', value: 42.5, tMonoMs: 300 }, 1);
    recorder.record({ channel: 'speedKph', value: 80, tMonoMs: 400 }, 1);
    await recorder.endSession();

    const rows = await readLapTelemetry(db, 'session-1', 1);
    expect(rows).toEqual([
      { tMonoMs: 100, channel: 'brakeSwitch', value: 0 },
      { tMonoMs: 200, channel: 'brakeSwitch', value: 100 },
      { tMonoMs: 300, channel: 'brakePct', value: 42.5 },
      { tMonoMs: 400, channel: 'speedKph', value: 80 },
    ]);
  });

  it('the lap detail chart list carries both brake channels', () => {
    expect(TELEMETRY_CHART_CHANNELS).toContain('brakeSwitch');
    expect(TELEMETRY_CHART_CHANNELS).toContain('brakePct');
    expect(new Set(TELEMETRY_CHART_CHANNELS).size).toBe(TELEMETRY_CHART_CHANNELS.length);
  });
});
