import type { SignalCandidateScore, SignalVerdictCapReason } from '@circuit/core';

/**
 * Signal Finder screen — the RO/EN string table (ticket P4m-FIX1 X8, Codex
 * P4m-REV1 finding 9, MEDIUM).
 *
 * The finding: "Romanian mode still renders English evidence, statuses, target
 * labels, engine text, banners, next-step instructions, sharing controls and
 * accessibility labels". The user's Supra is in Romania and the app has an RO
 * setting; half-translated is worse than untranslated, because the half that
 * stays English is exactly the half that says what the tool CONCLUDED.
 *
 * So every visible (and every ACCESSIBILITY) string of `SignalFinderScreen.tsx`
 * lives here, in both languages, and the screen holds none of its own. Two
 * things deliberately do NOT live here:
 *
 *  - the metronome's prompts, and the target labels/notes: those are TARGET
 *    DATA (`@circuit/core`'s `resolveSignalActionVerbs` /
 *    `resolveSignalTargetLabel` / `resolveDiscoveryRangeNote`), because a
 *    pedal's name belongs to the vehicle catalog, never to a screen;
 *  - the shared `.md` summary's own wording (`signalFinderExport.ts`), which
 *    is the text the user FORWARDS and is tested there.
 *
 * `signalFinderStrings.test.ts` pins the two invariants: RO has every key EN
 * has, and no English literal is left in the screen file.
 */

export type SignalFinderUiLanguage = 'en' | 'ro';

export interface SignalFinderScreenStrings {
  screenTitle: string;
  vehicleProfile: string;
  useProfile: (label: string) => string;
  shareProfile: string;
  shareProfileA11y: string;
  targets: string;
  find: string;
  findA11y: (target: string) => string;
  /** X9: why Find is disabled — a find with zero eligible DIDs would be zero scripts. */
  nothingToRead: string;
  stop: string;
  stopA11y: string;
  result: string;
  stepCounter: (index: number, total: number) => string;
  engineOff: string;
  engineRunning: string;
  engineOffHint: string;
  engineRunningHint: string;
  statusConfirmed: string;
  statusFound: string;
  statusMissing: string;
  statusHypotheses: (count: number) => string;
  statusNoHypotheses: string;
  readSummary: (dids: number, ecus: number, rounds: number) => string;
  /** X1: the header states whether the rate was MEASURED by this find's probe or assumed. */
  rateMeasured: (reqPerSec: number) => string;
  rateAssumed: (reqPerSec: number) => string;
  nothingAnswered: string;
  noResponse: string;
  notRead: (count: number) => string;
  /** X2: "not read (3) — ECU 0x29 silent". */
  notReadSilent: (count: number, ecus: string) => string;
  nextRound: (dids: number, seconds: number) => string;
  sparseSuffix: string;
  verdicts: Record<SignalCandidateScore['verdict'], string>;
  capReasons: Record<SignalVerdictCapReason, string>;
  insufficientReasons: Record<'undersampled' | 'length-inconsistent' | 'no-response', string>;
  edges: (matched: number, expected: number) => string;
  extra: (count: number) => string;
  baselineMoved: (count: number) => string;
  capped: (reason: string) => string;
  rawRange: (rest: string, min: string, max: string) => string;
  confirmAs: (target: string) => string;
  confirmA11y: (did: string, target: string) => string;
  nextStep: (range: string, ecu: string, minutes: number, engine: string, note: string) => string;
  everyEcuThatAnswered: string;
  share: string;
  shareA11y: string;
  shareJson: string;
  shareJsonA11y: string;
  summaryHeading: string;
  bannerNoProfileStorage: string;
  bannerConfirmed: (channel: string, ecu: string, did: string) => string;
  bannerRunFindFirst: string;
  bannerSummaryShared: string;
  bannerJsonShared: string;
  bannerSharingUnavailable: string;
  bannerProfileShared: string;
  /** P4m-FIX2 Y7: the reservation refusal — `signalFinderController`'s `'adapter-busy'` code. */
  errorAdapterBusy: string;
  /** P4m-FIX2 Y7: the catalog has no such target — the `'no-target'` code. */
  errorNoTarget: string;
  /** P4m-FIX2 Y7: any other runtime failure. A localized line PLUS the raw message in parentheses — the driver reads his own language, the developer still gets the real text. */
  errorUnknown: (raw: string) => string;
  /** P4m-FIX2 Y7: a share that reported its own error string (also raw, also parenthesised). */
  bannerShareFailed: (raw: string) => string;
}

