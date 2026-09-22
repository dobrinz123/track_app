import { describe, expect, it } from 'vitest';

import { SqlSessionRepository, StoredPayloadUnreadableError } from '../../src/persistence-sql';
import type { LapRecord, ReferenceLap, SessionSummary } from '../../src/contracts';
import { createSqlJsDatabase } from './sqlJsDatabase';

/**
 * Ticket P16 C1 (architecture map, sqlSessionRepository.ts:349) -- ONE CORRUPT
 * LAP ROW MUST NOT HIDE EVERY SESSION.
 *
 * `parsePayloads` (P12/P14) was introduced so an unreadable stored payload
 * reads as FAILED rather than as absent, and was rolled out to `lap_verdicts`
 * and `calibration_attempts` only. `listSessions` still did
 * `lapRows.map((r) => JSON.parse(r.payload))` unguarded, INSIDE the loop over
 * every session -- so a single corrupt lap payload, in any one session, threw
 * out of the loop and took the WHOLE session list with it. No history means no
 * session to open, which means no export: the exact "came home with nothing"
 * failure this area exists to close off.
 *
 * The rule these tests pin: a corrupt row costs THAT ROW, never its session
 * and never the list -- and the loss is COUNTED, never turned into a
 * fabricated empty lap or a silently shorter session.
 */

function lap(lapNumber: number): LapRecord {
  return {
    lapNumber,
    tStart: lapNumber * 100_000,
    tEnd: lapNumber * 100_000 + 90_000,
    durationMs: 90_000,
    sectorTimes: [{ sectorIndex: 0, durationMs: 90_000, quality: 'good' }],
    valid: true,
    invalidReasons: [],
    quality: 'good',
  };
}

function summary(sessionId: string, startedAtUtc: string, laps: LapRecord[]): SessionSummary {
  return {
    sessionId,
    userId: 'u1',
    circuitId: 'c1',
    layoutId: 'l1',
    layoutVersion: 1,
    startedAtUtc,
    laps,
    calibrationStatus: 'validated',
  };
}

function referenceLap(): ReferenceLap {
  return {
    userId: 'u1',
    circuitId: 'c1',
    layoutId: 'l1',
    layoutVersion: 1,
    durationMs: 90_000,
    sectorTimes: [{ sectorIndex: 0, durationMs: 90_000, quality: 'good' }],
    recordedAtUtc: '2026-09-22T10:00:00.000Z',
    sessionId: 's-good',
    lapNumber: 1,
    distanceGridM: [0, 1, 2],
    elapsedMsAtGrid: [0, 100, 200],
    gnssQualitySummary: { level: 'good', reasons: [] },
    appVersion: '1.0.0',
    algorithmVersion: 1,
    profileSchemaVersion: 1,
  };
}

describe('P16 C1 -- one corrupt lap row costs that row, not the session and not the list', () => {
  it('still lists EVERY session when one session holds a lap payload that will not parse', async () => {
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);

    // Two sessions. The older one is untouched; the newer one gets a lap row
    // corrupted underneath it, the shape a truncated database file leaves.
    await repository.saveSession(summary('s-good', '2026-09-22T09:00:00.000Z', [lap(1), lap(2)]));
    await repository.saveSession(summary('s-corrupt', '2026-09-22T11:00:00.000Z', [lap(1), lap(2)]));
    await db.runAsync('UPDATE laps SET payload = ? WHERE sessionId = ? AND lapNumber = ?', [
      '{not json',
      's-corrupt',
      2,
    ]);

    // BEFORE this ticket this call REJECTED: the unguarded JSON.parse threw
    // out of the per-session loop and the caller got no history at all --
    // including the entirely healthy `s-good`.
    const sessions = await repository.listSessions('u1', 'c1');

    expect(sessions.map((s) => s.sessionId)).toEqual(['s-corrupt', 's-good']);

    // The healthy session is complete and says nothing about unreadable rows.
    const good = sessions.find((s) => s.sessionId === 's-good')!;
    expect(good.laps.map((l) => l.lapNumber)).toEqual([1, 2]);
    expect(good.unreadableLapCount).toBeUndefined();

    // The damaged session keeps the lap it can read, and SAYS the other one
    // exists and could not be decoded. It is not silently a one-lap session.
    const corrupt = sessions.find((s) => s.sessionId === 's-corrupt')!;
    expect(corrupt.laps.map((l) => l.lapNumber)).toEqual([1]);
    expect(corrupt.unreadableLapCount).toBe(1);
  });

  it('a session whose every lap row is unreadable reads as FAILED, not as a session with no laps', async () => {
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    await repository.saveSession(summary('s-all-bad', '2026-09-22T09:00:00.000Z', [lap(1), lap(2)]));
    await db.runAsync('UPDATE laps SET payload = ? WHERE sessionId = ?', ['', 's-all-bad']);

    const [session] = await repository.listSessions('u1', 'c1');

    expect(session!.laps).toEqual([]);
    // THE POINT. `laps: []` on its own is the sentence "he completed no laps".
    // The count is what turns it back into "two laps are on this device and
    // this device cannot read them".
    expect(session!.unreadableLapCount).toBe(2);
  });

  it('a session that genuinely has no laps is still reported as empty, not as failed', async () => {
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    await repository.saveSession(summary('s-empty', '2026-09-22T09:00:00.000Z', []));

    const [session] = await repository.listSessions('u1', 'c1');

    expect(session!.laps).toEqual([]);
    expect(session!.unreadableLapCount).toBeUndefined();
  });

  it('loadTelemetry FAILS LOUD on a corrupt row rather than answering "no samples"', async () => {
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    await repository.saveTelemetry('s1', 1, [
      { tMono: 0, tUtc: 0, lat: 46, lon: 23, accuracyM: 3, source: 'gnss' },
    ]);
    await db.runAsync('UPDATE telemetry SET payload = ? WHERE sessionId = ? AND lapNumber = ?', [
      '{not json',
      's1',
      1,
    ]);

    // `Promise<LocationSample[]>` cannot carry "unreadable", and `[]` here
    // would be the fabricated-empty bug: the raw export would report a lap
    // that was driven as a lap with no trace. So it rejects, with a named
    // error that says which row -- the controller's reclaim path already
    // treats a `loadTelemetry` rejection as a reclaim failure it must record.
    await expect(repository.loadTelemetry('s1', 1)).rejects.toBeInstanceOf(StoredPayloadUnreadableError);
    await expect(repository.loadTelemetry('s1', 1)).rejects.toThrow(/telemetry/);

    // A lap with no stored row at all is still, correctly, empty.
    expect(await repository.loadTelemetry('s1', 2)).toEqual([]);
  });

  it('getReferenceLap FAILS LOUD on a corrupt row rather than answering "there is no personal best"', async () => {
    const db = await createSqlJsDatabase();
    const repository = await SqlSessionRepository.create(db);
    await repository.putReferenceLap(referenceLap());
    await db.runAsync('UPDATE reference_laps SET payload = ? WHERE userId = ?', ['{not json', 'u1']);

    // `null` here means "no personal best yet", which would let the next
    // slower lap be promoted over a PB that is still on the device.
    await expect(repository.getReferenceLap('u1', 'c1', 'l1', 1)).rejects.toBeInstanceOf(
      StoredPayloadUnreadableError,
    );

    // An absent reference lap is still, correctly, null.
    expect(await repository.getReferenceLap('u1', 'c1', 'l1', 2)).toBeNull();
  });
});
