import {
  decodeTraceChunkKey,
  type LapRecord,
  type LocationSample,
  type SessionCalibrationStatus,
  type SqlDatabase,
  type TelemetryChannelId,
} from '@circuit/core';

import type { StoredSession } from './mockHistory';

/**
 * Ticket P7R E1 (CRITICAL) — GETTING A ZERO-LAP SESSION OFF THE PHONE.
 *
 * Ticket P7M M1 made the raw GNSS trace survive independently of lap
 * detection: `SessionController` flushes every captured fix into the
 * `telemetry` table under a NEGATIVE `lapNumber` (real laps are >= 1 and a
 * learned out-lap owns 0), and a completed lap later reclaims its own
 * `tStart..tEnd` out of those chunks. That fix works. It is also, on its own,
 * unreachable from the driver's side:
 *
 *   `analysisExport.ts` exports an ANALYSIS, and an analysis requires laps.
 *
 * So on the exact day the P7M fix exists to protect — a first visit to a
 * circuit whose gate geometry has never been validated, where no lap is ever
 * detected — the drive reaches storage and then cannot be got out of the
 * phone. A file the owner cannot send is barely better than a file that was
 * never written.
 *
 * This module is the way out. It is a RAW export, not a report: it reads what
 * is on disk and writes it down, with no engine between. Specifically
 *
 *  - the GNSS trace of every completed lap (`LocalSessionRepository
 *    .loadTelemetry(sessionId, lapNumber)`, exactly as the analysis reads it),
 *  - the UNCLAIMED trace — every negative-`lapNumber` chunk row P7M wrote,
 *    which for a zero-lap session is the ENTIRE drive,
 *  - every recorded OBD/IMU sample of the session, INCLUDING the rows tagged
 *    `lap_number IS NULL` (`telemetryRecorder.ts` tags samples NULL until a
 *    lap exists, so for a zero-lap session that is all of them — and
 *    `telemetryRead.ts`'s existing readers deliberately exclude exactly
 *    those),
 *  - the lap records, if any, and whether the session was run on matching the
 *    calibration gate refused to vouch for (ticket P7R E2).
 *
 * It never requires an analysis, never requires a lap, and never throws: the
 * point of the whole thing is that data comes off the device.
 *
 * WHY THE SHARE HALF IS NOT HERE. `composition.ts` imports this module, and
 * `composition.ts` must stay importable by vitest -- a dozen suites import it
 * directly, and any reach into `react-native` (which `expo-file-system` and
 * `expo-sharing` both make) makes Vite resolve React Native's Flow-typed
 * source and fail the whole file to parse. So this module is pure TypeScript
 * over `@circuit/core` types only, and writing/sharing the files lives in
 * `rawSessionShare.ts`, which only the screens import. The same constraint
 * `composition.ts`'s own doc comments record for the accelerometer rest
 * vector.
 *
 * WHY THE SQL IS HERE rather than in `persistence/telemetryRead.ts`. Both
 * queries exist only for this export and both read rows every other reader
 * deliberately filters OUT (negative lap keys; NULL lap numbers). Keeping
 * them beside the document they populate means a change to one is a change to
 * the other in the same file, and it keeps `telemetryRead.ts`'s per-lap
 * contract — "a lap's rows, and nothing that belongs to no lap" — intact.
 */

/**
 * v2 (ticket P10A) -- three corrections, all of them about the document
 * telling the truth about what it contains:
 *
 *  - H4: chunk samples a half-completed reclaim left owned by BOTH a lap row
 *    and a chunk row are reconciled away, so one fix is exported once.
 *  - MEDIUM (ordering): the unclaimed trace is ordered by RUN, then by
 *    position within the run, instead of by `tMono` -- which is
 *    process-relative and therefore meaningless between two launches of the
 *    same session. `gnss.runs` names the runs.
 *  - H6: `session.calibrationStatus` is three-valued. `matchingUnvalidated`
 *    is retained, unchanged in meaning, for readers of v1 documents.
 */
export const RAW_SESSION_EXPORT_SCHEMA_VERSION = 2;
export const RAW_SESSION_EXPORT_KIND = 'trace-raw-session';

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** One decoded OBD/IMU sample, exactly as the recorder stored it. */
export interface RawSessionTelemetryRow {
  /** The lap it was recorded under, or `null` for a sample that belongs to no lap (which is EVERY sample of a zero-lap session). */
  lapNumber: number | null;
  tMonoMs: number;
  channel: TelemetryChannelId;
  value: number;
}

/** A lap's own stored GNSS trace. */
export interface RawSessionLapTrace {
  lapNumber: number;
  sampleCount: number;
  samples: LocationSample[];
  /**
   * Ticket P10A (MEDIUM, lap 0): `true` when this row exists in storage but
   * the session has no lap RECORD for it -- a learned-circuit out-lap trace
   * stored at lap 0, or a lap row whose session summary was lost. Before
   * this, the export only asked for the lap numbers the session summary
   * listed, so such a row was never read at all.
   */
  orphan?: boolean;
}

