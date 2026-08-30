import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import {
  findSignalTarget,
  resolveSignalTargetCatalog,
  resolveSignalTargetLabel,
  type FinderRateSource,
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
import type { SignalFinderEcuPass, SignalFinderReplacedBinding, SignalFinderSnapshot } from './signalFinderController';

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

/**
 * P4m M3 (binding): schema 2 added `session.rounds` and the top-level
 * `notRead` list (items 10 and 12).
 *
 * P4m-FIX1 (X1/X2): schema 3 adds `session.rateSource` — whether
 * `measuredReqPerSec` was MEASURED by this find's own probe or assumed — and
 * the top-level `silent` list (DIDs skipped because their ECU answered
 * nothing). Both are honesty fields: a reader of an old export cannot tell an
 * assumed rate from a measured one, which is the defect they close.
 *
 * P4m-FIX3 (Z1/Z7): schema 4 adds the top-level `diagnostics` section — the
 * RAW failure text (which no longer appears in ANY user-facing string, in
 * either language), the probe's timeout-inclusive rate (what the whole probe
 * achieved, as opposed to `session.measuredReqPerSec`, which is the rate of the
 * entries the round KEPT and therefore what the budget and every minute
 * estimate rest on), and whether the adapter confirmed its own shutdown.
 *
 * Ticket P4o O3/O4 (binding, field test 8): schema 5 adds the top-level
 * `replaced` list (every binding a confirm in THIS session replaced, with
 * both the old and the new (ecu, did) — field test 8's own defect was a
 * confirm silently overwriting a good binding with no record anywhere) and a
 * `confirmedDidHex` list on each `passes[]` entry (which DIDs were read
 * because the target already had a confirmed binding — O4's pool order).
 */
export const SIGNAL_FINDER_EXPORT_SCHEMA_VERSION = 5;
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
  /** P4m-FIX1 X1: was that rate measured by the probe, or assumed? */
  rateSource: FinderRateSource;
  timeline: MetronomeTimeline | null;
  passes: readonly SignalFinderEcuPass[];
  /** P4m (item 9/10): how many metronome scripts the driver actually performed for this target. */
  rounds: number;
  /** P4m (item 10): the DID budget one round reads at the measured rate. */
  budget: number;
  scores: readonly SignalCandidateScore[];
  noResponseDids: readonly { ecu: number; did: number }[];
  /** P4m (item 12): eligible DIDs no round reached — reported as "not read", NEVER as "no response". */
  notReadDids: readonly { ecu: number; did: number }[];
  /** P4m-FIX1 X2: eligible DIDs skipped because their ECU answered nothing in the probe. */
  silentDids: readonly { ecu: number; did: number }[];
  /** P4m-FIX1 X2: the ECUs those DIDs sit on. */
  silentEcus: readonly number[];
  samples: readonly SignalFinderSample[];
  confirmedBindings: readonly VehicleProfileBinding[];
  nextStep: NextDiscoveryStep | null;
  /** P4m-FIX3 Z1/Z7 (schema 4): everything the DRIVER is deliberately not shown. */
  diagnostics: SignalFinderExportDiagnostics;
  /** Ticket P4o O3 (schema 5): every binding a confirm in THIS session replaced. */
  replacedBindings: readonly SignalFinderReplacedBinding[];
}

/**
 * P4m-FIX3 Z7 (Codex P4m-REV3 finding 9): the one place a raw, untranslated
 * message may appear. The screen renders a localized line for the error CODE
 * and nothing else, so this section is what a developer (or the user forwarding
 * the JSON) needs in order to see the real failure.
 */
export interface SignalFinderExportDiagnostics {
  /**
   * The controller's raw `error` text — English/underlying, never rendered in
   * the UI, and REDACTED on its way into the document
   * ({@link redactDiagnosticError}, P4m-FIX4 W4).
   */
  rawError: string | null;
  /** P4m-FIX3 Z1: what the PROBE as a whole achieved, the timeouts of the entries it then dropped included. */
  timeoutInclusiveReqPerSec: number | null;
  /** P4m-FIX3 Z6: the previous transport's `close()` had not settled when its reservation was released. */
  adapterTeardownPending: boolean;
}

