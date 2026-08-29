import { describe, expect, it } from 'vitest';
import { SqlSessionRepository } from '@circuit/core';
import { SqlSettingsStore } from '../../src/persistence/sqlSettingsStore';
import {
  DEFAULT_SETTINGS,
  defaultLanguageForLocale,
  readDeviceLocale,
  type AppSettings,
} from '../../src/session/settingsStore';

/**
 * Ticket P4l-FIX1 F2 (binding): with nothing persisted, hydration applies the
 * DEVICE-LOCALE language default, so "the defaults" this suite compares
 * against are `DEFAULT_SETTINGS` with that one field resolved -- pinned here
 * rather than assuming the machine running the tests is English.
 */
const HYDRATED_DEFAULTS: AppSettings = {
  ...DEFAULT_SETTINGS,
  language: defaultLanguageForLocale(readDeviceLocale()),
};
import { createRawSqlJsDatabase, createSqlJsDatabase, wrapExistingSqlJsDatabase } from '../support/sqlJsDatabase';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SqlSettingsStore (against sql.js)', () => {
  it('create() hydrates DEFAULT_SETTINGS when no row exists yet', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db); // runs the migration that creates the `settings` table
    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings()).toEqual(HYDRATED_DEFAULTS);
  });

  it('update() applies a partial patch immediately and preserves untouched fields', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    const store = await SqlSettingsStore.create(db);

    store.update({ units: 'mph' });

    expect(store.getSettings().units).toBe('mph');
    expect(store.getSettings().deltaDeadbandMs).toBe(DEFAULT_SETTINGS.deltaDeadbandMs);
    expect(store.getSettings().coverageBins).toEqual(DEFAULT_SETTINGS.coverageBins);
  });

  it('subscribe() replays the current value immediately and unsubscribe stops further delivery', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    const store = await SqlSettingsStore.create(db);

    const seen: AppSettings[] = [];
    const unsubscribe = store.subscribe((s) => seen.push(s));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(HYDRATED_DEFAULTS);

    store.update({ units: 'mph' });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.units).toBe('mph');

    unsubscribe();
    store.update({ deltaDeadbandMs: 250 });
    expect(seen).toHaveLength(2); // no further delivery after unsubscribe
  });

  it('persists round-trip: a value set via update() survives a fresh SqlSettingsStore.create() over the same on-device database (simulated app restart)', async () => {
    const raw = await createRawSqlJsDatabase();
    const db1 = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db1);
    const store1 = await SqlSettingsStore.create(db1);

    store1.update({ units: 'mph', deltaDeadbandMs: 250 });
    await flush(); // let the fire-and-forget persist() write land before "restarting"

    const db2 = wrapExistingSqlJsDatabase(raw);
    const store2 = await SqlSettingsStore.create(db2);

    expect(store2.getSettings().units).toBe('mph');
    expect(store2.getSettings().deltaDeadbandMs).toBe(250);
    expect(store2.getSettings().coverageBins).toEqual(DEFAULT_SETTINGS.coverageBins);
  });

  it('coachingEnabled (Phase 3 coaching addendum) defaults to true and round-trips through update()/persistence like every other setting', async () => {
    const raw = await createRawSqlJsDatabase();
    const db1 = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db1);
    const store1 = await SqlSettingsStore.create(db1);

    expect(store1.getSettings().coachingEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.coachingEnabled).toBe(true);

    store1.update({ coachingEnabled: false });
    expect(store1.getSettings().coachingEnabled).toBe(false);
    // Untouched fields still preserved alongside the new field.
    expect(store1.getSettings().units).toBe(DEFAULT_SETTINGS.units);
    await flush(); // let the fire-and-forget persist() write land before "restarting"

    const db2 = wrapExistingSqlJsDatabase(raw);
    const store2 = await SqlSettingsStore.create(db2);
    expect(store2.getSettings().coachingEnabled).toBe(false);
  });

  it('voiceCoachEnabled (Phase 3 coaching addendum) defaults to false and round-trips through update()/persistence like every other setting', async () => {
    const raw = await createRawSqlJsDatabase();
    const db1 = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db1);
    const store1 = await SqlSettingsStore.create(db1);

    expect(store1.getSettings().voiceCoachEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.voiceCoachEnabled).toBe(false);

    store1.update({ voiceCoachEnabled: true });
    expect(store1.getSettings().voiceCoachEnabled).toBe(true);
    // Untouched fields (including the OTHER coaching field) still preserved.
    expect(store1.getSettings().coachingEnabled).toBe(DEFAULT_SETTINGS.coachingEnabled);
    await flush(); // let the fire-and-forget persist() write land before "restarting"

    const db2 = wrapExistingSqlJsDatabase(raw);
    const store2 = await SqlSettingsStore.create(db2);
    expect(store2.getSettings().voiceCoachEnabled).toBe(true);
  });

  it('a corrupt stored row falls back to DEFAULT_SETTINGS rather than throwing', async () => {
    const raw = await createRawSqlJsDatabase();
    const db = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['app-settings', '{not valid json']);

    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings()).toEqual(HYDRATED_DEFAULTS);
  });

  /**
   * P4e-FIX2 L1 fix (binding, Codex P4e-REV2 Part B finding): a PRESENT but
   * structurally malformed ENET field must be repaired, not accepted
   * verbatim -- `isPartialAppSettings` only proves the persisted JSON was
   * "some object", so `{"enetPort":70000,"enetTesterAddress":-1}` used to
   * overwrite `DEFAULT_SETTINGS` unchecked. The review's exact persisted
   * object.
   */
  it("the review's exact persisted object -- enetPort/enetTesterAddress out of range are repaired on hydration, valid adapterType kept", async () => {
    const raw = await createRawSqlJsDatabase();
    const db = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ adapterType: 'enet', enetPort: 70_000, enetTesterAddress: -1 }),
    ]);

    const store = await SqlSettingsStore.create(db);
    const settings = store.getSettings();

    expect(settings.adapterType).toBe('enet');
    expect(settings.enetPort).toBe(DEFAULT_SETTINGS.enetPort);
    expect(settings.enetTesterAddress).toBe(DEFAULT_SETTINGS.enetTesterAddress);
    // Untouched, already-valid fields survive the repair unchanged.
    expect(settings.enetTargetAddress).toBe(DEFAULT_SETTINGS.enetTargetAddress);
  });

  it('a persisted adapterType outside the enum resets to elm327 on hydration', async () => {
    const raw = await createRawSqlJsDatabase();
    const db = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ adapterType: 'bogus' }),
    ]);

    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings().adapterType).toBe('elm327');
  });

  it('a persisted enetChannelSpecsJson that is unparsable JSON resets to "" on hydration', async () => {
    const raw = await createRawSqlJsDatabase();
    const db = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ enetChannelSpecsJson: '{not json' }),
    ]);

    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings().enetChannelSpecsJson).toBe('');
  });

  it('a valid, fully-in-range ENET settings row hydrates unchanged (repair is a no-op)', async () => {
    const raw = await createRawSqlJsDatabase();
    const db = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ adapterType: 'enet', enetHost: '192.168.4.20', enetPort: 6_802, enetTesterAddress: 0xf1, enetTargetAddress: 0x10 }),
    ]);

    const store = await SqlSettingsStore.create(db);
    const settings = store.getSettings();
    expect(settings.adapterType).toBe('enet');
    expect(settings.enetHost).toBe('192.168.4.20');
    expect(settings.enetPort).toBe(6_802);
    expect(settings.enetTesterAddress).toBe(0xf1);
    expect(settings.enetTargetAddress).toBe(0x10);
  });

  /** ENET auto-discovery & DID sweep addendum (binding, Phase 4f): the two new settings this ticket introduces get the same hydration-repair treatment as every other ENET field above. */
  it('a persisted enetAutoDiscover that is not a boolean resets to the default (true) on hydration; a present, valid enetHostProvenance survives', async () => {
    const raw = await createRawSqlJsDatabase();
    const db = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ enetAutoDiscover: 'yes', enetHostProvenance: 'discovered 2026-08-27T00:00:00.000Z' }),
    ]);

    const store = await SqlSettingsStore.create(db);
    const settings = store.getSettings();
    expect(settings.enetAutoDiscover).toBe(true);
    expect(settings.enetHostProvenance).toBe('discovered 2026-08-27T00:00:00.000Z');
  });

  /** Field revision (2026-08-27, binding, "hidden developer mode"): a present-but-malformed persisted `developerModeEnabled` must never leave dev-only ENET tools visible in a release build by accident -- repaired back to `false`. */
  it('a persisted developerModeEnabled that is not a boolean resets to the default (false) on hydration', async () => {
    const raw = await createRawSqlJsDatabase();
    const db = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ developerModeEnabled: 'yes' }),
    ]);

    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings().developerModeEnabled).toBe(false);
  });

  it('developerModeEnabled defaults to false and round-trips through update()/persistence like every other setting', async () => {
    const raw = await createRawSqlJsDatabase();
    const db1 = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db1);
    const store1 = await SqlSettingsStore.create(db1);

    expect(store1.getSettings().developerModeEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.developerModeEnabled).toBe(false);

    store1.update({ developerModeEnabled: true });
    expect(store1.getSettings().developerModeEnabled).toBe(true);
    await flush();

    const db2 = wrapExistingSqlJsDatabase(raw);
    const store2 = await SqlSettingsStore.create(db2);
    expect(store2.getSettings().developerModeEnabled).toBe(true);
  });

  it('enetHostProvenance/enetAutoDiscover round-trip through update()/persistence across a simulated app restart', async () => {
    const raw = await createRawSqlJsDatabase();
    const db1 = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db1);
    const store1 = await SqlSettingsStore.create(db1);

    expect(store1.getSettings().enetAutoDiscover).toBe(true);
    expect(store1.getSettings().enetHostProvenance).toBe('');

    store1.update({ enetHost: '192.168.4.7', enetPort: 6801, enetHostProvenance: 'discovered 2026-08-27T00:00:00.000Z', enetAutoDiscover: false });
    await flush();

    const db2 = wrapExistingSqlJsDatabase(raw);
    const store2 = await SqlSettingsStore.create(db2);
    expect(store2.getSettings().enetHost).toBe('192.168.4.7');
    expect(store2.getSettings().enetHostProvenance).toBe('discovered 2026-08-27T00:00:00.000Z');
    expect(store2.getSettings().enetAutoDiscover).toBe(false);
  });

  /**
   * Ticket P4l-FIX1 F2 (binding): the language default comes from the DEVICE
   * LOCALE and is applied at hydration only -- a stored choice always wins,
   * and a stored value outside the two-value vocabulary is repaired rather
   * than accepted verbatim (same discipline as `developerModeEnabled`).
   */
  it('language: a persisted choice survives a restart; a missing/invalid one falls back to the device-locale default', async () => {
    const raw = await createRawSqlJsDatabase();
    const db1 = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db1);
    const store1 = await SqlSettingsStore.create(db1);
    expect(store1.getSettings().language).toBe(defaultLanguageForLocale(readDeviceLocale()));

    store1.update({ language: 'ro' });
    await flush();
    const store2 = await SqlSettingsStore.create(wrapExistingSqlJsDatabase(raw));
    expect(store2.getSettings().language).toBe('ro');

    await db1.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ language: 'klingon' }),
    ]);
    const store3 = await SqlSettingsStore.create(wrapExistingSqlJsDatabase(raw));
    expect(store3.getSettings().language).toBe(defaultLanguageForLocale(readDeviceLocale()));
  });
});