const EN: SignalFinderScreenStrings = {
  screenTitle: 'Signal Finder',
  vehicleProfile: 'Vehicle profile',
  useProfile: (label) => `Use the ${label} profile`,
  shareProfile: 'Share profile',
  shareProfileA11y: 'Share the vehicle profile',
  targets: 'Targets',
  find: 'Find',
  findA11y: (target) => `Find ${target}`,
  nothingToRead: 'nothing to read yet — sweep this ECU first',
  stop: 'Stop',
  stopA11y: 'Stop this find',
  result: 'Result',
  stepCounter: (index, total) => `Step ${index}/${total}`,
  engineOff: 'engine off',
  engineRunning: 'engine running',
  engineOffHint: 'engine off, ignition on',
  engineRunningHint: 'engine running / moving',
  statusConfirmed: 'confirmed',
  statusFound: 'found',
  statusMissing: 'missing',
  statusHypotheses: (count) => `${count} hypotheses`,
  statusNoHypotheses: 'no hypotheses yet',
  readSummary: (dids, ecus, rounds) =>
    `Read ${dids} DID${dids === 1 ? '' : 's'} across ${ecus} ECU${ecus === 1 ? '' : 's'} in ${rounds} round${rounds === 1 ? '' : 's'}`,
  rateMeasured: (reqPerSec) => `rate ${reqPerSec.toFixed(1)}/s measured`,
  rateAssumed: (reqPerSec) => `rate assumed ${reqPerSec.toFixed(1)}/s — probe failed`,
  nothingAnswered: 'Nothing answered.',
  noResponse: 'No response',
  notRead: (count) => `Not read: ${count}`,
  notReadSilent: (count, ecus) => `Not read: ${count} — ECU ${ecus} silent`,
  nextRound: (dids, seconds) => `Next round (${dids} DIDs, ≈ ${seconds} s)`,
  sparseSuffix: ' (sparse)',
  verdicts: { found: 'found', probable: 'probable', unrelated: 'unrelated', insufficient: 'insufficient' },
  capReasons: {
    'response-baseline-changes': 'restless baseline',
    'one-sided-bipolar': 'one-sided',
    'extra-transitions': 'extra transitions',
    'never-moved': 'never moved',
  },
  insufficientReasons: {
    undersampled: 'too few samples',
    'length-inconsistent': 'response length changed',
    'no-response': 'no response',
  },
  edges: (matched, expected) => `${matched}/${expected} edges`,
  extra: (count) => `(${count} extra)`,
  baselineMoved: (count) => `baseline moved ${count}x`,
  capped: (reason) => `capped: ${reason}`,
  rawRange: (rest, min, max) => `raw ${rest} → ${min}..${max}`,
  confirmAs: (target) => `Confirm as ${target}`,
  confirmA11y: (did, target) => `Confirm ${did} as ${target}`,
  nextStep: (range, ecu, minutes, engine, note) => `Next step: sweep ${ecu} ${range}, ≈ ${minutes} min, ${engine} — ${note}`,
  everyEcuThatAnswered: 'every ECU that answered',
  share: 'Share',
  shareA11y: 'Share the Signal Finder summary',
  shareJson: 'Share JSON',
  shareJsonA11y: 'Share the Signal Finder session JSON',
  summaryHeading: 'Summary (this is what gets shared)',
  bannerNoProfileStorage: 'No profile storage on this platform — nothing was written.',
  bannerConfirmed: (channel, ecu, did) => `Confirmed ${channel} = ${ecu} ${did}`,
  bannerRunFindFirst: 'Run a find first — there is nothing to share yet.',
  bannerSummaryShared: 'Summary shared. Tap "Share JSON" for the full session file.',
  bannerJsonShared: 'JSON shared.',
  bannerSharingUnavailable: 'Sharing is unavailable on this platform (the files were still built).',
  bannerProfileShared: 'Vehicle profile shared.',
  errorAdapterBusy: 'The adapter is in use (telemetry, the DID probe or a sweep) — stop that first.',
  errorNoTarget: 'This target is not defined for the selected vehicle profile.',
  errorUnknown: (raw) => `The find could not be completed (${raw})`,
  bannerShareFailed: (raw) => `Sharing failed (${raw})`,
};

