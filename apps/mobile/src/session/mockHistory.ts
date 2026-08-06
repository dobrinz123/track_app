import type { LapRecord, SectorTime } from '@circuit/core';

/**
 * Minimal shape of a stored session as consumed by the history/PB screens
 * (S9–S11). This intentionally does not reuse `@circuit/core`'s
 * `SessionSummary` 1:1 (no `userId` plumbing exists in the mock UI layer
 * yet) — it is a small, UI-facing, mock-only read model, analogous in spirit
 * to `SessionFacade` but for *past* sessions rather than the live one. A
 * later persistence-backed work package replaces `MockSessionHistoryStore`
 * with one backed by `LocalSessionRepository`.
 */
export interface StoredSession {
  sessionId: string;
  circuitId: string;
  layoutId: string;
  displayDateUtc: string;
  laps: LapRecord[];
}

export interface PersonalBestEntry {
  lap: LapRecord;
  sessionId: string;
  recordedAtUtc: string;
}

export interface SessionHistoryStore {
  listSessions(): StoredSession[];
  getSession(sessionId: string): StoredSession | null;
  getPersonalBest(): PersonalBestEntry | null;
}

function sectorTimes(total: number): SectorTime[] {
  const third = total / 3;
  return [0, 1, 2].map((sectorIndex) => ({
    sectorIndex,
    durationMs: Math.round(third),
    quality: 'good',
  }));
}

function lap(lapNumber: number, durationMs: number, valid = true, invalidReasons: string[] = []): LapRecord {
  return {
    lapNumber,
    tStart: 0,
    tEnd: durationMs,
    durationMs,
    sectorTimes: sectorTimes(durationMs),
    valid,
    invalidReasons,
    quality: valid ? 'good' : 'degraded',
  };
}

const MOCK_SESSIONS: readonly StoredSession[] = [
  {
    sessionId: 'demo-session-3',
    circuitId: 'transilvania-motor-ring',
    layoutId: 'main',
    displayDateUtc: '2026-08-02T09:14:00Z',
    laps: [lap(1, 21_850), lap(2, 20_120), lap(3, 20_340), lap(4, 21_002)],
  },
  {
    sessionId: 'demo-session-2',
    circuitId: 'transilvania-motor-ring',
    layoutId: 'main',
    displayDateUtc: '2026-07-26T10:02:00Z',
    laps: [lap(1, 22_910), lap(2, 21_530), lap(3, 20_980, false, ['PIT_TRANSIT']), lap(4, 21_275)],
  },
  {
    sessionId: 'demo-session-1',
    circuitId: 'transilvania-motor-ring',
    layoutId: 'main',
    displayDateUtc: '2026-07-19T08:41:00Z',
    laps: [lap(1, 24_110), lap(2, 22_760), lap(3, 22_505)],
  },
];

/** Deterministic mock read model backing S9/S10/S11 until real persistence is wired. DEV-ONLY. */
export class MockSessionHistoryStore implements SessionHistoryStore {
  listSessions(): StoredSession[] {
    return [...MOCK_SESSIONS];
  }

  getSession(sessionId: string): StoredSession | null {
    return MOCK_SESSIONS.find((s) => s.sessionId === sessionId) ?? null;
  }

  getPersonalBest(): PersonalBestEntry | null {
    let best: { session: StoredSession; lap: LapRecord } | null = null;
    for (const session of MOCK_SESSIONS) {
      for (const candidate of session.laps) {
        if (!candidate.valid) continue;
        if (!best || candidate.durationMs < best.lap.durationMs) {
          best = { session, lap: candidate };
        }
      }
    }
    if (!best) return null;
    return { lap: best.lap, sessionId: best.session.sessionId, recordedAtUtc: best.session.displayDateUtc };
  }
}
