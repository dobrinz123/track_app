import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  resolveSignalTargetCatalog,
  type MetronomeTimeline,
  type NextDiscoveryStep,
  type SignalBipolarSides,
  type SignalCandidateScore,
  type SignalEngineRequirement,
  type SignalFinderSample,
  type SignalTargetId,
  type SignalVerdictCapReason,
} from '@circuit/core';
import type { VehicleProfileBinding, VehicleProfileBindingStatus } from '../persistence/didSweepStore';
import type { SignalFinderEcuPass, SignalFinderSnapshot } from './signalFinderController';

/**
 * Signal Finder export (ticket P4l S5, binding — the user's own 2026-08-29
 * requirement, written into contracts.md as "Signal Finder (Phase 4l)" items
 * 6 and 8):
 *
 *   "one tap 'Share' on the result screen exports TWO files: (a) the full
 *    JSON session (`trace-signal-finder-<yyyy-mm-dd>-<target>.json`,
 *    schemaVersion 1) and (b) a human-readable summary
 *    `trace-signal-finder-<yyyy-mm-dd>-<target>.md` (<= 1 page ...). The
 *    summary is what the user forwards, the JSON is for tooling."
 *
 * The share MACHINERY is `didSweepExport.ts`'s, deliberately: the same
 * expo-file-system v57 class API (`File`/`Paths`, `write()` is SYNCHRONOUS)
 * and the same expo-sharing call, with the same never-throws contract (a web
 * preview / unavailable share sheet logs and reports `shared: false`).
 *
 * `expo-sharing`'s `shareAsync` takes exactly ONE file per call, so the
 * ticket's own fallback applies: {@link shareSignalFinderExport} writes both
 * files, shares the `.md` (what a human reads), and hands back the JSON's uri
 * so the screen can offer {@link shareSignalFinderJson} as a second button.
 */

export const SIGNAL_FINDER_EXPORT_SCHEMA_VERSION = 1;
export const SIGNAL_FINDER_EXPORT_KIND = 'trace-signal-finder';

/** RO/EN, per contracts.md item 8. Ticket P4l-FIX1 F2 (binding): the screen now passes the app's `language` setting (`settingsStore.ts`'s `AppLanguage`, the same two values), defaulted from the device locale -- it no longer hard-codes `'en'`. */
export type SignalFinderLanguage = 'en' | 'ro';

export interface SignalFinderExportInput {
  nowIso: string;
  sessionId: string | null;
  profileId: string;
  targetId: SignalTargetId;
  targetLabel: string;
  engineRequirement: SignalEngineRequirement;
  startedAtUtc: string | null;
  measuredReqPerSec: number;
  timeline: MetronomeTimeline | null;
  passes: readonly SignalFinderEcuPass[];
  scores: readonly SignalCandidateScore[];
  noResponseDids: readonly { ecu: number; did: number }[];
  samples: readonly SignalFinderSample[];
  confirmedBindings: readonly VehicleProfileBinding[];
  nextStep: NextDiscoveryStep | null;
}

export interface SignalFinderExportPass {
  ecuHex: string;
  didHex: string[];
  hypothesisDidHex: string[];
  cachedDidHex: string[];
}

export interface SignalFinderExportCandidate {
  ecuHex: string;
  didHex: string;
  verdict: SignalCandidateScore['verdict'];
  matchedEdges: number;
  expectedEdges: number;
  baselineChanges: number;
  responseBaselineChanges: number;
  byteOffset: number | null;
  correlationSign: number | null;
  restValueHex: string | null;
  lastRawHex: string;
  min: number | null;
  max: number | null;
  length: number | null;
  sampleCount: number;
  windowsBelowMinimum: number;
  insufficientReason: string | null;
  /**
   * P4l-FIX3 J6 (binding, Codex re-review finding L12): what the verdict is
   * ACTUALLY based on -- `matchedEdges - extraTransitions`, floored at 0.
   * The primary evidence figure; `matchedEdges` above stays for anyone still
   * reading the gross count.
   */
  netEdges: number;
  /** P4l-FIX2's own field, carried through: in-window transitions no expected edge accounts for. 0 when the score never set it. */
  extraTransitions: number;
  /** P4l-FIX2's own field: baseline samples at which ANY scored series of this DID moved. 0 when the score never set it. */
  didBaselineChanges: number;
  /** P4l-FIX2's own field: which sides of rest an `analog-bipolar` candidate's press windows visited. `null` for every other shape, or when the score never set it. */
  bipolarSides: SignalBipolarSides | null;
  /** P4l-FIX2's own field: why the verdict is lower than the edge ratio alone would give. `null` when nothing capped it. */
  verdictCapReason: SignalVerdictCapReason | null;
}

