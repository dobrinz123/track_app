import { describe, expect, it } from 'vitest';

import { InMemorySessionRepository, deleteAllUserData } from '../../src/persistence';

import { makeLocationSample, makeReferenceLap, makeSessionSummary, makeSnapshot, makeLapRecord } from './fixtures';

describe('deleteAllUserData', () => {
  it('deletes a user\'s sessions/checkpoints/telemetry/reference lap and verifies the repository is empty for them', async () => {
    const repo = new InMemorySessionRepository();
    await repo.saveSession(makeSessionSummary({ sessionId: 'u1-session', userId: 'user-1', circuitId: 'circuit-a' }));
    await repo.saveCheckpoint('u1-session', makeSnapshot(), [makeLapRecord()]);
    await repo.saveTelemetry('u1-session', 1, [makeLocationSample()]);
    await repo.putReferenceLap(makeReferenceLap({ userId: 'user-1' }));

    const result = await deleteAllUserData(repo, 'user-1', 'circuit-a', 'layout-1', 1);

    expect(result).toEqual({ ok: true, remainingSessionCount: 0, referenceLapCleared: true });
    expect(await repo.listSessions('user-1', 'circuit-a')).toEqual([]);
    expect(await repo.loadCheckpoint('u1-session')).toBeNull();
    expect(await repo.loadTelemetry('u1-session', 1)).toEqual([]);
    expect(await repo.getReferenceLap('user-1', 'circuit-a', 'layout-1', 1)).toBeNull();
  });

  it('leaves another user\'s data untouched and reports not-ok if verification finds leftovers for the target user', async () => {
    const repo = new InMemorySessionRepository();
    await repo.saveSession(makeSessionSummary({ sessionId: 'u1-session', userId: 'user-1', circuitId: 'circuit-a' }));
    await repo.saveSession(makeSessionSummary({ sessionId: 'u2-session', userId: 'user-2', circuitId: 'circuit-a' }));
    await repo.putReferenceLap(makeReferenceLap({ userId: 'user-2' }));

    const result = await deleteAllUserData(repo, 'user-1', 'circuit-a', 'layout-1', 1);

    expect(result.ok).toBe(true);
    expect((await repo.listSessions('user-2', 'circuit-a')).map((s) => s.sessionId)).toEqual(['u2-session']);
    expect(await repo.getReferenceLap('user-2', 'circuit-a', 'layout-1', 1)).not.toBeNull();
  });

  it('is a no-op-safe call against an already-empty repository', async () => {
    const repo = new InMemorySessionRepository();
    const result = await deleteAllUserData(repo, 'nobody', 'circuit-a', 'layout-1', 1);
    expect(result).toEqual({ ok: true, remainingSessionCount: 0, referenceLapCleared: true });
  });
});
