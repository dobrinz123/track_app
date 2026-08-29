import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type {
  DidBlockCandidateSummary,
  DidCandidateSummary,
  DidHeuristicSuggestion,
  DidObservationPhaseId,
  DidPhaseEvidence,
  DidPhaseSample,
} from '@circuit/core';
import { hexToBytes } from '../persistence/didSweepStore';
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

/**
 * Ticket P4j-FIX1 M6 (binding, after Codex P4j-REV1 MEDIUM #6: "The export
 * format changed incompatibly without a schema-version bump"). v2 is what P4j
 * actually shipped plus this fix wave:
 *  - `run.targetAddress` became a HEX STRING (it was a number in v1);
 *  - `run.targetAddressNumeric` is the v1-shaped numeric value, kept so a
 *    consumer written against v1 has somewhere to read a number from;
 *  - `blockCandidates` and per-series `batchIndex` were added;
 *  - `candidates[].phaseEvidence` (changed / unchanged / insufficient) and the
 *    `observationInsufficientDidHex` / `inconsistentDidHex` reports were added.
 */
export const DID_SWEEP_EXPORT_SCHEMA_VERSION = 2;

/** Carried IN the document (M6, binding) so whoever opens the JSON sees why v1 parsers may choke, without having to find this file. */
export const DID_SWEEP_EXPORT_SCHEMA_NOTE =
  'schemaVersion 2: run.targetAddress is a hex string (v1 used a number -- see run.targetAddressNumeric); blockCandidates, per-series batchIndex, candidates[].phaseEvidence, observationInsufficientDidHex and inconsistentDidHex are new in v2.';

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
  /** Ticket P4j-FIX1 H2/M6 (binding): the tri-state verdict per phase -- `insufficient` says "not enough samples to judge", which a bare `changedInPhase: false` could not distinguish from "measured, and it did not change". */
  phaseEvidence: Record<DidObservationPhaseId, DidPhaseEvidence>;
}

/**
 * Ticket P4j (binding): "Mid-size blocks (9-32 bytes) join the candidate pool
 * with per-byte-offset diffing: ... the export lists changed offsets."
 */
export interface DidSweepExportBlockCandidate {
  didHex: string;
  length: number;
  sampleCount: number;
  rank: DidBlockCandidateSummary['rank'];
  changedOffsetsByPhase: Record<DidObservationPhaseId, number[]>;
  /** Ticket P4j-FIX1 H2/M6 (binding): same tri-state verdict as the numeric candidates -- an empty offset list under `insufficient` means "not measured", not "nothing moved". */
  phaseEvidence: Record<DidObservationPhaseId, DidPhaseEvidence>;
}

export interface DidSweepExportPhaseSample {
  tMs: number;
  rawHex: string;
}