export interface SignalFinderExportDocument {
  schemaVersion: number;
  kind: string;
  generatedAtUtc: string;
  session: {
    sessionId: string | null;
    profileId: string;
    targetId: SignalTargetId;
    targetLabel: string;
    engineRequirement: SignalEngineRequirement;
    startedAtUtc: string | null;
    measuredReqPerSec: number;
  };
  metronome: {
    totalMs: number;
    pollDurationMs: number;
    settleMs: number;
    repetitions: number;
    expectedEdges: number;
    steps: Array<{ index: number; kind: string; repetition: number; startMs: number; endMs: number; prompt: string }>;
  };
  passes: SignalFinderExportPass[];
  candidates: SignalFinderExportCandidate[];
  /** Item 2 (binding): DIDs that answered NRC or never answered — reported, never silently absent. */
  noResponse: Array<{ ecuHex: string; didHex: string }>;
  samples: Array<{ ecuHex: string; didHex: string; tMs: number; rawHex: string }>;
  confirmedBindings: Array<{
    channel: string;
    ecuHex: string;
    didHex: string;
    length: number | null;
    decode: string;
    status: string;
    updatedAtUtc: string;
  }>;
  nextStep: (NextDiscoveryStep & { ecuHex: string | null; fromDidHex: string; toDidHex: string }) | null;
}

function didHex(did: number): string {
  return `0x${did.toString(16).toUpperCase().padStart(4, '0')}`;
}

