import type { LocationSample, TelemetrySample } from '@circuit/core';

import type { AnalysisLapRecording } from './analysisAssembly';
import type { AnalysisSourceResult } from './analysisViewModel';
import type { BundledCircuit } from './circuitCatalog';
import type { StoredSession } from './mockHistory';

/**
 * Ticket P5b B2 — the READ path behind the analysis screen: a stored session
 * id becomes the engine's input out of exactly the rows the rest of the app
 * already reads, and out of nothing else.
 *
 *  - the lap records come from the session history store (the same list
 *    `SessionHistoryScreen`/`LapDetailScreen` render);
 *  - the GNSS trace of each lap comes from `LocalSessionRepository.loadTelemetry`
 *    (what `SessionController` wrote at every lap boundary);
 *  - the decoded OBD channels come from `telemetry_samples`, in ONE read for
 *    the whole session rather than one per lap.
 *
 * Every dependency is injected, so this module is plain TypeScript with no
 * expo-sqlite and no composition singletons in it -- `AnalysisScreen.tsx` wires
 * the real ones, vitest wires doubles.
 *
 * A failed channel read is NOT a failed analysis: the GPS-only tier-0 analysis
 * still stands, and the missing channels are then reported by the engine as
 * missing (which is exactly what they are).
 */

/**
 * A stored session as this module reads it. `StoredSession` itself carries no
 * layout VERSION today (`SqlSessionHistoryStore` filters on it instead of
 * projecting it), so it is read structurally: when a store does carry one it is
 * checked, and when it does not there is simply nothing to contradict.
 */
export type StoredSessionForAnalysis = StoredSession & { layoutVersion?: number };

export interface AnalysisSessionLoaderDeps {
  /** The stored session, or `null` when it is no longer on the device. */
  getSession: (sessionId: string) => StoredSessionForAnalysis | null;
  /** The bundled catalog entry for a circuit id, or `null` when it is unknown. */
  getCircuit: (circuitId: string) => BundledCircuit | null;
  /** The lap's stored GNSS trace. */
  loadLapGnss: (sessionId: string, lapNumber: number) => Promise<LocationSample[]>;
  /** Every decoded OBD sample of the session, grouped by lap number. */
  loadSessionChannels: (sessionId: string) => Promise<ReadonlyMap<number, TelemetrySample[]>>;
  /** Where a failed channel read is reported. Defaults to `console.warn`. */
  onChannelReadError?: (error: unknown) => void;
}

/**
 * Builds the `loadSession` dependency `createAnalysisRunner` takes. Never
 * throws for a missing session or an unknown circuit -- those are NAMED
 * unavailable reasons, so the screen can say which one happened.
 */
export function createAnalysisSessionLoader(
  deps: AnalysisSessionLoaderDeps,
): (sessionId: string) => Promise<AnalysisSourceResult> {
  const onChannelReadError =
    deps.onChannelReadError ??
    ((error: unknown) => console.warn('[analysisSessionLoader] channel read failed', error));

  return async (sessionId: string): Promise<AnalysisSourceResult> => {
    const session = deps.getSession(sessionId);
    if (session === null) return null;
    const circuit = deps.getCircuit(session.circuitId);
    if (circuit === null) return { unavailable: 'circuit-not-in-catalog' };

    // Ticket P5b-FIX1 C3 (binding, Codex P5b-REV1 finding 3): the circuit id
    // alone does not pin the GEOMETRY. Laps recorded on another layout of the
    // same circuit -- or on an older version of this one -- project onto corner
    // positions they were never driven against, which would silently produce
    // corner metrics for corners the driver did not drive. That is a NAMED
    // dead end, never a quiet projection.
    if (session.layoutId !== circuit.profile.layoutId) {
      return { unavailable: 'layout-incompatible' };
    }
    if (
      session.layoutVersion !== undefined &&
      session.layoutVersion !== circuit.profile.layoutVersion
    ) {
      return { unavailable: 'layout-incompatible' };
    }

    let channelsByLap: ReadonlyMap<number, TelemetrySample[]>;
    try {
      channelsByLap = await deps.loadSessionChannels(sessionId);
    } catch (error) {
      onChannelReadError(error);
      channelsByLap = new Map();
    }

    const recordings: AnalysisLapRecording[] = [];
    for (const lap of [...session.laps].sort((a, b) => a.lapNumber - b.lapNumber)) {
      const locationSamples = await deps.loadLapGnss(sessionId, lap.lapNumber);
      recordings.push({
        lap: {
          lapNumber: lap.lapNumber,
          durationMs: lap.durationMs,
          valid: lap.valid,
          invalidReasons: lap.invalidReasons,
          quality: lap.quality,
        },
        locationSamples,
        telemetry: channelsByLap.get(lap.lapNumber) ?? [],
        sectorTimes: lap.sectorTimes.map((sector) => ({
          sectorIndex: sector.sectorIndex,
          durationMs: sector.durationMs,
        })),
      });
    }

    return {
      sessionId,
      circuit,
      displayDateUtc: session.displayDateUtc,
      recordings,
    };
  };
}
