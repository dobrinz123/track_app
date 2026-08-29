import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '@circuit/core';
import type { DidPhaseSample } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateDidSweepSchema, DID_SWEEP_SCHEMA_VERSION } from '../../src/persistence/didSweepSchema';
import {
  createInMemoryDidSweepStore,
  createSqlDidSweepStore,
  type DidSweepRunRecord,
  type DidSweepStore,
} from '../../src/persistence/didSweepStore';

/**
 * Ticket P4j-FIX1 H3 (binding, after Codex P4j-REV1 HIGH #3): "Persist
 * guided/batched samples and summaries per run (SQLite table
 * `did_sweep_observation_samples` + summaries JSON on the run; in-memory
 * fallback), keyed by runId; ... a later observation on the same run APPENDS
 * (new observationId) instead of resetting."
 *
 * Tested against BOTH backing implementations with the SAME assertions --
 * the controller/export must not be able to tell which one is live.
 */
async function migratedDb(): Promise<SqlDatabase> {
  const db = await createSqlJsDatabase();
  await migrateDidSweepSchema(db);
  return db;
}

function freshRun(runId: string): Omit<DidSweepRunRecord, 'responderCount'> {
  return {
    runId,
    adapterType: 'enet',
    targetAddress: 0x12,
    rangeFrom: 0x4000,
    rangeTo: 0x4fff,
    lastDid: null,
    startedAtUtc: '2026-08-29T10:45:03.790Z',
    updatedAtUtc: '2026-08-29T10:45:03.790Z',
    status: 'running',
    visitedCount: 0,
    timeoutCount: 0,
    unmatchedCount: 0,
    errorCount: 0,
    nrcCounts: {},
  };
}

function phaseSample(did: number, phase: DidPhaseSample['phase'], tMs: number, raw: number[], batchIndex?: number): DidPhaseSample {
  return batchIndex === undefined
    ? { did, phase, tMs, raw: Uint8Array.from(raw) }
    : { did, phase, tMs, raw: Uint8Array.from(raw), batchIndex };
}

const backends: Array<[string, () => Promise<DidSweepStore>]> = [
  ['in-memory', async () => createInMemoryDidSweepStore()],
  ['sql.js', async () => createSqlDidSweepStore(await migratedDb())],
];

describe('DidSweepStore observation persistence (ticket P4j-FIX1 H3, binding)', () => {
  it('the schema version is bumped for the new observation tables', () => {
    expect(DID_SWEEP_SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });

  for (const [name, make] of backends) {
    describe(name, () => {
      it('persists guided samples keyed by runId, with phase, tMs, raw hex and batchIndex intact', async () => {
        const store = await make();
        await store.createRun(freshRun('run-obs-1'));
        await store.appendObservationSamples('run-obs-1', 'obs-a', [
          phaseSample(0x4522, 'baseline', 8030, [0x01, 0x29], 0),
          phaseSample(0x4522, 'brake', 4221, [0x01, 0x31], 0),
        ]);
        const rows = await store.getObservationSamples('run-obs-1');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ observationId: 'obs-a', did: 0x4522, phase: 'baseline', tMs: 8030, rawHex: '0129', batchIndex: 0 });
        expect(rows[1]).toMatchObject({ observationId: 'obs-a', did: 0x4522, phase: 'brake', rawHex: '0131', batchIndex: 0 });
      });

      it('a LATER observation on the same run APPENDS under a new observationId instead of resetting', async () => {
        const store = await make();
        await store.createRun(freshRun('run-obs-2'));
        await store.appendObservationSamples('run-obs-2', 'obs-a', [phaseSample(0x4a1d, 'brake', 10, [0x01], 0)]);
        await store.appendObservationSamples('run-obs-2', 'obs-b', [phaseSample(0x4811, 'throttle', 20, [0x02])]);
        const rows = await store.getObservationSamples('run-obs-2');
        expect(rows.map((r) => r.observationId)).toEqual(['obs-a', 'obs-b']);
        expect(rows[1]?.batchIndex).toBeNull();
      });

      it('a null batchIndex round-trips as null (a focused / legacy guided run never batches)', async () => {
        const store = await make();
        await store.createRun(freshRun('run-obs-3'));
        await store.appendObservationSamples('run-obs-3', 'obs-a', [phaseSample(0x4812, 'steering', 5, [0xff, 0xfe])]);
        const [row] = await store.getObservationSamples('run-obs-3');
        expect(row?.batchIndex).toBeNull();
        expect(row?.rawHex).toBe('FFFE');
      });

      it('persists the observation SUMMARY per observationId and returns every one for the run', async () => {
        const store = await make();
        await store.createRun(freshRun('run-obs-4'));
        await store.saveObservationSummary('run-obs-4', 'obs-a', JSON.stringify({ mode: 'batched', candidates: [] }), '2026-08-29T11:00:00.000Z');
        await store.saveObservationSummary('run-obs-4', 'obs-b', JSON.stringify({ mode: 'focused', candidates: [] }), '2026-08-29T11:10:00.000Z');
        const summaries = await store.getObservationSummaries('run-obs-4');
        expect(summaries.map((s) => s.observationId)).toEqual(['obs-a', 'obs-b']);
        expect(JSON.parse(summaries[1]?.summaryJson ?? '{}')).toMatchObject({ mode: 'focused' });
      });

      it('re-saving the SAME observationId replaces that summary (never a duplicate row)', async () => {
        const store = await make();
        await store.createRun(freshRun('run-obs-5'));
        await store.saveObservationSummary('run-obs-5', 'obs-a', '{"n":1}', '2026-08-29T11:00:00.000Z');
        await store.saveObservationSummary('run-obs-5', 'obs-a', '{"n":2}', '2026-08-29T11:05:00.000Z');
        const summaries = await store.getObservationSummaries('run-obs-5');
        expect(summaries).toHaveLength(1);
        expect(summaries[0]?.summaryJson).toBe('{"n":2}');
      });

      it('writes nothing for a run that does not exist (never orphan rows)', async () => {
        const store = await make();
        await store.appendObservationSamples('ghost', 'obs-a', [phaseSample(0x1, 'brake', 0, [0x01])]);
        await store.saveObservationSummary('ghost', 'obs-a', '{}', '2026-08-29T11:00:00.000Z');
        expect(await store.getObservationSamples('ghost')).toEqual([]);
        expect(await store.getObservationSummaries('ghost')).toEqual([]);
      });

      it('deleting a run (retention included) deletes its observation samples and summaries too', async () => {
        const store = await make();
        await store.createRun(freshRun('run-obs-6'));
        await store.appendObservationSamples('run-obs-6', 'obs-a', [phaseSample(0x4522, 'brake', 0, [0x01, 0x29])]);
        await store.saveObservationSummary('run-obs-6', 'obs-a', '{}', '2026-08-29T11:00:00.000Z');
        await store.deleteRun('run-obs-6');
        expect(await store.getObservationSamples('run-obs-6')).toEqual([]);
        expect(await store.getObservationSummaries('run-obs-6')).toEqual([]);
      });
    });
  }
});