function ecuHex(ecu: number): string {
  return `0x${ecu.toString(16).toUpperCase().padStart(2, '0')}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

/**
 * P4l-FIX3 J2 (binding, after Codex P4l-REV1 M7/MEDIUM: "the on-screen
 * summary is built from a stale React snapshot"): the PURE bridge from a
 * `SignalFinderController` snapshot (plus the two things it never owns --
 * the session's samples and the persisted confirmed bindings) to
 * {@link SignalFinderExportInput}. A plain function of its own arguments, no
 * closure over anything from an earlier call -- `SignalFinderScreen.tsx`
 * calls this with `controller.getSnapshot()` taken AFTER `find()` resolves
 * (never the React `snapshot` state captured when the run started), so two
 * consecutive finds can never have their data combined. `null` only when the
 * snapshot has no target yet (nothing has ever run).
 */
export function signalFinderExportInputFromSnapshot(
  snap: SignalFinderSnapshot,
  samples: readonly SignalFinderSample[],
  confirmedBindings: readonly VehicleProfileBinding[],
  nowIso: string,
): SignalFinderExportInput | null {
  if (snap.targetId === null) return null;
  return {
    nowIso,
    sessionId: snap.sessionId,
    profileId: snap.profileId,
    targetId: snap.targetId,
    targetLabel: snap.targetLabel ?? snap.targetId,
    engineRequirement: snap.engineRequirement ?? 'off-ok',
    startedAtUtc: snap.startedAtUtc,
    measuredReqPerSec: snap.measuredReqPerSec,
    timeline: snap.timeline,
    passes: snap.passes,
    scores: snap.scores,
    noResponseDids: snap.noResponseDids,
    samples,
    confirmedBindings,
    nextStep: snap.nextStep,
  };
}

/** Builds the FULL export document (pure — no I/O). */
export function buildSignalFinderExportDocument(input: SignalFinderExportInput): SignalFinderExportDocument {
  const timeline = input.timeline;
  return {
    schemaVersion: SIGNAL_FINDER_EXPORT_SCHEMA_VERSION,
    kind: SIGNAL_FINDER_EXPORT_KIND,
    generatedAtUtc: input.nowIso,
    session: {
      sessionId: input.sessionId,
      profileId: input.profileId,
      targetId: input.targetId,
      targetLabel: input.targetLabel,
      engineRequirement: input.engineRequirement,
      startedAtUtc: input.startedAtUtc,
      measuredReqPerSec: input.measuredReqPerSec,
    },
    metronome: {
      totalMs: timeline?.totalMs ?? 0,
      pollDurationMs: timeline?.pollDurationMs ?? 0,
      settleMs: timeline?.settleMs ?? 0,
      repetitions: timeline?.repetitions ?? 0,
      expectedEdges: timeline?.expectedEdges ?? 0,
      steps: (timeline?.steps ?? []).map((step) => ({
        index: step.index,
        kind: step.kind,
        repetition: step.repetition,
        startMs: step.startMs,
        endMs: step.endMs,
        prompt: step.prompt,
      })),
    },
    passes: input.passes.map((pass) => ({
      ecuHex: ecuHex(pass.ecu),
      didHex: pass.dids.map(didHex),
      hypothesisDidHex: pass.hypothesisDids.map(didHex),
      cachedDidHex: pass.cachedDids.map(didHex),
    })),
    candidates: input.scores.map((score) => ({
      ecuHex: ecuHex(score.ecu),
      didHex: didHex(score.did),
      verdict: score.verdict,
      matchedEdges: score.matchedEdges,
      expectedEdges: score.expectedEdges,
      baselineChanges: score.baselineChanges,
      responseBaselineChanges: score.responseBaselineChanges,
      byteOffset: score.byteOffset,
      correlationSign: score.correlationSign,
      restValueHex: score.restValueHex,
      lastRawHex: score.lastRawHex,
      min: score.min,
      max: score.max,
      length: score.length,
      // P4l-FIX3 J6: `netEdges` is what the verdict was ACTUALLY computed
      // from (`@circuit/core`'s `scoreSignalCandidates`) -- every field here
      // is optional on `SignalCandidateScore` (older callers' object
      // literals still compile), so absent means "0/none", never `undefined`
      // leaking into the export.
      netEdges: Math.max(0, score.matchedEdges - (score.extraTransitions ?? 0)),
      extraTransitions: score.extraTransitions ?? 0,
      didBaselineChanges: score.didBaselineChanges ?? 0,
      bipolarSides: score.bipolarSides ?? null,
      verdictCapReason: score.verdictCapReason ?? null,
      sampleCount: score.sampleCount,
      windowsBelowMinimum: score.windowsBelowMinimum,
      insufficientReason: score.insufficientReason,
    })),
    noResponse: input.noResponseDids.map((entry) => ({ ecuHex: ecuHex(entry.ecu), didHex: didHex(entry.did) })),
    samples: input.samples.map((sample) => ({
      ecuHex: ecuHex(sample.ecu),
      didHex: didHex(sample.did),
      tMs: sample.tMs,
      rawHex: bytesToHex(sample.raw),
    })),
    confirmedBindings: input.confirmedBindings.map((binding) => ({
      channel: binding.channel,
      ecuHex: ecuHex(binding.ecu),
      didHex: didHex(binding.did),
      length: binding.length,
      decode: binding.decode,
      status: binding.status,
      updatedAtUtc: binding.updatedAtUtc,
    })),
    nextStep:
      input.nextStep === null
        ? null
        : {
            ...input.nextStep,
            ecuHex: input.nextStep.ecu === null ? null : ecuHex(input.nextStep.ecu),
            fromDidHex: didHex(input.nextStep.fromDid),
            toDidHex: didHex(input.nextStep.toDid),
          },
  };
}

/** `trace-signal-finder-<yyyy-mm-dd>-<target>.<ext>` (the ticket's own exact pattern). */
export function signalFinderExportFileName(generatedAtUtc: string, targetId: string, ext: 'json' | 'md'): string {
  return `${SIGNAL_FINDER_EXPORT_KIND}-${generatedAtUtc.slice(0, 10)}-${targetId}.${ext}`;
}

// ---------------------------------------------------------------------------
// Human-readable summary (<= 1 page). Pure — the SAME text the result screen
// shows and the .md file carries, so what the user reads on screen is exactly
// what they forward.
// ---------------------------------------------------------------------------

interface SummaryStrings {
  title: (target: string) => string;
  found: string;
  nothingFound: string;
  engineOff: string;
  engineRunning: string;
  session: string;
  read: string;
  didsAcross: (dids: number, ecus: number) => string;
  tableHeader: string;
  verdicts: Record<SignalCandidateScore['verdict'], string>;
  noResponse: string;
  confirmed: string;
  none: string;
  nextStep: string;
  sweep: (range: string, ecu: string) => string;
  minutes: (value: number) => string;
  evidenceEdges: string;
  generated: string;
  /** P4l-FIX3 J6: `"1 extra"` — an in-window transition no expected edge accounts for. */
  extraSuffix: (n: number) => string;
  /** P4l-FIX3 J6: `"baseline moved 3x"` — {@link SignalCandidateScore.didBaselineChanges}. */
  baselineMoved: (n: number) => string;
  /** P4l-FIX3 J6: `"capped: one-sided"`. */
  cappedLabel: (reason: string) => string;
  capReasons: Record<SignalVerdictCapReason, string>;
}

const EN: SummaryStrings = {
  title: (target) => `Signal Finder — ${target}`,
  found: 'Signal found',
  nothingFound: 'Nothing conclusive yet',
  engineOff: 'engine off (ignition on)',
  engineRunning: 'engine running / car moving',
  session: 'Session',
  read: 'Read',
  didsAcross: (dids, ecus) => `${dids} DIDs across ${ecus} ECU${ecus === 1 ? '' : 's'}`,
  tableHeader: '| DID | ECU | verdict | edges | baseline | raw |',
  verdicts: { found: 'found', probable: 'probable', unrelated: 'unrelated', insufficient: 'insufficient' },
  noResponse: 'No response (NRC or silence)',
  confirmed: 'Confirmed bindings',
  none: 'none',
  nextStep: 'Next step',
  sweep: (range, ecu) => `sweep ${ecu} ${range}`,
  minutes: (value) => `≈ ${Math.max(1, Math.round(value))} min`,
  evidenceEdges: 'edges matched',
  generated: 'Generated',
  extraSuffix: (n) => `${n} extra`,
  baselineMoved: (n) => `baseline moved ${n}x`,
  cappedLabel: (reason) => `capped: ${reason}`,
  capReasons: {
    'response-baseline-changes': 'restless baseline',
    'one-sided-bipolar': 'one-sided',
    'extra-transitions': 'extra transitions',
  },
};

const RO: SummaryStrings = {
  title: (target) => `Signal Finder — ${target}`,
  found: 'Semnal găsit',
  nothingFound: 'Încă nimic concludent',
  engineOff: 'motor oprit (contact pornit)',
  engineRunning: 'motor pornit / mașina în mers',
  session: 'Sesiune',
  read: 'Citite',
  didsAcross: (dids, ecus) => `${dids} DID-uri pe ${ecus} ECU`,
  tableHeader: '| DID | ECU | verdict | fronturi | repaus | brut |',
  verdicts: { found: 'găsit', probable: 'probabil', unrelated: 'fără legătură', insufficient: 'insuficient' },
  noResponse: 'Fără răspuns (NRC sau tăcere)',
  confirmed: 'Legături confirmate',
  none: 'niciuna',
  nextStep: 'Pasul următor',
  sweep: (range, ecu) => `scanează ${ecu} ${range}`,
  minutes: (value) => `≈ ${Math.max(1, Math.round(value))} min`,
  evidenceEdges: 'fronturi potrivite',
  generated: 'Generat',
  extraSuffix: (n) => `${n} în plus`,
  baselineMoved: (n) => `repaus schimbat de ${n} ori`,
  cappedLabel: (reason) => `plafonat: ${reason}`,
  capReasons: {
    'response-baseline-changes': 'repaus neliniștit',
    'one-sided-bipolar': 'unilateral',
    'extra-transitions': 'tranziții în plus',
  },
};

/**
 * P4l-FIX3 J3 (binding, after Codex P4l-REV1 M8/MEDIUM: "the Markdown
 * exporter does not guarantee the binding <= 1-page limit" -- the candidate
 * table was capped, but the no-response DID list and binding decode strings
 * were NOT, and counting SOURCE lines never bounded the RENDERED page).
 * Total budget, hard-enforced regardless of how many/how long the
 * variable-length sections are.
 */
const SUMMARY_MAX_LINES = 60;
const SUMMARY_MAX_CHARS = 4_096;
/** No-response DIDs are the single most likely section to blow the budget (a wide unswept range NRCs on every DID) — listed up to this many, then a marker. */
const SUMMARY_MAX_NO_RESPONSE_LISTED = 20;
/** Confirmed bindings are rare (usually 1-6) but each one's DECODE string is free-text (item 5's "decode guess") and has no length limit at the source. */
const SUMMARY_MAX_CONFIRMED_LISTED = 10;
const SUMMARY_MAX_DECODE_CHARS = 80;

/** `item, item, item (+N more)` — every variable-length list section renders through this ONE helper, so the marker text/format never drifts between sections. */
function joinWithMoreMarker<T>(items: readonly T[], max: number, render: (item: T) => string): string {
  const shown = items.slice(0, max).map(render).join(', ');
  const omitted = items.length - max;
  return omitted > 0 ? `${shown} (+${omitted} more)` : shown;
}

/** Truncates free-text (a binding's decode guess) to `maxChars`, marking how much was cut. Never splits a section's OWN "(+N more)" convention — this is chars, not items, so the wording says so. */
function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… (+${text.length - maxChars} more chars)`;
}

