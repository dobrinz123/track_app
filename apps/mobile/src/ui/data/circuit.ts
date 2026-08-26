import type { CircuitProfile } from '@circuit/core';

export const ADVISORY_NOTICE = 'Recreational timing aid — not an official timing system.';

const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/**
 * Per-circuitId display extras with no equivalent field on `CircuitProfile`
 * itself (ticket CN-W3). TMR keeps its researched opened-year/county here;
 * NOTHING is invented for MotorPark (or any future circuit) beyond what its
 * own bundled asset actually contains -- an entry with no key here simply
 * renders without those extra rows.
 */
const CIRCUIT_EXTRAS: Readonly<Record<string, { openedYear?: number; county?: string }>> = {
  'transilvania-motor-ring': { openedYear: 2018, county: 'Mureș County' },
};

export interface CircuitDisplayData {
  circuitId: string;
  displayName: string;
  locality: string;
  country: string;
  lengthKm: number;
  layoutId: string;
  direction: CircuitProfile['direction'];
  geometryStatus: CircuitProfile['geometryStatus'];
  sectorStatus: CircuitProfile['sectorStatus'];
  /** Built from `profile.source` (name/url/license/retrievedAt) plus the first sentence of `confidenceNotes` -- never claims "official". */
  provenanceText: string;
  osmAttribution: string;
  extras: { openedYear?: number; county?: string };
}

/** The first sentence of a long `confidenceNotes` free-text field (split on the first ". "), or `null` when the profile carries none. */
function firstConfidenceNote(confidenceNotes: string | undefined): string | null {
  if (confidenceNotes === undefined) return null;
  const trimmed = confidenceNotes.trim();
  if (trimmed === '') return null;
  const sentenceEnd = trimmed.indexOf('. ');
  return sentenceEnd === -1 ? trimmed : `${trimmed.slice(0, sentenceEnd)}.`;
}

/**
 * Builds `CircuitDetailScreen`'s display metadata from a real bundled
 * `CircuitProfile` -- geometry, provenance, and status fields are all read
 * from the profile itself, never fabricated (ADR-0002/ADR-0004). Replaces
 * the old hardcoded `TRANSILVANIA_MOTOR_RING` constant (ticket CN-W3) so the
 * detail screen renders whichever circuit the catalog resolves, not only TMR.
 */
export function circuitDisplayData(profile: CircuitProfile): CircuitDisplayData {
  const sourceParts: string[] = [profile.source.name];
  if (profile.source.url !== undefined) sourceParts.push(profile.source.url);
  if (profile.source.license !== undefined) sourceParts.push(profile.source.license);
  if (profile.source.retrievedAt !== undefined) sourceParts.push(`retrieved ${profile.source.retrievedAt}`);
  const note = firstConfidenceNote(profile.confidenceNotes);
  const provenanceText = note === null ? sourceParts.join(' · ') : `${sourceParts.join(' · ')} — ${note}`;

  return {
    circuitId: profile.circuitId,
    displayName: profile.displayName,
    locality: profile.locality,
    country: profile.country,
    lengthKm: profile.totalLengthM / 1000,
    layoutId: profile.layoutId,
    direction: profile.direction,
    geometryStatus: profile.geometryStatus,
    sectorStatus: profile.sectorStatus,
    provenanceText,
    osmAttribution: OSM_ATTRIBUTION,
    extras: CIRCUIT_EXTRAS[profile.circuitId] ?? {},
  };
}
