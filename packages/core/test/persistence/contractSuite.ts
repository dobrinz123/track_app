import { beforeEach, describe, expect, it } from 'vitest';
import type { LocalSessionRepository } from '../../src/contracts';
import { makeLocationSample, makeReferenceLap, makeSessionSummary, makeSnapshot, makeLapRecord } from './fixtures';

/**
 * Shared behavioral contract for every `LocalSessionRepository`
 * implementation. This is the semantic reference extracted from what was
 * `inMemorySessionRepository.test.ts`: every assertion that previously ran
 * only against `InMemorySessionRepository` now runs, verbatim, against any
 * repository `makeRepo` constructs (currently: InMemorySessionRepository and
 * SqlSessionRepository(sql.js) -- see
 * packages/core/test/persistence-sql/sqlSessionRepository.contract.test.ts).
 *
 * `makeRepo` is called fresh in a `beforeEach`, so implementations that need
 * async setup (e.g. opening/migrating a database) are fully supported and
 * every test starts from an empty store.
 */
export function runRepositoryContractTests(name: string, makeRepo: () => Promise<LocalSessionRepository>): void {
  describe(`${name} - reference laps`, () => {
    let repo: LocalSessionRepository;
    beforeEach(async () => {
      repo = await makeRepo();
    });

    it('putReferenceLap / getReferenceLap round-trips by exact key', async () => {
      const ref = makeReferenceLap();
      await repo.putReferenceLap(ref);
      const loaded = await repo.getReferenceLap(ref.userId, ref.circuitId, ref.layoutId, ref.layoutVersion);
      expect(loaded).toEqual(ref);
    });

    it('getReferenceLap returns null for unknown key', async () => {
      const loaded = await repo.getReferenceLap('nobody', 'nowhere', 'nolayout', 1);
      expect(loaded).toBeNull();
    });

    it('putReferenceLap atomically full-replaces the value at the same composite key', async () => {
      const first = makeReferenceLap({ durationMs: 90_000 });
      const second = makeReferenceLap({
        durationMs: 85_000,
        distanceGridM: [0, 50, 100],
        elapsedMsAtGrid: [0, 40_000, 85_000],
      });
      await repo.putReferenceLap(first);
      await repo.putReferenceLap(second);
      const loaded = await repo.getReferenceLap(second.userId, second.circuitId, second.layoutId, second.layoutVersion);
      expect(loaded).toEqual(second);
    });

    it('putReferenceLap keyed by (userId, circuitId, layoutId, layoutVersion) does not collide across distinct keys', async () => {
      const a = makeReferenceLap({ userId: 'user-1', durationMs: 90_000 });
      const b = makeReferenceLap({ userId: 'user-2', durationMs: 80_000 });
      const c = makeReferenceLap({ layoutVersion: 2, durationMs: 70_000 });
      await repo.putReferenceLap(a);
      await repo.putReferenceLap(b);
      await repo.putReferenceLap(c);

      expect(await repo.getReferenceLap('user-1', 'circuit-a', 'layout-1', 1)).toEqual(a);
      expect(await repo.getReferenceLap('user-2', 'circuit-a', 'layout-1', 1)).toEqual(b);
      expect(await repo.getReferenceLap('user-1', 'circuit-a', 'layout-1', 2)).toEqual(c);
    });

    it('getReferenceLap returns a deep copy: mutating the result does not affect the store', async () => {
      const ref = makeReferenceLap();
      await repo.putReferenceLap(ref);

      const loaded = await repo.getReferenceLap(ref.userId, ref.circuitId, ref.layoutId, ref.layoutVersion);
      expect(loaded).not.toBeNull();
      loaded!.durationMs = 1;
      loaded!.distanceGridM.push(9999);
      loaded!.sectorTimes[0]!.durationMs = -1;

      const reloaded = await repo.getReferenceLap(ref.userId, ref.circuitId, ref.layoutId, ref.layoutVersion);
      expect(reloaded).toEqual(ref);
      expect(reloaded?.durationMs).toBe(90_000);
      expect(reloaded?.distanceGridM).toEqual([0, 100, 200]);
    });

    it('putReferenceLap mutating the input object after the call does not affect the store', async () => {
      const ref = makeReferenceLap();
      await repo.putReferenceLap(ref);
      ref.durationMs = 1;
      ref.distanceGridM.push(12345);

      const loaded = await repo.getReferenceLap(ref.userId, ref.circuitId, ref.layoutId, ref.layoutVersion);
      expect(loaded?.durationMs).toBe(90_000);
      expect(loaded?.distanceGridM).toEqual([0, 100, 200]);
    });

    describe('structural validation rejects invalid ReferenceLap without corrupting the store', () => {
      it('rejects mismatched distanceGridM / elapsedMsAtGrid lengths', async () => {
        const bad = makeReferenceLap({ distanceGridM: [0, 100, 200], elapsedMsAtGrid: [0, 100] });
        await expect(repo.putReferenceLap(bad)).rejects.toThrow(Error);
      });

      it('rejects grids shorter than 2 points', async () => {
        const bad = makeReferenceLap({ distanceGridM: [0], elapsedMsAtGrid: [0] });
        await expect(repo.putReferenceLap(bad)).rejects.toThrow(Error);
      });

      it('rejects a decreasing elapsedMsAtGrid sequence', async () => {
        const bad = makeReferenceLap({ distanceGridM: [0, 100, 200], elapsedMsAtGrid: [0, 50_000, 40_000] });
        await expect(repo.putReferenceLap(bad)).rejects.toThrow(Error);
      });

      it('rejects durationMs <= 0', async () => {
        const bad = makeReferenceLap({ durationMs: 0 });
        await expect(repo.putReferenceLap(bad)).rejects.toThrow(Error);
      });

      it('a rejected put never overwrites a previously-stored valid reference lap', async () => {
        const good = makeReferenceLap({ durationMs: 90_000 });
        await repo.putReferenceLap(good);

        const bad = makeReferenceLap({ durationMs: -1 });
        await expect(repo.putReferenceLap(bad)).rejects.toThrow(Error);

        const loaded = await repo.getReferenceLap(good.userId, good.circuitId, good.layoutId, good.layoutVersion);
        expect(loaded).toEqual(good);
      });
    });
  });

  describe(`${name} - checkpoints`, () => {
    let repo: LocalSessionRepository;
    beforeEach(async () => {
      repo = await makeRepo();
    });

    it('loadCheckpoint returns null when nothing was saved', async () => {
      expect(await repo.loadCheckpoint('session-x')).toBeNull();
    });

    it('loadCheckpoint returns the latest checkpoint saved per sessionId', async () => {
      await repo.saveCheckpoint('session-1', makeSnapshot({ lapNumber: 1 }), [makeLapRecord({ lapNumber: 1 })]);
      await repo.saveCheckpoint('session-1', makeSnapshot({ lapNumber: 2 }), [
        makeLapRecord({ lapNumber: 1 }),
        makeLapRecord({ lapNumber: 2 }),
      ]);

      const loaded = await repo.loadCheckpoint('session-1');
      expect(loaded?.snapshot.lapNumber).toBe(2);
      expect(loaded?.laps).toHaveLength(2);
    });

    it('checkpoints for different sessionIds do not collide', async () => {
      await repo.saveCheckpoint('session-1', makeSnapshot({ lapNumber: 1 }), []);
      await repo.saveCheckpoint('session-2', makeSnapshot({ lapNumber: 5 }), []);

      expect((await repo.loadCheckpoint('session-1'))?.snapshot.lapNumber).toBe(1);
      expect((await repo.loadCheckpoint('session-2'))?.snapshot.lapNumber).toBe(5);
    });

    it('loadCheckpoint returns a deep copy that cannot be mutated back into the store', async () => {
      await repo.saveCheckpoint('session-1', makeSnapshot(), [makeLapRecord()]);

      const loaded = await repo.loadCheckpoint('session-1');
      expect(loaded).not.toBeNull();
      loaded!.snapshot.lapNumber = 999;
      loaded!.laps.push(makeLapRecord({ lapNumber: 42 }));

      const reloaded = await repo.loadCheckpoint('session-1');
      expect(reloaded?.snapshot.lapNumber).toBe(1);
      expect(reloaded?.laps).toHaveLength(1);
    });

    it('rejects a snapshot containing a function (not JSON-serializable)', async () => {
      const snapshot = makeSnapshot({ context: { cb: () => 1 } });
      await expect(repo.saveCheckpoint('session-1', snapshot, [])).rejects.toThrow(Error);
      expect(await repo.loadCheckpoint('session-1')).toBeNull();
    });

    it('rejects a snapshot containing an explicit undefined value', async () => {
      const snapshot = makeSnapshot({ context: { missing: undefined } });
      await expect(repo.saveCheckpoint('session-1', snapshot, [])).rejects.toThrow(Error);
    });

    it('rejects laps containing an array hole', async () => {
      // Deliberately sparse: index 1 is left unset (a "hole"), which JSON.stringify
      // would silently turn into `null`. Built via new Array(...) + assignment
      // rather than an elided array literal (`[a, , b]`) to avoid the
      // no-sparse-arrays lint rule while still producing a real hole.
      const laps: ReturnType<typeof makeLapRecord>[] = new Array(3);
      laps[0] = makeLapRecord();
      laps[2] = makeLapRecord({ lapNumber: 3 });
      await expect(repo.saveCheckpoint('session-1', makeSnapshot(), laps)).rejects.toThrow(Error);
    });
  });

  describe(`${name} - telemetry`, () => {
    let repo: LocalSessionRepository;
    beforeEach(async () => {
      repo = await makeRepo();
    });

    it('loadTelemetry returns an empty array when nothing was saved', async () => {
      expect(await repo.loadTelemetry('session-1', 1)).toEqual([]);
    });

    it('a second saveTelemetry for the same (sessionId, lapNumber) REPLACES, it does not append', async () => {
      await repo.saveTelemetry('session-1', 1, [makeLocationSample({ tMono: 1 }), makeLocationSample({ tMono: 2 })]);
      await repo.saveTelemetry('session-1', 1, [makeLocationSample({ tMono: 100 })]);

      const loaded = await repo.loadTelemetry('session-1', 1);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.tMono).toBe(100);
    });

    it('telemetry is keyed independently per (sessionId, lapNumber)', async () => {
      await repo.saveTelemetry('session-1', 1, [makeLocationSample({ tMono: 1 })]);
      await repo.saveTelemetry('session-1', 2, [makeLocationSample({ tMono: 2 }), makeLocationSample({ tMono: 3 })]);
      await repo.saveTelemetry('session-2', 1, [makeLocationSample({ tMono: 9 })]);

      expect(await repo.loadTelemetry('session-1', 1)).toHaveLength(1);
      expect(await repo.loadTelemetry('session-1', 2)).toHaveLength(2);
      expect(await repo.loadTelemetry('session-2', 1)).toHaveLength(1);
    });

    it('loadTelemetry returns a deep copy', async () => {
      await repo.saveTelemetry('session-1', 1, [makeLocationSample({ tMono: 1 })]);
      const loaded = await repo.loadTelemetry('session-1', 1);
      loaded.push(makeLocationSample({ tMono: 2 }));

      expect(await repo.loadTelemetry('session-1', 1)).toHaveLength(1);
    });
  });

  describe(`${name} - sessions`, () => {
    let repo: LocalSessionRepository;
    beforeEach(async () => {
      repo = await makeRepo();
    });

    it('listSessions filters by userId and circuitId', async () => {
      await repo.saveSession(makeSessionSummary({ sessionId: 's1', userId: 'user-1', circuitId: 'circuit-a' }));
      await repo.saveSession(makeSessionSummary({ sessionId: 's2', userId: 'user-1', circuitId: 'circuit-b' }));
      await repo.saveSession(makeSessionSummary({ sessionId: 's3', userId: 'user-2', circuitId: 'circuit-a' }));

      const results = await repo.listSessions('user-1', 'circuit-a');
      expect(results.map((s) => s.sessionId)).toEqual(['s1']);
    });

    it('listSessions sorts by startedAtUtc descending', async () => {
      await repo.saveSession(
        makeSessionSummary({
          sessionId: 'oldest',
          userId: 'user-1',
          circuitId: 'circuit-a',
          startedAtUtc: '2024-01-01T00:00:00.000Z',
        }),
      );
      await repo.saveSession(
        makeSessionSummary({
          sessionId: 'newest',
          userId: 'user-1',
          circuitId: 'circuit-a',
          startedAtUtc: '2024-03-01T00:00:00.000Z',
        }),
      );
      await repo.saveSession(
        makeSessionSummary({
          sessionId: 'middle',
          userId: 'user-1',
          circuitId: 'circuit-a',
          startedAtUtc: '2024-02-01T00:00:00.000Z',
        }),
      );

      const results = await repo.listSessions('user-1', 'circuit-a');
      expect(results.map((s) => s.sessionId)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('listSessions returns deep copies', async () => {
      await repo.saveSession(makeSessionSummary({ sessionId: 's1' }));
      const results = await repo.listSessions('user-1', 'circuit-a');
      results[0]!.laps.push(makeLapRecord({ lapNumber: 999 }));

      const reloaded = await repo.listSessions('user-1', 'circuit-a');
      expect(reloaded[0]?.laps).toHaveLength(1);
    });
  });

  describe(`${name} - deleteUserData`, () => {
    let repo: LocalSessionRepository;
    beforeEach(async () => {
      repo = await makeRepo();
    });

    it('removes only the target user sessions, telemetry, checkpoints, and reference laps', async () => {
      // user-1 data
      await repo.saveSession(makeSessionSummary({ sessionId: 'u1-session', userId: 'user-1', circuitId: 'circuit-a' }));
      await repo.saveCheckpoint('u1-session', makeSnapshot(), [makeLapRecord()]);
      await repo.saveTelemetry('u1-session', 1, [makeLocationSample()]);
      await repo.putReferenceLap(makeReferenceLap({ userId: 'user-1' }));

      // user-2 data
      await repo.saveSession(makeSessionSummary({ sessionId: 'u2-session', userId: 'user-2', circuitId: 'circuit-a' }));
      await repo.saveCheckpoint('u2-session', makeSnapshot(), [makeLapRecord()]);
      await repo.saveTelemetry('u2-session', 1, [makeLocationSample()]);
      await repo.putReferenceLap(makeReferenceLap({ userId: 'user-2' }));

      await repo.deleteUserData('user-1');

      // user-1 data gone
      expect(await repo.listSessions('user-1', 'circuit-a')).toEqual([]);
      expect(await repo.loadCheckpoint('u1-session')).toBeNull();
      expect(await repo.loadTelemetry('u1-session', 1)).toEqual([]);
      expect(await repo.getReferenceLap('user-1', 'circuit-a', 'layout-1', 1)).toBeNull();

      // user-2 data untouched
      expect((await repo.listSessions('user-2', 'circuit-a')).map((s) => s.sessionId)).toEqual(['u2-session']);
      expect(await repo.loadCheckpoint('u2-session')).not.toBeNull();
      expect(await repo.loadTelemetry('u2-session', 1)).toHaveLength(1);
      expect(await repo.getReferenceLap('user-2', 'circuit-a', 'layout-1', 1)).not.toBeNull();
    });

    // NOTE: sweeping orphan checkpoints/telemetry for sessionIds minted as
    // `${userId}--<random>` that were never saved via saveSession is a
    // SqlSessionRepository-specific strengthening (see the ticket's WP11a
    // concern) that InMemorySessionRepository does not implement -- covered
    // as a SQL-only test in
    // test/persistence-sql/sqlSessionRepository.contract.test.ts, not here,
    // so this shared suite keeps passing unmodified against both
    // implementations.
  });
}
