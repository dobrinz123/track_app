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
    /**
     * Ticket P4p G1 (binding): did the persisted ROW itself carry a usable
     * `activeVehicleProfileId`? Same question (and same reason) as N7's
     * `rowHasLanguage` above: `DEFAULT_SETTINGS.activeVehicleProfileId` is a
     * perfectly valid `'generic'`, so after the merge a row written before
     * this setting existed is indistinguishable from a deliberate "generic"
     * choice. `composition.ts`'s one-time migration heuristic runs only while
     * this is `false`, so a profile the USER chose is never overridden.
     */
    readonly activeVehicleProfileIdWasStored: boolean,
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
    // Ticket P4p G1: the same ROW-level question for the active vehicle
    // profile -- captured here, before the merge, for the reason N7 documents.
    let rowHasActiveVehicleProfileId = false;
    const raw = rows[0]?.value;
    if (raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isPartialAppSettings(parsed)) {
          rowHasLanguage = parsed.language === 'ro' || parsed.language === 'en';
          rowHasActiveVehicleProfileId =
            typeof parsed.activeVehicleProfileId === 'string' && parsed.activeVehicleProfileId.trim() !== '';
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
    // Ticket P4p G1 (binding): a present-but-malformed profile id must never
    // reach the binding cache -- an unresolvable id would silently poll
    // nothing at all. Repaired back to `'generic'` the same defensive way the
    // boolean settings above are, and NOT counted as a stored choice (the
    // migration heuristic then still gets its one chance).
    if (!rowHasActiveVehicleProfileId) {
      initial = { ...initial, activeVehicleProfileId: DEFAULT_SETTINGS.activeVehicleProfileId };
    }
    // Codex R2 fix (ticket P4q follow-up, binding): a present-but-malformed
    // `activeVehicleProfileSource` (outside the three-value vocabulary) must
    // never be read as `'user'` by accident -- that would either wrongly
    // block a real VIN auto-select, or (worse, if it decoded to something
    // else entirely) let one silently overwrite a choice the repair itself
    // cannot prove was ever explicit. Repaired back to the default, the same
    // defensive discipline every other enum-like field above follows.
    if (
      initial.activeVehicleProfileSource !== 'user' &&
      initial.activeVehicleProfileSource !== 'vin' &&
      initial.activeVehicleProfileSource !== 'default'
    ) {
      initial = { ...initial, activeVehicleProfileSource: DEFAULT_SETTINGS.activeVehicleProfileSource };
    }
    // Ticket P4q (binding): a present-but-malformed persisted VIN (wrong
    // type from a corrupt/legacy row) must never reach the Signal Finder
    // screen or the VIN-matching logic -- repaired back to `null` (never read
    // yet), the same defensive way the boolean/ENET fields above are.
    if (typeof initial.lastSeenVin !== 'string' && initial.lastSeenVin !== null) {
      initial = { ...initial, lastSeenVin: null };
    }
    // Ticket P6a (binding): both new flags are opt-in and both change how a
    // field-confirmed signal path behaves, so a present-but-malformed
    // persisted value must never be read as truthy and silently switch one on
    // -- repaired back to `false` exactly like `suggestionsEnabled` above. An
    // install from before these settings existed carries no key at all and
    // takes `DEFAULT_SETTINGS`' `false`.
    if (typeof initial.imuFusionEnabled !== 'boolean') {
      initial = { ...initial, imuFusionEnabled: false };
    }
    // Ticket P7R E3: the same defensive repair for the gyroscope-CAPTURE
    // flag, but back to its OWN default (`true`) rather than to `false`. The
    // rule being applied is "a malformed value is never trusted, the declared
    // default wins" -- not "a malformed value means off". Capture is additive
    // and cannot alter latG/longG, so its default is the safe answer here the
    // same way `false` is the safe answer for the flags that replace a
    // field-proven path. An install from before this setting existed carries
    // no key at all and likewise takes `DEFAULT_SETTINGS`' `true`.
    if (typeof initial.imuGyroCaptureEnabled !== 'boolean') {
      initial = { ...initial, imuGyroCaptureEnabled: DEFAULT_SETTINGS.imuGyroCaptureEnabled };
    }
    if (typeof initial.analysisSmoothingEnabled !== 'boolean') {
      initial = { ...initial, analysisSmoothingEnabled: false };
    }
    return new SqlSettingsStore(db, initial, rowHasActiveVehicleProfileId);
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

// ---------------------------------------------------------------------------
// Ticket P7R E2 — the durable record of which sessions were run on matching
// the calibration gate refused to vouch for.
// ---------------------------------------------------------------------------

/**
 * The `settings` key this log lives under. A SEPARATE key from
 * {@link SETTINGS_KEY}: it is not a user preference, it is a growing list of
 * facts about past sessions, and mixing the two would make every session note
 * rewrite the whole preferences blob (and a corrupt preferences row take the
 * record down with it).
 *
 * WHY THE SETTINGS TABLE AND NOT A COLUMN ON `sessions`. The honest home for
 * this fact is the session row itself. That row is owned by
 * `@circuit/core`'s `SessionSummary` + `persistence-sql/schema.ts`, neither of
 * which this ticket may touch, so the fact is stored BESIDE the session,
 * keyed by its id, in the one durable table this ticket does own. It is read
 * back by session id everywhere it matters (the history list and the export),
 * so from the outside it behaves as if it were on the row; what it is not is
 * transactional with the session write. A crash between the two would lose
 * the label rather than invent one -- the failure direction that under-claims
 * rather than over-claims, which is the right way round for an honesty flag.
 */
const UNVALIDATED_MATCHING_KEY = 'unvalidated-matching-sessions';

/**
 * How many session ids the log keeps, newest last. Bounded because it is
 * rewritten whole on every append and lives in a key-value row; 200 sessions
 * is years of track days for one driver, and the oldest ids falling off is
 * strictly better than an unbounded row.
 */
export const UNVALIDATED_MATCHING_LOG_LIMIT = 200;

function parseSessionIdList(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    // A corrupt row reads as "nothing recorded", never as a throw: this log
    // is read on the path to EXPORTING a session's data, and losing a label
    // must not be able to lose the data.
    return [];
  }
}

