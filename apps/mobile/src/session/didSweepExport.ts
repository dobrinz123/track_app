import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { DidCandidateSummary, DidHeuristicSuggestion, DidObservationPhaseId, DidPhaseSample } from '@circuit/core';
import type { DidSweepStore, DidSweepResponderRecord, DidSweepRunRecord } from '../persistence/didSweepStore';
import type { DidSweepController } from './didSweepController';

/**
 * DID sweep — results persistence, export & candidate filtering addendum
 * (2026-08-27, binding — Phase 4i): "'Share results' produces a JSON file
 * (`trace-did-sweep-<date>.json`: run meta, counters, responders with raw
 * hex, observation series if any, suggestions) through the OS share sheet
 * (`expo-sharing` + `expo-file-system`, SDK-matched). Also 'Copy summary' to
 * clipboard (counts + top candidates) for quick chat."
 *
 * `expo-clipboard` is NOT an existing dependency of this app (checked before
 * writing this file) -- per the ticket's own instruction ("only if already
 * available, else omit"), no clipboard WRITE is wired here.
 * {@link buildCopySummaryText} still builds the summary TEXT (pure, no I/O)
 * so the screen can show it in a selectable `<Text>` for the user to copy
 * manually, or a future ticket can wire an actual clipboard call without
 * touching this module's own logic.
 *
 * expo-file-system v57 (SDK-matched, `npx expo install`) uses the NEW
 * class-based API (`File`/`Directory`/`Paths`) -- `write()`/`create()` are
 * SYNCHRONOUS (never a promise); the legacy `writeAsStringAsync`-style API
 * lives under `expo-file-system/legacy` and is not used here.
 */

export const DID_SWEEP_EXPORT_SCHEMA_VERSION = 1;

/**
 * R1 fix (P4i-FIX2, binding, after Codex P4hrev3 H3 PARTIAL): Stop/Pause/
 * natural completion all AWAIT their own terminal persistence flush (see
 * `didSweepController.ts`'s `maybeFlushPersistence`/`stop()`/`pause()`) --
 * but a batch window of AT MOST `FLUSH_INTERVAL_MS` (1s) of already-visited
 * DIDs can still be re-sent if the process is killed OUTSIDE of a normal
 * Stop/Pause (e.g. the OS kills the app between two periodic flushes). This
 * residual is ACCEPTED (never eliminated -- doing so would mean flushing
 * after every single DID, which the addendum's own batching exists to avoid)
 * and disclosed here, in the export itself, rather than left implicit.
 */
export const DID_SWEEP_RESUME_BOUND = '≤1s of DIDs may be re-sent after a hard kill';

export interface DidSweepExportResponder {
  didHex: string;
  length: number;
  rawHex: string;
  firstSeenUtc: string;
  lastSeenUtc: string;
  sampleCount: number;
}

export interface DidSweepExportCandidate {
  didHex: string;
  rank: DidCandidateSummary['rank'];
  lastRawHex: string;
  sampleCount: number;
  min: number | null;
  max: number | null;
  distinctValueCount: number;
  changedInPhase: Record<DidObservationPhaseId, boolean>;
}

export interface DidSweepExportPhaseSample {
  tMs: number;
  rawHex: string;
}

export interface DidSweepExportPhaseSeries {
  didHex: string;
  phase: DidObservationPhaseId;
  samples: DidSweepExportPhaseSample[];
}

export interface DidSweepExportSuggestion {
  didHex: string;
  kind: DidHeuristicSuggestion['kind'];
  confidence: number;
  decode: DidHeuristicSuggestion['decode'];
  rationale: string;
}