export interface DidSweepExportPhaseSeries {
  didHex: string;
  phase: DidObservationPhaseId;
  /**
   * Ticket P4j-FIX2 V4 (binding, after Codex P4j-REV2 NEW MEDIUM #2:
   * "persisted observation groups are collapsed in export"): which
   * observation run (`didSweepController.ts`'s own `currentObservationId`)
   * this series belongs to -- `null` only for a sample that somehow arrived
   * without one (should not happen in practice; every guided/batched/focused
   * observation tags its samples). A DID sampled in TWO separate observations
   * (e.g. a batched run, then later a focused re-run) now produces TWO
   * separate series -- one per `observationId`, each with its OWN
   * `batchIndex` -- rather than one series that mixes two independent phase
   * timelines and reports only the first observation's `batchIndex`.
   */
  observationId: string | null;
  /**
   * Ticket P4j (binding, batched guided observation): "export includes
   * `batchIndex`" -- the 0-based batch (`planObservationBatches`' own
   * `index`) this DID's samples were collected in, or `null` for a guided run
   * that never batched its candidates (the legacy single-pass
   * `startGuidedObservation()`, or a focused-shortlist run). Constant across
   * every sample in `samples` below (a DID never moves between batches
   * mid-run) -- and, since P4j-FIX2 V4, across one `observationId` (never
   * mixed with a DIFFERENT observation's own `batchIndex`).
   */
  batchIndex: number | null;
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
  /** Ticket P4j-FIX1 M6 (binding): see {@link DID_SWEEP_EXPORT_SCHEMA_NOTE}. */
  schemaNote: string;
  generatedAtUtc: string;
  /** R1 fix (P4i-FIX2, binding): see {@link DID_SWEEP_RESUME_BOUND}'s own doc comment -- the accepted residual re-send window after a hard kill, disclosed to whoever reads this export. */
  resumeBound: string;
  run: {
    runId: string;
    adapterType: string;
    /**
     * Ticket P4j (binding): "the export's `run.targetAddress` is a hex
     * string too" -- e.g. `"0x12"` (2-hex-digit byte), `null` when the run
     * has no target address recorded.
     */
    targetAddress: string | null;
    /** Ticket P4j-FIX1 M6 (binding): the v1-shaped NUMERIC target address, kept alongside the hex string so a consumer written against schema v1 is not left parsing `"0x12"` as a number. `null` when the run recorded none. */
    targetAddressNumeric: number | null;
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
  /** Ticket P4j (binding): the RANKED mid-size (9-32 byte) block candidates (`didObservationPhases.ts`'s `computeDidBlockCandidateSummaries`) -- `[]` if no batched/focused guided run has ever populated one. */
  blockCandidates: DidSweepExportBlockCandidate[];
  /** Per-DID, per-phase raw sample series, relative timestamps (addendum: "observation series if any") -- `[]` if no guided observation has run yet. */
  observationSeries: DidSweepExportPhaseSeries[];
  /** `classifyResponders`-derived heuristic suggestions, if any single-window observation has run. */
  suggestions: DidSweepExportSuggestion[];
  /** Ticket P4j-FIX1 H1/M6 (binding): DIDs that never reached the per-phase sample guarantee (NRC/timeout, or the phase's hard cap) -- excluded from ranking, REPORTED here so the export never looks like they were measured and found static. */
  observationInsufficientDidHex: string[];
  /** Ticket P4j-FIX1 M3/M6 (binding): DIDs whose observation samples disagreed on response length -- routed to neither summarizer, never split into two apparent candidates. */
  inconsistentDidHex: string[];
}

function didHex(did: number): string {
  return `0x${did.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Ticket P4j (binding): "the export's `run.targetAddress` is a hex string too" -- a 2-hex-digit byte (e.g. `"0x12"`), same convention as `enetSettingsValidation.ts`'s `formatHexByte` (kept independent -- this module never imports mobile-only session helpers). */
function hexByte(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Builds the FULL export document (pure -- no I/O). `run`/`responders` normally come straight from `DidSweepStore`; `candidateSummaries`/`blockCandidateSummaries`/`observationSamples`/`suggestions` are optional (a run that never reached a guided/heuristic observation still exports its sweep results). */
export function buildDidSweepExportDocument(input: {
  run: DidSweepRunRecord;
  responders: readonly DidSweepResponderRecord[];
  candidateSummaries?: readonly DidCandidateSummary[];
  /** Ticket P4j (binding): mid-size (9-32 byte) block candidates -- `[]`/omitted when no batched/focused guided run has ranked any. */
  blockCandidateSummaries?: readonly DidBlockCandidateSummary[];
  observationSamples?: readonly DidPhaseSample[];
  suggestions?: readonly DidHeuristicSuggestion[];
  /** Ticket P4j-FIX1 H1 (binding): DIDs excluded from ranking for want of samples. */
  insufficientDids?: readonly number[];
  /** Ticket P4j-FIX1 M3 (binding): DIDs whose samples disagreed on length. */
  inconsistentDids?: readonly number[];
  nowIso: string;
}): DidSweepExportDocument {
  const observationSamples = input.observationSamples ?? [];
  const seriesByKey = new Map<string, DidSweepExportPhaseSeries>();
  for (const sample of observationSamples) {
    // Ticket P4j-FIX2 V4 (binding, after Codex P4j-REV2 NEW MEDIUM #2): keyed
    // by observationId TOO -- a DID sampled in two separate observations
    // (e.g. batched, then later a focused re-run) is never merged into one
    // series that mixes two independent phase timelines and reports only
    // the FIRST observation's `batchIndex`.
    const observationId = sample.observationId ?? null;
    const key = `${observationId ?? ''}:${sample.did}:${sample.phase}`;
    let series = seriesByKey.get(key);
    if (series === undefined) {
      // Ticket P4j (binding): "export includes batchIndex" -- constant per
      // (observationId, did, phase) series (a DID never moves between
      // batches mid-run, nor between observations), so it is set once, from
      // the FIRST sample seen for this key.
      series = { didHex: didHex(sample.did), phase: sample.phase, observationId, batchIndex: sample.batchIndex ?? null, samples: [] };
      seriesByKey.set(key, series);
    }
    series.samples.push({ tMs: sample.tMs, rawHex: bytesToHex(sample.raw) });
  }

  return {
    schemaVersion: DID_SWEEP_EXPORT_SCHEMA_VERSION,
    schemaNote: DID_SWEEP_EXPORT_SCHEMA_NOTE,
    generatedAtUtc: input.nowIso,
    resumeBound: DID_SWEEP_RESUME_BOUND,
    run: {
      runId: input.run.runId,
      adapterType: input.run.adapterType,
      targetAddress: input.run.targetAddress === null ? null : hexByte(input.run.targetAddress),
      targetAddressNumeric: input.run.targetAddress,
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
      phaseEvidence: c.phaseEvidence,
    })),
    blockCandidates: (input.blockCandidateSummaries ?? []).map((b) => ({
      didHex: didHex(b.did),
      length: b.length,
      sampleCount: b.sampleCount,
      rank: b.rank,
      changedOffsetsByPhase: b.changedOffsetsByPhase,
      phaseEvidence: b.phaseEvidence,
    })),
    observationSeries: [...seriesByKey.values()],
    suggestions: (input.suggestions ?? []).map((s) => ({
      didHex: didHex(s.did),
      kind: s.kind,
      confidence: s.confidence,
      decode: s.decode,
      rationale: s.rationale,
    })),
    observationInsufficientDidHex: [...(input.insufficientDids ?? [])].sort((a, b) => a - b).map(didHex),
    inconsistentDidHex: [...(input.inconsistentDids ?? [])].sort((a, b) => a - b).map(didHex),
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

  // Ticket P4j-FIX1 H3 (binding, after Codex P4j-REV1 HIGH #3): the series and
  // summaries come from the STORE, not only live memory. The pre-fix export
  // read `controller.getGuidedSamples()` alone, so a kill/reopen (or simply
  // starting a second observation, which reset the in-memory array) shared a
  // run whose `observationSeries`, candidates, block offsets and `batchIndex`
  // were all empty.
  //
  // Ticket P4j-FIX2 V3 (binding, after Codex P4j-REV2 NEW MEDIUM #1: "live/
  // store export precedence loses current in-memory samples during a later
  // observation"): reconciled by `(observationId, seq)` -- a UNION, never
  // "pick the longer source" by comparing a per-observation live count
  // against the CUMULATIVE persisted count across every observation of this
  // run (the pre-fix defect: observation A's 320 persisted rows made the
  // whole-run persisted total outweigh observation B's 10 live samples, so
  // storage was chosen wholesale and B's 2 freshest not-yet-checkpointed
  // samples were silently dropped). Every OTHER (earlier) observation's
  // persisted rows are kept as-is; the CURRENT observation's own rows are
  // overlaid/extended by whatever is live -- live is always AT LEAST as
  // complete as its own last checkpoint (`persistedSampleIndex` only ever
  // lags `guidedSamples.length`, never leads it), so this can only ADD
  // samples for the current observation, never lose any.
  const persistedSamples = await store.getObservationSamples(runId).catch(() => []);
  const liveSamples = controller.getGuidedSamples();
  const currentObservationId = snapshot.observationId;
  const mergedSamplesByKey = new Map<string, DidPhaseSample>();
  for (const row of persistedSamples) {
    const phase = row.phase as DidObservationPhaseId;
    mergedSamplesByKey.set(`${row.observationId}:${row.seq}`, {
      did: row.did,
      phase,
      tMs: row.tMs,
      raw: hexToBytes(row.rawHex),
      batchIndex: row.batchIndex ?? undefined,
      observationId: row.observationId,
    });
  }
  if (currentObservationId !== null) {
    liveSamples.forEach((sample, seq) => {
      mergedSamplesByKey.set(`${currentObservationId}:${seq}`, { ...sample, observationId: currentObservationId });
    });
  }
  const observationSamples: readonly DidPhaseSample[] = [...mergedSamplesByKey.values()];

  const persistedSummary = await readLatestObservationSummary(store, runId);
  const useLiveSummary = snapshot.candidateSummaries.length > 0 || snapshot.blockCandidateSummaries.length > 0;

  return buildDidSweepExportDocument({
    run,
    responders,
    candidateSummaries: useLiveSummary ? snapshot.candidateSummaries : persistedSummary?.candidates,
    blockCandidateSummaries: useLiveSummary ? snapshot.blockCandidateSummaries : persistedSummary?.blockCandidates,
    observationSamples,
    suggestions: snapshot.suggestions,
    insufficientDids: useLiveSummary ? snapshot.observationInsufficientDids : persistedSummary?.insufficientDids,
    inconsistentDids: useLiveSummary ? snapshot.inconsistentCandidateDids : persistedSummary?.inconsistentDids,
    nowIso,
  });
}

/** The shape `didSweepController.ts`'s `persistObservationSummary` writes (P4j-FIX1 H3). Read defensively -- a corrupt/older blob degrades to "no summary", never a throw. */
interface PersistedObservationSummary {
  candidates?: DidCandidateSummary[];
  blockCandidates?: DidBlockCandidateSummary[];
  insufficientDids?: number[];
  inconsistentDids?: number[];
}

async function readLatestObservationSummary(store: DidSweepStore, runId: string): Promise<PersistedObservationSummary | null> {
  try {
    const summaries = await store.getObservationSummaries(runId);
    const latest = summaries[summaries.length - 1];
    if (latest === undefined) return null;
    const parsed: unknown = JSON.parse(latest.summaryJson);
    return typeof parsed === 'object' && parsed !== null ? (parsed as PersistedObservationSummary) : null;
  } catch {
    return null;
  }
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
