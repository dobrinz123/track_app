import { loadProfileFromJson, summarize, type CircuitProfile, type RuntimeProfile } from '@circuit/core';
import { TMR_CIRCUIT_PROFILE, TMR_RUNTIME_PROFILE } from './tmrProfile';
// Static import (same contract as tmrProfile.ts, ADR-0004): Metro inlines this
// `.json` module into the Hermes bundle at build time -- NOT a runtime
// fetch/fs read. MotorPark has no observed-speeds overlay yet (TMR-only,
// Phase 3 coaching addendum), so this entry is profile+runtime only, exactly
// what `AppCircuitCatalog.get()` already returns.
import motorparkProfileJson from '@circuit/core/assets/circuits/motorpark-romania.v1.json';

/**
 * Display-oriented summary of a circuit for list/selection UI. Field set is
 * a fixed contract shared with the concurrent `@circuit/core`
 * `createCircuitCatalog` work package -- the foreman swaps the backing
 * implementation of `AppCircuitCatalog` at integration without touching
 * call sites, as long as this shape doesn't change.
 */
export interface CircuitSummary {
  circuitId: string;
  displayName: string;
  country: string;
  locality: string;
  lengthM: number;
  layoutId: string;
  layoutVersion: number;
  geometryStatus: string;
  sectorStatus: string;
}

export interface AppCircuitCatalog {
  list(): CircuitSummary[];
  get(circuitId: string): { profile: CircuitProfile; runtime: RuntimeProfile } | null;
}

/**
 * Bundled MotorPark România profile+runtime (ticket CN-W2), loaded through
 * the SAME validation path (`loadProfileFromJson`) as TMR above -- see
 * tmrProfile.ts's `load()` for the identical pattern this mirrors.
 */
function loadMotorPark(): { profile: CircuitProfile; runtime: RuntimeProfile } {
  const result = loadProfileFromJson(JSON.stringify(motorparkProfileJson));
  if (!result.ok) {
    throw new Error(`Bundled MotorPark profile failed validation: ${result.errors.join(', ')}`);
  }
  return { profile: result.profile, runtime: result.runtime };
}

const motorpark = loadMotorPark();
export const MOTORPARK_CIRCUIT_PROFILE: CircuitProfile = motorpark.profile;
export const MOTORPARK_RUNTIME_PROFILE: RuntimeProfile = motorpark.runtime;

/** Bundled circuits: Transilvania Motor Ring + MotorPark România (session/tmrProfile.ts, above). */
const ENTRIES: ReadonlyMap<string, { profile: CircuitProfile; runtime: RuntimeProfile }> = new Map([
  [TMR_CIRCUIT_PROFILE.circuitId, { profile: TMR_CIRCUIT_PROFILE, runtime: TMR_RUNTIME_PROFILE }],
  [MOTORPARK_CIRCUIT_PROFILE.circuitId, { profile: MOTORPARK_CIRCUIT_PROFILE, runtime: MOTORPARK_RUNTIME_PROFILE }],
]);

/**
 * Today's `AppCircuitCatalog` backing implementation -- the single bundled
 * TMR entry, wrapped in the multi-circuit-ready interface. NOT yet backed by
 * `@circuit/core`'s `createCircuitCatalog` (still landing on a concurrent
 * branch); this in-app implementation is deliberately swappable in place.
 */
export const circuitCatalog: AppCircuitCatalog = {
  list(): CircuitSummary[] {
    return Array.from(ENTRIES.values(), (entry) => summarize(entry.profile));
  },
  get(circuitId: string) {
    return ENTRIES.get(circuitId) ?? null;
  },
};
