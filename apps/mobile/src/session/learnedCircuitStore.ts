import {
  decodeLearnedCircuit,
  encodeLearnedCircuit,
  polylineLength,
  type CircuitProfile,
  type Corner,
  type SqlDatabase,
} from '@circuit/core';

import type { BundledCircuit } from './circuitCatalog';

/**
 * Ticket P5d T4/T6 -- the learned circuits on this device.
 *
 * Same shape as `SqlSessionHistoryStore`: an async `refresh()` fills an
 * in-memory cache, and every read a screen or the catalog performs is
 * synchronous. Writes are single statements, so they need no
 * `SqlWriteGate` (see `sqlWriteGate.ts`: only multi-statement units do).
 *
 * A row that cannot be decoded is SKIPPED and counted, never thrown: one
 * corrupt learned circuit must not take the circuit list -- or the app's
 * bootstrap -- down with it.
 */

export interface LearnedCircuitRecord {
  circuitId: string;
  displayName: string;
  lengthM: number;
  cornerCount: number;
  createdAtUtc: string;
  /** `true` once the driver saved it as a reusable, listed circuit (T6). */
  saved: boolean;
}

export interface LearnedCircuitEntry extends BundledCircuit {
  record: LearnedCircuitRecord;
  /** True when the stored corner set was unusable and had to be re-derived from the geometry. */
  cornersRecovered: boolean;
}

export type RemoveLearnedCircuitResult =
  | { ok: true }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'has-sessions'; sessionCount: number };

interface LearnedCircuitRow {
  circuit_id: string;
  display_name: string;
  payload: string;
  length_m: number;
  corner_count: number;
  created_at_utc: string;
  saved: number;
}

export class SqlLearnedCircuitStore {
  private cache = new Map<string, LearnedCircuitEntry>();
  private invalidRows = 0;

  constructor(private readonly db: SqlDatabase) {}

  /** Reloads every learned circuit from the database, validating each one. */
  async refresh(): Promise<void> {
    const rows = await this.db.getAllAsync<LearnedCircuitRow>(
      'SELECT circuit_id, display_name, payload, length_m, corner_count, created_at_utc, saved FROM learned_circuits ORDER BY created_at_utc DESC',
    );
    const cache = new Map<string, LearnedCircuitEntry>();
    let invalid = 0;
    for (const row of rows) {
      const decoded = decodeLearnedCircuit(row.payload);
      if (!decoded.ok) {
        invalid += 1;
        console.warn(
          `[learnedCircuitStore] skipping unreadable learned circuit "${row.circuit_id}": ${decoded.errors.join(', ')}`,
        );
        continue;
      }
      cache.set(row.circuit_id, {
        profile: decoded.profile,
        runtime: decoded.runtime,
        corners: decoded.corners,
        cornersRecovered: decoded.cornersRecovered,
        record: {
          circuitId: row.circuit_id,
          displayName: decoded.profile.displayName,
          lengthM: row.length_m,
          cornerCount: decoded.corners.length,
          createdAtUtc: row.created_at_utc,
          saved: row.saved !== 0,
        },
      });
    }
    this.cache = cache;
    this.invalidRows = invalid;
  }

  /** Every learned circuit, saved or not -- what the catalog resolves session geometry from. */
  entries(): LearnedCircuitEntry[] {
    return [...this.cache.values()];
  }

  /** Only the circuits the driver actually saved -- what the selection list shows. */
  saved(): LearnedCircuitRecord[] {
    return this.entries()
      .filter((entry) => entry.record.saved)
      .map((entry) => entry.record);
  }

  get(circuitId: string): LearnedCircuitEntry | null {
    return this.cache.get(circuitId) ?? null;
  }

  /** How many stored rows could not be read back (diagnostics; never silently zero). */
  invalidRowCount(): number {
    return this.invalidRows;
  }

  /** Writes a learned circuit whole (insert or replace) and updates the cache. */
  async put(input: {
    profile: CircuitProfile;
    corners: readonly Corner[];
    saved: boolean;
  }): Promise<void> {
    const payload = encodeLearnedCircuit(input.profile, input.corners);
    await this.db.runAsync(
      `INSERT OR REPLACE INTO learned_circuits
         (circuit_id, display_name, payload, length_m, corner_count, created_at_utc, saved)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.profile.circuitId,
        input.profile.displayName,
        payload,
        input.profile.totalLengthM,
        input.corners.length,
        input.profile.createdAtUtc,
        input.saved ? 1 : 0,
      ],
    );
    await this.refresh();
  }

  /**
   * Ticket T6's "Save circuit": names an already-learned loop and makes it a
   * listed circuit. The stored PROFILE is rewritten too, so the name the
   * driver chose is the name every later screen (and every export) reads.
   */
  async markSaved(circuitId: string, displayName: string): Promise<boolean> {
    const entry = this.cache.get(circuitId);
    if (entry === undefined) return false;
    const name = displayName.trim();
    if (name.length === 0) return false;
    await this.put({
      profile: { ...entry.profile, displayName: name, updatedAtUtc: new Date().toISOString() },
      corners: entry.corners,
      saved: true,
    });
    return true;
  }

  /**
   * Deletes a learned circuit -- but REFUSES while any session still points at
   * it. Chosen over archiving deliberately: a session whose circuit is gone
   * cannot be analysed or replayed (`analysisSessionLoader` returns
   * `circuit-not-in-catalog`), so deleting the geometry would silently break
   * the driver's own recorded laps. The driver deletes the sessions first, and
   * the count in the refusal says how many there are.
   */
  async remove(circuitId: string): Promise<RemoveLearnedCircuitResult> {
    if (!this.cache.has(circuitId)) return { ok: false, reason: 'not-found' };
    const rows = await this.db.getAllAsync<{ sessionCount: number }>(
      'SELECT COUNT(*) AS sessionCount FROM sessions WHERE circuitId = ?',
      [circuitId],
    );
    const sessionCount = rows[0]?.sessionCount ?? 0;
    if (sessionCount > 0) return { ok: false, reason: 'has-sessions', sessionCount };

    await this.db.runAsync('DELETE FROM learned_circuits WHERE circuit_id = ?', [circuitId]);
    await this.refresh();
    return { ok: true };
  }
}

/** The learned loop's length as the geometry itself reports it -- never the stored copy. */
export function learnedCircuitLengthM(entry: BundledCircuit): number {
  return polylineLength(entry.runtime.centerline);
}
