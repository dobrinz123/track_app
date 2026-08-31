import { beforeEach, describe, expect, it } from 'vitest';
import { SqlSessionRepository, type SqlDatabase, type TelemetrySample } from '@circuit/core';

import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import { TelemetryRecorder } from '../../src/persistence/telemetryRecorder';
import { readSessionTelemetryByLap } from '../../src/persistence/telemetryRead';
import { TEST_LOOP_OUT_LAP_NUMBER } from '../../src/session/testLoopGuards';

/**
 * Ticket P5d-FIX2 N4 (Codex P5d-REV2): the Test Loop learning lap's channel
 * rows are tagged with the OUT-LAP number, not NULL.
 *
 * Why it matters, pinned rather than argued: the analysis read path excludes
 * `lap_number IS NULL` by design, so channels written as NULL would be
 * invisible to the very analysis the learning lap exists to feed.
 */

function sample(tMonoMs: number, value: number): TelemetrySample {
  return { tMonoMs, channel: 'speedKph', value } as TelemetrySample;
}

describe('Test Loop out-lap channels (P5d-FIX2 N4)', () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    await migrateTelemetrySchema(db);
  });

  it('is lap 0, and lap 0 is readable by the analysis read path', async () => {
    expect(TEST_LOOP_OUT_LAP_NUMBER).toBe(0);
    const recorder = new TelemetryRecorder(db, 'session-1');
    recorder.record(sample(10, 41), TEST_LOOP_OUT_LAP_NUMBER);
    recorder.record(sample(20, 42), TEST_LOOP_OUT_LAP_NUMBER);
    recorder.record(sample(30, 43), 1);
    await recorder.endSession();

    const byLap = await readSessionTelemetryByLap(db, 'session-1');
    expect([...byLap.keys()].sort()).toEqual([0, 1]);
    expect(byLap.get(0)).toHaveLength(2);
  });

  it('a NULL-tagged row would have been dropped by that same read path', async () => {
    const recorder = new TelemetryRecorder(db, 'session-2');
    recorder.record(sample(10, 41), null);
    await recorder.endSession();

    const byLap = await readSessionTelemetryByLap(db, 'session-2');
    expect(byLap.size).toBe(0);
  });
});
