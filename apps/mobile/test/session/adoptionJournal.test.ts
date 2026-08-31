import { beforeEach, describe, expect, it } from 'vitest';
import { SqlSessionRepository, type SqlDatabase } from '@circuit/core';

import { createSqlJsDatabase } from '../support/sqlJsDatabase';
import { migrateTelemetrySchema } from '../../src/persistence/telemetrySchema';
import {
  MAX_ADOPTION_REPAIR_ATTEMPTS,
  claimAdoptionJournal,
  clearClaimedJournal,
  deleteOrphanSession,
  newJournalId,
  readAdoptionJournal,
  writeAdoptionJournal,
} from '../../src/session/adoptionJournal';

/**
 * Ticket P5d-FIX4 G1 and G3 (Codex P5d-REV4).
 *
 * G1: the journal carries a UUID, and repairing it is a CLAIM -- exactly one
 *     launch wins, a launch that lost does nothing, and no launch may ever
 *     clear a journal that is not the one it claimed.
 * G3: rolling an orphan session back DELETES it -- session row, checkpoint,
 *     laps and telemetry, in one transaction -- rather than leaving a
 *     completed-looking session nobody drove.
 */
describe('adoption journal claim (P5d-FIX4 G1)', () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    await migrateTelemetrySchema(db);
    await writeAdoptionJournal(db, {
      id: newJournalId(),
      circuitId: 'learned-1',
      stage: 'stored',
      attempts: 0,
    });
  });

  it('gives a RACING claim to exactly one launch', async () => {
    // Two launches that read the same row and then both try to claim it: the
    // compare-and-swap is on that row, so the second one loses.
    const before = await readAdoptionJournal(db);
    expect(before).not.toBeNull();
    const first = await claimAdoptionJournal(db, 'launch-a');
    expect(first).not.toBeNull();
    expect(first!.journal.claimedBy).toBe('launch-a');
    expect(first!.journal.attempts).toBe(1);

    // The loser still holds the row it read, and may not clear it.
    const staleClaim = {
      journal: before!,
      serialized: JSON.stringify(before),
      exhausted: false,
    };
    expect(await clearClaimedJournal(db, staleClaim)).toBe(false);
    expect(await readAdoptionJournal(db)).not.toBeNull();

    // A LATER launch may take the repair over -- that is what the attempt
    // counter is for -- but it is attempt two, not a fresh start.
    const later = await claimAdoptionJournal(db, 'launch-b');
    expect(later!.journal.attempts).toBe(2);
    expect(later!.journal.claimedBy).toBe('launch-b');
  });

  it('counts every attempt, and stops offering the journal after the last one', async () => {
    for (let attempt = 1; attempt <= MAX_ADOPTION_REPAIR_ATTEMPTS; attempt += 1) {
      const claim = await claimAdoptionJournal(db, `launch-${attempt}`);
      expect(claim).not.toBeNull();
      expect(claim!.journal.attempts).toBe(attempt);
      // The repair failed: the journal stays, with its attempt counted.
      expect(await readAdoptionJournal(db)).not.toBeNull();
    }
    const exhausted = await claimAdoptionJournal(db, 'launch-late');
    expect(exhausted).not.toBeNull();
    expect(exhausted!.exhausted).toBe(true);
  });

  it('refuses to clear a journal that is not the one that was claimed', async () => {
    const claim = await claimAdoptionJournal(db, 'launch-a');
    expect(claim).not.toBeNull();
    // Another launch replaced the journal in the meantime.
    await writeAdoptionJournal(db, {
      id: newJournalId(),
      circuitId: 'learned-2',
      stage: 'staged',
      attempts: 0,
    });

    expect(await clearClaimedJournal(db, claim!)).toBe(false);
    const survivor = await readAdoptionJournal(db);
    expect(survivor).not.toBeNull();
    expect(survivor!.circuitId).toBe('learned-2');
  });

  it('clears the journal it did claim', async () => {
    const claim = await claimAdoptionJournal(db, 'launch-a');
    expect(await clearClaimedJournal(db, claim!)).toBe(true);
    expect(await readAdoptionJournal(db)).toBeNull();
  });
});

