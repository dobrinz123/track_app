import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SqlSessionRepository,
  buildTestLoopCircuit,
  runSessionPipeline,
  type SqlDatabase,
  type TestLoopCircuit,
} from '@circuit/core';

import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateLearnedCircuitSchema } from '../../src/persistence/learnedCircuitSchema';
import { SqlLearnedCircuitStore } from '../../src/session/learnedCircuitStore';
import { rectangleLoopSamples } from '../support/testLoopTraces';

/**
 * Ticket P5d T4/T6 -- a learned circuit is only a circuit if it comes back
 * after the app is closed. These tests use the REAL sql.js database and the
 * REAL core encoder, and "restart" by building a second store over the same
 * database file, exactly as a cold launch does.
 */

function learn(circuitId: string, displayName: string): TestLoopCircuit {
  const result = buildTestLoopCircuit(rectangleLoopSamples({ laps: 2 }), {
    circuitId,
    displayName,
    createdAtUtc: '2026-08-31T09:00:00.000Z',
  });
  if (!result.ok) throw new Error(`fixture did not learn a loop: ${result.reason}`);
  return result;
}

describe('SqlLearnedCircuitStore (P5d T4, T6)', () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    await migrateLearnedCircuitSchema(db);
  });

  it('saves a learned circuit and reads it back after a restart', async () => {
    const store = new SqlLearnedCircuitStore(db);
    await store.refresh();
    const circuit = learn('learned-1', 'Bucla de acasă');
    await store.put({ profile: circuit.profile, corners: circuit.corners, saved: true });

    const restarted = new SqlLearnedCircuitStore(db);
    await restarted.refresh();

    const entry = restarted.get('learned-1');
    expect(entry).not.toBeNull();
    expect(entry!.record.displayName).toBe('Bucla de acasă');
    expect(entry!.record.saved).toBe(true);
    expect(entry!.profile.geometryStatus).toBe('ad-hoc');
    expect(entry!.corners).toEqual(circuit.corners);
    // The runtime companion is rebuilt from the stored geometry, not stored.
    expect(entry!.runtime.centerline.length).toBe(circuit.profile.centerline.length);
    expect(restarted.saved().map((record) => record.circuitId)).toEqual(['learned-1']);
  });

  it('keeps an UNSAVED test loop for its own session, but out of the circuit list', async () => {
    const store = new SqlLearnedCircuitStore(db);
    await store.refresh();
    const circuit = learn('learned-unsaved', 'Test loop');
    await store.put({ profile: circuit.profile, corners: circuit.corners, saved: false });

    const restarted = new SqlLearnedCircuitStore(db);
    await restarted.refresh();

    expect(restarted.get('learned-unsaved')).not.toBeNull();
    expect(restarted.saved()).toEqual([]);
    expect(restarted.entries().map((entry) => entry.record.circuitId)).toEqual([
      'learned-unsaved',
    ]);
  });

  it('promotes an unsaved loop to a named, listed circuit', async () => {
    const store = new SqlLearnedCircuitStore(db);
    await store.refresh();
    const circuit = learn('learned-2', 'Test loop');
    await store.put({ profile: circuit.profile, corners: circuit.corners, saved: false });

    const promoted = await store.markSaved('learned-2', 'Cartierul meu');
    expect(promoted).toBe(true);

    const restarted = new SqlLearnedCircuitStore(db);
    await restarted.refresh();
    expect(restarted.saved().map((record) => record.displayName)).toEqual(['Cartierul meu']);
    expect(restarted.get('learned-2')!.profile.displayName).toBe('Cartierul meu');
  });

  it('REFUSES to delete a learned circuit that still has sessions (the sessions are the reason it exists)', async () => {
    const store = new SqlLearnedCircuitStore(db);
    await store.refresh();
    const circuit = learn('learned-3', 'Bucla');
    await store.put({ profile: circuit.profile, corners: circuit.corners, saved: true });
    await db.runAsync(
      'INSERT INTO sessions (sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc) VALUES (?, ?, ?, ?, ?, ?)',
      ['s1', 'local', 'learned-3', 'learned', 1, '2026-08-31T10:00:00.000Z'],
    );

    const refused = await store.remove('learned-3');
    expect(refused).toEqual({ ok: false, reason: 'has-sessions', sessionCount: 1 });
    expect(store.get('learned-3')).not.toBeNull();

    await db.runAsync('DELETE FROM sessions WHERE circuitId = ?', ['learned-3']);
    const removed = await store.remove('learned-3');
    expect(removed).toEqual({ ok: true });
    expect(store.get('learned-3')).toBeNull();
  });

  it('a session on the STORED geometry detects laps through the production pipeline (T6)', async () => {
    const store = new SqlLearnedCircuitStore(db);
    await store.refresh();
    const circuit = learn('learned-laps', 'Bucla');
    await store.put({ profile: circuit.profile, corners: circuit.corners, saved: true });

    const reloaded = new SqlLearnedCircuitStore(db);
    await reloaded.refresh();
    const entry = reloaded.get('learned-laps');
    expect(entry).not.toBeNull();

    // Four laps of the same loop, timed against the geometry as it came back
    // OUT of the database -- not the in-memory one it went in as.
    const result = runSessionPipeline(entry!.runtime, rectangleLoopSamples({ laps: 4 }), {
      corridorWidthM: entry!.profile.corridorWidthM,
      calibrateFirst: rectangleLoopSamples({ laps: 2 }),
      endSession: true,
    });

    expect(result.laps.length).toBeGreaterThanOrEqual(2);
    for (const lap of result.laps) {
      // ~677 m at 8-16 m/s is a lap of roughly a minute.
      expect(lap.durationMs).toBeGreaterThan(30_000);
      expect(lap.durationMs).toBeLessThan(120_000);
    }
  });

  it('skips a corrupt row instead of failing the whole catalog', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new SqlLearnedCircuitStore(db);
    await store.refresh();
    const circuit = learn('learned-good', 'Good');
    await store.put({ profile: circuit.profile, corners: circuit.corners, saved: true });
    await db.runAsync(
      'INSERT INTO learned_circuits (circuit_id, display_name, payload, length_m, corner_count, created_at_utc, saved) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['learned-bad', 'Bad', '{not json', 100, 1, '2026-08-31T10:00:00.000Z', 1],
    );

    const restarted = new SqlLearnedCircuitStore(db);
    await restarted.refresh();

    expect(restarted.get('learned-good')).not.toBeNull();
    expect(restarted.get('learned-bad')).toBeNull();
    expect(restarted.invalidRowCount()).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * Ticket P5d-FIX1 H2 and item 10 (Codex P5d-REV1 HIGH 2 / LOW 10).
 */
describe('SqlLearnedCircuitStore -- hardening (P5d-FIX1 H2, item 10)', () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    await migrateLearnedCircuitSchema(db);
  });

  it('hands out FROZEN profiles: geometryStatus cannot be rewritten in place', async () => {
    const store = new SqlLearnedCircuitStore(db);
    await store.refresh();
    const circuit = learn('learned-frozen', 'Bucla');
    await store.put({ profile: circuit.profile, corners: circuit.corners, saved: true });

    const reloaded = new SqlLearnedCircuitStore(db);
    await reloaded.refresh();
    const entry = reloaded.get('learned-frozen');
    expect(entry).not.toBeNull();
    expect(Object.isFrozen(entry!.profile)).toBe(true);
    expect(() => {
      (entry!.profile as { geometryStatus: string }).geometryStatus = 'official';
    }).toThrow(TypeError);
    expect(entry!.profile.geometryStatus).toBe('ad-hoc');
  });

  it('refuses to insert over an id that is already taken, instead of replacing it', async () => {
    const store = new SqlLearnedCircuitStore(db);
    await store.refresh();
    const first = learn('learned-collision', 'Prima');
    await store.insert({ profile: first.profile, corners: first.corners, saved: true });

    const second = learn('learned-collision', 'A doua');
    const result = await store.insert({
      profile: second.profile,
      corners: second.corners,
      saved: false,
    });

    expect(result).toEqual({ ok: false, reason: 'id-taken' });
    // The circuit that held the id is untouched -- name, saved flag and all.
    const kept = store.get('learned-collision');
    expect(kept!.record.displayName).toBe('Prima');
    expect(kept!.record.saved).toBe(true);
  });

  it('inserts a genuinely new id normally', async () => {
    const store = new SqlLearnedCircuitStore(db);
    await store.refresh();
    const circuit = learn('learned-fresh', 'Nouă');

    expect(await store.insert({ profile: circuit.profile, corners: circuit.corners, saved: false })).toEqual(
      { ok: true },
    );
    expect(store.get('learned-fresh')).not.toBeNull();
  });
});