/**
 * Hard backstop UNDERNEATH every per-section cap above: even if every
 * section individually stayed inside its own limit, many small sections
 * together could still exceed the total budget (many confirmed channels,
 * say). Truncates whole trailing LINES (never mid-line) and appends one
 * final marker line — the one place a truncation can still occur without a
 * dedicated "(+N more)" of its own, so it gets one here.
 */
function enforceTotalBudget(lines: readonly string[]): string {
  let text = lines.join('\n');
  if (text.length <= SUMMARY_MAX_CHARS && lines.length <= SUMMARY_MAX_LINES) return text;
  let kept = lines;
  if (kept.length > SUMMARY_MAX_LINES) kept = kept.slice(0, SUMMARY_MAX_LINES - 1);
  text = kept.join('\n');
  while (text.length > SUMMARY_MAX_CHARS - 40 && kept.length > 1) {
    kept = kept.slice(0, kept.length - 1);
    text = kept.join('\n');
  }
  return `${text}\n_(+ more, truncated to stay within the summary budget)_`;
}

/**
 * P4l-FIX3 J6 (binding, Codex re-review finding L12): the primary evidence
 * for one candidate — `netEdges/expectedEdges` (what the verdict was
 * ACTUALLY computed from), plus `extraTransitions`, `didBaselineChanges` and
 * `verdictCapReason` in the SAME short line whenever any of them is present.
 * The common case (nothing extra, nothing capped) renders exactly like the
 * old plain `matchedEdges/expectedEdges` cell.
 */
