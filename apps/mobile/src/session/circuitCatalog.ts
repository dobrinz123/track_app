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
  /**
   * Ticket P5d T6: where this circuit came from. `'bundled'` is a reviewed
   * asset that ships with the app; `'learned'` is geometry this device learned
   * from one lap of driving (`geometryStatus: 'ad-hoc'`). The selection list
   * labels the two differently -- a learned circuit must never look like a
   * surveyed one.
   */
  origin: 'bundled' | 'learned';
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
 * Since ticket P5d T6 it serves BUNDLED entries plus the learned registry
 * immediately below.
 */

/**
 * Ticket P5d T6 -- circuits this device LEARNED (Test Loop mode), registered
 * at bootstrap by `composition.ts` from `SqlLearnedCircuitStore`.
 *
 * Two visibilities, because a learned loop means two different things:
 *  - `listed: true`  -- the driver saved and named it, so it belongs in the
 *    selection list beside the bundled circuits (labelled as learned);
 *  - `listed: false` -- a one-off test loop, kept ONLY so its own session can
 *    still be resolved (history, analysis, replay) after a restart.
 * `get()` resolves BOTH; `list()` shows only the first kind.
 *
 * This registry is module state deliberately: the catalog is the single
 * lookup every screen, controller and analysis pass already goes through, so
 * a learned circuit becomes a first-class circuit by appearing here rather
 * than by every call site learning about a second source.
 */
export interface LearnedCatalogEntry {
  circuit: BundledCircuit;
  listed: boolean;
}

let learnedEntries: ReadonlyMap<string, LearnedCatalogEntry> = new Map();

/** Replaces the learned-circuit registry wholesale (bootstrap, and after every save/delete). */
export function setLearnedCircuits(entries: readonly LearnedCatalogEntry[]): void {
  const next = new Map<string, LearnedCatalogEntry>();
  for (const entry of entries) {
    // A bundled circuit id can never be shadowed by a learned one.
    if (ENTRIES.has(entry.circuit.profile.circuitId)) {
      console.warn(
        `[circuitCatalog] ignoring learned circuit "${entry.circuit.profile.circuitId}": that id is a bundled circuit`,
      );
      continue;
    }
    // P5d-FIX1 H2 (binding, Codex P5d-REV1 HIGH 2): a learned profile is
    // FROZEN before it enters the catalog, exactly like the bundled ones
    // (M15 above). `geometryStatus` is the single field the live-cue gate
    // (`testLoopGuards`) and the suggestion gate (`analysisAssembly`) read;
    // a mutable shared profile is one assignment away from turning ad-hoc
    // geometry into `official` for every screen at once. `buildTestLoopCircuit`
    // and the store decoder both freeze too -- this is the last of the three
    // doors, so no path into the catalog can leave one open.
    Object.freeze(entry.circuit.profile);
    next.set(entry.circuit.profile.circuitId, entry);
  }
  learnedEntries = next;
}

/** True when `circuitId` is a learned (ad-hoc) circuit rather than a bundled one. */
export function isLearnedCircuitId(circuitId: string): boolean {
  return learnedEntries.has(circuitId);
}

export const circuitCatalog: AppCircuitCatalog = {
  list(): CircuitSummary[] {
    const bundled = Array.from(ENTRIES.values(), (entry) => ({
      ...summarize(entry.profile),
      origin: 'bundled' as const,
    }));
    const learned = Array.from(learnedEntries.values())
      .filter((entry) => entry.listed)
      .map((entry) => ({ ...summarize(entry.circuit.profile), origin: 'learned' as const }));
    return [...bundled, ...learned];
  },
  get(circuitId: string) {
    return ENTRIES.get(circuitId) ?? learnedEntries.get(circuitId)?.circuit ?? null;
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
  // Ticket P5d T6: bundled OR learned -- a saved learned circuit is selectable
  // exactly like a bundled one, so this must resolve through the catalog
  // rather than the bundled map alone. (Without this the session controller
  // and history store for a learned circuit would silently be built for the
  // default circuit instead.)
  const entry = circuitCatalog.get(settings.selectedCircuitId);
  if (entry !== null) return entry;
  console.warn(
    `[circuitCatalog] resolveSelectedCircuit: unknown selectedCircuitId "${settings.selectedCircuitId}" -- falling back to ${TMR_CIRCUIT_PROFILE.circuitId}`,
  );
  return ENTRIES.get(TMR_CIRCUIT_PROFILE.circuitId)!;
}