/**
 * Ticket P10A: one stored unclaimed chunk row, with the RUN identity its key
 * carries. See `@circuit/core`'s `decodeTraceChunkKey`.
 */
export interface RawSessionTraceChunk {
  /** The stored `telemetry.lapNumber` key -- always negative. */
  key: number;
  /** Which app run wrote it. Runs sort ascending in real time. */
  runBase: number;
  /** Position within that run; ascending is chronological WITHIN the run. */
  sequence: number;
  samples: LocationSample[];
}

export interface RawSessionExportDocument {
  kind: typeof RAW_SESSION_EXPORT_KIND;
  schemaVersion: typeof RAW_SESSION_EXPORT_SCHEMA_VERSION;
  /** Injected, never `Date.now()` inside. */
  generatedAtUtc: string;
  session: {
    sessionId: string;
    circuitId: string;
    layoutId: string;
    dateUtc: string;
    lapCount: number;
    /**
     * Ticket P7R E2: `true` when this session was run past a REJECTED
     * calibration. Its lap and sector times, where there are any, may be
     * wrong or absent. `false` for an ordinary session; the raw GNSS and
     * telemetry below are unaffected either way — they are measurements, not
     * matched results.
     *
     * Ticket P10A H6: kept EXACTLY equal to
     * `calibrationStatus === 'unvalidated'` so a v1 reader is never misled.
     * It cannot express "unknown", which is why `calibrationStatus` exists
     * beside it and is the field to read.
     */
    matchingUnvalidated: boolean;
    /** Ticket P10A H6: the durable three-valued provenance. `'unknown'` is never to be read as calibrated. */
    calibrationStatus: SessionCalibrationStatus;
    /**
     * Ticket P10A H3: GNSS fixes the recorder captured and could NOT write.
     * `0` (or absent, for a session recorded before this was tracked) means
     * the trace below is everything that was captured.
     */
    unwrittenSampleCount: number | null;
    /** Ticket P10A H3: `true` when `unwrittenSampleCount` is known to be greater than zero — this document is SHORT. */
    traceIncomplete: boolean;
  };
  /**
   * The GNSS trace, split by who owns it. `unclaimed` is the P7M chunk trace:
   * out-lap, cool-down, pit — and, when no lap was ever detected, everything.
   */
  gnss: {
    totalSampleCount: number;
    lapSampleCount: number;
    unclaimedSampleCount: number;
    laps: RawSessionLapTrace[];
    unclaimed: LocationSample[];
    /**
     * Ticket P10A (MEDIUM, ordering): the app runs `unclaimed` is assembled
     * from, oldest run first, each one's samples contiguous and in capture
     * order. More than one entry means this session was resumed after a
     * process death — and that its `tMono` values restart at each boundary.
     */
    /**
     * Ticket P10B M8: counted AFTER reconciliation, from the samples this
     * document actually contains. `startIndex` is where this run's block
     * begins in `unclaimed`, so a reader slices rather than accumulates.
     */
    runs: { runBase: number; chunkCount: number; sampleCount: number; startIndex: number }[];
    /**
     * Ticket P10A H4: fixes that were stored in BOTH a lap row and a chunk
     * row (a lap write that committed while its reclaim did not) and were
     * counted once here rather than twice. Non-zero means this device holds
     * a session written before the lap write and its reclaim became one
     * transaction, or one interrupted part-way.
     */
    reconciledDuplicateCount: number;
  };
  telemetry: {
    sampleCount: number;
    /** Distinct channels present, sorted — so a reader can see at a glance what the car actually reported. */
    channels: string[];
    /** Samples with no lap (all of them, for a zero-lap session). */
    unlappedSampleCount: number;
    samples: RawSessionTelemetryRow[];
  };
  /** The lap records as stored. Empty for a zero-lap session — which is the case this export exists for. */
  laps: LapRecord[];
  /**
   * Ticket P14 H2 (Codex P13 round) -- WHICH OF THIS DOCUMENT'S READS FAILED.
   *
   * Each of the reads below (`gnss:lap<N>`, `gnss:unclaimed`,
   * `gnss:storedLapNumbers`, `telemetry`) degrades on its own so a partial
   * failure still ships a document — that part was always right. What was
   * wrong is that the failure went no further than a `console.warn`: the
   * arrays came back empty and every reader above, the session report first
   * among them, presented an UNREADABLE trace as a trace that was read and
   * found to contain nothing.
   *
   * Empty means every read succeeded. A non-empty entry means this document is
   * SHORT in a way that has nothing to do with what the car did.
   */
  readFailures: { part: string; detail: string }[];
  /** Plain statements about what this document does and does not contain. Never inferred conclusions. */
  notes: string[];
}