describe('orphan session rollback (P5d-FIX4 G3)', () => {
  let db: SqlDatabase;

  beforeEach(async () => {
    db = await createSqlJsDatabase();
    await SqlSessionRepository.create(db);
    await migrateTelemetrySchema(db);
  });

it('clears the session pointer settings in the SAME transaction (P5d-FIX5 M2)', async () => {
    await db.runAsync(
      'INSERT INTO sessions (sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc) VALUES (?, ?, ?, ?, ?, ?)',
      ['s-ghost', 'local', 'learned-ghost', 'learned', 1, '2026-08-31T10:00:00.000Z'],
    );
    for (const [key, value] of [
      ['activeSessionId', 's-ghost'],
      ['activeSessionCircuitId', 'learned-ghost'],
      ['activeSessionStartedAtUtc', '2026-08-31T10:00:00.000Z'],
    ]) {
      await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }

    await deleteOrphanSession(db, 's-ghost');

    const pointerRows = await db.getAllAsync<{ key: string }>(
      "SELECT key FROM settings WHERE key IN ('activeSessionId', 'activeSessionCircuitId', 'activeSessionStartedAtUtc')",
    );
    expect(pointerRows).toHaveLength(0);
  });

  it('leaves a pointer that names a DIFFERENT session alone', async () => {
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'activeSessionId',
      's-other',
    ]);
    await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [
      'activeSessionCircuitId',
      'transilvania-motor-ring',
    ]);

    await deleteOrphanSession(db, 's-ghost');

    const pointerRows = await db.getAllAsync<{ key: string; value: string }>(
      "SELECT key, value FROM settings WHERE key = 'activeSessionId'",
    );
    expect(pointerRows[0]?.value).toBe('s-other');
  });

  it('deletes the session, its checkpoint, its laps and its telemetry in one go', async () => {
    await db.runAsync(
      'INSERT INTO sessions (sessionId, userId, circuitId, layoutId, layoutVersion, startedAtUtc) VALUES (?, ?, ?, ?, ?, ?)',
      ['s-ghost', 'local', 'learned-ghost', 'learned', 1, '2026-08-31T10:00:00.000Z'],
    );
    await db.runAsync('INSERT INTO laps (sessionId, lapNumber, payload) VALUES (?, ?, ?)', [
      's-ghost',
      1,
      '{}',
    ]);
    await db.runAsync('INSERT INTO checkpoints (sessionId, payload) VALUES (?, ?)', [
      's-ghost',
      '{}',
    ]);
    await db.runAsync('INSERT INTO telemetry (sessionId, lapNumber, payload) VALUES (?, ?, ?)', [
      's-ghost',
      0,
      '[]',
    ]);
    await db.runAsync(
      'INSERT INTO telemetry_samples (session_id, lap_number, t_mono_ms, channel, value) VALUES (?, ?, ?, ?, ?)',
      ['s-ghost', 0, 1, 'speedKph', 40],
    );

    await deleteOrphanSession(db, 's-ghost');

    for (const query of [
      'SELECT sessionId FROM sessions WHERE sessionId = ?',
      'SELECT sessionId FROM laps WHERE sessionId = ?',
      'SELECT sessionId FROM checkpoints WHERE sessionId = ?',
      'SELECT sessionId FROM telemetry WHERE sessionId = ?',
    ]) {
      expect(await db.getAllAsync(query, ['s-ghost'])).toHaveLength(0);
    }
    expect(
      await db.getAllAsync('SELECT session_id FROM telemetry_samples WHERE session_id = ?', [
        's-ghost',
      ]),
    ).toHaveLength(0);
  });
});
