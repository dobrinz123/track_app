import type { SqlDatabase } from '@circuit/core';
import { DEFAULT_SETTINGS, type AppSettings, type SettingsStore } from '../session/settingsStore';
import { repairPersistedEnetSettings } from '../session/enetSettingsValidation';

const SETTINGS_KEY = 'app-settings';

function isPartialAppSettings(value: unknown): value is Partial<AppSettings> {
  return typeof value === 'object' && value !== null;
}

/**
 * `SettingsStore` backed by the `settings` key-value table added in the
 * persistence-sql v2 migration (MUST DO #4) -- same on-device SQLite
 * database as session/lap/checkpoint/reference-lap data, not a separate
 * store. `getSettings()`/`subscribe()` stay synchronous (matching
 * `SettingsStore`'s existing contract, which `SettingsScreen` calls
 * directly): the current value is cached in memory and hydrated once from
 * disk in `create()`; every `update()` applies to the cache immediately and
 * persists in the background.
 */
export class SqlSettingsStore implements SettingsStore {
  private settings: AppSettings;
  private readonly listeners = new Set<(s: AppSettings) => void>();

  private constructor(
    private readonly db: SqlDatabase,
    initial: AppSettings,
  ) {
    this.settings = initial;
  }

  static async create(db: SqlDatabase): Promise<SqlSettingsStore> {
    const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      SETTINGS_KEY,
    ]);
    let initial = DEFAULT_SETTINGS;
    const raw = rows[0]?.value;
    if (raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isPartialAppSettings(parsed)) initial = { ...DEFAULT_SETTINGS, ...parsed };
      } catch {
        // Corrupt/legacy row: fall back to defaults rather than throw --
        // settings are non-critical and never block app startup.
      }
    }
    // P4e-FIX2 L1 fix (binding, review finding): `isPartialAppSettings` only
    // proves the persisted JSON was "some object" -- a PRESENT but malformed
    // ENET field (e.g. `enetPort: 70000`, `enetTesterAddress: -1`) would
    // otherwise overwrite `DEFAULT_SETTINGS` unchecked. `repairPersistedEnetSettings`
    // resets exactly those fields back to their defaults when structurally
    // invalid; every other (including every ELM327) field is untouched.
    // Applied unconditionally (a no-op when `initial` is already
    // `DEFAULT_SETTINGS`, i.e. no row / a corrupt row) so there is only one
    // hydration path to reason about.
    initial = repairPersistedEnetSettings(initial);
    return new SqlSettingsStore(db, initial);
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  subscribe(cb: (s: AppSettings) => void): () => void {
    this.listeners.add(cb);
    cb(this.settings);
    return () => {
      this.listeners.delete(cb);
    };
  }

  update(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch };
    for (const listener of this.listeners) listener(this.settings);
    void this.persist();
  }

  private async persist(): Promise<void> {
    try {
      await this.db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
        SETTINGS_KEY,
        JSON.stringify(this.settings),
      ]);
    } catch {
      // Best-effort: a failed write leaves the in-memory value (already
      // applied above) as the source of truth for the rest of this process
      // launch; it will be retried on the next `update()`.
    }
  }
}
