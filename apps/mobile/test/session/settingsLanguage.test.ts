import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS,
  InMemorySettingsStore,
  defaultLanguageForLocale,
  type AppLanguage,
} from '../../src/session/settingsStore';

/**
 * Ticket P4l-FIX1 F2 (binding): the app carries ONE language setting
 * (`'ro' | 'en'`), defaulted from the device locale -- Romanian for a `ro`
 * locale, English for everything else -- and the Signal Finder summary is
 * rendered in it instead of the hard-coded `'en'` the P4l screen shipped.
 * The default rule is a pure function so it can be pinned here without ever
 * touching a native locale API.
 */
describe('P4l-FIX1 F2: language default from the device locale', () => {
  it('a Romanian locale defaults to "ro", in every tag form', () => {
    for (const locale of ['ro', 'ro-RO', 'ro_RO', 'RO-ro', 'ro-MD']) {
      expect(defaultLanguageForLocale(locale)).toBe<AppLanguage>('ro');
    }
  });

  it('every other locale defaults to "en"', () => {
    for (const locale of ['en', 'en-US', 'de-DE', 'hu-RO', 'fr', 'roa', 'rom']) {
      expect(defaultLanguageForLocale(locale)).toBe<AppLanguage>('en');
    }
  });

  it('an unknown/absent locale defaults to "en" rather than throwing', () => {
    expect(defaultLanguageForLocale(null)).toBe('en');
    expect(defaultLanguageForLocale(undefined)).toBe('en');
    expect(defaultLanguageForLocale('')).toBe('en');
    expect(defaultLanguageForLocale('   ')).toBe('en');
  });

  it('the settings store carries the language and defaults to "en" (locale applied at hydration)', () => {
    expect(DEFAULT_SETTINGS.language).toBe('en');
    const store = new InMemorySettingsStore();
    expect(store.getSettings().language).toBe('en');
    store.update({ language: 'ro' });
    expect(store.getSettings().language).toBe('ro');
  });
});
