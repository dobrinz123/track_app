import {
  analyzeCorners,
  applyObservedSpeeds,
  loadObservedSpeedsFromJson,
  loadProfileFromJson,
  type CircuitProfile,
  type Corner,
  type RuntimeProfile,
} from '@circuit/core';
// Static import (MUST DO #5, ADR-0004): Metro treats `.json` as a source
// extension (resolveJsonModule) and inlines this module's contents directly
// into the Hermes bundle at build time -- NOT a runtime `fetch`/`fs` read.
// `docs/decisions/ADR-0004-no-mac-ios-workflow.md`'s offline/static-bundle
// requirement depends on this being a real `import`, not a dynamic load; see
// the static-bundle proof in the WP14 integration report for the verified
// evidence that the asset is embedded.
import tmrProfileJson from '@circuit/core/assets/circuits/transilvania-motor-ring.v2.json';
// Same static-import contract as the profile above -- the Phase 3 coaching
// addendum's user-supplied onboard apex-speed observations (advisory,
// unofficial; see the asset's own `provenance` block), validated through
// `loadObservedSpeedsFromJson` against the ACTUAL analyzed corner set below
// before being applied, never trusted as a raw object.
import tmrObservedSpeedsJson from '@circuit/core/assets/circuits/transilvania-motor-ring.observed-speeds.v1.json';

/**
 * The one circuit this MVP supports (Transilvania Motor Ring), loaded
 * through the SAME validation path (`loadProfileFromJson`) every other
 * profile source uses -- `JSON.stringify` back to text is cheap and keeps
 * this a single, well-tested code path rather than a second
 * "trust the object" loader.
 *
 * Corners (Phase 3 coaching addendum) are analyzed from the validated
 * runtime ONCE here -- not per-session in `composition.ts` -- and the
 * observed-speeds overlay is applied through the same validate-before-trust
 * pattern as the profile itself (`loadObservedSpeedsFromJson` re-parses the
 * statically-imported JSON as text and checks every `cornerId` against this
 * exact analyzed set before `applyObservedSpeeds` uses it).
 */
function load(): { profile: CircuitProfile; runtime: RuntimeProfile; corners: Corner[] } {
  const result = loadProfileFromJson(JSON.stringify(tmrProfileJson));
  if (!result.ok) {
    throw new Error(`Bundled Transilvania Motor Ring profile failed validation: ${result.errors.join(', ')}`);
  }
  const analyzed = analyzeCorners(result.runtime);
  const observed = loadObservedSpeedsFromJson(JSON.stringify(tmrObservedSpeedsJson), analyzed);
  const corners = applyObservedSpeeds(analyzed, observed.observations);
  return { profile: result.profile, runtime: result.runtime, corners };
}

const loaded = load();

export const TMR_CIRCUIT_PROFILE: CircuitProfile = loaded.profile;
export const TMR_RUNTIME_PROFILE: RuntimeProfile = loaded.runtime;
/** Phase 3 coaching addendum: the TMR corner set (model-derived, overlaid with observed apex speeds where available) every `SessionController` built by `composition.ts` is configured with when `settings.coachingEnabled` is true. */
export const TMR_CORNERS: Corner[] = loaded.corners;
