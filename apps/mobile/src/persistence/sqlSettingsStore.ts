import type { SqlDatabase } from '@circuit/core';
import {
  DEFAULT_SETTINGS,
  defaultLanguageForLocale,
  readDeviceLocale,
  type AppSettings,
  type SettingsStore,
} from '../session/settingsStore';
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

  /**
   * `readLocale` is injectable ONLY so the language-default rule can be
   * pinned by a test without a native locale API; production always uses the
   * device's own `readDeviceLocale`.
   */
  static async create(
    db: SqlDatabase,
    readLocale: () => string | null = readDeviceLocale,
  ): Promise<SqlSettingsStore> {
    const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      SETTINGS_KEY,
    ]);
    let initial = DEFAULT_SETTINGS;
    // Ticket P4l-FIX4 N7 (binding, Codex P4l-REV2b finding 11): whether the
    // USER ever chose a language is a fact about the ROW, and it has to be
    // captured BEFORE the merge below -- `DEFAULT_SETTINGS.language` is a
    // perfectly valid `'en'`, so after merging, a row written by any build
    // that predates the setting is indistinguishable from a deliberate
    // English choice, and the device-locale default was never reachable.
    let rowHasLanguage = false;
    const raw = rows[0]?.value;
    if (raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isPartialAppSettings(parsed)) {
          rowHasLanguage = parsed.language === 'ro' || parsed.language === 'en';
          initial = { ...DEFAULT_SETTINGS, ...parsed };
        }
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
    // Field revision (2026-08-27, binding, "hidden developer mode"): a
    // present-but-malformed persisted value (e.g. from a corrupt row, or a
    // future schema change) must never leave dev-only ENET tools visible in
    // a release build by accident -- repaired back to `false` (never
    // trusted as truthy) the same defensive way `repairPersistedEnetSettings`
    // above handles the ENET fields.
    if (typeof initial.developerModeEnabled !== 'boolean') {
      initial = { ...initial, developerModeEnabled: false };
    }
    // Ticket P5c-B (contracts.md R2-3): the trackday suggestion stage is
    // opt-in, so a present-but-malformed persisted value must never be read
    // as truthy and silently switch it on -- repaired back to `false` exactly
    // like `developerModeEnabled` above. An install from before this setting
    // existed carries no key at all and takes `DEFAULT_SETTINGS`' `false`.
    if (typeof initial.suggestionsEnabled !== 'boolean') {
      initial = { ...initial, suggestionsEnabled: false };
    }
    // Ticket P4l-FIX1 F2 (binding), corrected by P4l-FIX4 N7: the language
    // DEFAULT comes from the device locale, applied here and only here --
    // whenever the persisted ROW did not itself carry a valid choice (no row
    // at all, a row from before the setting existed, or a value outside the
    // two-value vocabulary, repaired the same defensive way
    // `developerModeEnabled` above is). A user's own stored choice always
    // wins and is never re-derived on later launches.
    if (!rowHasLanguage) {
      initial = { ...initial, language: defaultLanguageForLocale(readLocale()) };
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
