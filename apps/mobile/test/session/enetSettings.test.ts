import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, InMemorySettingsStore } from '../../src/session/settingsStore';
import { SqlSettingsStore } from '../../src/persistence/sqlSettingsStore';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * ENET telemetry addendum (P4e-T2, binding): the new `adapterType`/`enet*`
 * settings fields, hydrated the SAME way as every other field (additive
 * merge onto `DEFAULT_SETTINGS`) -- see `telemetrySettings.test.ts` for the
 * ELM327-side equivalent this mirrors.
 */
describe('ENET telemetry addendum settings defaults', () => {
  it('DEFAULT_SETTINGS carries the binding ENET defaults, and the ELM327 defaults are unchanged', () => {
    expect(DEFAULT_SETTINGS.adapterType).toBe('elm327');
    expect(DEFAULT_SETTINGS.enetHost).toBe('');
    expect(DEFAULT_SETTINGS.enetPort).toBe(6_801);
    expect(DEFAULT_SETTINGS.enetTesterAddress).toBe(0xf4);
    expect(DEFAULT_SETTINGS.enetTargetAddress).toBe(0x12);
    expect(DEFAULT_SETTINGS.enetChannelSpecsJson).toBe('');
    // ELM327 path byte-identical: unaffected by the new fields existing.
    expect(DEFAULT_SETTINGS.adapterHost).toBe('192.168.0.10');
    expect(DEFAULT_SETTINGS.adapterPort).toBe(35_000);
  });

  it('InMemorySettingsStore starts with the ENET defaults and applies partial ENET updates', () => {
    const store = new InMemorySettingsStore();
    expect(store.getSettings().adapterType).toBe('elm327');

    store.update({ adapterType: 'enet', enetHost: '192.168.4.20', enetPort: 6_802 });
    const settings = store.getSettings();
    expect(settings.adapterType).toBe('enet');
    expect(settings.enetHost).toBe('192.168.4.20');
    expect(settings.enetPort).toBe(6_802);
    // Untouched ENET fields, and unrelated fields, survive the partial update.
    expect(settings.enetTesterAddress).toBe(0xf4);
    expect(settings.units).toBe('kmh');
  });
});

describe('ENET telemetry addendum settings migration (SqlSettingsStore)', () => {
  it('a settings row persisted BEFORE this ticket (no adapterType/enet* fields at all) hydrates with the new ENET defaults, ELM327 fields unchanged', async () => {
    const db = await createSqlJsDatabase();
    await db.execAsync('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    const legacyBlob = JSON.stringify({
      units: 'mph',
      telemetryEnabled: true,
      adapterHost: '10.0.0.9',
      adapterPort: 35_002,
      // No adapterType/enetHost/enetPort/enetTesterAddress/enetTargetAddress/enetChannelSpecsJson.
    });
    await db.runAsync('INSERT INTO settings (key, value) VALUES (?, ?)', ['app-settings', legacyBlob]);

    const store = await SqlSettingsStore.create(db);
    const settings = store.getSettings();

    // The legacy ELM327 fields are preserved exactly...
    expect(settings.units).toBe('mph');
    expect(settings.telemetryEnabled).toBe(true);
    expect(settings.adapterHost).toBe('10.0.0.9');
    expect(settings.adapterPort).toBe(35_002);
    // ...and the new ENET fields are additively filled in from defaults.
    expect(settings.adapterType).toBe('elm327');
    expect(settings.enetHost).toBe('');
    expect(settings.enetPort).toBe(6_801);
    expect(settings.enetTesterAddress).toBe(0xf4);
    expect(settings.enetTargetAddress).toBe(0x12);
    expect(settings.enetChannelSpecsJson).toBe('');
  });

  it('round-trips a fresh ENET-selected update through persist() and a re-open (simulated app restart)', async () => {
    const db = await createSqlJsDatabase();
    await db.execAsync('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

    const store1 = await SqlSettingsStore.create(db);
    store1.update({
      adapterType: 'enet',
      enetHost: '192.168.4.20',
      enetPort: 6_802,
      enetTesterAddress: 0xf1,
      enetTargetAddress: 0x10,
      enetChannelSpecsJson: '[]',
    });
    await Promise.resolve();
    await Promise.resolve();

    const store2 = await SqlSettingsStore.create(db);
    const settings = store2.getSettings();
    expect(settings.adapterType).toBe('enet');
    expect(settings.enetHost).toBe('192.168.4.20');
    expect(settings.enetPort).toBe(6_802);
    expect(settings.enetTesterAddress).toBe(0xf1);
    expect(settings.enetTargetAddress).toBe(0x10);
    expect(settings.enetChannelSpecsJson).toBe('[]');
  });
});
