import { loadProfileFromJson, type CircuitProfile, type RuntimeProfile } from '@circuit/core';
// Static import (MUST DO #5, ADR-0004): Metro treats `.json` as a source
// extension (resolveJsonModule) and inlines this module's contents directly
// into the Hermes bundle at build time -- NOT a runtime `fetch`/`fs` read.
// `docs/decisions/ADR-0004-no-mac-ios-workflow.md`'s offline/static-bundle
// requirement depends on this being a real `import`, not a dynamic load; see
// the static-bundle proof in the WP14 integration report for the verified
// evidence that the asset is embedded.
import tmrProfileJson from '@circuit/core/assets/circuits/transilvania-motor-ring.v2.json';

/**
 * The one circuit this MVP supports (Transilvania Motor Ring), loaded
 * through the SAME validation path (`loadProfileFromJson`) every other
 * profile source uses -- `JSON.stringify` back to text is cheap and keeps
 * this a single, well-tested code path rather than a second
 * "trust the object" loader.
 */
function load(): { profile: CircuitProfile; runtime: RuntimeProfile } {
  const result = loadProfileFromJson(JSON.stringify(tmrProfileJson));
  if (!result.ok) {
    throw new Error(`Bundled Transilvania Motor Ring profile failed validation: ${result.errors.join(', ')}`);
  }
  return { profile: result.profile, runtime: result.runtime };
}

const loaded = load();

export const TMR_CIRCUIT_PROFILE: CircuitProfile = loaded.profile;
export const TMR_RUNTIME_PROFILE: RuntimeProfile = loaded.runtime;
