import { describe, expect, it } from 'vitest';
import { SqlSessionRepository, type SqlDatabase } from '@circuit/core';

import { migrateDidSweepSchema } from '../../src/persistence/didSweepSchema';
import { migrateLearnedCircuitSchema } from '../../src/persistence/learnedCircuitSchema';
import {
  DEVICE_USER_DATA_TABLES,
  countStoredVehicleIdentity,
  vehicleIdentityResetPatch,
  wipeDeviceUserData,
} from '../../src/persistence/deviceDataWipe';
import { DEFAULT_SETTINGS } from '../../src/session/settingsStore';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * HANDOFF release blocker #1: "Delete all my data" left the VIN, the vehicle
 * bindings, the DID sweep records and the learned circuits on the device.
 * These pin the on-disk half of the fix against a real SQLite engine.
 */

const VIN = 'WZ1DB0C04LW000001';
/** A "Tag as channel" definition whose provenance names the car -- the settings editor accepts exactly this. */
const TAGGED_CHANNELS = JSON.stringify([
  { channel: 'transOilC', ecu: 18, did: 0x4002, decode: 'u8', provenance: `Measured on VIN ${VIN}` },
]);

async function freshDb(): Promise<SqlDatabase> {
  const db = await createSqlJsDatabase();
  await SqlSessionRepository.create(db);
  await migrateDidSweepSchema(db);
  await migrateLearnedCircuitSchema(db);
  return db;
}

async function count(db: SqlDatabase, table: string): Promise<number> {
  const rows = await db.getAllAsync<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return rows[0]?.count ?? 0;
}

async function storedSettings(db: SqlDatabase): Promise<Record<string, unknown> | null> {
  const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', ['app-settings']);
  const raw = rows[0]?.value;
  return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
}

async function seedEverything(db: SqlDatabase): Promise<void> {
  await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', [
    'app-settings',
    JSON.stringify({
      units: 'mph',
      language: 'ro',
      lastSeenVin: VIN,
      activeVehicleProfileId: 'toyota-gr-supra-a90-b58',
      activeVehicleProfileSource: 'vin',
      enetChannelSpecsJson: TAGGED_CHANNELS,
    }),
  ]);
  await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', ['vehicle-profile-snapshot:driver-1--a', '{}']);
  await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', ['vehicle-profile-snapshot:driver-1--b', '{}']);
  await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', ['activeSessionId', 'driver-1--c']);
  await db.runAsync(
    "INSERT INTO vehicle_profile_bindings (profile_id, channel, ecu, did, decode, status, updated_at_utc) VALUES ('toyota-gr-supra-a90-b58', 'brake', 18, 1, 'u8', 'field-confirmed', '2026-09-20T10:00:00Z')",
  );
  await db.runAsync(
    "INSERT INTO signal_finder_ruled_out (profile_id, target_id, ecu, did, verdict, session_id, ruled_out_at_utc) VALUES ('toyota-gr-supra-a90-b58', 'brake', 18, 2, 'unrelated', 's1', '2026-09-20T10:00:00Z')",
  );
  await db.runAsync(
    "INSERT INTO did_sweep_runs (run_id, adapter_type, range_from, range_to, started_at_utc, updated_at_utc, status) VALUES ('run-1', 'enet', 0, 65535, '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z', 'complete')",
  );
  await db.runAsync(
    "INSERT INTO did_sweep_responders (run_id, did, length, raw_hex, first_seen_utc, last_seen_utc) VALUES ('run-1', 1, 1, '00', '2026-09-20T10:00:00Z', '2026-09-20T10:00:00Z')",
  );
  await db.runAsync(
    "INSERT INTO did_sweep_observation_samples (run_id, observation_id, seq, did, phase, t_ms, raw_hex) VALUES ('run-1', 'obs-1', 0, 1, 'baseline', 0, '00')",
  );
  await db.runAsync(
    "INSERT INTO did_sweep_observation_summaries (run_id, observation_id, created_at_utc, summary_json) VALUES ('run-1', 'obs-1', '2026-09-20T10:00:00Z', '{}')",
  );
  await db.runAsync(
    "INSERT INTO learned_circuits (circuit_id, display_name, payload, length_m, corner_count, created_at_utc, saved) VALUES ('learned-a', 'Home loop', '{}', 1200, 4, '2026-09-20T10:00:00Z', 1)",
  );
}