export interface DidSweepExportDocument {
  schemaVersion: number;
  generatedAtUtc: string;
  /** R1 fix (P4i-FIX2, binding): see {@link DID_SWEEP_RESUME_BOUND}'s own doc comment -- the accepted residual re-send window after a hard kill, disclosed to whoever reads this export. */
  resumeBound: string;
  run: {
    runId: string;
    adapterType: string;
    targetAddress: number | null;
    rangeFromHex: string;
    rangeToHex: string;
    lastDidHex: string | null;
    startedAtUtc: string;
    updatedAtUtc: string;
    status: DidSweepRunRecord['status'];
  };
  counters: {
    visitedCount: number;
    responderCount: number;
    timeoutCount: number;
    unmatchedCount: number;
    errorCount: number;
    /** Keyed by NRC value (hex string, e.g. `"0x11"`). */
    nrcCounts: Record<string, number>;
  };
  /** EVERY sweep responder (addendum: "Static responders are kept in the export but excluded from observation"). */
  responders: DidSweepExportResponder[];
  /** The RANKED, filtered candidate set (`didObservationPhases.ts`'s `computeDidCandidateSummaries`) -- `[]` if no guided observation has run yet. */
  candidates: DidSweepExportCandidate[];
  /** Per-DID, per-phase raw sample series, relative timestamps (addendum: "observation series if any") -- `[]` if no guided observation has run yet. */
  observationSeries: DidSweepExportPhaseSeries[];
  /** `classifyResponders`-derived heuristic suggestions, if any single-window observation has run. */
  suggestions: DidSweepExportSuggestion[];
}

