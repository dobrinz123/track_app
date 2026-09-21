import { describe, expect, it } from 'vitest';
import { SqlSessionRepository } from '@circuit/core';

import { DEFAULT_SETTINGS, InMemorySettingsStore } from '../../src/session/settingsStore';
import { SqlSettingsStore } from '../../src/persistence/sqlSettingsStore';
import {
  ANALYSIS_SMOOTHING_SETTING_STRINGS,
  IMU_FUSION_SETTING_STRINGS,
} from '../../src/ui/screens/imuSettingsStrings';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';

/**
 * Ticket P6a — the two new settings: declaration, defaults, persistence and
 * copy. Both are experimental opt-ins that change how a field-confirmed
 * signal path behaves, so the interesting cases are all about a value the
 * store did NOT write: a missing key, and a malformed one.
 */

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('P6a settings -- imuFusionEnabled / analysisSmoothingEnabled', () => {
  it('both default to false', () => {
    expect(DEFAULT_SETTINGS.imuFusionEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.analysisSmoothingEnabled).toBe(false);
  });

  it('are plain toggles on the in-memory store, independent of each other', () => {
    const store = new InMemorySettingsStore();
    store.update({ imuFusionEnabled: true });
    expect(store.getSettings().imuFusionEnabled).toBe(true);
    expect(store.getSettings().analysisSmoothingEnabled).toBe(false);
    store.update({ analysisSmoothingEnabled: true, imuFusionEnabled: false });
    expect(store.getSettings().imuFusionEnabled).toBe(false);
    expect(store.getSettings().analysisSmoothingEnabled).toBe(true);
  });

  it('round-trip through SQLite and come back as they were written', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    const first = await SqlSettingsStore.create(db);
    expect(first.getSettings().imuFusionEnabled).toBe(false);
    expect(first.getSettings().analysisSmoothingEnabled).toBe(false);

    first.update({ imuFusionEnabled: true, analysisSmoothingEnabled: true });
    await flush();

    const reopened = await SqlSettingsStore.create(db);
    expect(reopened.getSettings().imuFusionEnabled).toBe(true);
    expect(reopened.getSettings().analysisSmoothingEnabled).toBe(true);
  });

  it('a row written BEFORE these settings existed hydrates to false, not to undefined', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ units: 'mph', coachingEnabled: true }),
    ]);

    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings().units).toBe('mph');
    expect(store.getSettings().imuFusionEnabled).toBe(false);
    expect(store.getSettings().analysisSmoothingEnabled).toBe(false);
  });

  it('a present-but-malformed value is repaired to false, never read as truthy', async () => {
    const db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'app-settings',
      JSON.stringify({ imuFusionEnabled: 'yes', analysisSmoothingEnabled: 1 }),
    ]);

    const store = await SqlSettingsStore.create(db);
    expect(store.getSettings().imuFusionEnabled).toBe(false);
    expect(store.getSettings().analysisSmoothingEnabled).toBe(false);
  });
});

describe('P6a settings copy -- RO and EN', () => {
  for (const [name, table] of [
    ['IMU_FUSION_SETTING_STRINGS', IMU_FUSION_SETTING_STRINGS],
    ['ANALYSIS_SMOOTHING_SETTING_STRINGS', ANALYSIS_SMOOTHING_SETTING_STRINGS],
  ] as const) {
    it(`${name}: RO carries every key EN does, and neither is empty`, () => {
      expect(Object.keys(table.ro).sort()).toEqual(Object.keys(table.en).sort());
      for (const language of ['en', 'ro'] as const) {
        for (const value of Object.values(table[language])) {
          expect(typeof value).toBe('string');
          expect(value.trim().length).toBeGreaterThan(0);
        }
      }
    });
  }

  it('both rows say, in both languages, that they are off by default', () => {
    expect(IMU_FUSION_SETTING_STRINGS.en.helpBounds).toContain('Off by default');
    expect(IMU_FUSION_SETTING_STRINGS.ro.helpBounds).toContain('Oprit implicit');
    expect(ANALYSIS_SMOOTHING_SETTING_STRINGS.en.helpBounds).toContain('Off by default');
    expect(ANALYSIS_SMOOTHING_SETTING_STRINGS.ro.helpBounds).toContain('Oprit implicit');
  });

  it('the IMU row states the bound that matters: it is never used for lap timing', () => {
    expect(IMU_FUSION_SETTING_STRINGS.en.helpBounds).toContain('lap timing');
    expect(IMU_FUSION_SETTING_STRINGS.ro.helpBounds).toContain('cronometrare');
  });

  it('the smoothing row states that it only ever runs after a session ends', () => {
    expect(ANALYSIS_SMOOTHING_SETTING_STRINGS.en.helpBounds).toContain('after a session ends');
    expect(ANALYSIS_SMOOTHING_SETTING_STRINGS.ro.helpBounds).toContain('după încheierea sesiunii');
  });
});