export interface SignalFinderExportPass {
  ecuHex: string;
  didHex: string[];
  /** Ticket P4o O4 (schema 5): read because the target already had a confirmed binding here. */
  confirmedDidHex: string[];
  hypothesisDidHex: string[];
  /** P4m (item 10b): read because an earlier observation saw them CHANGE. */
  changedDidHex: string[];
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
  /** P4m (item 11): the verdict rests on sparse but consistent evidence (`found (sparse)`). */
  sparse: boolean;
  /** P4m (item 11): edges proved by window agreement rather than by observed transitions. */
  windowMatchedEdges: number;
  /** P4m (item 11): the single bit that separates the two levels (DME 0x4007 = bit 0), or `null`. */
  flagBit: number | null;
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
    /** P4m-FIX1 X1 (schema 3): `'measured'` only when this find's own probe measured it. */
    rateSource: FinderRateSource;
    /** P4m (schema 2): metronome scripts actually performed, and the per-round DID budget. */
    rounds: number;
    budget: number;
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
  /** Item 2 (binding): DIDs that were POLLED and answered NRC or nothing — reported, never silently absent. */
  noResponse: Array<{ ecuHex: string; didHex: string }>;
  /** P4m (item 12, schema 2): eligible DIDs no round reached. Build 5 reported these 1372 DIDs as "No response" — an honesty bug. */
  notRead: Array<{ ecuHex: string; didHex: string }>;
  /** P4m-FIX1 X2 (schema 3): DIDs skipped because their ECU answered nothing in the probe, with those ECUs named. */
  silent: { ecus: string[]; dids: Array<{ ecuHex: string; didHex: string }> };
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
  /** P4m-FIX3 Z1/Z7 (schema 4): the raw error text and the probe's own overall rate — never shown on screen. */
  diagnostics: SignalFinderExportDiagnostics;
  /** Ticket P4o O3 (schema 5): every binding a confirm in THIS session replaced, oldest first. */
  replaced: Array<{
    channel: string;
    ecuHex: string;
    didHex: string;
    previousEcuHex: string;
    previousDidHex: string;
    replacedAtUtc: string;
  }>;
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
    rateSource: snap.rateSource,
    timeline: snap.timeline,
    passes: snap.passes,
    rounds: snap.round,
    budget: snap.budget,
    scores: snap.scores,
    noResponseDids: snap.noResponseDids,
    notReadDids: snap.notReadDids,
    silentDids: snap.silentDids,
    silentEcus: snap.silentEcus,
    samples,
    confirmedBindings,
    nextStep: snap.nextStep,
    // Z7: the RAW error leaves the app here and only here.
    diagnostics: {
      rawError: snap.error,
      timeoutInclusiveReqPerSec: snap.diagnosticReqPerSec,
      adapterTeardownPending: snap.adapterTeardownPending,
    },
    // P4o O3: whatever this session's confirms have replaced so far.
    replacedBindings: snap.replacedBindings,
  };
}

/** What replaces anything that could identify a machine, a network or a secret. */
export const DIAGNOSTICS_REDACTION = '‹redacted›';

/**
 * P4m-REV5 L8: the suffixes that make a dotted name an ADDRESS rather than a
 * qualified identifier. Everything else with a dot in it (`transport.close`,
 * `net.Socket`, `Error.captureStackTrace`) is the message's own subject and is
 * kept — unless a port follows it, which no method name ever carries.
 */
const HOST_SUFFIXES = ['local', 'lan', 'home', 'internal', 'arpa', 'com', 'net', 'org', 'io', 'dev', 'app', 'co', 'ro', 'eu'];

/** How much of the (already redacted) message survives — enough for the error's name and its first clause. */
const DIAGNOSTICS_MAX_CHARS = 120;