function evidenceCell(candidate: SignalFinderExportCandidate, s: SummaryStrings): string {
  let cell = `${candidate.netEdges}/${candidate.expectedEdges}`;
  if (candidate.extraTransitions > 0) cell += ` (${s.extraSuffix(candidate.extraTransitions)})`;
  if (candidate.didBaselineChanges > 0) cell += `, ${s.baselineMoved(candidate.didBaselineChanges)}`;
  if (candidate.verdictCapReason !== null) cell += `, ${s.cappedLabel(s.capReasons[candidate.verdictCapReason])}`;
  return cell;
}

/** The <= 1-page summary. Never dumps the raw sample log — that is what the JSON is for. */
export function buildSignalFinderSummaryMarkdown(
  doc: SignalFinderExportDocument,
  language: SignalFinderLanguage,
): string {
  const s = language === 'ro' ? RO : EN;
  const engine = doc.session.engineRequirement === 'running' ? s.engineRunning : s.engineOff;
  const didCount = doc.passes.reduce((total, pass) => total + pass.didHex.length, 0);
  const found = doc.candidates.filter((c) => c.verdict === 'found');

  const lines: string[] = [];
  lines.push(`# ${s.title(doc.session.targetLabel)}`);
  lines.push('');
  lines.push(`**${found.length > 0 ? s.found : s.nothingFound}** — ${engine}`);
  lines.push('');
  lines.push(`- ${s.session}: \`${doc.session.sessionId ?? '-'}\` (${doc.session.startedAtUtc ?? '-'})`);
  lines.push(
    `- ${s.read}: ${s.didsAcross(didCount, doc.passes.length)} — ${doc.passes.map((p) => p.ecuHex).join(', ') || '-'}`,
  );
  lines.push('');
  lines.push(s.tableHeader);
  lines.push('| --- | --- | --- | --- | --- | --- |');
  // Ranked already (found first); a long tail of `unrelated` rows would break
  // the one-page promise, so only the informative ones are tabulated.
  const rows = doc.candidates.filter((c) => c.verdict !== 'unrelated').slice(0, 12);
  const tabulated = rows.length > 0 ? rows : doc.candidates.slice(0, 8);
  for (const candidate of tabulated) {
    const offset = candidate.byteOffset === null ? '' : ` b${candidate.byteOffset}`;
    lines.push(
      `| ${candidate.didHex}${offset} | ${candidate.ecuHex} | ${s.verdicts[candidate.verdict]} | ${evidenceCell(candidate, s)} | ${candidate.baselineChanges} | ${candidate.restValueHex ?? '-'} → ${candidate.min ?? '-'}..${candidate.max ?? '-'} |`,
    );
  }
  lines.push('');
  if (doc.candidates.length > tabulated.length) {
    lines.push(`_… ${doc.candidates.length - tabulated.length} × ${s.verdicts.unrelated} (+${doc.candidates.length - tabulated.length} more)_`);
    lines.push('');
  }
  if (doc.noResponse.length > 0) {
    lines.push(
      `**${s.noResponse}:** ${joinWithMoreMarker(doc.noResponse, SUMMARY_MAX_NO_RESPONSE_LISTED, (entry) => `${entry.didHex} (${entry.ecuHex})`)}`,
    );
    lines.push('');
  }
  lines.push(
    `**${s.confirmed}:** ${
      doc.confirmedBindings.length === 0
        ? s.none
        : joinWithMoreMarker(
            doc.confirmedBindings,
            SUMMARY_MAX_CONFIRMED_LISTED,
            (b) => `${b.channel} = ${b.ecuHex} ${b.didHex} — ${truncateText(b.decode, SUMMARY_MAX_DECODE_CHARS)}`,
          )
    }`,
  );
  if (doc.nextStep !== null) {
    lines.push('');
    const range = `${doc.nextStep.fromDidHex}–${doc.nextStep.toDidHex}`;
    const engineNext = doc.nextStep.engineRequirement === 'running' ? s.engineRunning : s.engineOff;
    lines.push(
      `**${s.nextStep}:** ${s.sweep(range, doc.nextStep.ecuHex ?? '*')}, ${s.minutes(doc.nextStep.estimatedMinutes)}, ${engineNext} — ${doc.nextStep.note}`,
    );
  }
  lines.push('');
  lines.push(`_${s.generated}: ${doc.generatedAtUtc} · ${doc.kind} v${doc.schemaVersion}_`);
  return enforceTotalBudget(lines);
}

