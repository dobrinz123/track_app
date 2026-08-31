import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, InMemorySettingsStore } from '../../src/session/settingsStore';
import { SUGGESTION_SETTING_STRINGS } from '../../src/ui/screens/trackdayStrings';

/**
 * Ticket P5c-B D2/D5 — `suggestionsEnabled` is the opt-in gate for the whole
 * trackday stage (contracts.md R2-3). It is OFF by default and stays off for
 * every existing install that has nothing persisted, so the app behaves
 * exactly as it did before this ticket unless the driver says otherwise.
 */

describe('suggestionsEnabled setting', () => {
  it('is OFF by default', () => {
    expect(DEFAULT_SETTINGS.suggestionsEnabled).toBe(false);
  });

  it('is a plain persisted toggle like every other coaching switch', () => {
    const store = new InMemorySettingsStore();
    expect(store.getSettings().suggestionsEnabled).toBe(false);
    store.update({ suggestionsEnabled: true });
    expect(store.getSettings().suggestionsEnabled).toBe(true);
    store.update({ suggestionsEnabled: false });
    expect(store.getSettings().suggestionsEnabled).toBe(false);
  });

  it('has RO and EN copy that states the bounds the driver is opting into', () => {
    expect(Object.keys(SUGGESTION_SETTING_STRINGS.ro).sort()).toEqual(
      Object.keys(SUGGESTION_SETTING_STRINGS.en).sort(),
    );
    expect(SUGGESTION_SETTING_STRINGS.en.helpBounds).toContain('10 m');
    expect(SUGGESTION_SETTING_STRINGS.en.helpBounds).toContain('3 km/h');
    expect(SUGGESTION_SETTING_STRINGS.ro.helpBounds).toContain('10 m');
    expect(SUGGESTION_SETTING_STRINGS.ro.helpBounds).toContain('3 km/h');
  });
});
