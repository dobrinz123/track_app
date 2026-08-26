import { describe, expect, it } from 'vitest';
import { SqlSessionRepository } from '@circuit/core';
import { SqlSettingsStore } from '../../src/persistence/sqlSettingsStore';
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/session/settingsStore';
import { createRawSqlJsDatabase, createSqlJsDatabase, wrapExistingSqlJsDatabase } from '../support/sqlJsDatabase';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SqlSettingsStore (against sql.js)', () => {
  it('create() hydrates DEFAULT_SETTINGS when no row exists yet', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db); // runs the migration that creates the `settings` table
    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
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
    expect(seen[0]).toEqual(DEFAULT_SETTINGS);

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
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
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
});
