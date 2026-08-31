import {
  analyzeCorners,
  loadProfileFromJson,
  summarize,
  type CircuitProfile,
  type Corner,
  type RuntimeProfile,
} from '@circuit/core';
import { TMR_CIRCUIT_PROFILE, TMR_CORNERS, TMR_RUNTIME_PROFILE } from './tmrProfile';
import type { AppSettings } from './settingsStore';
// Static import (same contract as tmrProfile.ts, ADR-0004): Metro inlines this
// `.json` module into the Hermes bundle at build time -- NOT a runtime
// fetch/fs read.
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

/** A bundled circuit's full data -- profile, runtime companion, and its coaching corner set (ticket CN-W3, contracts.md's Multi-circuit selection addendum). */
export interface BundledCircuit {
  profile: CircuitProfile;
  runtime: RuntimeProfile;
  corners: Corner[];
}

export interface AppCircuitCatalog {
  list(): CircuitSummary[];
  get(circuitId: string): BundledCircuit | null;
}

/**
 * Bundled MotorPark România profile+runtime (ticket CN-W2), loaded through
 * the SAME validation path (`loadProfileFromJson`) as TMR above -- see
 * tmrProfile.ts's `load()` for the identical pattern this mirrors. Corners
 * are analyzed (ticket CN-W3) but MotorPark ships NO observed-speeds overlay
 * yet -- unlike TMR, its corner set stays purely model-derived (contracts.md:
 * "an observed-speeds overlay is applied ONLY when that circuit ships one").
 */
function loadMotorPark(): { profile: CircuitProfile; runtime: RuntimeProfile; corners: Corner[] } {
  const result = loadProfileFromJson(JSON.stringify(motorparkProfileJson));
  if (!result.ok) {
    throw new Error(`Bundled MotorPark profile failed validation: ${result.errors.join(', ')}`);
  }
  return { profile: result.profile, runtime: result.runtime, corners: analyzeCorners(result.runtime) };
}

const motorpark = loadMotorPark();
export const MOTORPARK_CIRCUIT_PROFILE: CircuitProfile = motorpark.profile;
export const MOTORPARK_RUNTIME_PROFILE: RuntimeProfile = motorpark.runtime;
export const MOTORPARK_CORNERS: Corner[] = motorpark.corners;

/**
 * M15 hardening (Codex P5c-REV2 finding 15, MEDIUM): freeze both bundled
 * profiles so `geometryStatus` -- the ONLY field the suggestion engine's
 * safety gate reads to decide whether a circuit's corner geometry may be
 * advised on at all (`analysisAssembly.ts`'s `context.geometryValidated`) --
 * can never be mutated IN PLACE once the catalog is built. These two objects
 * are the single shared source of truth every screen, controller and
 * analysis pass reads for the rest of the app's lifetime; nothing here ever
 * legitimately needs to flip that field at runtime -- the only sanctioned way
 * `geometryStatus` changes is a NEW, re-reviewed catalog asset at build time.
 * A caller that wants a DIFFERENT status for one scenario (the test suite's
 * `withValidatedGeometry`) builds its own spread COPY -- a distinct object
 * this freeze does not reach and was never meant to -- rather than editing
 * the shared singleton every other caller still trusts.
 */
Object.freeze(TMR_CIRCUIT_PROFILE);
Object.freeze(MOTORPARK_CIRCUIT_PROFILE);

/** Bundled circuits: Transilvania Motor Ring + MotorPark România (session/tmrProfile.ts, above). */
const ENTRIES: ReadonlyMap<string, BundledCircuit> = new Map([
  [TMR_CIRCUIT_PROFILE.circuitId, { profile: TMR_CIRCUIT_PROFILE, runtime: TMR_RUNTIME_PROFILE, corners: TMR_CORNERS }],
  [
    MOTORPARK_CIRCUIT_PROFILE.circuitId,
    { profile: MOTORPARK_CIRCUIT_PROFILE, runtime: MOTORPARK_RUNTIME_PROFILE, corners: MOTORPARK_CORNERS },
  ],
]);

/**
 * Today's `AppCircuitCatalog` backing implementation -- both bundled entries,
 * wrapped in the multi-circuit-ready interface. NOT yet backed by
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

/**
 * Resolves the app's ONE selected circuit (contracts.md's Multi-circuit
 * selection addendum) from persisted settings. An id that isn't in the
 * bundled catalog -- a stale/corrupt settings row, or a circuit removed from
 * a later catalog build -- falls back to TMR (the documented default) with a
 * `console.warn`, never a crash and never a fetch.
 */
export function resolveSelectedCircuit(settings: Pick<AppSettings, 'selectedCircuitId'>): BundledCircuit {
  const entry = ENTRIES.get(settings.selectedCircuitId);
  if (entry !== undefined) return entry;
  console.warn(
    `[circuitCatalog] resolveSelectedCircuit: unknown selectedCircuitId "${settings.selectedCircuitId}" -- falling back to ${TMR_CIRCUIT_PROFILE.circuitId}`,
  );
  return ENTRIES.get(TMR_CIRCUIT_PROFILE.circuitId)!;
}
