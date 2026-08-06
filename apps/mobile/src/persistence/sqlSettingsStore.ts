import type { SqlDatabase } from '@circuit/core';
import { DEFAULT_SETTINGS, type AppSettings, type SettingsStore } from '../session/settingsStore';

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