export interface RawSessionExportInput {
  generatedAtUtc: string;
  session: StoredSession;
  /** Ticket P10A H6. */
  calibrationStatus: SessionCalibrationStatus;
  /** Ticket P10A H3: what the recorder reported it could not store, or `null` when the session predates that bookkeeping. */
  unwrittenSampleCount: number | null;
  lapTraces: readonly RawSessionLapTrace[];
  /** Ticket P10A: the chunk rows WITH their run identity, not a flattened bag of samples. */
  unclaimedChunks: readonly RawSessionTraceChunk[];
  telemetry: readonly RawSessionTelemetryRow[];
  /** Ticket P14 H2: the component reads that threw, if any. Absent is the same as none. */
  readFailures?: readonly { part: string; detail: string }[];
}

/**
 * Ticket P10A H4 — THE DURABLE IDENTITY OF ONE RECORDED FIX.
 *
 * Every field the device stored, in a fixed order. Deliberately NOT `tMono`
 * alone: `tMono` is process-relative and restarts at every launch, so two
 * samples from different runs of the same session can legitimately share one,
 * and deduplicating on it would silently delete a real fix from a resumed
 * drive. A full-field match is the same MEASUREMENT — the same instant, the
 * same position, the same accuracy, speed, heading, altitude and source —
 * which is what a lap row and an unreclaimed chunk row hold two copies of.
 */
function sampleIdentity(sample: LocationSample): string {
  return [
    sample.tMono,
    sample.lat,
    sample.lon,
    sample.accuracyM ?? '',
    sample.speedMps ?? '',
    sample.headingDeg ?? '',
    sample.altitudeM ?? '',
    sample.tUtc ?? '',
    sample.source,
  ].join('|');
}

/**
 * Ticket P10A H4: drops from the unclaimed trace exactly those fixes a lap
 * row ALSO holds.
 *
 * Two guards keep this from ever deleting a genuine fix:
 *
 *  1. a candidate must fall inside a range a lap row actually CLAIMS (a lap
 *     record's `tStart..tEnd`, or -- for a stored row the session summary
 *     does not list -- that row's own span), so a chunk sample from a
 *     different phase of the drive is never even considered; and
 *  2. it must match an UNCONSUMED lap-row sample by {@link sampleIdentity}.
 *     Matches are consumed one for one, so if a lap row holds one copy and
 *     the chunks hold two genuinely distinct captures, exactly one is
 *     removed.
 */
function reconcileUnclaimed(
  lapTraces: readonly RawSessionLapTrace[],
  laps: readonly LapRecord[],
  unclaimed: readonly TaggedSample[],
): { kept: TaggedSample[]; removed: number } {
  const available = new Map<string, number>();
  for (const trace of lapTraces) {
    for (const sample of trace.samples) {
      const id = sampleIdentity(sample);
      available.set(id, (available.get(id) ?? 0) + 1);
    }
  }
  if (available.size === 0) return { kept: [...unclaimed], removed: 0 };

  const claimedRanges: { from: number; to: number }[] = laps.map((lap) => ({
    from: Math.min(lap.tStart, lap.tEnd),
    to: Math.max(lap.tStart, lap.tEnd),
  }));
  const recordedLapNumbers = new Set(laps.map((lap) => lap.lapNumber));
  for (const trace of lapTraces) {
    if (recordedLapNumbers.has(trace.lapNumber) || trace.samples.length === 0) continue;
    // An orphan row (lap 0's learn trace, say) has no lap record to give a
    // range, so it claims exactly the span of what it stores.
    let from = trace.samples[0]!.tMono;
    let to = from;
    for (const sample of trace.samples) {
      if (sample.tMono < from) from = sample.tMono;
      if (sample.tMono > to) to = sample.tMono;
    }
    claimedRanges.push({ from, to });
  }
  if (claimedRanges.length === 0) return { kept: [...unclaimed], removed: 0 };

  const kept: TaggedSample[] = [];
  let removed = 0;
  for (const tagged of unclaimed) {
    const sample = tagged.sample;
    const inClaimedRange = claimedRanges.some(
      (range) => sample.tMono >= range.from && sample.tMono <= range.to,
    );
    if (inClaimedRange) {
      const id = sampleIdentity(sample);
      const remaining = available.get(id) ?? 0;
      if (remaining > 0) {
        available.set(id, remaining - 1);
        removed += 1;
        continue;
      }
    }
    kept.push(tagged);
  }
  return { kept, removed };
}

/**
 * Ticket P10B M8: one unclaimed fix WITH the run and chunk row it came out
 * of, carried through reconciliation so the exported run counts can be
 * computed from what actually shipped.
 */
