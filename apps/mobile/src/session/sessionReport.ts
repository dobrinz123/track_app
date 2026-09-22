import {
  mergeLapValidityVerdicts,
  summarizeLapVerdicts,
  type CalibrationAttemptRecord,
  type LapRecord,
  type LapValidityVerdict,
  type LapVerdictAnswer,
  type SessionCalibrationStatus,
} from '@circuit/core';

import type { StoredSession } from './mockHistory';
import type {
  RawSessionExportDocument,
  RawSessionExportUnavailable,
} from './rawSessionExport';

/**
 * Ticket P12 item C (binding) -- ONE COMPLETE REPORT PER SESSION.
 *
 * Build 12 exists to COLLECT, so that build 13 can be accurate. Four review
 * rounds have established that lap boundaries and lap labels can still be
 * wrong in narrow cases while the raw GNSS and OBD data always survive; this
 * document therefore stops trying to be right and concentrates on recording
 * everything needed to work out afterwards what right would have been.
 *
 * It is a SUPERSET of `rawSessionExport.ts`'s document, which it embeds whole
 * rather than restating: the raw export is already the honest record of what
 * fixes and samples are on the device, and duplicating it here would create
 * two answers to the same question. What this adds is everything the raw
 * export deliberately leaves out because it is not a measurement:
 *
 *  - the circuit's identity, layout version and `geometryStatus` (item C);
 *  - every calibration attempt of the session, including the ones that
 *    stalled or were cancelled (item B);
 *  - every lap with the owner's verdict on the app's verdict (item A),
 *    INCLUDING the laps he never got to;
 *  - the trace-completeness figures, stated even when unknown.
 *
 * TWO RULES GOVERN EVERY FIELD BELOW.
 *
 *  1. VERSIONED AND SELF-DESCRIBING. `kind` + `schemaVersion` at the top, and
 *     nothing in it is derived from anything but the inputs passed in.
 *  2. HONEST ABOUT WHAT IS MISSING. Every part carries an entry in
 *     `availability` saying whether it is present, genuinely empty,
 *     unavailable on this device, or failed to read -- so a consumer NEVER has
 *     to guess whether an absent field means "not measured" or "measured as
 *     nothing". That distinction is the one this whole ticket turns on.
 *
 * NO UI AND NO FILE IO LIVE HERE, for the same reason `rawSessionExport.ts`
 * has none: `composition.ts` imports this module and must stay importable by
 * vitest, which any reach into `react-native` breaks. The export button and
 * the file writing belong to the next worker.
 */
export const SESSION_REPORT_SCHEMA_VERSION = 1;
export const SESSION_REPORT_KIND = 'trace-session-report';

// ---------------------------------------------------------------------------
// Honesty bookkeeping
// ---------------------------------------------------------------------------

/**
 * The four answers a part of this document can give about itself. They are
 * deliberately four and not two:
 *
 *  - `'present'`     -- read, and it has content.
 *  - `'empty'`       -- read, and there genuinely was nothing. (No lap was
 *                       completed; no calibration attempt was made.)
 *  - `'unavailable'` -- this device cannot answer. The store does not
 *                       implement it, or bootstrap never built one.
 *  - `'failed'`      -- a read was attempted and threw. `detail` says what.
 *
 * `'empty'` and `'unavailable'` being different values IS the requirement: an
 * absent array must never be readable as "measured as nothing".
 */
export type SessionReportPartState = 'present' | 'empty' | 'unavailable' | 'failed';

