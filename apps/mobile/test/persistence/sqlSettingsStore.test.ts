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

  it('a corrupt stored row falls back to DEFAULT_SETTINGS rather than throwing', async () => {
    const raw = await createRawSqlJsDatabase();
    const db = wrapExistingSqlJsDatabase(raw);
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', ['app-settings', '{not valid json']);

    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
