import type { LapRecord, LocationSample, SqlDatabase, TelemetryChannelId } from '@circuit/core';

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

export const RAW_SESSION_EXPORT_SCHEMA_VERSION = 1;
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
     */
    matchingUnvalidated: boolean;
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
  /** Plain statements about what this document does and does not contain. Never inferred conclusions. */
  notes: string[];
}

export interface RawSessionExportInput {
  generatedAtUtc: string;
  session: StoredSession;
  matchingUnvalidated: boolean;
  lapTraces: readonly RawSessionLapTrace[];
  unclaimedTrace: readonly LocationSample[];
  telemetry: readonly RawSessionTelemetryRow[];
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
    }))
    .sort((a, b) => a.lapNumber - b.lapNumber);
  // Chronological, because the chunk rows are written in key order and a
  // reader of a raw trace wants a drive, not a filing order.
  const unclaimed = [...input.unclaimedTrace].sort((a, b) => a.tMono - b.tMono);
  const telemetry = [...input.telemetry].sort((a, b) => a.tMonoMs - b.tMonoMs);
  const lapSampleCount = laps.reduce((total, lap) => total + lap.sampleCount, 0);
  const channels = [...new Set(telemetry.map((row) => row.channel))].sort();
  const unlappedSampleCount = telemetry.filter((row) => row.lapNumber === null).length;

  const notes: string[] = [
    'Raw recorded data, exactly as stored on the device. No analysis, no smoothing, no derived metrics.',
    'gnss.unclaimed holds every GNSS fix that belongs to no completed lap (out-lap, cool-down, pit) — and the whole drive when no lap was detected.',
  ];
  if (input.session.laps.length === 0) {
    notes.push(
      'This session completed no lap. The timing engine never detected a start/finish crossing, so there are no lap times — the trace below is the drive itself.',
    );
  }
  if (input.matchingUnvalidated) {
    notes.push(
      'This session was started past a REJECTED calibration. Any lap or sector times in it may be wrong or missing. The GNSS and telemetry samples are unaffected: they are measurements, not matched results.',
    );
  }
  if (telemetry.length === 0) {
    notes.push('No OBD or motion-sensor samples were recorded for this session.');
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
      matchingUnvalidated: input.matchingUnvalidated,
    },
    gnss: {
      totalSampleCount: lapSampleCount + unclaimed.length,
      lapSampleCount,
      unclaimedSampleCount: unclaimed.length,
      laps,
      unclaimed,
    },
    telemetry: {
      sampleCount: telemetry.length,
      channels,
      unlappedSampleCount,
      samples: telemetry,
    },
    laps: input.session.laps.map((lap) => ({ ...lap })),
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
  if (doc.session.matchingUnvalidated) {
    lines.push('- Calibration: **not validated** — timing in this session may be unreliable');
  }
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
 * Ticket P7R E1: every UNCLAIMED GNSS chunk row of a session, concatenated.
 *
 * These are the rows `SessionController.flushRawTrace()` writes at negative
 * `lapNumber` (`TRACE_CHUNK_KEY_STRIDE`). Nothing else in the app reads
 * telemetry except by a specific known lap number, which is precisely why
 * they were invisible until now.
 *
 * `ORDER BY lapNumber DESC` is chronological, not merely deterministic: a key
 * is `-(runBase * STRIDE + sequence)`, so a LATER chunk is a MORE negative
 * key. Descending therefore walks the run forwards. The document builder
 * re-sorts by `tMono` anyway (a session id resumed after a crash contributes
 * a second key band), so this ordering is a sensible starting point rather
 * than the guarantee.
 *
 * A row whose payload will not parse is SKIPPED, not fatal: one corrupt chunk
 * out of a thousand must not cost the other nine hundred and ninety-nine.
 */
export async function readUnclaimedGnssTrace(
  db: SqlDatabase,
  sessionId: string,
): Promise<LocationSample[]> {
  const rows = await db.getAllAsync<TelemetryPayloadRow>(
    'SELECT lapNumber, payload FROM telemetry WHERE sessionId = ? AND lapNumber < 0 ORDER BY lapNumber DESC',
    [sessionId],
  );
  const samples: LocationSample[] = [];
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.payload);
      if (Array.isArray(parsed)) samples.push(...(parsed as LocationSample[]));
    } catch (error) {
      console.warn(
        `[rawSessionExport] unreadable trace chunk ${row.lapNumber} of session ${sessionId}`,
        error,
      );
    }
  }
  return samples;
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
  const rows = await db.getAllAsync<TelemetrySampleDbRow>(
    'SELECT lap_number, t_mono_ms, channel, value FROM telemetry_samples WHERE session_id = ? ORDER BY t_mono_ms',
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
  /** The unclaimed chunk trace. */
  loadUnclaimedGnss: (sessionId: string) => Promise<LocationSample[]>;
  /** Every telemetry sample of the session, lapped and unlapped. */
  loadTelemetry: (sessionId: string) => Promise<RawSessionTelemetryRow[]>;
  /** Ticket P7R E2: was this session run past a rejected calibration? */
  isMatchingUnvalidated: (sessionId: string) => boolean;
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

  const lapTraces: RawSessionLapTrace[] = [];
  for (const lap of [...session.laps].sort((a, b) => a.lapNumber - b.lapNumber)) {
    let samples: LocationSample[] = [];
    try {
      samples = await deps.loadLapGnss(sessionId, lap.lapNumber);
    } catch (error) {
      onReadError(error);
    }
    lapTraces.push({ lapNumber: lap.lapNumber, sampleCount: samples.length, samples });
  }

  let unclaimedTrace: LocationSample[] = [];
  try {
    unclaimedTrace = await deps.loadUnclaimedGnss(sessionId);
  } catch (error) {
    onReadError(error);
  }

  let telemetry: RawSessionTelemetryRow[] = [];
  try {
    telemetry = await deps.loadTelemetry(sessionId);
  } catch (error) {
    onReadError(error);
  }

  return buildRawSessionExportDocument({
    generatedAtUtc,
    session,
    matchingUnvalidated: deps.isMatchingUnvalidated(sessionId),
    lapTraces,
    unclaimedTrace,
    telemetry,
  });
}
