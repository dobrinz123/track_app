import { describe, expect, it } from 'vitest';
import { TELEMETRY_CHART_CHANNELS } from '../../src/persistence/telemetryRead';

/**
 * F5 LOW fix (channel revision, binding): pins `telemetryRead.ts`'s exported
 * `TELEMETRY_CHART_CHANNELS` id order -- imported directly from production
 * (no copied mirror; the review's own finding was that the previous version
 * of this test declared its own literal and compared it to another literal,
 * so a real production divergence would never fail it).
 * `LapDetailScreen.tsx` itself still imports `react-native`, which breaks
 * vitest's parser (same constraint as `SettingsScreen.tsx`'s
 * `parsePortDraft`/`parseHexPidDraft`, see
 * `test/session/settingsPortDraft.test.ts`'s own doc comment) -- that's
 * exactly why the id/order constant now lives in the RN-free
 * `telemetryRead.ts` instead.
 */
describe('TELEMETRY_CHART_CHANNELS order (channel revision, F5 fix)', () => {
  it('pins the exact binding chart channel order', () => {
    expect(TELEMETRY_CHART_CHANNELS).toEqual([
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
    expect(new Set(TELEMETRY_CHART_CHANNELS).size).toBe(TELEMETRY_CHART_CHANNELS.length);
  });
});
