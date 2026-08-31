import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '@circuit/core';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateDidSweepSchema, DID_SWEEP_SCHEMA_VERSION } from '../../src/persistence/didSweepSchema';
import {
  createInMemoryVehicleProfileBindingStore,
  createSqlVehicleProfileBindingStore,
  createVehicleProfileBindingStore,
  type VehicleProfileBinding,
  type VehicleProfileBindingStore,
} from '../../src/persistence/didSweepStore';

/**
 * Ticket P4l S3 / contracts.md "Signal Finder (Phase 4l)" item 5 (binding):
 * "'Confirm as <target>' writes a channel binding (ecu, did, length, decode
 * guess, status `field-confirmed`, evidence summary, timestamp) into the
 * persisted vehicle profile (SQLite, exportable JSON identical to
 * `data/vehicle-profiles/*.json`)."
 *
 * Tested against BOTH backing implementations with the SAME assertions --
 * the controller/screen must not be able to tell which one is live (same
 * convention as `didSweepObservationStore.test.ts`).
 */

async function migratedDb(): Promise<SqlDatabase> {
  const db = await createSqlJsDatabase();
  await migrateDidSweepSchema(db);
  return db;
}

function binding(overrides: Partial<VehicleProfileBinding> = {}): VehicleProfileBinding {
  return {
    profileId: 'toyota-supra-b58',
    channel: 'brakeSwitch',
    ecu: 0x29,
    did: 0x500c,
    length: 1,
    decode: 'bit0 (0x04 released -> 0x05 pressed)',
    status: 'field-confirmed',
    evidenceJson: JSON.stringify({ matchedEdges: 10, expectedEdges: 10, baselineChanges: 0 }),
    updatedAtUtc: '2026-08-29T18:00:00.000Z',
    ...overrides,
  };
}

describe('did_sweep schema v3/v4 (additive)', () => {
  // Ticket P4p G5 moved the version to 4 (`signal_finder_ruled_out`), which is
  // another plain `CREATE TABLE IF NOT EXISTS` addition -- v3's own table is
  // created exactly as before.
  it('bumps the version row to the current schema version and creates vehicle_profile_bindings', async () => {
    expect(DID_SWEEP_SCHEMA_VERSION).toBe(4);
    const db = await migratedDb();
    const version = await db.getAllAsync<{ version: number }>('SELECT version FROM did_sweep_schema_migrations LIMIT 1');
    expect(version[0]?.version).toBe(4);
    const rows = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vehicle_profile_bindings'",
    );
    expect(rows).toHaveLength(1);
  });

  it('creates the v4 ruled-out table alongside it', async () => {
    const db = await migratedDb();
    const rows = await db.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'signal_finder_ruled_out'",
    );
    expect(rows).toHaveLength(1);
  });

  it('is idempotent and leaves the v2 observation tables untouched', async () => {
    const db = await migratedDb();
    await migrateDidSweepSchema(db);
    const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    const names = tables.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['did_sweep_runs', 'did_sweep_observation_samples', 'did_sweep_observation_summaries', 'vehicle_profile_bindings']));
    const version = await db.getAllAsync<{ version: number }>('SELECT version FROM did_sweep_schema_migrations');
    expect(version).toHaveLength(1);
  });
});

describe.each<[string, () => Promise<VehicleProfileBindingStore>]>([
  ['in-memory', async () => createInMemoryVehicleProfileBindingStore()],
  ['sql', async () => createSqlVehicleProfileBindingStore(await migratedDb())],
])('VehicleProfileBindingStore (%s)', (_label, makeStore) => {
  it('starts empty and returns what was written', async () => {
    const store = await makeStore();
    expect(await store.listBindings('toyota-supra-b58')).toEqual([]);
    await store.upsertBinding(binding());
    expect(await store.listBindings('toyota-supra-b58')).toEqual([binding()]);
  });

  it('upserts by (profileId, channel) -- confirming again REPLACES, never duplicates', async () => {
    const store = await makeStore();
    await store.upsertBinding(binding());
    await store.upsertBinding(binding({ did: 0x500b, length: 2, updatedAtUtc: '2026-08-30T09:00:00.000Z' }));
    const rows = await store.listBindings('toyota-supra-b58');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ did: 0x500b, length: 2, updatedAtUtc: '2026-08-30T09:00:00.000Z' });
  });

  it('keeps profiles apart', async () => {
    const store = await makeStore();
    await store.upsertBinding(binding());
    await store.upsertBinding(binding({ profileId: 'generic', ecu: 0x30 }));
    expect(await store.listBindings('toyota-supra-b58')).toHaveLength(1);
    expect((await store.listBindings('generic'))[0]?.ecu).toBe(0x30);
  });

  it('getBinding resolves one channel, deleteBinding removes it', async () => {
    const store = await makeStore();
    await store.upsertBinding(binding());
    await store.upsertBinding(binding({ channel: 'accelPedal', ecu: 0x12, did: 0x4659, length: 2 }));
    expect(await store.getBinding('toyota-supra-b58', 'brakeSwitch')).toMatchObject({ did: 0x500c });
    expect(await store.getBinding('toyota-supra-b58', 'steeringAngle')).toBeNull();
    await store.deleteBinding('toyota-supra-b58', 'brakeSwitch');
    expect(await store.getBinding('toyota-supra-b58', 'brakeSwitch')).toBeNull();
    expect(await store.listBindings('toyota-supra-b58')).toHaveLength(1);
  });

  it('lists bindings in a stable order (channel ascending)', async () => {
    const store = await makeStore();
    await store.upsertBinding(binding({ channel: 'steeringAngle', ecu: 0x30, did: 0x1234 }));
    await store.upsertBinding(binding({ channel: 'accelPedal', ecu: 0x12, did: 0x4659 }));
    await store.upsertBinding(binding());
    expect((await store.listBindings('toyota-supra-b58')).map((b) => b.channel)).toEqual([
      'accelPedal',
      'brakeSwitch',
      'steeringAngle',
    ]);
  });
});

describe('createVehicleProfileBindingStore', () => {
  it('falls back to the in-memory implementation with no database (web preview)', async () => {
    const store = createVehicleProfileBindingStore(null);
    await store.upsertBinding(binding());
    expect(await store.listBindings('toyota-supra-b58')).toHaveLength(1);
  });
});
