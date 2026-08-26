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
 * Neutral display label for a raw `geometryStatus`/`sectorStatus` value.
 *
 * L2 fix (ticket CN-FIX2, binding): never a bespoke "Official" claim.
 * N6 fix (ticket CN-FIX3, contracts.md's lifecycle lock amendment, binding):
 * the schema-permitted value `'official'` (`packages/core/src/contracts.ts`)
 * previously rendered as the bare word "official" -- a claim the app cannot
 * make for ANY bundled profile, since it never verifies geometry itself. It
 * maps to the neutral "Source-declared" instead: the SOURCE says so, the app
 * does not. Every other value keeps its own words verbatim.
 *
 * Presentation (LEAD field-feedback addendum to CN-FIX3, binding): labels are
 * capitalized and keep their hyphen -- `'community-derived'` ->
 * "Community-derived", `'app-defined'` -> "App-defined" -- restoring the
 * pre-CN-FIX2 rendering that the raw lowercase/hyphen-spaced version
 * regressed. An unknown future value simply gets its first letter
 * capitalized, hyphens intact.
 */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  official: 'Source-declared',
  'community-derived': 'Community-derived',
  'app-defined': 'App-defined',
  'dev-only': 'Dev-only',
};

export function statusLabel(status: string): string {
  const mapped = STATUS_LABELS[status];
  if (mapped !== undefined) return mapped;
  return status.length === 0 ? status : `${status[0]!.toUpperCase()}${status.slice(1)}`;
}

/**
 * Friendly display label for a raw `layoutId` (ticket CN-FIX3b, user
 * decision). The ID ITSELF is untouched everywhere it actually matters --
 * bundled profile data, `circuitCatalog`/`summarize()`'s `CircuitSummary`,
 * and every PB/history storage key (`SqlSessionHistoryStore` is keyed on
 * `layoutId`+`layoutVersion`) -- this is purely how it READS on screen:
 * "main" and "full" are internal slugs, not words a driver should be shown.
 *
 * `'main'` -> "Main layout"; `'full'` -> "Full circuit"; anything else keeps
 * its own id with the first letter capitalized plus " layout"
 * (`'ring-1'` -> "Ring-1 layout"), so a future bundled layout renders
 * sensibly with no code change here.
 */
const LAYOUT_LABELS: Readonly<Record<string, string>> = {
  main: 'Main layout',
  full: 'Full circuit',
};

export function layoutLabel(layoutId: string): string {
  const mapped = LAYOUT_LABELS[layoutId];
  if (mapped !== undefined) return mapped;
  if (layoutId.length === 0) return '';
  return `${layoutId[0]!.toUpperCase()}${layoutId.slice(1)} layout`;
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