interface TaggedSample {
  sample: LocationSample;
  runBase: number;
  key: number;
}

/**
 * Builds the standalone, versioned document. Pure: every input is passed in,
 * nothing is read here, and no value is derived from anything but the rows
 * given. The mapping is deliberately explicit (the same discipline
 * `analysisExport.ts`'s C7 fix established) so a change in what the app
 * stores has to come through this function to change what is exported.
 */
export function buildRawSessionExportDocument(
  input: RawSessionExportInput,
): RawSessionExportDocument {
  const laps = [...input.lapTraces]
    .map((trace) => ({
      lapNumber: trace.lapNumber,
      sampleCount: trace.samples.length,
      samples: [...trace.samples],
      ...(trace.orphan === true ? { orphan: true as const } : {}),
    }))
    .sort((a, b) => a.lapNumber - b.lapNumber);

  // Ticket P10A (MEDIUM, ordering): run by run, then chunk by chunk, then in
  // stored order. NEVER a global sort on `tMono` -- see
  // `decodeTraceChunkKey`'s doc comment for why that scrambles a resumed
  // session's drive instead of ordering it.
  const orderedChunks = [...input.unclaimedChunks].sort(
    (a, b) => a.runBase - b.runBase || a.sequence - b.sequence || a.key - b.key,
  );
  const rawUnclaimed: TaggedSample[] = [];
  for (const chunk of orderedChunks) {
    for (const sample of chunk.samples) {
      rawUnclaimed.push({ sample, runBase: chunk.runBase, key: chunk.key });
    }
  }

  // Ticket P10A H4: one fix, exported once.
  const reconciled = reconcileUnclaimed(laps, input.session.laps, rawUnclaimed);
  const unclaimed = reconciled.kept.map((tagged) => tagged.sample);

  // Ticket P10B M8 -- THE RUN COUNTS DESCRIBE WHAT SHIPPED, NOT WHAT WAS
  // READ. They were computed from the chunk rows BEFORE reconciliation while
  // `unclaimed` held the samples AFTER it, so a run whose only fix was a
  // duplicate of a lap-row sample still claimed one sample in the export --
  // and a consumer walking `runs` in order (their only purpose: `tMono` is
  // not comparable across runs, so the boundaries are how you split the
  // array) then attributed the NEXT run's fix to the previous run. The
  // reviewer reproduced exactly that with one fix in each of two runs.
  //
  // Counted from the reconciled array instead, with each sample's run
  // identity intact, plus the index it starts at so the boundary is stated
  // rather than inferred. A run that contributed nothing to `unclaimed` is
  // not listed: it shipped no samples to be bounded.
  const runTotals = new Map<number, { chunkCount: number; sampleCount: number; startIndex: number; keys: Set<number> }>();
  reconciled.kept.forEach((tagged, index) => {
    const totals = runTotals.get(tagged.runBase) ?? {
      chunkCount: 0,
      sampleCount: 0,
      startIndex: index,
      keys: new Set<number>(),
    };
    totals.sampleCount += 1;
    totals.keys.add(tagged.key);
    totals.chunkCount = totals.keys.size;
    runTotals.set(tagged.runBase, totals);
  });
  const runs = [...runTotals.entries()]
    .map(([runBase, totals]) => ({
      runBase,
      chunkCount: totals.chunkCount,
      sampleCount: totals.sampleCount,
      startIndex: totals.startIndex,
    }))
    .sort((a, b) => a.runBase - b.runBase);

  // Ticket P10A (MEDIUM, ordering): sensor rows arrive in storage (rowid)
  // order, which IS capture order across launches. Re-sorting them on
  // `t_mono_ms` -- as this did -- put a resumed run's first seconds before
  // the pre-crash drive, for exactly the reason the GNSS chunks do not sort
  // that way either.
  const telemetry = [...input.telemetry];
  const lapSampleCount = laps.reduce((total, lap) => total + lap.sampleCount, 0);
  const channels = [...new Set(telemetry.map((row) => row.channel))].sort();
  const unlappedSampleCount = telemetry.filter((row) => row.lapNumber === null).length;
  const orphanLapNumbers = laps.filter((lap) => lap.orphan === true).map((lap) => lap.lapNumber);
  const traceIncomplete = (input.unwrittenSampleCount ?? 0) > 0;

  const notes: string[] = [
    'Raw recorded data, exactly as stored on the device. No analysis, no smoothing, no derived metrics.',
    'gnss.unclaimed holds every GNSS fix that belongs to no completed lap (out-lap, cool-down, pit) — and the whole drive when no lap was detected.',
  ];
  if (input.session.laps.length === 0) {
    notes.push(
      'This session completed no lap. The timing engine never detected a start/finish crossing, so there are no lap times — the trace below is the drive itself.',
    );
  }
  if (input.calibrationStatus === 'unvalidated') {
    notes.push(
      'This session was started past a REJECTED calibration. Any lap or sector times in it may be wrong or missing. The GNSS and telemetry samples are unaffected: they are measurements, not matched results.',
    );
  } else if (input.calibrationStatus === 'unknown') {
    notes.push(
      'Calibration status UNKNOWN for this session: the device holds no record of whether its matching was ever validated. Treat any lap or sector times as unverified. The GNSS and telemetry samples are unaffected: they are measurements, not matched results.',
    );
  }
  if (traceIncomplete) {
    notes.push(
      `INCOMPLETE RECORDING: ${String(input.unwrittenSampleCount)} captured GNSS fix(es) could not be written to storage and are NOT in this file. The trace below is shorter than the drive.`,
    );
  }
  if (runs.length > 1) {
    notes.push(
      `This session was recorded across ${String(runs.length)} app runs (a resume after the app stopped). gnss.unclaimed is ordered run by run; tMono restarts at each run boundary and is not comparable between runs.`,
    );
  }
  if (reconciled.removed > 0) {
    notes.push(
      `${String(reconciled.removed)} GNSS fix(es) were stored in both a lap row and an unclaimed chunk (an interrupted reclaim) and are counted once here, not twice.`,
    );
  }
  if (orphanLapNumbers.length > 0) {
    notes.push(
      `Stored GNSS rows with no matching lap record were included: lap ${orphanLapNumbers.join(', ')}. Lap 0 is a learned-circuit out-lap trace.`,
    );
  }
  const readFailures = [...(input.readFailures ?? [])];
  if (telemetry.length === 0) {
    // Ticket P14 H2: "nothing was recorded" is a CLAIM, and it may only be
    // made when the read that would have found something actually ran.
    notes.push(
      readFailures.some((failure) => failure.part === 'telemetry')
        ? 'The OBD/motion-sample read FAILED for this session. This file carries no telemetry, which is NOT the same as the car having reported none -- see `readFailures`.'
        : 'No OBD or motion-sensor samples were recorded for this session.',
    );
  }
  for (const failure of readFailures) {
    notes.push(
      `Could not read "${failure.part}": ${failure.detail}. Whatever that read would have returned is MISSING from this file and its absence here is evidence of nothing.`,
    );
  }

  return {
    kind: RAW_SESSION_EXPORT_KIND,
    schemaVersion: RAW_SESSION_EXPORT_SCHEMA_VERSION,
    generatedAtUtc: input.generatedAtUtc,
    session: {
      sessionId: input.session.sessionId,
      circuitId: input.session.circuitId,
      layoutId: input.session.layoutId,
      dateUtc: input.session.displayDateUtc,
      lapCount: input.session.laps.length,
      matchingUnvalidated: input.calibrationStatus === 'unvalidated',
      calibrationStatus: input.calibrationStatus,
      unwrittenSampleCount: input.unwrittenSampleCount,
      traceIncomplete,
    },
    gnss: {
      totalSampleCount: lapSampleCount + unclaimed.length,
      lapSampleCount,
      unclaimedSampleCount: unclaimed.length,
      laps,
      unclaimed,
      runs,
      reconciledDuplicateCount: reconciled.removed,
    },
    telemetry: {
      sampleCount: telemetry.length,
      channels,
      unlappedSampleCount,
      samples: telemetry,
    },
    laps: input.session.laps.map((lap) => ({ ...lap })),
    readFailures,
    notes,
  };
}