/**
 * P4m-FIX4 W4 (Codex P4m-REV4 finding 4, MEDIUM): "schema 4 exports arbitrary
 * underlying error text without redaction ... transport/platform errors can
 * contain addresses, paths, identifiers, or credentials", and this document is
 * one the user is invited to SHARE.
 *
 * What survives is what a developer actually debugs from: the error's own
 * name/code and the first {@link DIAGNOSTICS_MAX_CHARS} characters of what it
 * said. What never leaves the phone: URLs, IPv4/IPv6 addresses, host:port
 * pairs, file paths, and anything long enough to be a token (24+ characters of
 * hex or base64). The patterns are eager about addresses — a redacted timestamp
 * costs nothing, a leaked address costs the user — and deliberately narrow
 * about dotted names (P4m-REV5 L8, {@link HOST_SUFFIXES}), because
 * `transport.close` is the half of the message worth keeping.
 */
export function redactDiagnosticError(raw: string | null): string | null {
  if (raw === null) return null;
  const patterns: RegExp[] = [
    /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, // any URL (scheme://host/path)
    /\b[A-Za-z]:[\\/][^\s"']*/g, // Windows path
    /(?:^|[\s"'(])[\\/][^\s"')]{2,}/g, // POSIX path
    /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, // IPv4, with or without a port
    /\b[0-9A-Fa-f]{0,4}(?::{1,2}[0-9A-Fa-f]{1,4}){2,7}\b/g, // IPv6, compressed forms included
    // P4m-REV5 L8: a dotted name is an ADDRESS only when its last label is a
    // TLD-like suffix, or when a port follows it. `transport.close` and
    // `net.Socket` are the message's own subject, not somebody's host.
    new RegExp(`\\b(?:[A-Za-z0-9-]+\\.)+(?:${HOST_SUFFIXES.join('|')})\\b(?::\\d{1,5})?`, 'gi'),
    /\b(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}:\d{1,5}\b/g, // any dotted name that carries a port
    /\b[A-Za-z][A-Za-z0-9_-]+:\d{2,5}\b/g, // bare host:port
    /\b[0-9A-Fa-f]{24,}\b/g, // hex token
    /\b[A-Za-z0-9+/_-]{24,}={0,2}\b/g, // base64-ish token
  ];
  let text = raw;
  for (const pattern of patterns) {
    text = text.replace(pattern, (match) => {
      // The POSIX-path pattern eats its leading separator character: keep it.
      const lead = /^[\s"'(]/.test(match) ? match[0] : '';
      return `${lead}${DIAGNOSTICS_REDACTION}`;
    });
  }
  text = text.replace(/\s+/g, ' ').trim();
  return text.length > DIAGNOSTICS_MAX_CHARS ? `${text.slice(0, DIAGNOSTICS_MAX_CHARS)}…` : text;
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
      rateSource: input.rateSource,
      rounds: input.rounds,
      budget: input.budget,
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
      confirmedDidHex: pass.confirmedDids.map(didHex),
      hypothesisDidHex: pass.hypothesisDids.map(didHex),
      changedDidHex: pass.changedDids.map(didHex),
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
      sparse: score.sparse ?? false,
      windowMatchedEdges: score.windowMatchedEdges ?? 0,
      flagBit: score.flagBit ?? null,
    })),
    noResponse: input.noResponseDids.map((entry) => ({ ecuHex: ecuHex(entry.ecu), didHex: didHex(entry.did) })),
    notRead: input.notReadDids.map((entry) => ({ ecuHex: ecuHex(entry.ecu), didHex: didHex(entry.did) })),
    silent: {
      ecus: input.silentEcus.map(ecuHex),
      dids: input.silentDids.map((entry) => ({ ecuHex: ecuHex(entry.ecu), didHex: didHex(entry.did) })),
    },
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
    diagnostics: {
      // W4: the ONE place the raw text is written out is the one place it is
      // redacted -- whatever built the input, and however it got here.
      rawError: redactDiagnosticError(input.diagnostics.rawError),
      timeoutInclusiveReqPerSec: input.diagnostics.timeoutInclusiveReqPerSec,
      adapterTeardownPending: input.diagnostics.adapterTeardownPending,
    },
    replaced: input.replacedBindings.map((r) => ({
      channel: r.channel,
      ecuHex: ecuHex(r.ecu),
      didHex: didHex(r.did),
      previousEcuHex: ecuHex(r.previousEcu),
      previousDidHex: didHex(r.previousDid),
      replacedAtUtc: r.replacedAtUtc,
    })),
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
  /** P4m M3: " in 2 rounds" — how many scripts the driver actually performed. */
  inRounds: (rounds: number) => string;
  /** P4m M3/item 12: "Not read: 20 (tap Next round)" — never listed under "No response". */
  notRead: (count: number) => string;
  /** P4m item 11: the "(sparse)" qualifier on a found verdict. */
  sparseSuffix: string;
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
  /** P4m-FIX1 X1: the header states whether the rate was MEASURED by the find's own probe or assumed. */
  rateMeasured: (reqPerSec: number) => string;
  rateAssumed: (reqPerSec: number) => string;
  /** P4m-FIX1 X2: "Not read: 4 — ECU 0x29 silent". */
  silent: (count: number, ecus: string) => string;
  /** P4m-FIX3 Z4: the same list when the ECU itself is ALIVE — only the DID never answered (its probe attempt AND its one retry). */
  silentDids: (count: number) => string;
  /** P4m-FIX1 X8: the list-truncation marker — an RO summary used to end its lists in English. */
  moreItems: (count: number) => string;
  /** P4m-FIX1 X8: the free-text truncation marker. */
  moreChars: (count: number) => string;
  /** P4m-FIX1 X8: the whole-summary budget marker. */
  truncated: string;
  /** Ticket P4o O3: "Replaced" section heading — the bindings a confirm in THIS session overwrote. */
  replaced: string;
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
  inRounds: (rounds) => ` in ${rounds} round${rounds === 1 ? '' : 's'}`,
  notRead: (count) => `Not read: ${count} (tap Next round)`,
  sparseSuffix: ' (sparse)',
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
  rateMeasured: (reqPerSec) => `${reqPerSec.toFixed(1)} req/s measured`,
  rateAssumed: (reqPerSec) => `rate assumed ${reqPerSec.toFixed(1)} req/s — probe failed`,
  silent: (count, ecus) => `Not read: ${count} — ECU ${ecus} silent`,
  silentDids: (count) => `Not read: ${count} — no answer to the probe or its one retry`,
  moreItems: (count) => `(+${count} more)`,
  moreChars: (count) => `(+${count} more chars)`,
  truncated: '_(+ more, truncated to stay within the summary budget)_',
  replaced: 'Replaced',
  capReasons: {
    'response-baseline-changes': 'restless baseline',
    'one-sided-bipolar': 'one-sided',
    'extra-transitions': 'extra transitions',
    'never-moved': 'never moved',
    'two-level': 'switch-like, not analog',
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
  inRounds: (rounds) => ` în ${rounds} rund${rounds === 1 ? 'ă' : 'e'}`,
  notRead: (count) => `Necitite: ${count} (apasă Runda următoare)`,
  sparseSuffix: ' (rar)',
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
  rateMeasured: (reqPerSec) => `${reqPerSec.toFixed(1)} cereri/s măsurate`,
  rateAssumed: (reqPerSec) => `rată presupusă ${reqPerSec.toFixed(1)} cereri/s — sondarea nu a răspuns`,
  silent: (count, ecus) => `Necitite: ${count} — ECU ${ecus} nu răspunde`,
  silentDids: (count) => `Necitite: ${count} — fără răspuns la sondaj sau la reîncercare`,
  moreItems: (count) => `(+încă ${count})`,
  moreChars: (count) => `(+încă ${count} caractere)`,
  truncated: '_(+ restul, tăiat ca rezumatul să rămână de o pagină)_',
  replaced: 'Înlocuite',
  capReasons: {
    'response-baseline-changes': 'repaus neliniștit',
    'one-sided-bipolar': 'unilateral',
    'extra-transitions': 'tranziții în plus',
    'never-moved': 'nu s-a schimbat deloc',
    'two-level': 'ca un comutator, nu analog',
  },
};

/** P4m-FIX1 X8: both tables, exported so a test can pin that RO carries every key EN does — nothing a driver reads may be English-only. */
export const SIGNAL_FINDER_SUMMARY_STRINGS: Readonly<Record<SignalFinderLanguage, SummaryStrings>> = { en: EN, ro: RO };

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
function joinWithMoreMarker<T>(items: readonly T[], max: number, render: (item: T) => string, s: SummaryStrings): string {
  const shown = items.slice(0, max).map(render).join(', ');
  const omitted = items.length - max;
  return omitted > 0 ? `${shown} ${s.moreItems(omitted)}` : shown;
}

/** Truncates free-text (a binding's decode guess) to `maxChars`, marking how much was cut. Never splits a section's OWN "(+N more)" convention — this is chars, not items, so the wording says so. */
function truncateText(text: string, maxChars: number, s: SummaryStrings): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… ${s.moreChars(text.length - maxChars)}`;
}

/**
 * Hard backstop UNDERNEATH every per-section cap above: even if every
 * section individually stayed inside its own limit, many small sections
 * together could still exceed the total budget (many confirmed channels,
 * say). Truncates whole trailing LINES (never mid-line) and appends one
 * final marker line — the one place a truncation can still occur without a
 * dedicated "(+N more)" of its own, so it gets one here.
 */
function enforceTotalBudget(lines: readonly string[], s: SummaryStrings): string {
  let text = lines.join('\n');
  if (text.length <= SUMMARY_MAX_CHARS && lines.length <= SUMMARY_MAX_LINES) return text;
  let kept = lines;
  if (kept.length > SUMMARY_MAX_LINES) kept = kept.slice(0, SUMMARY_MAX_LINES - 1);
  text = kept.join('\n');
  while (text.length > SUMMARY_MAX_CHARS - 40 && kept.length > 1) {
    kept = kept.slice(0, kept.length - 1);
    text = kept.join('\n');
  }
  return `${text}\n${s.truncated}`;
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
  // P4m (item 11): a `sparse` verdict rests on WINDOW AGREEMENT, not on
  // observed transitions (at one sample per window a transition is often
  // unobservable), so that is the number this row must show.
  let cell = candidate.sparse
    ? `${candidate.windowMatchedEdges}/${candidate.expectedEdges}`
    : `${candidate.netEdges}/${candidate.expectedEdges}`;
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
  /**
   * P4m-FIX2 Y7 (Codex P4m-REV2 finding 9): "the controller stores
   * `target.label` in English and the export consumes it unchanged" — so an RO
   * summary was titled "Brake switch". The `.md` is the file the driver
   * FORWARDS, so its target name is resolved BY LANGUAGE from the catalog
   * (data) at export time. `doc.session.targetLabel` stays the stable
   * English/tooling name inside the JSON: one machine-readable identity, one
   * human-readable rendering, neither pretending to be the other.
   */
  const target = findSignalTarget(resolveSignalTargetCatalog(doc.session.profileId), doc.session.targetId);
  const targetLabel = target === null ? doc.session.targetLabel : resolveSignalTargetLabel(target, language);
  const engine = doc.session.engineRequirement === 'running' ? s.engineRunning : s.engineOff;
  const didCount = doc.passes.reduce((total, pass) => total + pass.didHex.length, 0);
  const found = doc.candidates.filter((c) => c.verdict === 'found');

  const lines: string[] = [];
  lines.push(`# ${s.title(targetLabel)}`);
  lines.push('');
  lines.push(`**${found.length > 0 ? s.found : s.nothingFound}** — ${engine}`);
  lines.push('');
  lines.push(`- ${s.session}: \`${doc.session.sessionId ?? '-'}\` (${doc.session.startedAtUtc ?? '-'})`);
  // P4m M3 (binding): "Read N DIDs across E ECUs in R round(s)" — the header
  // states what the DRIVER actually did, and (item 12) what is still unread.
  lines.push(
    `- ${s.read}: ${s.didsAcross(didCount, doc.passes.length)}${s.inRounds(doc.session.rounds)} — ${
      doc.passes.map((p) => p.ecuHex).join(', ') || '-'
    }`,
  );
  if (doc.notRead.length > 0) lines.push(`- ${s.notRead(doc.notRead.length)}`);
  // P4m-FIX1 X2: a silent ECU gets its own line WITH the reason -- never mixed
  // into "not read (tap Next round)" (no round can fix a silent ECU), never
  // into "no response" (those DIDs were actually asked).
  // P4m-FIX3 Z4: name an ECU as silent ONLY when the probe found it wholly
  // silent. A hypothesis that missed its one retry on an otherwise answering
  // ECU is a silent DID, and saying "ECU 0x12 silent" about the DME that
  // answered everything else is the same class of dishonesty as item 12's.
  if (doc.silent.dids.length > 0) {
    lines.push(
      `- ${doc.silent.ecus.length > 0 ? s.silent(doc.silent.dids.length, doc.silent.ecus.join(', ')) : s.silentDids(doc.silent.dids.length)}`,
    );
  }
  // P4m-FIX1 X1: the rate the budget rested on, and whether it was measured.
  lines.push(
    `- ${
      doc.session.rateSource === 'measured'
        ? s.rateMeasured(doc.session.measuredReqPerSec)
        : s.rateAssumed(doc.session.measuredReqPerSec)
    }`,
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
      `| ${candidate.didHex}${offset} | ${candidate.ecuHex} | ${s.verdicts[candidate.verdict]}${
        candidate.sparse ? s.sparseSuffix : ''
      } | ${evidenceCell(candidate, s)} | ${candidate.baselineChanges} | ${candidate.restValueHex ?? '-'} → ${candidate.min ?? '-'}..${candidate.max ?? '-'} |`,
    );
  }
  lines.push('');
  if (doc.candidates.length > tabulated.length) {
    // P4m-FIX2 Y7: the one list marker that still hard-coded English — every
    // other section already went through `joinWithMoreMarker`'s `s.moreItems`.
    const omitted = doc.candidates.length - tabulated.length;
    lines.push(`_… ${omitted} × ${s.verdicts.unrelated} ${s.moreItems(omitted)}_`);
    lines.push('');
  }
  if (doc.noResponse.length > 0) {
    lines.push(
      `**${s.noResponse}:** ${joinWithMoreMarker(doc.noResponse, SUMMARY_MAX_NO_RESPONSE_LISTED, (entry) => `${entry.didHex} (${entry.ecuHex})`, s)}`,
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
            (b) => `${b.channel} = ${b.ecuHex} ${b.didHex} — ${truncateText(b.decode, SUMMARY_MAX_DECODE_CHARS, s)}`,
            s,
          )
    }`,
  );
  // P4o O3: only rendered when something was actually replaced this session
  // -- unlike "Confirmed bindings" above, there is no "none" line to keep a
  // report from field test 5 onward looking identical.
  if (doc.replaced.length > 0) {
    lines.push('');
    lines.push(
      `**${s.replaced}:** ${joinWithMoreMarker(
        doc.replaced,
        SUMMARY_MAX_CONFIRMED_LISTED,
        (r) => `${r.channel} = ${r.previousEcuHex} ${r.previousDidHex} → ${r.ecuHex} ${r.didHex}`,
        s,
      )}`,
    );
  }
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
  return enforceTotalBudget(lines, s);
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