const RO: SignalFinderScreenStrings = {
  screenTitle: 'Signal Finder',
  vehicleProfile: 'Profil vehicul',
  useProfile: (label) => `Folosește profilul ${label}`,
  shareProfile: 'Partajează profilul',
  shareProfileA11y: 'Partajează profilul vehiculului',
  targets: 'Ținte',
  find: 'Caută',
  findA11y: (target) => `Caută ${target}`,
  nothingToRead: 'nimic de citit încă — scanează întâi acest ECU',
  stop: 'Oprește',
  stopA11y: 'Oprește căutarea',
  result: 'Rezultat',
  stepCounter: (index, total) => `Pasul ${index}/${total}`,
  engineOff: 'motor oprit',
  engineRunning: 'motor pornit',
  engineOffHint: 'motor oprit, contact pornit',
  engineRunningHint: 'motor pornit / în mers',
  statusConfirmed: 'confirmat',
  statusFound: 'găsit',
  statusMissing: 'negăsit',
  statusHypotheses: (count) => `${count} ipoteze`,
  statusNoHypotheses: 'nicio ipoteză încă',
  readSummary: (dids, ecus, rounds) =>
    `Citite ${dids} DID-uri pe ${ecus} ECU în ${rounds} rund${rounds === 1 ? 'ă' : 'e'}`,
  rateMeasured: (reqPerSec) => `rată ${reqPerSec.toFixed(1)}/s măsurată`,
  rateAssumed: (reqPerSec) => `rată presupusă ${reqPerSec.toFixed(1)}/s — sondarea nu a răspuns`,
  nothingAnswered: 'Nimic nu a răspuns.',
  noResponse: 'Fără răspuns',
  notRead: (count) => `Necitite: ${count}`,
  notReadSilent: (count, ecus) => `Necitite: ${count} — ECU ${ecus} nu răspunde`,
  nextRound: (dids, seconds) => `Runda următoare (${dids} DID-uri, ≈ ${seconds} s)`,
  sparseSuffix: ' (rar)',
  verdicts: { found: 'găsit', probable: 'probabil', unrelated: 'fără legătură', insufficient: 'insuficient' },
  capReasons: {
    'response-baseline-changes': 'repaus neliniștit',
    'one-sided-bipolar': 'unilateral',
    'extra-transitions': 'tranziții în plus',
    'never-moved': 'nu s-a schimbat deloc',
  },
  insufficientReasons: {
    undersampled: 'prea puține citiri',
    'length-inconsistent': 'lungimea răspunsului s-a schimbat',
    'no-response': 'fără răspuns',
  },
  edges: (matched, expected) => `${matched}/${expected} fronturi`,
  extra: (count) => `(${count} în plus)`,
  baselineMoved: (count) => `repaus schimbat de ${count} ori`,
  capped: (reason) => `plafonat: ${reason}`,
  rawRange: (rest, min, max) => `brut ${rest} → ${min}..${max}`,
  confirmAs: (target) => `Confirmă ca ${target}`,
  confirmA11y: (did, target) => `Confirmă ${did} ca ${target}`,
  nextStep: (range, ecu, minutes, engine, note) => `Pasul următor: scanează ${ecu} ${range}, ≈ ${minutes} min, ${engine} — ${note}`,
  everyEcuThatAnswered: 'fiecare ECU care a răspuns',
  share: 'Partajează',
  shareA11y: 'Partajează rezumatul Signal Finder',
  shareJson: 'Partajează JSON',
  shareJsonA11y: 'Partajează sesiunea Signal Finder în format JSON',
  summaryHeading: 'Rezumat (exact ce se partajează)',
  bannerNoProfileStorage: 'Platforma nu are stocare de profil — nu s-a scris nimic.',
  bannerConfirmed: (channel, ecu, did) => `Confirmat ${channel} = ${ecu} ${did}`,
  bannerRunFindFirst: 'Rulează întâi o căutare — nu există încă nimic de partajat.',
  bannerSummaryShared: 'Rezumat partajat. Apasă „Partajează JSON" pentru fișierul complet al sesiunii.',
  bannerJsonShared: 'JSON partajat.',
  bannerSharingUnavailable: 'Partajarea nu este disponibilă pe această platformă (fișierele au fost totuși create).',
  bannerProfileShared: 'Profilul vehiculului a fost partajat.',
  errorAdapterBusy: 'Adaptorul este folosit (telemetrie, sonda DID sau o scanare) — oprește-l întâi.',
  errorNoTarget: 'Această țintă nu este definită pentru profilul de vehicul selectat.',
  errorUnknown: (raw) => `Căutarea nu a putut fi finalizată (${raw})`,
  bannerShareFailed: (raw) => `Partajarea a eșuat (${raw})`,
};

export const SIGNAL_FINDER_SCREEN_STRINGS: Readonly<Record<SignalFinderUiLanguage, SignalFinderScreenStrings>> = {
  en: EN,
  ro: RO,
};

/** The table for the app's language setting; anything other than `'ro'` reads English. */
export function resolveSignalFinderScreenStrings(language: string | null | undefined): SignalFinderScreenStrings {
  return language === 'ro' ? RO : EN;
}

/**
 * P4m-FIX2 Y7 (binding, Codex P4m-REV2 finding 9): the controller's error CODE
 * rendered in the driver's own language. The raw `error` text stays what it
 * always was — an English/underlying message the export and the logs keep —
 * and an unrecognised failure gets the generic localized line WITH that raw
 * text in parentheses, so nothing is hidden from whoever has to debug it.
 *
 * A plain function of its two arguments (no React, no controller): the screen
 * calls it, and `signalFinderStrings.test.ts` pins it directly.
 */
export function signalFinderErrorMessage(
  snapshot: { errorCode: 'adapter-busy' | 'no-target' | 'run-failed' | null; error: string | null },
  strings: SignalFinderScreenStrings,
): string | null {
  if (snapshot.errorCode === null && snapshot.error === null) return null;
  switch (snapshot.errorCode) {
    case 'adapter-busy':
      return strings.errorAdapterBusy;
    case 'no-target':
      return strings.errorNoTarget;
    default:
      return strings.errorUnknown(snapshot.error ?? '');
  }
}
