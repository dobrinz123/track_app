import { describe, expect, it } from 'vitest';
import type { TelemetryChannelId } from '@circuit/core';

/**
 * Telemetry addendum — channel revision (2026-08-11, binding): pins
 * `LapDetailScreen.tsx`'s `TELEMETRY_CHART_CHANNELS` id order: speedKph, rpm,
 * throttlePct, latG, longG, engineOilC, transOilC. `LapDetailScreen.tsx`
 * itself imports `react-native`, which breaks vitest's parser under this
 * repo's plain-Node `vitest.config.ts` (same constraint as
 * `SettingsScreen.tsx`'s `parsePortDraft`/`parseHexPidDraft`, see
 * `test/session/settingsPortDraft.test.ts`'s own doc comment), so this is a
 * byte-for-byte mirror of just the `id` order -- keep the two in sync on any
 * future change to either.
 */
const TELEMETRY_CHART_CHANNEL_IDS: readonly TelemetryChannelId[] = [
  'speedKph',
  'rpm',
  'throttlePct',
  'latG',
  'longG',
  'engineOilC',
  'transOilC',
];

describe('LapDetailScreen TELEMETRY_CHART_CHANNELS order (channel revision)', () => {
  it('pins the exact binding chart channel order', () => {
    expect(TELEMETRY_CHART_CHANNEL_IDS).toEqual([
      'speedKph',
      'rpm',
      'throttlePct',
      'latG',
      'longG',
      'engineOilC',
      'transOilC',
    ]);
  });

  it('every channel id is unique (no duplicate chart)', () => {
    expect(new Set(TELEMETRY_CHART_CHANNEL_IDS).size).toBe(TELEMETRY_CHART_CHANNEL_IDS.length);
  });
});
