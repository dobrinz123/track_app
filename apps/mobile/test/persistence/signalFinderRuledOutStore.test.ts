import { describe, expect, it } from 'vitest';
import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateDidSweepSchema } from '../../src/persistence/didSweepSchema';
import {
  createInMemorySignalFinderRuledOutStore,
  createSignalFinderRuledOutStore,
  type SignalFinderRuledOutRecord,
  type SignalFinderRuledOutStore,
} from '../../src/persistence/didSweepStore';

/**
 * Ticket P4p G5 (binding, user request after field test 9): "the steering
 * finds re-tested the same known DIDs and found nothing -- never offer them
 * again". A DID that a COMPLETED find scored `unrelated` for a target is
 * ruled out FOR THAT TARGET, persisted, and excluded from later plans until
 * the user asks for a re-test.
 *
 * Additive table `signal_finder_ruled_out`, same discipline as
 * `vehicle_profile_bindings` (schema v4, `CREATE TABLE IF NOT EXISTS`, no
 * column added to an existing table, keyed so re-ruling the same DID
 * REPLACES rather than accumulates).
 */

function record(overrides: Partial<SignalFinderRuledOutRecord> = {}): SignalFinderRuledOutRecord {
  return {
    profileId: 'generic',
    targetId: 'steeringAngle',
    ecu: 0x12,
    did: 0x5422,
    verdict: 'unrelated',
    sessionId: 'signal-finder-1788176402317-rbjd9h',
    ruledOutAtUtc: '2026-08-31T11:41:13.062Z',
    ...overrides,
  };
}

function suite(name: string, make: () => Promise<SignalFinderRuledOutStore>): void {
  describe(`SignalFinderRuledOutStore (${name})`, () => {
    it('round-trips a ruled-out DID for its target', async () => {
      const store = await make();
      await store.addRuledOut([record()]);
      const rows = await store.listRuledOut('generic', 'steeringAngle');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ ecu: 0x12, did: 0x5422, verdict: 'unrelated', sessionId: 'signal-finder-1788176402317-rbjd9h' });
    });

    it('is PER TARGET -- a DID ruled out for steering is untouched for the brake', async () => {
      const store = await make();
      await store.addRuledOut([record()]);
      expect(await store.listRuledOut('generic', 'brakePressure')).toEqual([]);
    });

    it('is per profile -- the supra profile does not inherit the generic profile s exclusions', async () => {
      const store = await make();
      await store.addRuledOut([record()]);
      expect(await store.listRuledOut('toyota-supra-b58', 'steeringAngle')).toEqual([]);
    });

    it('ruling the same DID out twice replaces rather than accumulates', async () => {
      const store = await make();
      await store.addRuledOut([record()]);
      await store.addRuledOut([record({ sessionId: 'signal-finder-later', ruledOutAtUtc: '2026-09-01T09:00:00.000Z' })]);
      const rows = await store.listRuledOut('generic', 'steeringAngle');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sessionId).toBe('signal-finder-later');
    });

    it('clearRuledOut restores exactly one target s exclusions and nothing else', async () => {
      const store = await make();
      await store.addRuledOut([record(), record({ targetId: 'brakePressure', did: 0x4002 })]);
      await store.clearRuledOut('generic', 'steeringAngle');
      expect(await store.listRuledOut('generic', 'steeringAngle')).toEqual([]);
      expect(await store.listRuledOut('generic', 'brakePressure')).toHaveLength(1);
    });

    it('lists deterministically (ecu, then did)', async () => {
      const store = await make();
      await store.addRuledOut([
        record({ ecu: 0x29, did: 0x500c }),
        record({ ecu: 0x12, did: 0x5468 }),
        record({ ecu: 0x12, did: 0x5422 }),
      ]);
      expect((await store.listRuledOut('generic', 'steeringAngle')).map((row) => [row.ecu, row.did])).toEqual([
        [0x12, 0x5422],
        [0x12, 0x5468],
        [0x29, 0x500c],
      ]);
    });
  });
}

suite('in-memory', async () => createInMemorySignalFinderRuledOutStore());
suite('sql.js', async () => {
  const db = await createSqlJsDatabase();
  await migrateDidSweepSchema(db);
  return createSignalFinderRuledOutStore(db);
});

describe('createSignalFinderRuledOutStore', () => {
  it('falls back to the in-memory implementation with no database (web preview), like every other store here', async () => {
    const store = createSignalFinderRuledOutStore(null);
    await store.addRuledOut([record()]);
    expect(await store.listRuledOut('generic', 'steeringAngle')).toHaveLength(1);
  });
});