// ---------------------------------------------------------------------------
// Share (same never-throws contract as `didSweepExport.ts`'s own).
// ---------------------------------------------------------------------------

export interface SignalFinderShareResult {
  /** True whenever the export "succeeded" in a user-facing sense — including the web/unsupported-platform fallback. */
  ok: boolean;
  /** True only when the OS share sheet was genuinely invoked. */
  shared: boolean;
  /** The written `.md` file's uri, or `null` on the fallback path. */
  markdownUri: string | null;
  /** The written `.json` file's uri — what the screen's second button shares. */
  jsonUri: string | null;
  markdownLength: number;
  jsonLength: number;
  error?: string;
}

function writeBoth(doc: SignalFinderExportDocument, language: SignalFinderLanguage): {
  markdown: string;
  json: string;
  markdownUri: string;
  jsonUri: string;
} {
  const markdown = buildSignalFinderSummaryMarkdown(doc, language);
  const json = JSON.stringify(doc, null, 2);
  const markdownFile = new File(Paths.cache, signalFinderExportFileName(doc.generatedAtUtc, doc.session.targetId, 'md'));
  markdownFile.write(markdown);
  const jsonFile = new File(Paths.cache, signalFinderExportFileName(doc.generatedAtUtc, doc.session.targetId, 'json'));
  jsonFile.write(json);
  return { markdown, json, markdownUri: markdownFile.uri, jsonUri: jsonFile.uri };
}

/**
 * Writes BOTH files and hands the `.md` to the OS share sheet (the human-
 * readable half is what the user forwards). The JSON's uri comes back in the
 * result so the screen can offer {@link shareSignalFinderJson} as a second
 * button — `expo-sharing` shares exactly one file per call. Never throws.
 */