// ---------------------------------------------------------------------------
// File naming — the same one-sanitizer discipline `analysisExport.ts` uses.
// ---------------------------------------------------------------------------

export const RAW_SESSION_EXPORT_UNDATED = 'undated';

function sanitizeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function normalizeDate(value: string): string {
  const day = value.trim().slice(0, 10).replace(/[^0-9]/g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return RAW_SESSION_EXPORT_UNDATED;
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || date < 1 || date > 31 || year < 1_000) {
    return RAW_SESSION_EXPORT_UNDATED;
  }
  return day;
}

/**
 * `trace-raw-<circuit>-<yyyy-mm-dd>-<session>.<ext>`. The session id is part
 * of the name because a zero-lap day can easily produce several attempts on
 * the same date, and two files that overwrite each other in the cache would
 * be a new way to lose the drive.
 */
export function rawSessionExportFileName(doc: RawSessionExportDocument, ext: 'json' | 'md'): string {
  const prefix = sanitizeSegment(RAW_SESSION_EXPORT_KIND.replace(/-session$/, ''));
  const circuit = sanitizeSegment(doc.session.circuitId);
  const date = sanitizeSegment(normalizeDate(doc.session.dateUtc));
  const session = sanitizeSegment(doc.session.sessionId).slice(0, 24);
  return (
    [prefix, circuit, date, session].filter((segment) => segment.length > 0).join('-') + `.${ext}`
  );
}