export interface SessionReportAvailability {
  /** Which part of the document this is about, e.g. `'gnss'`, `'lapVerdicts'`. */
  part: string;
  state: SessionReportPartState;
  /** What was read, where a count is meaningful. */
  count?: number;
  /** Why, for `'unavailable'` and `'failed'`. Plain language. */
  detail?: string;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

/** The circuit this session was driven on, as the device's catalog describes it. */
export interface SessionReportCircuit {
  circuitId: string;
  displayName: string;
  layoutId: string;
  layoutVersion: number;
  /**
   * How the geometry got here. `'ad-hoc'` is geometry LEARNED on device from
   * one lap of driving -- never surveyed, never validated on track -- and the
   * single field every honesty gate in the app reads. Recorded because a lap
   * boundary computed against unvalidated geometry and one computed against a
   * surveyed layout are not the same kind of evidence.
   */
  geometryStatus: string;
  sectorStatus: string;
  direction: string;
  totalLengthM: number;
  corridorWidthM: number;
  profileSchemaVersion: number;
}

/** One lap, with the app's verdict and the owner's verdict on that verdict. */
export interface SessionReportLap {
  lap: LapRecord;
  /** Item A. Always present for every lap -- `'unanswered'` when nobody judged it. */
  verdict: LapValidityVerdict;
}

/** What is known about how completely this session's trace reached storage. */
export interface SessionReportRecording {
  /** GNSS fixes durably written, when a live controller reported it; `null` when only the stored row is available. */
  persistedSampleCount: number | null;
  /** Captured fixes that never reached storage. `null` for a session recorded before this was tracked. */
  unwrittenSampleCount: number | null;
  /** Write attempts that failed, including ones a retry later rescued. `null` when unknown. */
  failedWriteCount: number | null;
  /** `true` only when `unwrittenSampleCount` is KNOWN to be greater than zero. Never inferred from a `null`. */
  traceIncomplete: boolean;
  /**
   * Ticket P14 H3 (Codex P13 round): did the recording of this session ever
   * FINISH? `true` only after `endSession()` wrote the final row; `false` for
   * a session the app was still recording when it stopped; `null` for one
   * recorded before this was tracked.
   */
  recordingFinalized: boolean | null;
  /**
   * Ticket P14 H3 -- THE FIELD A READER SHOULD ACTUALLY READ.
   *
   *  - `'incomplete'` -- `unwrittenSampleCount` is KNOWN to be greater than
   *                      zero. The trace is short and by how much is stated.
   *  - `'complete'`   -- zero unwritten AND the recording was finalised. Both
   *                      halves are required: a zero from a session that never
   *                      finished is the last figure written before it was
   *                      interrupted, not a verdict on the whole recording.
   *  - `'unknown'`    -- anything else. Including the case the reviewer caught:
   *                      zero unwritten on a session whose recording was never
   *                      finalised, which the old code reported as "complete
   *                      (no captured fix went unwritten)".
   */
  completeness: 'complete' | 'incomplete' | 'unknown';
}

/**
 * Anything else a tool in the app produced for this session -- a suggestion
 * record, an adoption journal, an analysis result. Deliberately opaque: this
 * document's job is to carry it off the device intact, not to understand it.
 */
export interface SessionReportExtra {
  /** What produced it, e.g. `'trackdayRecord'`. */
  source: string;
  /** What it is, in one line, for a human reading the file. */
  description: string;
  /** The payload, exactly as the tool produced it. */
  data: unknown;
  /**
   * Ticket P13B item 4 (binding, owner's words: "if a tool has no report, say
   * so in the document instead of omitting it").
   *
   * The aggregate `extras` availability row says how many tools answered; it
   * cannot say which tool had nothing and which one could not be asked. So
   * every extra carries its OWN state, and
   * {@link buildSessionReportDocument} emits one `extras:<source>` row per
   * entry alongside the aggregate. A tool that produced nothing is listed
   * with `data: null` and `state: 'empty'`, never dropped -- a missing row is
   * exactly the ambiguity rule 2 exists to remove.
   *
   * Defaults to `'present'` when omitted, which is what every pre-P13B caller
   * meant by passing an entry at all.
   */
  state?: SessionReportPartState;
  /** Why, for `'empty'`, `'unavailable'` and `'failed'`. Plain language. */
  detail?: string;
}

export interface SessionReportDocument {
  kind: typeof SESSION_REPORT_KIND;
  schemaVersion: typeof SESSION_REPORT_SCHEMA_VERSION;
  /** Injected, never `Date.now()` inside. */
  generatedAtUtc: string;
  session: {
    sessionId: string;
    startedAtUtc: string;
    circuitId: string;
    layoutId: string;
    lapCount: number;
    /** Item C: the three-valued provenance. `'unknown'` is never to be read as calibrated. */
    calibrationStatus: SessionCalibrationStatus;
  };
  /** `null` when the device could not identify the circuit -- see `availability`. */
  circuit: SessionReportCircuit | null;
  /** Item B: every calibration attempt of this session, oldest first. Empty AND unavailable are distinguished in `availability`. */
  calibrationAttempts: CalibrationAttemptRecord[];
  /** Item A: one entry per lap, plus any answer for a lap the session no longer lists. */
  laps: SessionReportLap[];
  /** Item A: how many laps fall into each bucket. `unanswered` is the figure that says how much of the check actually got done. */
  verdictSummary: Record<LapVerdictAnswer, number>;
  recording: SessionReportRecording;
  /**
   * Item C: the complete raw record -- GNSS (lap rows AND the unclaimed chunks
   * a zero-lap session produces), every OBD/IMU channel, the lap records, and
   * that document's own notes. `null` when it could not be built at all.
   */
  raw: RawSessionExportDocument | null;
  extras: SessionReportExtra[];
  /** Rule 2. One entry per part of this document; nothing is silently omitted. */
  availability: SessionReportAvailability[];
  /** Plain statements about what this document does and does not contain. Never inferred conclusions. */
  notes: string[];
}

// ---------------------------------------------------------------------------
// The builder (pure)
// ---------------------------------------------------------------------------

export interface SessionReportInput {
  generatedAtUtc: string;
  session: StoredSession;
  calibrationStatus: SessionCalibrationStatus;
  circuit: SessionReportCircuit | null;
  /** `null` means UNAVAILABLE (no store to ask); an empty array means genuinely none. */
  calibrationAttempts: readonly CalibrationAttemptRecord[] | null;
  /** `null` means UNAVAILABLE; an empty array means the owner answered nothing. */
  lapVerdicts: readonly LapValidityVerdict[] | null;
  recording: SessionReportRecording;
  raw: RawSessionExportDocument | null;
  extras: readonly SessionReportExtra[];
  /** Parts that failed to read, with their reasons -- merged into `availability`. */
  failures?: readonly { part: string; detail: string }[];
}

/**
 * Builds the document. Pure: every input is passed in, nothing is read here,
 * and no value is derived from anything but what was given -- the same
 * discipline `rawSessionExport.ts` and `analysisExport.ts` established, for
 * the same reason: a change in what the app stores has to come THROUGH this
 * function to change what is reported.
 */
export function buildSessionReportDocument(input: SessionReportInput): SessionReportDocument {
  const failureByPart = new Map((input.failures ?? []).map((failure) => [failure.part, failure.detail]));
  const availability: SessionReportAvailability[] = [];

  function note(part: string, value: unknown[] | null, unavailableDetail: string): void {
    const failure = failureByPart.get(part);
    if (failure !== undefined) {
      availability.push({ part, state: 'failed', detail: failure });
      return;
    }
    if (value === null) {
      availability.push({ part, state: 'unavailable', detail: unavailableDetail });
      return;
    }
    availability.push({
      part,
      state: value.length === 0 ? 'empty' : 'present',
      count: value.length,
    });
  }

  const laps = [...input.session.laps].sort((a, b) => a.lapNumber - b.lapNumber);
  // Item A: the merge is what turns "no row" into an explicit `'unanswered'`.
  // When the store could not be asked at all, the laps still get entries --
  // and `availability` is what says those `'unanswered'`s are the absence of
  // a READ, not the absence of an answer.
  const verdicts = mergeLapValidityVerdicts(input.session.sessionId, laps, input.lapVerdicts ?? []);
  const reportLaps: SessionReportLap[] = verdicts.map((verdict) => {
    const lap = laps.find((entry) => entry.lapNumber === verdict.lapNumber);
    return {
      // A verdict for a lap the session no longer lists keeps its answer; the
      // lap itself is reconstructed from what the verdict snapshotted, which
      // is all that is known about it. It is flagged in `notes` below.
      lap:
        lap ??
        ({
          lapNumber: verdict.lapNumber,
          tStart: 0,
          tEnd: 0,
          durationMs: 0,
          sectorTimes: [],
          valid: verdict.appValid,
          invalidReasons: [...verdict.appInvalidReasons],
          quality: 'invalid',
        } satisfies LapRecord),
      verdict,
    };
  });
  const orphanVerdictLaps = reportLaps
    .filter((entry) => !laps.some((lap) => lap.lapNumber === entry.lap.lapNumber))
    .map((entry) => entry.lap.lapNumber);

  note('circuit', input.circuit === null ? null : [input.circuit], 'the device could not identify this session\'s circuit');
  note(
    'calibrationAttempts',
    input.calibrationAttempts === null ? null : [...input.calibrationAttempts],
    'this device cannot store or read calibration attempt records',
  );
  note(
    'lapVerdicts',
    input.lapVerdicts === null ? null : [...input.lapVerdicts],
    'this device cannot store or read the owner\'s lap verdicts',
  );
  note('laps', laps, 'unreachable: a session always carries its lap list');
  note('raw', input.raw === null ? null : [input.raw], 'the raw GNSS/telemetry record could not be assembled');
  note('extras', [...input.extras], 'unreachable: extras default to an empty list');
  // Ticket P13B item 4: one row per tool, so "Signal Finder produced nothing"
  // and "Signal Finder was never asked" are different statements in the file
  // rather than two identical absences.
  for (const extra of input.extras) {
    availability.push({
      part: `extras:${extra.source}`,
      state: extra.state ?? 'present',
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    });
  }
  // Ticket P14 H2/H4/H5/H7: a reported failure whose part is not one of the
  // named sections above still gets a row -- the component reads of the raw
  // record (`raw:telemetry`, `raw:gnss:unclaimed`, ...) above all. Rule 2 says
  // nothing is silently omitted, and a failure with nowhere to land was
  // exactly a silent omission: `raw` came back `present` and the reads that
  // threw under it were mentioned nowhere in this document.
  for (const [part, detail] of failureByPart) {
    if (availability.some((row) => row.part === part)) continue;
    availability.push({ part, state: 'failed', detail });
  }
  availability.push({
    part: 'recording',
    state: input.recording.unwrittenSampleCount === null ? 'unavailable' : 'present',
    ...(input.recording.unwrittenSampleCount === null
      ? { detail: 'this session predates trace-completeness bookkeeping' }
      : {}),
  });
  // Ticket P14 H3: the verdict on the recording is its OWN row, because the
  // counters being present is a different fact from the recording being
  // finished. `'unknown'` here is `'unavailable'`: the device cannot answer.
  availability.push({
    part: 'recording:completeness',
    state: input.recording.completeness === 'unknown' ? 'unavailable' : 'present',
    ...(input.recording.completeness === 'unknown'
      ? {
          detail:
            input.recording.recordingFinalized === false
              ? 'the recording of this session was never finalised, so the stored counters are a running figure and not a final account'
              : 'this device holds no conclusive account of whether every captured fix reached storage',
        }
      : {}),
  });

  const verdictSummary = summarizeLapVerdicts(verdicts);

  /**
   * Ticket P15 F1 (Codex P14 round) -- EVERY SENTENCE BELOW IS DERIVED FROM
   * THE SECTION'S AVAILABILITY, NEVER FROM THE EMPTINESS OF ITS COLLECTION.
   *
   * P14 made `availability` four-valued so a failed read can never be
   * reported as `empty`. The flags came out right and the PROSE did not: a
   * section marked `failed` still produced "were never judged by the owner"
   * and "No calibration attempt was recorded", so the machine-readable half
   * of the document said one thing and the half the owner actually reads said
   * the opposite. An empty collection is now evidence of nothing until the
   * availability row says the read succeeded.
   *
   * Every row is pushed above; nothing after this point adds one.
   */
  const stateByPart = new Map(availability.map((row) => [row.part, row.state]));
  const partState = (part: string): SessionReportPartState | undefined => stateByPart.get(part);
  const lapVerdictsState = partState('lapVerdicts');
  const calibrationAttemptsState = partState('calibrationAttempts');

  const notes: string[] = [
    'A complete record of one session: the raw measurements, the app\'s own verdicts, and the owner\'s verdict on those verdicts. Nothing here is smoothed, inferred or corrected.',
    'Every part of this document has an entry in `availability`. A part marked `empty` was read and had nothing; a part marked `unavailable` was never readable on this device; a part marked `failed` WAS read and the read did not succeed, so what it holds is unknown. They are three different facts and must not be treated as one.',
  ];
  if (laps.length === 0) {
    // Ticket P15 F1: "completed no lap" is a statement about a lap list that
    // was READ. The list normally comes off the session row and cannot fail,
    // but a host that reports `laps` as unreadable must not have this said
    // over the top of it.
    const lapsState = partState('laps');
    notes.push(
      lapsState === 'failed' || lapsState === 'unavailable'
        ? 'The lap list for this session could NOT be read, so this document cannot say whether a lap was completed. An absent lap here is unreadable, not absent.'
        : 'This session completed no lap. The timing engine never detected a start/finish crossing, so there are no lap times -- the trace in `raw` is the drive itself.',
    );
  }
  // Ticket P15 F1: three branches, one per availability state, and the
  // "never judged" count is reachable ONLY from a read that succeeded.
  if (lapVerdictsState === 'failed') {
    notes.push(
      `The owner's lap verdicts could NOT be read for this session: ${
        failureByPart.get('lapVerdicts') ?? 'the read failed'
      } A lap listed below as \`unanswered\` may in fact carry an answer this device could not decode -- \`unanswered\` here is the absence of a READ, not the absence of an answer, and the ${String(
        verdictSummary.unanswered,
      )} of ${String(verdicts.length)} lap(s) it applies to must not be counted either way.`,
    );
  } else if (lapVerdictsState === 'unavailable') {
    notes.push(
      'The owner\'s lap verdicts could NOT be read on this device. Every lap below shows `unanswered`, which here means "not readable", NOT "not answered".',
    );
  } else if (verdictSummary.unanswered > 0) {
    notes.push(
      `${String(verdictSummary.unanswered)} of ${String(verdicts.length)} lap(s) were never judged by the owner. An unanswered lap is evidence of nothing -- do not count it as agreement with the app.`,
    );
  }
  // Ticket P15 F1: likewise here. "No calibration attempt was recorded" is a
  // statement about a successful read, and was being made about a failed one.
  if (calibrationAttemptsState === 'failed') {
    notes.push(
      `This session's calibration attempt records could NOT be read in full: ${
        failureByPart.get('calibrationAttempts') ?? 'the read failed'
      } ${String(
        (input.calibrationAttempts ?? []).length,
      )} attempt(s) are listed below -- that is what survived, not necessarily every attempt made. An attempt missing from this document is UNREADABLE, not absent.`,
    );
  } else if (calibrationAttemptsState === 'unavailable') {
    notes.push(
      'The calibration attempt records could NOT be read on this device, so this document makes no statement about whether a Learn lap was run for this session. That is not the same as none having been run.',
    );
  } else if (input.calibrationAttempts !== null && input.calibrationAttempts.length === 0) {
    notes.push(
      'No calibration attempt was recorded for this session. Either it was recorded before attempts were tracked, or it resumed an earlier session without a fresh Learn lap.',
    );
  }
  const unconcluded = (input.calibrationAttempts ?? []).filter((attempt) => !attempt.concluded);
  if (unconcluded.length > 0) {
    notes.push(
      calibrationAttemptsState === 'failed'
        ? // Ticket P15 F1: H4's case. The conclusion WAS reached and its write
          // failed, so the row still on disk is the earlier, provisional one.
          // Reporting that row's missing conclusion as a fact about the Learn
          // lap is precisely the over-claim the four-valued flags exist to
          // stop.
          `${String(
            unconcluded.length,
          )} calibration attempt(s) are stored as PROVISIONAL: their stored row carries no conclusion. Because this session's calibration records could not be read or written in full (see above), a provisional row does NOT establish that no conclusion was ever reached -- the conclusion may have been reached and failed to reach storage. Their coverage figures are the last live reading either way.`
        : `${String(unconcluded.length)} calibration attempt(s) never concluded: the Learn lap was still running when the app stopped. Their coverage figures are the last live reading, not a verdict.`,
    );
  }
  if (input.calibrationStatus === 'unvalidated') {
    notes.push(
      'This session was started past a REJECTED calibration. Any lap or sector times in it may be wrong or missing. The GNSS and telemetry samples are unaffected: they are measurements, not matched results.',
    );
  } else if (input.calibrationStatus === 'unknown') {
    notes.push(
      'Calibration status UNKNOWN for this session: the device holds no record of whether its matching was ever validated. Treat any lap or sector times as unverified.',
    );
  }
  if (input.circuit !== null && input.circuit.geometryStatus !== 'official') {
    notes.push(
      `The circuit geometry is "${input.circuit.geometryStatus}", not an officially surveyed layout. Lap boundaries and sector splits were computed against it and inherit its uncertainty.`,
    );
  }
  if (input.recording.completeness === 'incomplete') {
    notes.push(
      `INCOMPLETE RECORDING: ${String(input.recording.unwrittenSampleCount)} captured GNSS fix(es) were never written to storage and are NOT in this file.`,
    );
  } else if (input.recording.unwrittenSampleCount === null) {
    notes.push(
      'Trace completeness is UNKNOWN for this session: the device kept no count of fixes it failed to write. The trace may be short without saying so.',
    );
  } else if (input.recording.recordingFinalized === false) {
    // Ticket P14 H3: the reviewer's case, stated rather than smoothed over.
    notes.push(
      'Trace completeness is UNKNOWN for this session: its recording was never finalised -- the app stopped or crashed while it was still running. The stored count of unwritten fixes is the last figure written before that, not a final account, and fixes captured after it were lost without being counted.',
    );
  } else if (input.recording.recordingFinalized === null) {
    notes.push(
      'Trace completeness is UNKNOWN for this session: the device holds no record of whether its recording was ever finalised, so the stored counters cannot be read as a final account.',
    );
  }
  if (orphanVerdictLaps.length > 0) {
    notes.push(
      `Verdicts were kept for lap(s) ${orphanVerdictLaps.join(', ')}, which the session's stored lap list no longer contains. Their lap rows below are reconstructed from what the verdict itself recorded.`,
    );
  }
  if (input.raw === null) {
    notes.push('The raw GNSS and telemetry record could not be assembled, so this document carries no measurements at all.');
  }
  for (const failure of input.failures ?? []) {
    notes.push(`Could not read "${failure.part}": ${failure.detail}`);
  }

  return {
    kind: SESSION_REPORT_KIND,
    schemaVersion: SESSION_REPORT_SCHEMA_VERSION,
    generatedAtUtc: input.generatedAtUtc,
    session: {
      sessionId: input.session.sessionId,
      startedAtUtc: input.session.displayDateUtc,
      circuitId: input.session.circuitId,
      layoutId: input.session.layoutId,
      lapCount: laps.length,
      calibrationStatus: input.calibrationStatus,
    },
    circuit: input.circuit === null ? null : { ...input.circuit },
    calibrationAttempts: [...(input.calibrationAttempts ?? [])],
    laps: reportLaps,
    verdictSummary,
    recording: { ...input.recording },
    raw: input.raw,
    extras: [...input.extras],
    availability,
    notes,
  };
}

// ---------------------------------------------------------------------------
// File naming -- the same one-sanitizer discipline `rawSessionExport.ts` uses.
// ---------------------------------------------------------------------------

export const SESSION_REPORT_UNDATED = 'undated';

function sanitizeSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function normalizeDate(value: string): string {
  const day = value.trim().slice(0, 10).replace(/[^0-9]/g, '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return SESSION_REPORT_UNDATED;
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  if (month < 1 || month > 12 || date < 1 || date > 31 || year < 1_000) return SESSION_REPORT_UNDATED;
  return day;
}

/** `trace-report-<circuit>-<yyyy-mm-dd>-<session>.<ext>`. The session id is in the name so two attempts on one day cannot overwrite each other. */
export function sessionReportFileName(doc: SessionReportDocument, ext: 'json' | 'md'): string {
  const circuit = sanitizeSegment(doc.session.circuitId);
  const date = sanitizeSegment(normalizeDate(doc.session.startedAtUtc));
  const session = sanitizeSegment(doc.session.sessionId).slice(0, 24);
  return (
    ['trace-report', circuit, date, session].filter((segment) => segment.length > 0).join('-') + `.${ext}`
  );
}

// ---------------------------------------------------------------------------
// Summary (a companion; the JSON is the point)
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  const totalSeconds = ms / 1_000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds - minutes * 60).toFixed(3).padStart(6, '0');
  return `${String(minutes)}:${seconds}`;
}