export async function shareSignalFinderExport(
  doc: SignalFinderExportDocument,
  language: SignalFinderLanguage,
): Promise<SignalFinderShareResult> {
  const markdown = buildSignalFinderSummaryMarkdown(doc, language);
  const json = JSON.stringify(doc, null, 2);
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      console.log(
        `[signalFinderExport] Sharing unavailable on this platform (e.g. web preview) -- summary ${markdown.length} bytes, JSON ${json.length} bytes`,
      );
      return { ok: true, shared: false, markdownUri: null, jsonUri: null, markdownLength: markdown.length, jsonLength: json.length };
    }
    const written = writeBoth(doc, language);
    await Sharing.shareAsync(written.markdownUri, { mimeType: 'text/markdown', dialogTitle: 'Share Signal Finder summary' });
    return {
      ok: true,
      shared: true,
      markdownUri: written.markdownUri,
      jsonUri: written.jsonUri,
      markdownLength: written.markdown.length,
      jsonLength: written.json.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[signalFinderExport] export failed (falling back) -- summary is ${markdown.length} bytes: ${message}`);
    return { ok: false, shared: false, markdownUri: null, jsonUri: null, markdownLength: markdown.length, jsonLength: json.length, error: message };
  }
}

/** The second button: shares the full JSON on its own. Never throws. */
export async function shareSignalFinderJson(doc: SignalFinderExportDocument): Promise<SignalFinderShareResult> {
  const json = JSON.stringify(doc, null, 2);
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      console.log(`[signalFinderExport] Sharing unavailable on this platform -- JSON is ${json.length} bytes`);
      return { ok: true, shared: false, markdownUri: null, jsonUri: null, markdownLength: 0, jsonLength: json.length };
    }
    const file = new File(Paths.cache, signalFinderExportFileName(doc.generatedAtUtc, doc.session.targetId, 'json'));
    file.write(json);
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Share Signal Finder session (JSON)' });
    return { ok: true, shared: true, markdownUri: null, jsonUri: file.uri, markdownLength: 0, jsonLength: json.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[signalFinderExport] JSON export failed (falling back) -- JSON is ${json.length} bytes: ${message}`);
    return { ok: false, shared: false, markdownUri: null, jsonUri: null, markdownLength: 0, jsonLength: json.length, error: message };
  }
}

// ---------------------------------------------------------------------------
// P4l-FIX3 J4 (binding — contracts.md "Signal Finder (Phase 4l)" item 5:
// "'Confirm as <target>' writes a channel binding ... into the persisted
// vehicle profile (SQLite, exportable JSON identical to
// `data/vehicle-profiles/*.json`)"): the persisted `VehicleProfileBinding`
// rows (`didSweepStore.ts`) merged into the SAME top-level shape as the
// canonical profile files — `profileId`, `make`/`model` (when the profile is
// a known one; the hypothesis-free 'generic' profile carries neither),
// `transport`, `ecus`, `channels[]`. A SEPARATE document from
// {@link SignalFinderExportDocument} above (which is one FIND SESSION's own
// record) — this one is the whole car's accumulated, confirmed knowledge,
// independent of which session confirmed which channel.
// ---------------------------------------------------------------------------

export const VEHICLE_PROFILE_EXPORT_SCHEMA_VERSION = 1;
export const VEHICLE_PROFILE_EXPORT_KIND = 'trace-vehicle-profile';

/** Only every ENET transport exists in this app today (contracts.md); a per-profile `transport` field is still emitted (matching the canonical file's own key) rather than assumed by every reader. */
const VEHICLE_PROFILE_TRANSPORT = 'enet';

export interface VehicleProfileChannelDocument {
  channel: string;
  source: 'did';
  ecu: string;
  did: string;
  length: number | null;
  decode: string;
  status: VehicleProfileBindingStatus;
  /** A short human note on where this came from — the canonical file's own `provenance` field. */
  provenance: string;
  /** The binding's own evidence summary — parsed JSON when `evidenceJson` is well-formed, else the raw string (never thrown away, never throws). */
  evidence: unknown;
  updatedAtUtc: string;
}

export interface VehicleProfileEcuDocument {
  address: string;
  /** The STRONGEST status any binding on this ECU has reached (`field-confirmed` > `field-observed` > `weak` > `hypothesis`). */
  status: VehicleProfileBindingStatus;
}

export interface VehicleProfileDocument {
  schemaVersion: number;
  kind: string;
  generatedAtUtc: string;
  profileId: string;
  make?: string;
  model?: string;
  transport: string;
  ecus: Record<string, VehicleProfileEcuDocument>;
  channels: VehicleProfileChannelDocument[];
}

/** `field-confirmed` outranks every other status a binding can carry — used to pick the ECU-level status when several bindings share an ECU. */
const BINDING_STATUS_RANK: Readonly<Record<VehicleProfileBindingStatus, number>> = {
  hypothesis: 0,
  weak: 1,
  'field-observed': 2,
  'field-confirmed': 3,
};

