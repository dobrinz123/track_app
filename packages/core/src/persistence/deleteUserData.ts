import type { LocalSessionRepository } from '../contracts';

/**
 * Result of `deleteAllUserData` -- distinguishes "the repository call
 * completed" from "the repository is actually empty afterward" so a caller
 * (e.g. the mobile Settings screen, M3 fix) never shows a success banner
 * for a deletion that silently left data behind.
 */
export interface DeleteUserDataResult {
  ok: boolean;
  remainingSessionCount: number;
  referenceLapCleared: boolean;
}

/**
 * Wraps `LocalSessionRepository.deleteUserData` (already correctly
 * implemented by every repository -- see the persistence contract suite)
 * with a verify-empty check for the caller's own (circuitId, layoutId,
 * layoutVersion). This is the one piece that was missing end-to-end: the
 * app previously never called `deleteUserData` from any screen. Kept here,
 * not inline in the mobile facade, so it is unit-testable against
 * `InMemorySessionRepository` (the mobile UI itself is not unit-testable in
 * this repo).
 */
export async function deleteAllUserData(
  repository: LocalSessionRepository,
  userId: string,
  circuitId: string,
  layoutId: string,
  layoutVersion: number,
): Promise<DeleteUserDataResult> {
  await repository.deleteUserData(userId);

  const remainingSessions = await repository.listSessions(userId, circuitId);
  const referenceLap = await repository.getReferenceLap(userId, circuitId, layoutId, layoutVersion);

  return {
    ok: remainingSessions.length === 0 && referenceLap === null,
    remainingSessionCount: remainingSessions.length,
    referenceLapCleared: referenceLap === null,
  };
}
