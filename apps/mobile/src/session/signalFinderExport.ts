import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type {
  MetronomeTimeline,
  NextDiscoveryStep,
  SignalCandidateScore,
  SignalEngineRequirement,
  SignalFinderSample,
  SignalTargetId,
} from '@circuit/core';
import type { VehicleProfileBinding } from '../persistence/didSweepStore';
import type { SignalFinderEcuPass } from './signalFinderController';

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

/** RO/EN, per contracts.md item 8. `apps/mobile`'s settings store has no language setting yet, so the screen passes `'en'` until one exists. */
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
};

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
      `| ${candidate.didHex}${offset} | ${candidate.ecuHex} | ${s.verdicts[candidate.verdict]} | ${candidate.matchedEdges}/${candidate.expectedEdges} | ${candidate.baselineChanges} | ${candidate.restValueHex ?? '-'} → ${candidate.min ?? '-'}..${candidate.max ?? '-'} |`,
    );
  }
  lines.push('');
  if (doc.candidates.length > tabulated.length) {
    lines.push(`_… ${doc.candidates.length - tabulated.length} × ${s.verdicts.unrelated}_`);
    lines.push('');
  }
  if (doc.noResponse.length > 0) {
    lines.push(`**${s.noResponse}:** ${doc.noResponse.map((entry) => `${entry.didHex} (${entry.ecuHex})`).join(', ')}`);
    lines.push('');
  }
  lines.push(
    `**${s.confirmed}:** ${
      doc.confirmedBindings.length === 0
        ? s.none
        : doc.confirmedBindings
            .map((b) => `${b.channel} = ${b.ecuHex} ${b.didHex} — ${b.decode}`)
            .join('; ')
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
  return lines.join('\n');
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