/**
 * A short human-readable companion, kept to roughly a page. Its audience is
 * the person forwarding the file, so it states the things that decide whether
 * the file is worth reading: how much of it is missing, and how much of the
 * verdict check actually got done.
 */
export function buildSessionReportMarkdown(doc: SessionReportDocument): string {
  /**
   * Ticket P15 F1 (Codex P14 round) -- THE SUMMARY READS ITS OWN FLAGS.
   *
   * This is the half of the export a human opens first, and it was writing
   * confident negatives ("0 unanswered", "None recorded.", "owner: not
   * answered", "Telemetry samples: 0") straight over the top of an
   * `availability` block that said those sections had FAILED to read. Every
   * sentence below now asks the availability row first. Nothing is deleted:
   * the counts still appear, qualified by what is known about the read that
   * produced them.
   */
  const stateOf = (part: string): SessionReportPartState | undefined =>
    doc.availability.find((row) => row.part === part)?.state;
  const detailOf = (part: string): string =>
    doc.availability.find((row) => row.part === part)?.detail ?? 'the read failed';
  const circuitState = stateOf('circuit');
  const verdictState = stateOf('lapVerdicts');
  const lapsState = stateOf('laps');
  const calibrationState = stateOf('calibrationAttempts');
  const extrasState = stateOf('extras');
  const unread = (state: SessionReportPartState | undefined): boolean =>
    state === 'failed' || state === 'unavailable';
  /** A raw component whose read did not succeed makes its count a floor, not a total. */
  const rawComponentUnread = (prefix: string): boolean =>
    doc.availability.some((row) => row.part.startsWith(prefix) && unread(row.state));

  const lines: string[] = [
    `# Session report -- ${doc.session.circuitId}`,
    '',
    `- Session: \`${doc.session.sessionId}\``,
    `- Started: ${doc.session.startedAtUtc}`,
    `- Layout: ${doc.session.layoutId}${doc.circuit === null ? '' : ` v${String(doc.circuit.layoutVersion)}`}`,
    doc.circuit === null
      ? circuitState === 'failed'
        ? `- Circuit geometry: **not readable** -- the circuit record could not be read on this device (${detailOf(
            'circuit',
          )}). That is not the same as this circuit being unidentifiable.`
        : '- Circuit geometry: **unknown** -- the device could not identify this circuit'
      : `- Circuit geometry: ${doc.circuit.geometryStatus} (sectors ${doc.circuit.sectorStatus})`,
    `- Laps: ${String(doc.session.lapCount)}${
      unread(lapsState) ? ' -- **the lap list could not be read**, so this count is not a total' : ''
    }`,
  ];
  lines.push(
    doc.session.calibrationStatus === 'unvalidated'
      ? '- Calibration: **not validated** -- timing in this session may be unreliable'
      : doc.session.calibrationStatus === 'unknown'
        ? '- Calibration: **unknown** -- the device holds no record of whether matching was validated'
        : '- Calibration: validated',
  );
  // Ticket P15 F1: the counts stay; what the word "unanswered" means in them
  // is stated when the verdict read did not succeed.
  lines.push(
    `- Owner verdicts: ${String(doc.verdictSummary.agreed)} agreed, ${String(doc.verdictSummary.disagreed)} disagreed, ${String(doc.verdictSummary.unanswered)} unanswered${
      verdictState === 'failed'
        ? ' -- **the stored verdicts could not be read**, so "unanswered" here means not readable, not unanswered'
        : verdictState === 'unavailable'
          ? ' -- **this device cannot read the owner\'s verdicts**, so "unanswered" here means not readable, not unanswered'
          : ''
    }`,
  );
  // Ticket P14 H3: driven by `completeness`, never by "the count is zero".
  lines.push(
    doc.recording.completeness === 'incomplete'
      ? `- Recording: **INCOMPLETE** -- ${String(doc.recording.unwrittenSampleCount)} captured GNSS fix(es) never reached storage`
      : doc.recording.completeness === 'complete'
        ? '- Recording: complete (no captured fix went unwritten)'
        : doc.recording.recordingFinalized === false
          ? '- Recording completeness: **unknown** -- this recording was never finalised, so the stored counters are not a final account'
          : '- Recording completeness: **unknown**',
  );
  if (doc.raw === null) {
    // Ticket P15 F1: previously these two lines were simply omitted, which is
    // the silent absence rule 2 exists to forbid -- a reader cannot tell a
    // missing line from a zero.
    lines.push(
      '- GNSS fixes / telemetry samples: **not stated** -- the raw measurement record could not be assembled, so no count of either is known',
    );
  } else {
    // Ticket P15 F1: a component read that failed makes its count a FLOOR.
    // Stating `0` flat beside an availability block saying the table was
    // locked is the same over-claim in the other half of the document.
    lines.push(
      `- GNSS fixes: ${String(doc.raw.gnss.totalSampleCount)} (${String(doc.raw.gnss.lapSampleCount)} in laps, ${String(doc.raw.gnss.unclaimedSampleCount)} unclaimed)${
        rawComponentUnread('raw:gnss')
          ? ' -- **a floor, not a total**: part of the GNSS record could not be read (see the availability list below)'
          : ''
      }`,
    );
    lines.push(
      `- Telemetry samples: ${String(doc.raw.telemetry.sampleCount)}${
        doc.raw.telemetry.channels.length === 0 ? '' : ` across ${doc.raw.telemetry.channels.join(', ')}`
      }${
        rawComponentUnread('raw:telemetry')
          ? ' -- **a floor, not a total**: the telemetry record could not be read (see the availability list below)'
          : ''
      }`,
    );
  }

  lines.push('', '## Calibration attempts');
  if (doc.calibrationAttempts.length === 0) {
    lines.push(
      calibrationState === 'failed'
        ? `- **Not readable on this device.** The stored calibration records could not be read: ${detailOf(
            'calibrationAttempts',
          )} This is not the same as "none were made".`
        : calibrationState === 'unavailable'
          ? '- **Not readable on this device.** This device cannot store or read calibration attempt records. This is not the same as "none were made".'
          : '- None recorded.',
    );
  } else {
    if (calibrationState === 'failed') {
      // Ticket P15 F1: the list below is what survived, and at least one row
      // in it may be an earlier PROVISIONAL row whose conclusion never landed.
      lines.push(
        `- **PARTIAL.** This session's calibration records could not be read or written in full: ${detailOf(
          'calibrationAttempts',
        )} What follows is what the device could produce, not necessarily every attempt nor its final account.`,
      );
    }
    for (const attempt of doc.calibrationAttempts) {
      const conclusion = attempt.concluded
        ? ''
        : calibrationState === 'failed'
          ? ' (PROVISIONAL -- the stored row carries no conclusion; the conclusion may have been reached and failed to reach storage)'
          : ' (never concluded)';
      lines.push(
        `- ${attempt.outcome.toUpperCase()}${conclusion} -- coverage ${(attempt.coverageFraction * 100).toFixed(1)}%, ${String(Math.round(attempt.durationMs / 1_000))} s, ${String(attempt.samplesFed)} fix(es)`,
      );
      for (const line of attempt.explanation) lines.push(`  - ${line}`);
    }
  }

  lines.push('', '## Laps and verdicts');
  if (doc.laps.length === 0) {
    lines.push(
      unread(lapsState)
        ? '- **Not readable.** The lap list for this session could not be read, so this document cannot say whether a lap was completed.'
        : '- No lap was completed.',
    );
  } else {
    for (const entry of doc.laps) {
      const appVerdict = entry.lap.valid
        ? 'app: VALID'
        : `app: INVALID (${entry.lap.invalidReasons.join(', ') || 'no reason recorded'})`;
      // Ticket P15 F1: "not answered" is a claim about a read that succeeded.
      // An answer that WAS read is real whatever else failed, so only the
      // `unanswered` placeholder is re-labelled.
      const owner =
        entry.verdict.answer === 'unanswered'
          ? verdictState === 'failed'
            ? 'owner: NOT READABLE -- a stored verdict for this lap could not be decoded'
            : verdictState === 'unavailable'
              ? 'owner: NOT READABLE -- this device cannot read the owner\'s verdicts'
              : 'owner: not answered'
          : `owner: ${entry.verdict.answer}${entry.verdict.answerRevision > 1 ? ` (answer ${String(entry.verdict.answerRevision)})` : ''}`;
      lines.push(`- Lap ${String(entry.lap.lapNumber)} ${formatMs(entry.lap.durationMs)} -- ${appVerdict}; ${owner}`);
      if (entry.verdict.note !== undefined) lines.push(`  - note: ${entry.verdict.note}`);
    }
  }

  // Ticket P13B item 4: the tool roll-call, named rather than counted, so the
  // person forwarding the file can see at a glance which tools answered.
  lines.push('', '## Other tools');
  if (doc.extras.length === 0) {
    lines.push(
      extrasState === 'failed'
        ? `- **Not readable.** The tool roll-call could not be read for this session: ${detailOf(
            'extras',
          )} This is not the same as no tool having produced anything.`
        : extrasState === 'unavailable'
          ? '- **Not readable on this device.** The tool roll-call could not be read here. This is not the same as no tool having produced anything.'
          : '- No tool output was enumerated for this session.',
    );
  } else {
    for (const extra of doc.extras) {
      const state = extra.state ?? 'present';
      lines.push(
        `- ${extra.source}: ${state}${extra.detail === undefined ? '' : ` -- ${extra.detail}`}`,
      );
      lines.push(`  - ${extra.description}`);
    }
  }

  lines.push('', '## What is and is not in this file');
  for (const entry of doc.availability) {
    lines.push(
      `- ${entry.part}: ${entry.state}${entry.count === undefined ? '' : ` (${String(entry.count)})`}${entry.detail === undefined ? '' : ` -- ${entry.detail}`}`,
    );
  }

  lines.push('', '## Notes');
  for (const note of doc.notes) lines.push(`- ${note}`);
  lines.push('', `_${doc.kind} v${String(doc.schemaVersion)} - generated ${doc.generatedAtUtc}_`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The loader
// ---------------------------------------------------------------------------

/** Why a session could not be reported on. Always a NAMED reason, never a silent empty file. */
export type SessionReportUnavailable = RawSessionExportUnavailable;

export interface SessionReportDeps {
  /** The stored session, or `null` when it is not on the device. */
  getSession: (sessionId: string) => StoredSession | null;
  /** The raw document, or a named reason. `rawSessionExport.ts`'s loader, wired by composition. */
  loadRaw: (
    sessionId: string,
    generatedAtUtc: string,
  ) => Promise<RawSessionExportDocument | RawSessionExportUnavailable>;
  /** The durable three-valued provenance of this session's matching. */
  calibrationStatus: (sessionId: string) => SessionCalibrationStatus;
  /** The circuit as the catalog describes it, or `null` when it cannot be identified. */
  circuit: (session: StoredSession) => SessionReportCircuit | null;
  /** Item B. Absent (not just empty) when this device cannot read attempts at all. */
  listCalibrationAttempts?: (sessionId: string) => Promise<readonly CalibrationAttemptRecord[]>;
  /** Item A. Absent when this device cannot read verdicts at all. */
  listLapVerdicts?: (sessionId: string) => Promise<readonly LapValidityVerdict[]>;
  /** Trace-completeness figures the stored row cannot supply (`persistedSampleCount` is live-only). */
  recording?: (sessionId: string) => Partial<SessionReportRecording>;
  /** Whatever other tools in the app produced for this session. */
  extras?: (sessionId: string) => Promise<readonly SessionReportExtra[]>;
  /**
   * Ticket P14 H4/H5/H7 (Codex P13 round) -- FAILURES THE READS ABOVE CANNOT
   * THROW.
   *
   * Some parts of this document are wrong not because a call threw but
   * because of something the caller knows and the call cannot express: rows
   * that exist in storage and would not decode (H5), a record the live
   * controller built and could not write (H4), a historical configuration
   * this device no longer holds (H7). Each one makes a section of this
   * document FAILED or UNAVAILABLE rather than empty, and this is where the
   * host says so.
   *
   * Never throws; a rejection is itself reported as a failure of `readFailures`.
   */
  readFailures?: (sessionId: string) => Promise<readonly { part: string; detail: string }[]>;
  /** Where a partial read failure is reported. Defaults to `console.warn`. */
  onReadError?: (error: unknown) => void;
}

/**
 * Assembles the report for one stored session.
 *
 * NEVER REJECTS on a partial failure, for the same reason the raw export does
 * not: the purpose is getting data off the device, and a report that refuses
 * to be produced because one of six reads failed is worth less than one that
 * ships and says which read failed. Every failure lands in `availability` and
 * in `notes`.
 *
 * The only hard failure is a session that is not on the device at all, which
 * comes back as a NAMED reason.
 */
export async function loadSessionReportDocument(
  deps: SessionReportDeps,
  sessionId: string,
  generatedAtUtc: string,
): Promise<SessionReportDocument | SessionReportUnavailable> {
  const onReadError =
    deps.onReadError ?? ((error: unknown) => console.warn('[sessionReport] read failed', error));
  const session = deps.getSession(sessionId);
  if (session === null) return 'session-not-found';

  const failures: { part: string; detail: string }[] = [];
  function fail(part: string, error: unknown): void {
    onReadError(error);
    failures.push({ part, detail: error instanceof Error ? error.message : String(error) });
  }

  let raw: RawSessionExportDocument | null = null;
  try {
    const loaded = await deps.loadRaw(sessionId, generatedAtUtc);
    if (typeof loaded === 'string') {
      failures.push({ part: 'raw', detail: `raw export unavailable: ${loaded}` });
    } else {
      raw = loaded;
      // Ticket P14 H2: the raw document degrades COMPONENT BY COMPONENT -- a
      // failed OBD read still exports the GNSS trace -- and it now says which
      // components failed. Those failures are this document's too: without
      // them a raw record whose every read threw arrived here as a perfectly
      // well-formed document full of empty arrays, and `raw` was marked
      // `present`. One row per failed component, plus one for `raw` itself, so
      // neither the summary nor a machine reader can take the record at face
      // value.
      for (const failure of raw.readFailures) {
        failures.push({ part: `raw:${failure.part}`, detail: failure.detail });
      }
      if (raw.readFailures.length > 0) {
        failures.push({
          part: 'raw',
          detail: `${String(raw.readFailures.length)} component read(s) of the raw record failed (${raw.readFailures
            .map((failure) => failure.part)
            .join(', ')}); what they would have returned is NOT in this document`,
        });
      }
    }
  } catch (error) {
    fail('raw', error);
  }

  let calibrationAttempts: readonly CalibrationAttemptRecord[] | null = null;
  if (deps.listCalibrationAttempts !== undefined) {
    try {
      calibrationAttempts = await deps.listCalibrationAttempts(sessionId);
    } catch (error) {
      fail('calibrationAttempts', error);
    }
  }

  let lapVerdicts: readonly LapValidityVerdict[] | null = null;
  if (deps.listLapVerdicts !== undefined) {
    try {
      lapVerdicts = await deps.listLapVerdicts(sessionId);
    } catch (error) {
      fail('lapVerdicts', error);
    }
  }

  let extras: readonly SessionReportExtra[] = [];
  if (deps.extras !== undefined) {
    try {
      extras = await deps.extras(sessionId);
    } catch (error) {
      fail('extras', error);
    }
  }

  let circuit: SessionReportCircuit | null = null;
  try {
    circuit = deps.circuit(session);
  } catch (error) {
    fail('circuit', error);
  }

  // Ticket P14 H4/H5/H7: failures only the host can know about.
  if (deps.readFailures !== undefined) {
    try {
      failures.push(...(await deps.readFailures(sessionId)).map((failure) => ({ ...failure })));
    } catch (error) {
      fail('readFailures', error);
    }
  }

  // The stored row is the floor; a live controller's figures (which alone know
  // `persistedSampleCount`) override it where they exist.
  const live = deps.recording?.(sessionId) ?? {};
  const unwritten = live.unwrittenSampleCount ?? session.unwrittenSampleCount ?? null;
  // Ticket P14 H3: whether the recording was ever FINISHED. `undefined` from
  // both sources stays `null` (= UNKNOWN); it is never defaulted to `true`,
  // because the whole failure this fixes was a default that over-claimed.
  const finalized = live.recordingFinalized ?? session.recordingFinalized ?? null;
  const traceIncomplete = unwritten !== null && unwritten > 0;
  const recording: SessionReportRecording = {
    persistedSampleCount: live.persistedSampleCount ?? null,
    unwrittenSampleCount: unwritten,
    failedWriteCount: live.failedWriteCount ?? session.failedWriteCount ?? null,
    // `null` is UNKNOWN and must never read as complete; only a known positive
    // count makes this true.
    traceIncomplete,
    recordingFinalized: finalized,
    // Ticket P14 H3: BOTH halves are required to say "complete". A zero from a
    // session whose recording never finished is the last figure written before
    // it was interrupted -- reading it as a verdict is how a truncated drive
    // came to be reported as "complete (no captured fix went unwritten)".
    completeness: traceIncomplete
      ? 'incomplete'
      : unwritten !== null && finalized === true
        ? 'complete'
        : 'unknown',
  };

  return buildSessionReportDocument({
    generatedAtUtc,
    session,
    calibrationStatus: deps.calibrationStatus(sessionId),
    circuit,
    calibrationAttempts,
    lapVerdicts,
    recording,
    raw,
    extras,
    failures,
  });
}