// ---------------------------------------------------------------------------
// Summary (a bonus; the JSON is the point)
// ---------------------------------------------------------------------------

function durationMs(samples: readonly LocationSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  return Math.max(0, last.tMono - first.tMono);
}

/**
 * A short human-readable companion. Deliberately short: this document's
 * audience is a parser, and the summary exists only so the person forwarding
 * the file can see at a glance that it is not empty.
 */
export function buildRawSessionSummaryMarkdown(doc: RawSessionExportDocument): string {
  const spanMs = durationMs(doc.gnss.unclaimed);
  const lines: string[] = [
    `# Raw session — ${doc.session.circuitId}`,
    '',
    `- Session: \`${doc.session.sessionId}\``,
    `- Date: ${doc.session.dateUtc}`,
    `- Layout: ${doc.session.layoutId}`,
    `- Laps recorded: ${doc.session.lapCount}`,
    `- GNSS fixes: ${doc.gnss.totalSampleCount} (${doc.gnss.lapSampleCount} in laps, ${doc.gnss.unclaimedSampleCount} unclaimed)`,
    spanMs === null
      ? '- Unclaimed trace span: not measurable (fewer than two fixes)'
      : `- Unclaimed trace span: ${Math.round(spanMs / 1_000)} s`,
    `- Telemetry samples: ${doc.telemetry.sampleCount}${
      doc.telemetry.channels.length === 0 ? '' : ` across ${doc.telemetry.channels.join(', ')}`
    }`,
  ];
  // Ticket P10A H6/H7: the calibration line is UNCONDITIONAL. A summary that
  // simply omits it when the status is not "rejected" reads, to the person
  // forwarding the file, as a session that was calibrated -- which is the
  // exact claim an unknown provenance is not entitled to make.
  lines.push(
    doc.session.calibrationStatus === 'unvalidated'
      ? '- Calibration: **not validated** — timing in this session may be unreliable'
      : doc.session.calibrationStatus === 'unknown'
        ? '- Calibration: **unknown** — the device holds no record of whether matching was validated'
        : '- Calibration: validated',
  );
  if (doc.session.traceIncomplete) {
    lines.push(
      `- Recording: **INCOMPLETE** — ${String(doc.session.unwrittenSampleCount)} captured GNSS fix(es) were never written to storage`,
    );
  }
  // Ticket P14 H2: UNCONDITIONAL, for the same reason the calibration line
  // above is. A reader deciding whether this file is worth anything has to be
  // told, at the top, that part of it could not be read — an empty section in
  // a file that says nothing about its own reads is indistinguishable from a
  // section that was read and found empty.
  lines.push(
    doc.readFailures.length === 0
      ? '- Reads: every part of this record was read successfully'
      : `- Reads: **${String(doc.readFailures.length)} FAILED** — ${doc.readFailures
          .map((failure) => failure.part)
          .join(', ')}. Those parts are missing from this file and their absence proves nothing.`,
  );
  lines.push('', '## Notes');
  for (const note of doc.notes) lines.push(`- ${note}`);
  lines.push('', `_${doc.kind} v${doc.schemaVersion} · generated ${doc.generatedAtUtc}_`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

interface TelemetryPayloadRow {
  lapNumber: number;
  payload: string;
}

/**
 * Ticket P7R E1 / P10A: every UNCLAIMED GNSS chunk row of a session, WITH the
 * run identity its key carries.
 *
 * These are the rows `SessionController.flushRawTrace()` writes at negative
 * `lapNumber` (`TRACE_CHUNK_KEY_STRIDE`). Nothing else in the app reads
 * telemetry except by a specific known lap number, which is precisely why
 * they were invisible until P7R E1.
 *
 * `ORDER BY lapNumber DESC` walks a single run forwards (a key is
 * `-(runBase * STRIDE + sequence)`, so a LATER chunk is a MORE negative key)
 * and also orders the runs themselves oldest-first, since `runBase` is the
 * high half. The caller re-sorts on the decoded `(runBase, sequence)` anyway
 * rather than trusting the arithmetic of the key ordering.
 *
 * Ticket P10A (MEDIUM, ordering): the run identity is the whole point of
 * returning chunks instead of a flat sample list. The previous reader threw
 * the keys away and the builder then sorted the samples by `tMono`, which is
 * process-relative -- so a resumed session's first seconds sorted BEFORE the
 * drive that preceded the crash.
 *
 * A row whose payload will not parse is SKIPPED, not fatal: one corrupt chunk
 * out of a thousand must not cost the other nine hundred and ninety-nine.
 */
export async function readUnclaimedGnssChunks(
  db: SqlDatabase,
  sessionId: string,
): Promise<RawSessionTraceChunk[]> {
  const rows = await db.getAllAsync<TelemetryPayloadRow>(
    'SELECT lapNumber, payload FROM telemetry WHERE sessionId = ? AND lapNumber < 0 ORDER BY lapNumber DESC',
    [sessionId],
  );
  const chunks: RawSessionTraceChunk[] = [];
  for (const row of rows) {
    const decoded = decodeTraceChunkKey(row.lapNumber);
    if (decoded === null) continue;
    try {
      const parsed: unknown = JSON.parse(row.payload);
      if (!Array.isArray(parsed)) continue;
      const samples = parsed as LocationSample[];
      if (samples.length === 0) continue;
      chunks.push({ key: row.lapNumber, ...decoded, samples });
    } catch (error) {
      console.warn(
        `[rawSessionExport] unreadable trace chunk ${row.lapNumber} of session ${sessionId}`,
        error,
      );
    }
  }
  chunks.sort((a, b) => a.runBase - b.runBase || a.sequence - b.sequence || a.key - b.key);
  return chunks;
}

/** The same rows flattened into capture order (run by run). Kept for callers that only want the samples. */
export async function readUnclaimedGnssTrace(
  db: SqlDatabase,
  sessionId: string,
): Promise<LocationSample[]> {
  const chunks = await readUnclaimedGnssChunks(db, sessionId);
  return chunks.flatMap((chunk) => chunk.samples);
}

/**
 * Ticket P10A (MEDIUM, lap 0) -- WHICH GNSS LAP ROWS THIS SESSION ACTUALLY
 * HAS ON DISK.
 *
 * The export used to derive its lap-row reads purely from the session
 * summary's lap RECORDS. A learned-circuit session stores its out-lap
 * learning trace at `lapNumber = 0` with no completed-lap record and, on a
 * run that never crossed the line, no negative chunks either -- so the export
 * asked for nothing and produced an empty document for a session whose drive
 * was sitting in row 0 the whole time.
 *
 * Never throws: an unreadable index degrades to "no extra rows", which is the
 * pre-P10A behaviour, not a failed export.
 */
export async function readStoredGnssLapNumbers(
  db: SqlDatabase,
  sessionId: string,
): Promise<number[]> {
  const rows = await db.getAllAsync<{ lapNumber: number }>(
    'SELECT lapNumber FROM telemetry WHERE sessionId = ? AND lapNumber >= 0 ORDER BY lapNumber ASC',
    [sessionId],
  );
  return rows.map((row) => row.lapNumber);
}

interface TelemetrySampleDbRow {
  lap_number: number | null;
  t_mono_ms: number;
  channel: TelemetryChannelId;
  value: number;
}

/**
 * Ticket P7R E1: EVERY recorded OBD/IMU sample of a session, lapped and
 * unlapped alike.
 *
 * The distinction from `telemetryRead.ts`'s `readSessionTelemetryByLap` is
 * the whole point: that reader excludes `lap_number IS NULL` rows because the
 * analysis consumes telemetry per lap and a sample belonging to no lap has
 * nowhere to go. For a session with no laps, those excluded rows ARE the
 * session.
 */
export async function readAllSessionTelemetry(
  db: SqlDatabase,
  sessionId: string,
): Promise<RawSessionTelemetryRow[]> {
  // Ticket P10A (MEDIUM, ordering): `rowid`, not `t_mono_ms`. The recorder
  // appends, so rowid order IS capture order -- including across a resume,
  // where `t_mono_ms` restarts from the new process's origin and would sort
  // the resumed run's samples in among (or before) the pre-crash ones.
  const rows = await db.getAllAsync<TelemetrySampleDbRow>(
    'SELECT lap_number, t_mono_ms, channel, value FROM telemetry_samples WHERE session_id = ? ORDER BY rowid',
    [sessionId],
  );
  return rows.map((row) => ({
    lapNumber: row.lap_number === null ? null : row.lap_number,
    tMonoMs: row.t_mono_ms,
    channel: row.channel,
    value: row.value,
  }));
}

/** Why a session could not be exported. Always a NAMED reason, never a silent empty file. */
export type RawSessionExportUnavailable = 'session-not-found' | 'storage-unavailable';

export interface RawSessionExportDeps {
  /** The stored session, or `null` when it is not on the device. */
  getSession: (sessionId: string) => StoredSession | null;
  /** A completed lap's stored GNSS trace (`LocalSessionRepository.loadTelemetry`). */
  loadLapGnss: (sessionId: string, lapNumber: number) => Promise<LocationSample[]>;
  /** Ticket P10A (MEDIUM, ordering): the unclaimed chunk rows, run identity intact. */
  loadUnclaimedGnss: (sessionId: string) => Promise<readonly RawSessionTraceChunk[]>;
  /**
   * Ticket P10A (MEDIUM, lap 0): every GNSS lap row this session actually has
   * stored, regardless of whether a lap RECORD names it. Optional so a caller
   * with no way to enumerate rows (the web preview's in-memory repository)
   * still exports what the lap records name.
   */
  listStoredGnssLapNumbers?: (sessionId: string) => Promise<readonly number[]>;
  /** Every telemetry sample of the session, lapped and unlapped. */
  loadTelemetry: (sessionId: string) => Promise<RawSessionTelemetryRow[]>;
  /** Ticket P10A H6: the DURABLE three-valued provenance of this session's matching. */
  calibrationStatus: (sessionId: string) => SessionCalibrationStatus;
  /** Ticket P10A H3: GNSS fixes the recorder could not write, or `null` when the session predates that bookkeeping. */
  unwrittenSampleCount?: (sessionId: string) => number | null;
  /** Where a partial read failure is reported. Defaults to `console.warn`. */
  onReadError?: (error: unknown) => void;
}

/**
 * Assembles the document for one stored session.
 *
 * NEVER REJECTS on a partial failure. Each of the three reads is independent
 * and each degrades on its own: a failed telemetry read still exports the
 * GNSS trace, a failed chunk read still exports the laps, and a lap whose
 * trace will not load contributes zero samples rather than failing the
 * export. The document records what it actually contains, so a short export
 * is visible as a short export rather than presented as a complete one.
 *
 * The only hard failure is a session that is not on the device at all, which
 * comes back as a NAMED reason.
 */
export async function loadRawSessionExportDocument(
  deps: RawSessionExportDeps,
  sessionId: string,
  generatedAtUtc: string,
): Promise<RawSessionExportDocument | RawSessionExportUnavailable> {
  const onReadError =
    deps.onReadError ?? ((error: unknown) => console.warn('[rawSessionExport] read failed', error));
  const session = deps.getSession(sessionId);
  if (session === null) return 'session-not-found';

  /**
   * Ticket P14 H2: every component read that threw, carried INTO the document
   * rather than only into a log. The degradation is unchanged -- a failed
   * telemetry read still exports the GNSS trace -- but the resulting document
   * now says which of its parts is empty because it was read and which is
   * empty because it could not be.
   */
  const readFailures: { part: string; detail: string }[] = [];
  function noteFailure(part: string, error: unknown): void {
    onReadError(error);
    readFailures.push({ part, detail: error instanceof Error ? error.message : String(error) });
  }

  // Ticket P10A (MEDIUM, lap 0): the union of the lap numbers the session
  // RECORDS name and the lap numbers actually PRESENT in storage. Rows in the
  // second set but not the first are flagged `orphan` so the document says
  // where they came from rather than quietly presenting them as laps.
  const recordedLapNumbers = [...session.laps].map((lap) => lap.lapNumber);
  let storedLapNumbers: readonly number[] = [];
  if (deps.listStoredGnssLapNumbers !== undefined) {
    try {
      storedLapNumbers = await deps.listStoredGnssLapNumbers(sessionId);
    } catch (error) {
      noteFailure('gnss:storedLapNumbers', error);
    }
  }
  const recorded = new Set(recordedLapNumbers);
  const lapNumbers = [...new Set([...recordedLapNumbers, ...storedLapNumbers])].sort(
    (a, b) => a - b,
  );

  const lapTraces: RawSessionLapTrace[] = [];
  for (const lapNumber of lapNumbers) {
    let samples: LocationSample[] = [];
    try {
      samples = await deps.loadLapGnss(sessionId, lapNumber);
    } catch (error) {
      noteFailure(`gnss:lap${String(lapNumber)}`, error);
    }
    const orphan = !recorded.has(lapNumber);
    // An orphan row that turns out to be empty is not worth a line in the
    // document -- it is an emptied/reclaimed row, not lost data.
    if (orphan && samples.length === 0) continue;
    lapTraces.push({
      lapNumber,
      sampleCount: samples.length,
      samples,
      ...(orphan ? { orphan: true } : {}),
    });
  }

  let unclaimedChunks: readonly RawSessionTraceChunk[] = [];
  try {
    unclaimedChunks = await deps.loadUnclaimedGnss(sessionId);
  } catch (error) {
    noteFailure('gnss:unclaimed', error);
  }

  let telemetry: RawSessionTelemetryRow[] = [];
  try {
    telemetry = await deps.loadTelemetry(sessionId);
  } catch (error) {
    noteFailure('telemetry', error);
  }

  return buildRawSessionExportDocument({
    generatedAtUtc,
    session,
    calibrationStatus: deps.calibrationStatus(sessionId),
    unwrittenSampleCount: deps.unwrittenSampleCount?.(sessionId) ?? null,
    lapTraces,
    unclaimedChunks,
    telemetry,
    readFailures,
  });
}
