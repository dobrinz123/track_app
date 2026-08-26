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
  /** ONE attribution line built from `profile.source` alone (name/license/way id/retrievedAt) -- see `buildProvenanceText()`. Never the raw `confidenceNotes` text (L3 fix, ticket CN-FIX2). */
  provenanceText: string;
  osmAttribution: string;
  extras: { openedYear?: number; county?: string };
}

/** Extracts the OSM way id from a `source.url` of the form `.../way/<id>` -- the only place a bundled `CircuitProfile` actually carries one (`source` itself has no dedicated way-id field). `undefined` when the url is absent or doesn't match that shape. */
function extractWayId(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const match = /\/way\/(\d+)/.exec(url);
  return match?.[1];
}

/**
 * L3 fix (ticket CN-FIX2, binding): ONE attribution line built strictly from
 * the profile's own `source` fields (name · license · way id · retrieved
 * date) -- e.g. `© OpenStreetMap contributors · ODbL 1.0 · way 488429454 ·
 * retrieved 2026-08-06`. Deliberately never touches `confidenceNotes` (a
 * long, internal research note, not display copy) -- appending it verbatim
 * duplicated the attribution on screen and risked surfacing an un-negated
 * "official" from that free text.
 */
function buildProvenanceText(source: CircuitProfile['source']): string {
  const parts: string[] = [source.name];
  if (source.license !== undefined) parts.push(source.license);
  const wayId = extractWayId(source.url);
  if (wayId !== undefined) parts.push(`way ${wayId}`);
  if (source.retrievedAt !== undefined) parts.push(`retrieved ${source.retrievedAt}`);
  return parts.join(' · ');
}

/**
 * L2 fix (ticket CN-FIX2, binding): neutral display label for a raw
 * `geometryStatus`/`sectorStatus` value -- the raw status string itself,
 * hyphens spaced for readability (e.g. `'community-derived'` ->
 * `'community derived'`). Deliberately NEVER substitutes a bespoke,
 * capitalized "Official" label for it (contracts.md: no render branch may
 * ever display "Official" as a status, even for a hypothetical future
 * circuit whose profile literally carries `geometryStatus`/`sectorStatus
 * === 'official'`) -- replaces `CircuitDetailScreen`'s old
 * `status === 'official' ? 'Official' : '...'` ternary.
 */
export function statusLabel(status: string): string {
  return status.replace(/-/g, ' ');
}

/**
 * Builds `CircuitDetailScreen`'s display metadata from a real bundled
 * `CircuitProfile` -- geometry, provenance, and status fields are all read
 * from the profile itself, never fabricated (ADR-0002/ADR-0004). Replaces
 * the old hardcoded `TRANSILVANIA_MOTOR_RING` constant (ticket CN-W3) so the
 * detail screen renders whichever circuit the catalog resolves, not only TMR.
 */
export function circuitDisplayData(profile: CircuitProfile): CircuitDisplayData {
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
    provenanceText: buildProvenanceText(profile.source),
    osmAttribution: OSM_ATTRIBUTION,
    extras: CIRCUIT_EXTRAS[profile.circuitId] ?? {},
  };
}
