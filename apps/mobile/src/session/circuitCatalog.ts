import { summarize, type CircuitProfile, type RuntimeProfile } from '@circuit/core';
import { TMR_CIRCUIT_PROFILE, TMR_RUNTIME_PROFILE } from './tmrProfile';

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

/** Today's only entry: the bundled Transilvania Motor Ring profile (session/tmrProfile.ts). */
const ENTRIES: ReadonlyMap<string, { profile: CircuitProfile; runtime: RuntimeProfile }> = new Map([
  [TMR_CIRCUIT_PROFILE.circuitId, { profile: TMR_CIRCUIT_PROFILE, runtime: TMR_RUNTIME_PROFILE }],
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
