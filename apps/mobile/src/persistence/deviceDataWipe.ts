import type { SqlDatabase } from '@circuit/core';

import { DEFAULT_SETTINGS, type AppSettings } from '../session/settingsStore';
import { SESSION_VEHICLE_SNAPSHOT_KEY_PREFIX } from './sessionVehicleSnapshot';
import { SETTINGS_KEY } from './sqlSettingsStore';

/**
 * The half of "Delete all my data" that `@circuit/core`'s
 * `deleteUserData` cannot see: everything the mobile app stores about the
 * driver's CAR and the driver's own CIRCUITS, outside the session tables.
 *
 * A VIN is personal data in the EU, and so is what hangs off it -- the DID
 * bindings and sweep results are fingerprints of one specific vehicle, and a
 * learned circuit is a trace of where the driver drove. So are the custom
 * channel definitions tagged from a sweep ("Tag as channel"): they are the
 * same findings as the bindings, and their provenance text can hold the VIN.
 * Preferences (units, language, adapter address, coaching toggles, a profile
 * the USER picked) are not data about the driver and survive the wipe.
 */

/** Mobile-owned tables whose every row is vehicle- or driver-specific. */
export const DEVICE_USER_DATA_TABLES = [
  'vehicle_profile_bindings',
  'signal_finder_ruled_out',
  'did_sweep_runs',
  'did_sweep_responders',
  'did_sweep_observation_samples',
  'did_sweep_observation_summaries',
] as const;

export interface DeviceDataWipeResult {
  ok: boolean;
  /** Rows still present per table (and per settings concern) after the wipe; empty when `ok`. */
  remaining: Record<string, number>;
}

/**
 * The settings patch that forgets the vehicle's identity. The VIN goes, and
 * so do the channel definitions tagged from this car's sweeps; a profile the
 * VIN auto-selected goes with them, because keeping it would keep the make
 * and model the VIN resolved to. A profile the user chose is a preference and
 * stays.
 */
export function vehicleIdentityResetPatch(settings: AppSettings): Partial<AppSettings> {
  const vehicleFindings = { lastSeenVin: null, enetChannelSpecsJson: DEFAULT_SETTINGS.enetChannelSpecsJson };
  if (settings.activeVehicleProfileSource !== 'vin') return vehicleFindings;
  return {
    ...vehicleFindings,
    activeVehicleProfileId: DEFAULT_SETTINGS.activeVehicleProfileId,
    activeVehicleProfileSource: DEFAULT_SETTINGS.activeVehicleProfileSource,
  };
}

/** How many identity fields a stored settings blob still carries -- 0 when {@link vehicleIdentityResetPatch} has been applied. */
function identityFieldsLeft(stored: Partial<AppSettings>): number {
  let left = 0;
  if (stored.lastSeenVin !== null && stored.lastSeenVin !== undefined) left += 1;
  if (typeof stored.enetChannelSpecsJson === 'string' && stored.enetChannelSpecsJson !== '') left += 1;
  if (stored.activeVehicleProfileSource === 'vin') left += 1;
  return left;
}

function parseSettingsRow(raw: string | undefined): Partial<AppSettings> | null {
  if (raw === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Partial<AppSettings>) : null;
  } catch {
    return null;
  }
}

async function countRows(tx: SqlDatabase, sql: string, params: readonly string[] = []): Promise<number> {
  const rows = await tx.getAllAsync<{ count: number }>(sql, params);
  return rows[0]?.count ?? 0;
}

async function scrubStoredSettings(tx: SqlDatabase): Promise<number> {
  const rows = await tx.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY]);
  const raw = rows[0]?.value;
  if (raw === undefined) return 0;
  const stored = parseSettingsRow(raw);
  if (stored === null) {
    await tx.runAsync('DELETE FROM settings WHERE key = ?', [SETTINGS_KEY]);
    return 0;
  }
  const scrubbed = { ...stored, ...vehicleIdentityResetPatch({ ...DEFAULT_SETTINGS, ...stored }) };
  await tx.runAsync('UPDATE settings SET value = ? WHERE key = ?', [JSON.stringify(scrubbed), SETTINGS_KEY]);
  const after = await tx.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY]);
  const verified = parseSettingsRow(after[0]?.value);
  return verified === null ? 1 : identityFieldsLeft(verified);
}

/**
 * How many identity fields the stored settings row carries right now. Run
 * after the wipe, through the same serialized handle as every settings
 * write, it sees the row as it is once every write queued before it landed.
 */
export async function countStoredVehicleIdentity(db: SqlDatabase): Promise<number> {
  const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [SETTINGS_KEY]);
  const raw = rows[0]?.value;
  if (raw === undefined) return 0;
  const stored = parseSettingsRow(raw);
  return stored === null ? 1 : identityFieldsLeft(stored);
}

/**
 * Deletes and verifies, in one transaction. A learned circuit that a session
 * still points at is kept (deleting its geometry would break that session's
 * analysis and replay) and counted as remaining, so a wipe whose session
 * half failed can never report this half as clean either.
 */
export async function wipeDeviceUserData(db: SqlDatabase): Promise<DeviceDataWipeResult> {
  const remaining: Record<string, number> = {};
  await db.withTransactionAsync(async (tx) => {
    for (const table of DEVICE_USER_DATA_TABLES) {
      await tx.runAsync(`DELETE FROM ${table}`);
      remaining[table] = await countRows(tx, `SELECT COUNT(*) AS count FROM ${table}`);
    }

    await tx.runAsync(
      'DELETE FROM learned_circuits WHERE circuit_id NOT IN (SELECT circuitId FROM sessions)',
    );
    remaining.learned_circuits = await countRows(tx, 'SELECT COUNT(*) AS count FROM learned_circuits');

    const prefix = SESSION_VEHICLE_SNAPSHOT_KEY_PREFIX;
    await tx.runAsync('DELETE FROM settings WHERE substr(key, 1, length(?)) = ?', [prefix, prefix]);
    remaining.session_vehicle_snapshots = await countRows(
      tx,
      'SELECT COUNT(*) AS count FROM settings WHERE substr(key, 1, length(?)) = ?',
      [prefix, prefix],
    );

    remaining.vehicle_identity_settings = await scrubStoredSettings(tx);
  });

  const leftovers = Object.fromEntries(Object.entries(remaining).filter(([, count]) => count > 0));
  return { ok: Object.keys(leftovers).length === 0, remaining: leftovers };
}
