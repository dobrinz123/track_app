import type { ReferenceLap } from '../contracts';

// Structural validation only (the PB-replacement policy in docs/architecture/contracts.md
// "PB replacement rules" is enforced by the caller, not the repository). This guard exists
// so a malformed ReferenceLap can never reach storage: `putReferenceLap` must be all-or-nothing.
export function validateReferenceLap(ref: ReferenceLap): void {
  const { distanceGridM, elapsedMsAtGrid, durationMs } = ref;

  if (!Array.isArray(distanceGridM) || !Array.isArray(elapsedMsAtGrid)) {
    throw new Error('ReferenceLap.distanceGridM and elapsedMsAtGrid must both be arrays.');
  }

  if (distanceGridM.length !== elapsedMsAtGrid.length) {
    throw new Error(
      `ReferenceLap grid length mismatch: distanceGridM has ${distanceGridM.length} points, ` +
        `elapsedMsAtGrid has ${elapsedMsAtGrid.length}.`,
    );
  }

  if (distanceGridM.length < 2) {
    throw new Error(`ReferenceLap grid must have at least 2 points, got ${distanceGridM.length}.`);
  }

  for (let i = 1; i < elapsedMsAtGrid.length; i += 1) {
    const prev = elapsedMsAtGrid[i - 1] as number;
    const curr = elapsedMsAtGrid[i] as number;
    if (curr < prev) {
      throw new Error(
        `ReferenceLap.elapsedMsAtGrid must be non-decreasing; index ${i} (${curr}) < index ${i - 1} (${prev}).`,
      );
    }
  }

  if (!(durationMs > 0)) {
    throw new Error(`ReferenceLap.durationMs must be > 0, got ${durationMs}.`);
  }
}