/**
 * Every session id previously recorded by
 * {@link markSessionMatchingUnvalidated}, oldest first. Never throws: a
 * failed read resolves to an empty list.
 */
export async function readUnvalidatedMatchingSessionIds(db: SqlDatabase): Promise<string[]> {
  try {
    const rows = await db.getAllAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      UNVALIDATED_MATCHING_KEY,
    ]);
    return parseSessionIdList(rows[0]?.value);
  } catch {
    return [];
  }
}

/**
 * Records that `sessionId` was run on matching the calibration gate rejected.
 * Idempotent (a second call for the same id is a no-op), bounded by
 * {@link UNVALIDATED_MATCHING_LOG_LIMIT}, and never throws -- a failed write
 * must never be able to stop a driver going out.
 *
 * Resolves `true` when the log now contains the id.
 */
export async function markSessionMatchingUnvalidated(
  db: SqlDatabase,
  sessionId: string,
): Promise<boolean> {
  if (sessionId.length === 0) return false;
  try {
    const existing = await readUnvalidatedMatchingSessionIds(db);
    if (existing.includes(sessionId)) return true;
    const next = [...existing, sessionId].slice(-UNVALIDATED_MATCHING_LOG_LIMIT);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      UNVALIDATED_MATCHING_KEY,
      JSON.stringify(next),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops the whole log. Used by delete-all: these are facts about sessions
 * that no longer exist. Never throws; resolves `false` when the row could
 * not be removed.
 */
export async function clearUnvalidatedMatchingSessionIds(db: SqlDatabase): Promise<boolean> {
  try {
    await db.runAsync('DELETE FROM settings WHERE key = ?', [UNVALIDATED_MATCHING_KEY]);
    return true;
  } catch {
    return false;
  }
}