/**
 * Splits a catalog's own descriptive `label` (e.g. `'Toyota GR Supra
 * (A90/J29), BMW B58'`, `targets.ts`'s own data) into `make`/`model` at the
 * first space. A deliberately light heuristic for PRESENTATION metadata
 * only (never fed back into decoding/scoring) — the alternative would be a
 * second, hand-maintained make/model table in this file, duplicating data
 * that already lives in exactly one place (the catalog registry).
 */
function makeAndModelFromCatalogLabel(label: string): { make?: string; model?: string } {
  const idx = label.indexOf(' ');
  if (idx <= 0) return {};
  return { make: label.slice(0, idx), model: label.slice(idx + 1) };
}

function parseEvidence(evidenceJson: string): unknown {
  try {
    return JSON.parse(evidenceJson);
  } catch {
    return evidenceJson;
  }
}

/** `trace-vehicle-profile-<profileId>-<yyyy-mm-dd>.json` (mirrors {@link signalFinderExportFileName}'s own pattern). */
export function vehicleProfileExportFileName(profileId: string, generatedAtUtc: string): string {
  return `${VEHICLE_PROFILE_EXPORT_KIND}-${profileId}-${generatedAtUtc.slice(0, 10)}.json`;
}

/**
 * Merges every persisted binding for `profileId` into the canonical
 * vehicle-profile shape (pure — no I/O; `bindings` comes from
 * `VehicleProfileBindingStore.listBindings(profileId)`). Every binding
 * becomes one `channels[]` entry; `ecus` is derived from the distinct ECU
 * addresses actually seen, each carrying the STRONGEST status recorded for
 * it.
 */
export function buildVehicleProfileDocument(
  profileId: string,
  bindings: readonly VehicleProfileBinding[],
  generatedAtUtc: string,
): VehicleProfileDocument {
  const catalog = profileId === 'generic' ? null : resolveSignalTargetCatalog(profileId);
  const { make, model } = catalog === null ? {} : makeAndModelFromCatalogLabel(catalog.label);

  const ecus: Record<string, VehicleProfileEcuDocument> = {};
  for (const b of bindings) {
    const address = ecuHex(b.ecu);
    const existing = ecus[address];
    if (existing === undefined || BINDING_STATUS_RANK[b.status] > BINDING_STATUS_RANK[existing.status]) {
      ecus[address] = { address, status: b.status };
    }
  }

  const channels: VehicleProfileChannelDocument[] = bindings.map((b) => ({
    channel: b.channel,
    source: 'did',
    ecu: ecuHex(b.ecu),
    did: didHex(b.did),
    length: b.length,
    decode: b.decode,
    status: b.status,
    provenance: `Signal Finder — ${b.status} (${b.updatedAtUtc})`,
    evidence: parseEvidence(b.evidenceJson),
    updatedAtUtc: b.updatedAtUtc,
  }));

  return {
    schemaVersion: VEHICLE_PROFILE_EXPORT_SCHEMA_VERSION,
    kind: VEHICLE_PROFILE_EXPORT_KIND,
    generatedAtUtc,
    profileId,
    ...(make === undefined ? {} : { make }),
    ...(model === undefined ? {} : { model }),
    transport: VEHICLE_PROFILE_TRANSPORT,
    ecus,
    channels,
  };
}

/** Writes and shares the vehicle-profile JSON on its own (one file, `expo-sharing`'s own one-file-per-call limit) — the screen's "Share profile" button. Never throws, mirrors {@link shareSignalFinderJson}'s own contract. */
export async function shareVehicleProfileExport(doc: VehicleProfileDocument): Promise<SignalFinderShareResult> {
  const json = JSON.stringify(doc, null, 2);
  try {
    const available = await Sharing.isAvailableAsync();
    if (!available) {
      console.log(`[signalFinderExport] Sharing unavailable on this platform -- vehicle profile JSON is ${json.length} bytes`);
      return { ok: true, shared: false, markdownUri: null, jsonUri: null, markdownLength: 0, jsonLength: json.length };
    }
    const file = new File(Paths.cache, vehicleProfileExportFileName(doc.profileId, doc.generatedAtUtc));
    file.write(json);
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: 'Share vehicle profile' });
    return { ok: true, shared: true, markdownUri: null, jsonUri: file.uri, markdownLength: 0, jsonLength: json.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[signalFinderExport] vehicle profile export failed (falling back) -- JSON is ${json.length} bytes: ${message}`);
    return { ok: false, shared: false, markdownUri: null, jsonUri: null, markdownLength: 0, jsonLength: json.length, error: message };
  }
}
