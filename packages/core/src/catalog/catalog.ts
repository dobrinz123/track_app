import type { CircuitProfile } from '../contracts';
import { loadProfileFromJson, type RuntimeProfile } from '../profile';

export interface CircuitSummary {
  circuitId: string;
  displayName: string;
  country: string;
  locality: string;
  lengthM: number;
  layoutId: string;
  layoutVersion: number;
  geometryStatus: CircuitProfile['geometryStatus'];
  sectorStatus: CircuitProfile['sectorStatus'];
}

export interface CircuitCatalogEntry {
  raw: unknown;
}

export interface CircuitCatalogProfile {
  profile: CircuitProfile;
  runtime: RuntimeProfile;
}

export interface CircuitCatalog {
  /** Summaries keyed by circuitCatalogKey(circuitId, layoutId). */
  readonly summaries: Readonly<Record<string, CircuitSummary>>;
  list(): CircuitSummary[];
  /**
   * A circuit-only lookup succeeds when exactly one layout exists. Pass layoutId
   * to address a particular layout when a circuit has more than one.
   */
  get(circuitId: string, layoutId?: string): CircuitCatalogProfile | null;
}

export class CircuitCatalogError extends Error {
  readonly errors: readonly string[];

  constructor(errors: string[]) {
    super(`Invalid circuit catalog:\n${errors.map((error) => `- ${error}`).join('\n')}`);
    this.name = 'CircuitCatalogError';
    this.errors = errors;
  }
}

/**
 * Stable, collision-free catalog key for a circuit layout. JSON array encoding
 * keeps identifiers containing punctuation unambiguous.
 */
export function circuitCatalogKey(circuitId: string, layoutId: string): string {
  return JSON.stringify([circuitId, layoutId]);
}

export function summarize(profile: CircuitProfile): CircuitSummary {
  return {
    circuitId: profile.circuitId,
    displayName: profile.displayName,
    country: profile.country,
    locality: profile.locality,
    lengthM: profile.totalLengthM,
    layoutId: profile.layoutId,
    layoutVersion: profile.layoutVersion,
    geometryStatus: profile.geometryStatus,
    sectorStatus: profile.sectorStatus,
  };
}

function entryLabel(raw: unknown, index: number): string {
  if (typeof raw !== 'object' || raw === null) return `entry ${index}`;
  const candidate = raw as Record<string, unknown>;
  const circuitId = typeof candidate.circuitId === 'string' ? candidate.circuitId : undefined;
  const layoutId = typeof candidate.layoutId === 'string' ? candidate.layoutId : undefined;
  if (circuitId === undefined) return `entry ${index}`;
  return layoutId === undefined ? circuitId : `${circuitId}/${layoutId}`;
}

function serializeRaw(raw: unknown): string | null {
  try {
    const serialized = JSON.stringify(raw);
    return typeof serialized === 'string' ? serialized : null;
  } catch {
    return null;
  }
}

export function createCircuitCatalog(entries: CircuitCatalogEntry[]): CircuitCatalog {
  const errors: string[] = [];
  const profiles = new Map<string, CircuitCatalogProfile>();
  const keysByCircuit = new Map<string, string[]>();

  entries.forEach((entry, index) => {
    const label = entryLabel(entry.raw, index);
    const serialized = serializeRaw(entry.raw);
    const result =
      serialized === null
        ? { ok: false as const, errors: ['INVALID_JSON'] }
        : loadProfileFromJson(serialized);
    if (!result.ok) {
      errors.push(`${label}: ${result.errors.join(', ')}`);
      return;
    }

    const { circuitId, layoutId } = result.profile;
    const key = circuitCatalogKey(circuitId, layoutId);
    if (profiles.has(key)) {
      errors.push(`${circuitId}/${layoutId}: DUPLICATE_CIRCUIT_LAYOUT`);
      return;
    }

    profiles.set(key, { profile: result.profile, runtime: result.runtime });
    const circuitKeys = keysByCircuit.get(circuitId) ?? [];
    circuitKeys.push(key);
    keysByCircuit.set(circuitId, circuitKeys);
  });

  if (errors.length > 0) throw new CircuitCatalogError(errors);

  const summaries: Record<string, CircuitSummary> = {};
  for (const [key, value] of profiles) summaries[key] = summarize(value.profile);

  return {
    summaries,
    list: () =>
      Object.values(summaries).sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName) ||
          left.layoutId.localeCompare(right.layoutId),
      ),
    get: (circuitId, layoutId) => {
      if (layoutId !== undefined) {
        return profiles.get(circuitCatalogKey(circuitId, layoutId)) ?? null;
      }
      const circuitKeys = keysByCircuit.get(circuitId);
      if (circuitKeys?.length !== 1) return null;
      const key = circuitKeys[0];
      return key === undefined ? null : (profiles.get(key) ?? null);
    },
  };
}
