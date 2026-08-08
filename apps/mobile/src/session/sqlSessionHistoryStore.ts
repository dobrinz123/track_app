import type { LapRecord, LocalSessionRepository, ReferenceLap } from '@circuit/core';
import type { PersonalBestEntry, SessionHistoryStore, StoredSession } from './mockHistory';

function syntheticLapFromReference(ref: ReferenceLap): LapRecord {
  // Fallback only: used if the PB's originating session/lap somehow isn't
  // present in the cached session list (e.g. its session row predates this
  // store, or telemetry-only edge cases) -- still real, stored data (the
  // reference lap itself), never fabricated timing.
  return {
    lapNumber: ref.lapNumber,
    tStart: 0,
    tEnd: ref.durationMs,
    durationMs: ref.durationMs,
    sectorTimes: ref.sectorTimes,
    valid: true,
    invalidReasons: [],
    quality: ref.gnssQualitySummary.level,
  };
}

/**
 * `SessionHistoryStore` (S9-S11) backed by the real `SqlSessionRepository`
 * (MUST DO #4). `listSessions()`/`getSession()`/`getPersonalBest()` stay
 * synchronous, matching the existing interface screens call directly during
 * render -- `refresh()` (async) repopulates an in-memory cache, called once
 * at app startup and again after every session save.
 */
export class SqlSessionHistoryStore implements SessionHistoryStore {
  private cache: StoredSession[] = [];
  private pb: PersonalBestEntry | null = null;

  constructor(
    // Interface, not the concrete SQL class: the web dev preview substitutes
    // the in-memory repository (expo-sqlite's wasm backend is unreliable there).
    private readonly repository: LocalSessionRepository,
    private readonly userId: string,
    private readonly circuitId: string,
    private readonly layoutId: string,
    private readonly layoutVersion: number,
  ) {}

  async refresh(): Promise<void> {
    const summaries = await this.repository.listSessions(this.userId, this.circuitId);
    this.cache = summaries
      .filter((s) => s.layoutId === this.layoutId && s.layoutVersion === this.layoutVersion)
      .map((s) => ({
        sessionId: s.sessionId,
        circuitId: s.circuitId,
        layoutId: s.layoutId,
        displayDateUtc: s.startedAtUtc,
        laps: s.laps,
      }));

    const ref = await this.repository.getReferenceLap(this.userId, this.circuitId, this.layoutId, this.layoutVersion);
    if (ref === null) {
      this.pb = null;
      return;
    }
    const session = this.cache.find((s) => s.sessionId === ref.sessionId);
    const lap = session?.laps.find((l) => l.lapNumber === ref.lapNumber) ?? syntheticLapFromReference(ref);
    this.pb = { lap, sessionId: ref.sessionId, recordedAtUtc: ref.recordedAtUtc };
  }

  listSessions(): StoredSession[] {
    return [...this.cache];
  }

  getSession(sessionId: string): StoredSession | null {
    return this.cache.find((s) => s.sessionId === sessionId) ?? null;
  }

  getPersonalBest(): PersonalBestEntry | null {
    return this.pb;
  }
}
