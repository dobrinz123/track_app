import { describe, expect, it } from 'vitest';
import { ADVISORY_NOTICE, circuitDisplayData, statusLabel } from '../../../src/ui/data/circuit';
import { TMR_CIRCUIT_PROFILE } from '../../../src/session/tmrProfile';
import { MOTORPARK_CIRCUIT_PROFILE } from '../../../src/session/circuitCatalog';

/** Every occurrence of "official" (case-insensitive) in `text` must be immediately preceded by "not an " (ticket CN-FIX2, L2 fix -- contracts.md: the word "official" may appear only inside a negation). */
function officialOccurrencesAreNegated(text: string): boolean {
  const officialCount = (text.match(/official/gi) ?? []).length;
  const negatedCount = (text.match(/not an official/gi) ?? []).length;
  return officialCount === negatedCount;
}

/**
 * `circuitDisplayData()` (ticket CN-W3) replaces the old hardcoded
 * `TRANSILVANIA_MOTOR_RING` constant -- it must render EITHER bundled
 * circuit from its real `CircuitProfile` alone, and must never claim
 * "official" (contracts.md's Coaching/geometry addenda: geometry is
 * community-derived, sectors are app-defined, for both circuits).
 */
describe('circuitDisplayData (ticket CN-W3)', () => {
  it('TMR: renders the real profile fields, never the word "official"', () => {
    const data = circuitDisplayData(TMR_CIRCUIT_PROFILE);
    expect(data.circuitId).toBe(TMR_CIRCUIT_PROFILE.circuitId);
    expect(data.displayName).toBe(TMR_CIRCUIT_PROFILE.displayName);
    expect(data.locality).toBe(TMR_CIRCUIT_PROFILE.locality);
    expect(data.country).toBe(TMR_CIRCUIT_PROFILE.country);
    expect(data.layoutId).toBe(TMR_CIRCUIT_PROFILE.layoutId);
    expect(data.direction).toBe(TMR_CIRCUIT_PROFILE.direction);
    expect(data.geometryStatus).toBe(TMR_CIRCUIT_PROFILE.geometryStatus);
    expect(data.sectorStatus).toBe(TMR_CIRCUIT_PROFILE.sectorStatus);
    expect(data.lengthKm).toBeCloseTo(TMR_CIRCUIT_PROFILE.totalLengthM / 1000, 6);
    // TMR-specific extras (researched, not on the profile itself) still surface.
    expect(data.extras.openedYear).toBe(2018);
    expect(data.extras.county).toBe('Mureș County');
    expect(data.provenanceText.toLowerCase()).not.toContain('official');
    expect(data.osmAttribution.toLowerCase()).not.toContain('official');
    expect(ADVISORY_NOTICE.toLowerCase()).toContain('not an official');
  });

  it('MotorPark: renders the real profile fields, no invented extras, never the word "official" (beyond the disclaimer copy)', () => {
    const data = circuitDisplayData(MOTORPARK_CIRCUIT_PROFILE);
    expect(data.circuitId).toBe(MOTORPARK_CIRCUIT_PROFILE.circuitId);
    expect(data.displayName).toBe('MotorPark România');
    expect(data.layoutId).toBe(MOTORPARK_CIRCUIT_PROFILE.layoutId);
    expect(data.direction).toBe(MOTORPARK_CIRCUIT_PROFILE.direction);
    expect(data.geometryStatus).toBe(MOTORPARK_CIRCUIT_PROFILE.geometryStatus);
    expect(data.sectorStatus).toBe(MOTORPARK_CIRCUIT_PROFILE.sectorStatus);
    // Nothing invented beyond what MotorPark's own asset carries.
    expect(data.extras).toEqual({});
    expect(data.provenanceText.toLowerCase()).not.toContain('official');
    expect(data.provenanceText).toContain(MOTORPARK_CIRCUIT_PROFILE.source.name);
  });

  it('L3 fix (ticket CN-FIX2): provenance text is ONE attribution line including the profile source name, LICENSE, and RETRIEVEDAT -- not just the name/url the old (vacuous) version of this test checked', () => {
    const data = circuitDisplayData(TMR_CIRCUIT_PROFILE);
    expect(data.provenanceText).toContain(TMR_CIRCUIT_PROFILE.source.name);
    expect(TMR_CIRCUIT_PROFILE.source.license).toBeDefined();
    expect(data.provenanceText).toContain(TMR_CIRCUIT_PROFILE.source.license as string);
    expect(TMR_CIRCUIT_PROFILE.source.retrievedAt).toBeDefined();
    expect(data.provenanceText).toContain(TMR_CIRCUIT_PROFILE.source.retrievedAt as string);
    // The OSM way id, parsed from `source.url` -- the format ticket CN-FIX2
    // specifies: "© OpenStreetMap contributors · ODbL 1.0 · way <ids> ·
    // retrieved <date>".
    const wayId = /\/way\/(\d+)/.exec(TMR_CIRCUIT_PROFILE.source.url ?? '')?.[1];
    expect(wayId).toBeDefined();
    expect(data.provenanceText).toBe(
      `${TMR_CIRCUIT_PROFILE.source.name} · ${TMR_CIRCUIT_PROFILE.source.license} · way ${wayId} · retrieved ${TMR_CIRCUIT_PROFILE.source.retrievedAt}`,
    );
  });

  it('L3 fix: provenance text NEVER appends the raw confidenceNotes text verbatim (it previously duplicated the attribution on screen)', () => {
    for (const profile of [TMR_CIRCUIT_PROFILE, MOTORPARK_CIRCUIT_PROFILE]) {
      const data = circuitDisplayData(profile);
      expect(profile.confidenceNotes).toBeDefined();
      // The confidenceNotes text is long research prose -- its FIRST WORD
      // being absent from the (short, structured) provenance line is a
      // reliable proxy for "not appended verbatim" without over-fitting to
      // exact wording.
      const firstWord = (profile.confidenceNotes as string).trim().split(/\s+/)[0];
      expect(data.provenanceText).not.toContain(firstWord);
    }
  });

  it('L2/status-label fix (ticket CN-FIX2): every "official" occurrence across circuitDisplayData AND the status-label helper is a negated "not an official" disclaimer, never a bare status claim', () => {
    for (const profile of [TMR_CIRCUIT_PROFILE, MOTORPARK_CIRCUIT_PROFILE]) {
      const data = circuitDisplayData(profile);
      expect(officialOccurrencesAreNegated(data.provenanceText)).toBe(true);
      expect(officialOccurrencesAreNegated(data.osmAttribution)).toBe(true);
      expect(officialOccurrencesAreNegated(statusLabel(data.geometryStatus))).toBe(true);
      expect(officialOccurrencesAreNegated(statusLabel(data.sectorStatus))).toBe(true);
      // Neither bundled circuit's real geometryStatus/sectorStatus is
      // 'official' today -- both render as their own capitalized, hyphenated
      // words, never a bespoke "Official" substitute.
      expect(statusLabel('community-derived')).toBe('Community-derived');
      expect(statusLabel('app-defined')).toBe('App-defined');
    }
  });

  /**
   * N6 fix (ticket CN-FIX3, contracts.md's lifecycle lock amendment,
   * binding). This REPLACES the CN-FIX2 test that asserted
   * `statusLabel('official') === 'official'` -- that pinned exactly the
   * behavior CN-REV3's N6 flagged: a future bundled profile carrying the
   * schema-permitted `geometryStatus: 'official'` rendered the bare word.
   */
  it('N6: no schema-permitted status value ever renders the word "official" -- it maps to the neutral "Source-declared"', () => {
    // Every value `packages/core/src/contracts.ts` permits for
    // geometryStatus ('official' | 'community-derived' | 'dev-only') and
    // sectorStatus ('official' | 'app-defined').
    const SCHEMA_STATUS_VALUES = ['official', 'community-derived', 'dev-only', 'app-defined'];
    for (const status of SCHEMA_STATUS_VALUES) {
      expect(statusLabel(status)).not.toMatch(/official/i);
    }
    expect(statusLabel('official')).toBe('Source-declared');
  });

  it('LEAD field-feedback addendum (CN-FIX3): status labels are capitalized and keep their hyphen -- an unknown future value just gets its first letter capitalized', () => {
    expect(statusLabel('community-derived')).toBe('Community-derived');
    expect(statusLabel('app-defined')).toBe('App-defined');
    expect(statusLabel('dev-only')).toBe('Dev-only');
    expect(statusLabel('surveyed-2027')).toBe('Surveyed-2027');
    expect(statusLabel('')).toBe('');
  });
});