describe('vehicleIdentityResetPatch', () => {
  it('forgets the VIN and the tagged channels, and keeps a profile the user chose', () => {
    expect(
      vehicleIdentityResetPatch({
        ...DEFAULT_SETTINGS,
        lastSeenVin: VIN,
        enetChannelSpecsJson: TAGGED_CHANNELS,
        activeVehicleProfileId: 'toyota-gr-supra-a90-b58',
        activeVehicleProfileSource: 'user',
      }),
    ).toEqual({ lastSeenVin: null, enetChannelSpecsJson: '' });
  });

  it('also resets a profile the VIN selected, because it encodes what the VIN resolved to', () => {
    expect(
      vehicleIdentityResetPatch({
        ...DEFAULT_SETTINGS,
        lastSeenVin: VIN,
        activeVehicleProfileId: 'toyota-gr-supra-a90-b58',
        activeVehicleProfileSource: 'vin',
      }),
    ).toEqual({
      lastSeenVin: null,
      enetChannelSpecsJson: '',
      activeVehicleProfileId: DEFAULT_SETTINGS.activeVehicleProfileId,
      activeVehicleProfileSource: DEFAULT_SETTINGS.activeVehicleProfileSource,
    });
  });
});

describe('wipeDeviceUserData', () => {
  it('deletes every vehicle and learned-circuit row, the per-session vehicle snapshots, and the stored VIN', async () => {
    const db = await freshDb();
    await seedEverything(db);

    const result = await wipeDeviceUserData(db);

    expect(result).toEqual({ ok: true, remaining: {} });
    for (const table of DEVICE_USER_DATA_TABLES) expect(await count(db, table), table).toBe(0);
    expect(await count(db, 'learned_circuits')).toBe(0);
    const snapshots = await db.getAllAsync<{ key: string }>(
      "SELECT key FROM settings WHERE key LIKE 'vehicle-profile-snapshot:%'",
    );
    expect(snapshots).toEqual([]);
    const settings = await storedSettings(db);
    expect(settings?.lastSeenVin).toBeNull();
    expect(settings?.enetChannelSpecsJson).toBe('');
    expect(settings?.activeVehicleProfileSource).toBe('default');
    expect(JSON.stringify(await db.getAllAsync('SELECT value FROM settings'))).not.toContain(VIN);
  });

  it('keeps preferences and every settings key it does not own', async () => {
    const db = await freshDb();
    await seedEverything(db);

    await wipeDeviceUserData(db);

    const settings = await storedSettings(db);
    expect(settings?.units).toBe('mph');
    expect(settings?.language).toBe('ro');
    const pointer = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      'activeSessionId',
    ]);
    expect(pointer).toEqual([{ value: 'driver-1--c' }]);
  });

  it('keeps a learned circuit a surviving session still needs, and reports it instead of claiming success', async () => {
    const db = await freshDb();
    await seedEverything(db);
    await db.runAsync(
      "INSERT INTO sessions (sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc) VALUES ('driver-1--kept', 'driver-1', 'learned-a', 'main', 1, '2026-09-20T10:00:00Z')",
    );

    const result = await wipeDeviceUserData(db);

    expect(result.ok).toBe(false);
    expect(result.remaining).toEqual({ learned_circuits: 1 });
    expect(await count(db, 'vehicle_profile_bindings')).toBe(0);
    expect((await storedSettings(db))?.lastSeenVin).toBeNull();
  });

  it('succeeds on a device that never stored settings or vehicle data', async () => {
    const db = await freshDb();

    expect(await wipeDeviceUserData(db)).toEqual({ ok: true, remaining: {} });
    expect(await storedSettings(db)).toBeNull();
  });

  it('drops an unreadable settings row rather than leaving a VIN it cannot parse', async () => {
    const db = await freshDb();
    await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', ['app-settings', `{"lastSeenVin":"${VIN}"`]);

    expect(await wipeDeviceUserData(db)).toEqual({ ok: true, remaining: {} });
    expect(await storedSettings(db)).toBeNull();
  });

  it('the post-wipe check catches a stale settings write that lands after the wipe', async () => {
    const db = await freshDb();
    await seedEverything(db);
    await wipeDeviceUserData(db);
    expect(await countStoredVehicleIdentity(db)).toBe(0);

    // What a whole-blob persist queued with the old in-memory settings would write.
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ lastSeenVin: VIN, enetChannelSpecsJson: TAGGED_CHANNELS, activeVehicleProfileSource: 'vin' }),
    ]);

    expect(await countStoredVehicleIdentity(db)).toBe(3);
  });

  it('rolls back and rejects when a table is missing, so the caller reports failure', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    await migrateLearnedCircuitSchema(db);

    await expect(wipeDeviceUserData(db)).rejects.toThrow(/vehicle_profile_bindings/);
  });
});