function didHex(did: number): string {
  return `0x${did.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Builds the FULL export document (pure -- no I/O). `run`/`responders` normally come straight from `DidSweepStore`; `candidateSummaries`/`observationSamples`/`suggestions` are optional (a run that never reached a guided/heuristic observation still exports its sweep results). */
export function buildDidSweepExportDocument(input: {
  run: DidSweepRunRecord;
  responders: readonly DidSweepResponderRecord[];
  candidateSummaries?: readonly DidCandidateSummary[];
  observationSamples?: readonly DidPhaseSample[];
  suggestions?: readonly DidHeuristicSuggestion[];
  nowIso: string;
}): DidSweepExportDocument {
  const observationSamples = input.observationSamples ?? [];
  const seriesByKey = new Map<string, DidSweepExportPhaseSeries>();
  for (const sample of observationSamples) {
    const key = `${sample.did}:${sample.phase}`;
    let series = seriesByKey.get(key);
    if (series === undefined) {
      series = { didHex: didHex(sample.did), phase: sample.phase, samples: [] };
      seriesByKey.set(key, series);
    }
    series.samples.push({ tMs: sample.tMs, rawHex: bytesToHex(sample.raw) });
  }

  return {
    schemaVersion: DID_SWEEP_EXPORT_SCHEMA_VERSION,
    generatedAtUtc: input.nowIso,
    resumeBound: DID_SWEEP_RESUME_BOUND,
    run: {
      runId: input.run.runId,
      adapterType: input.run.adapterType,
      targetAddress: input.run.targetAddress,
      rangeFromHex: didHex(input.run.rangeFrom),
      rangeToHex: didHex(input.run.rangeTo),
      lastDidHex: input.run.lastDid === null ? null : didHex(input.run.lastDid),
      startedAtUtc: input.run.startedAtUtc,
      updatedAtUtc: input.run.updatedAtUtc,
      status: input.run.status,
    },
    counters: {
      visitedCount: input.run.visitedCount,
      responderCount: input.run.responderCount,
      timeoutCount: input.run.timeoutCount,
      unmatchedCount: input.run.unmatchedCount,
      errorCount: input.run.errorCount,
      nrcCounts: Object.fromEntries(Object.entries(input.run.nrcCounts).map(([nrc, count]) => [`0x${Number(nrc).toString(16).toUpperCase()}`, count])),
    },
    responders: [...input.responders]
      .sort((a, b) => a.did - b.did)
      .map((r) => ({
        didHex: didHex(r.did),
        length: r.length,
        rawHex: r.rawHex,
        firstSeenUtc: r.firstSeenUtc,
        lastSeenUtc: r.lastSeenUtc,
        sampleCount: r.sampleCount,
      })),
    candidates: (input.candidateSummaries ?? []).map((c) => ({
      didHex: didHex(c.did),
      rank: c.rank,
      lastRawHex: c.lastRawHex,
      sampleCount: c.sampleCount,
      min: c.min,
      max: c.max,
      distinctValueCount: c.distinctValueCount,
      changedInPhase: c.changedInPhase,
    })),
    observationSeries: [...seriesByKey.values()],
    suggestions: (input.suggestions ?? []).map((s) => ({
      didHex: didHex(s.did),
      kind: s.kind,
      confidence: s.confidence,
      decode: s.decode,
      rationale: s.rationale,
    })),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * F3 fix (P4i-FIX1, binding, after Codex P4hrev2c HIGH finding #5): "the
 * screen passes them [`getGuidedSamples()`] to `buildDidSweepExportDocument`."
 * The exact "screen/controller handoff" this finding is about -- reads
 * `runId`'s run+responders from `store` and the controller's OWN live
 * `candidateSummaries`/`suggestions`/`getGuidedSamples()`, then builds the
 * export document. `DidSweepScreen.tsx`'s "Share results" calls this
 * DIRECTLY (never re-implements the handoff inline) so the guided
 * observation series can never again be silently omitted here. `null` if
 * `runId` doesn't exist in `store` (mirrors the screen's own prior "Could not
 * find this run in storage" branch).
 */
export async function buildDidSweepExportForRun(
  controller: Pick<DidSweepController, 'getSnapshot' | 'getGuidedSamples'>,
  store: DidSweepStore,
  runId: string,
  nowIso: string,
): Promise<DidSweepExportDocument | null> {
  const run = await store.getRun(runId);
  if (run === null) return null;
  const responders = await store.getResponders(runId);
  const snapshot = controller.getSnapshot();
  return buildDidSweepExportDocument({
    run,
    responders,
    candidateSummaries: snapshot.candidateSummaries,
    observationSamples: controller.getGuidedSamples(),
    suggestions: snapshot.suggestions,
    nowIso,
  });
}

/** `trace-did-sweep-<date>.json`, `<date>` being the export's own `generatedAtUtc` truncated to `YYYY-MM-DD` (addendum's own exact filename pattern). */
export function didSweepExportFileName(generatedAtUtc: string): string {
  const date = generatedAtUtc.slice(0, 10);
  return `trace-did-sweep-${date}.json`;
}

/** "Copy summary" text (addendum: "counts + top candidates") -- pure, no I/O; see this module's own doc comment for why no clipboard WRITE happens here. */
export function buildCopySummaryText(doc: DidSweepExportDocument): string {
  const topCandidates = doc.candidates.filter((c) => c.rank !== 'static').slice(0, 5);
  const lines = [
    `DID sweep ${doc.run.rangeFromHex}-${doc.run.rangeToHex} (${doc.run.status})`,
    `${doc.counters.responderCount} responders / ${doc.counters.visitedCount} visited, ${doc.counters.timeoutCount} timeouts`,
  ];
  lines.push(
    topCandidates.length === 0
      ? 'No ranked candidates yet'
      : `Top candidates: ${topCandidates.map((c) => `${c.didHex} (${c.rank})`).join(', ')}`,
  );
  return lines.join('\n');
}

export interface DidSweepExportResult {
  /** True whenever export "succeeded" in a user-facing sense -- includes the web/unsupported-platform FALLBACK (never a failure the user needs to act on), per the addendum: "Web preview: export falls back to showing the JSON length + a console log (never throws)." */
  ok: boolean;
  /** True only when the OS share sheet was genuinely invoked (native). False on the fallback path (web preview, or `expo-sharing` reporting unavailable). */
  shared: boolean;
  jsonLength: number;
  error?: string;
}

/**
 * Writes `doc` to a cache-directory JSON file and hands it to the OS share
 * sheet. NEVER throws (addendum: "never throws") -- any failure (web
 * preview, `expo-sharing` unavailable, a native write/share error) falls
 * back to a console log naming the JSON's length, with `shared: false`.
 */
export async function shareDidSweepExport(doc: DidSweepExportDocument): Promise<DidSweepExportResult> {
  const json = JSON.stringify(doc, null, 2);
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      console.log(`[didSweepExport] Sharing unavailable on this platform (e.g. web preview) -- JSON is ${json.length} bytes`);
      return { ok: true, shared: false, jsonLength: json.length };
    }
    const file = new File(Paths.cache, didSweepExportFileName(doc.generatedAtUtc));
    file.write(json);
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Share DID sweep results' });
    return { ok: true, shared: true, jsonLength: json.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[didSweepExport] export failed (falling back) -- JSON is ${json.length} bytes: ${message}`);
    return { ok: false, shared: false, jsonLength: json.length, error: message };
  }
}
