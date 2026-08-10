import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, InMemorySettingsStore } from '../../src/session/settingsStore';
import { SqlSettingsStore } from '../../src/persistence/sqlSettingsStore';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

describe('Telemetry addendum settings defaults', () => {
  it('DEFAULT_SETTINGS carries the binding telemetry defaults', () => {
    expect(DEFAULT_SETTINGS.telemetryEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.telemetrySimulate).toBe(false);
    expect(DEFAULT_SETTINGS.adapterHost).toBe('192.168.0.10');
    expect(DEFAULT_SETTINGS.adapterPort).toBe(35_000);
  });

  it('DEFAULT_SETTINGS.transOilPidHex is empty (channel revision: disabled by default)', () => {
    expect(DEFAULT_SETTINGS.transOilPidHex).toBe('');
  });

  it('InMemorySettingsStore starts with the telemetry defaults and applies partial telemetry updates', () => {
    const store = new InMemorySettingsStore();
    expect(store.getSettings().telemetryEnabled).toBe(false);

    store.update({ telemetryEnabled: true, adapterHost: '10.0.0.5', adapterPort: 35_001 });
    const settings = store.getSettings();
    expect(settings.telemetryEnabled).toBe(true);
    expect(settings.adapterHost).toBe('10.0.0.5');
    expect(settings.adapterPort).toBe(35_001);
    // Untouched fields survive the partial update.
    expect(settings.units).toBe('kmh');
  });

  it('InMemorySettingsStore applies a transOilPidHex update', () => {
    const store = new InMemorySettingsStore();
    expect(store.getSettings().transOilPidHex).toBe('');
    store.update({ transOilPidHex: '221E0C' });
    expect(store.getSettings().transOilPidHex).toBe('221E0C');
  });
});

describe('Telemetry addendum settings migration (SqlSettingsStore)', () => {
  it('a settings row persisted BEFORE this ticket (no telemetry fields at all) hydrates with the new telemetry defaults', async () => {
    const db = await createSqlJsDatabase();
    // Seed a "pre-telemetry" settings table directly -- the settings table
    // itself already exists in the app's real schema (persistence-sql v2);
    // this simulates an existing installation's stored JSON blob predating
    // this ticket's four new fields.
    await db.execAsync('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const legacyBlob = JSON.stringify({
      units: 'mph',
      deltaDeadbandMs: 250,
      coverageBins: { thresholds: [0.5, 1] },
      coachingEnabled: false,
      voiceCoachEnabled: true,
      // No telemetryEnabled/telemetrySimulate/adapterHost/adapterPort.
    });
    await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', ['app-settings', legacyBlob]);

    const store = await SqlSettingsStore.create(db);
    const settings = store.getSettings();

    // The legacy fields are preserved exactly...
    expect(settings.units).toBe('mph');
    expect(settings.voiceCoachEnabled).toBe(true);
    // ...and the new telemetry fields are additively filled in from defaults,
    // never throwing or dropping the rest of the row.
    expect(settings.telemetryEnabled).toBe(false);
    expect(settings.telemetrySimulate).toBe(false);
    expect(settings.adapterHost).toBe('192.168.0.10');
    expect(settings.adapterPort).toBe(35_000);
    // Channel revision: a row persisted before this ticket also has no
    // transOilPidHex at all -- additively filled in as disabled, same rule.
    expect(settings.transOilPidHex).toBe('');
  });

  it('round-trips a fresh telemetry-enabled update through persist() and a re-open (simulated app restart)', async () => {
    const db = await createSqlJsDatabase();
    await db.execAsync('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

    const store1 = await SqlSettingsStore.create(db);
    store1.update({ telemetryEnabled: true, telemetrySimulate: true, adapterHost: '192.168.4.1', adapterPort: 35_555 });
    // `persist()` is fire-and-forget from `update()`'s perspective; give its
    // microtask a turn before "restarting".
    await Promise.resolve();
    await Promise.resolve();

    const store2 = await SqlSettingsStore.create(db);
    const settings = store2.getSettings();
    expect(settings.telemetryEnabled).toBe(true);
    expect(settings.telemetrySimulate).toBe(true);
    expect(settings.adapterHost).toBe('192.168.4.1');
    expect(settings.adapterPort).toBe(35_555);
  });

  it('round-trips a transOilPidHex update through persist() and a re-open (simulated app restart)', async () => {
    const db = await createSqlJsDatabase();
    await db.execAsync('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

    const store1 = await SqlSettingsStore.create(db);
    store1.update({ transOilPidHex: '221E0C' });
    await Promise.resolve();
    await Promise.resolve();

    const store2 = await SqlSettingsStore.create(db);
    expect(store2.getSettings().transOilPidHex).toBe('221E0C');
  });
});
