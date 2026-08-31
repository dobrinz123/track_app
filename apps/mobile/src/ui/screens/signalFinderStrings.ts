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
  /** X2: "not read (3) — ECU 0x29 silent". Only when the probe found the ECU WHOLLY silent. */
  notReadSilent: (count: number, ecus: string) => string;
  /** P4m-FIX3 Z4: individual DIDs that answered neither the probe nor their one retry, on ECUs that ARE alive. */
  notReadSilentDids: (count: number) => string;
  /** P4m-FIX3 Z5: the pre-script probe, with its progress and the bound it cannot exceed. */
  probing: (probed: number, total: number, seconds: number) => string;
  /** P4m-FIX3 Z6: the adapter never confirmed its shutdown; the next find waits for it. */
  warningTeardownPending: string;
  /** P4m-FIX3 Z6: a find refused because that shutdown is still pending — the `'adapter-teardown-pending'` code. */
  errorTeardownPending: string;
  nextRound: (dids: number, seconds: number) => string;
  sparseSuffix: string;
  /** Ticket P4o-FIX3 T1: the "(graded)" qualifier on a found GRADED analog verdict with strong evidence. */
  gradedSuffix: string;
  /** Ticket P4o-FIX3 T1: the "(graded — weak evidence: ...)" qualifier for a found GRADED analog verdict resting on a single intermediate sample per press window. */
  gradedWeakSuffix: string;
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
  /**
   * Ticket P4o O3 (binding): the confirm button's label when the channel
   * already has a DIFFERENT field-confirmed binding — shown from the very
   * first tap (the screen already knows the existing binding), not only
   * after arming. `previousDid`/`newDid` are hex, e.g. "0x58B7"/"0x4002".
   */
  replaceAs: (previousDid: string, newDid: string) => string;
  replaceA11y: (previousDid: string, newDid: string, target: string) => string;
  /** P4o O3: shown once the FIRST tap has armed the replace, alongside the existing binding's own evidence — the driver's chance to back out before the second, committing tap. */
  replaceArmed: string;
  /** P4o O3: the existing binding's evidence line — decode guess plus (ecu, did). */
  replaceExistingEvidence: (ecu: string, did: string, decode: string) => string;
  /** P4o O2: appended to a capped-at-`probable` two-level row — "Confirm as <target>" is disabled for it. */
  confirmDisabledTwoLevel: string;
  nextStep: (range: string, ecu: string, minutes: number, engine: string, note: string) => string;
  everyEcuThatAnswered: string;
  share: string;
  shareA11y: string;
  shareJson: string;
  shareJsonA11y: string;
  summaryHeading: string;
  bannerNoProfileStorage: string;
  bannerConfirmed: (channel: string, ecu: string, did: string) => string;
  /** P4n N3 (binding): appended to `bannerConfirmed` when a telemetry session is ALREADY running -- its poll plan cannot pick this confirm up live (`telemetryProvider.ts`'s ENET config is fixed at construction). */
  bannerConfirmedRestartHint: string;
  bannerRunFindFirst: string;
  bannerSummaryShared: string;
  bannerJsonShared: string;
  bannerSharingUnavailable: string;
  bannerProfileShared: string;
  /** P4m-FIX2 Y7: the reservation refusal — `signalFinderController`'s `'adapter-busy'` code. */
  errorAdapterBusy: string;
  /** P4m-FIX2 Y7: the catalog has no such target — the `'no-target'` code. */
  errorNoTarget: string;
  /**
   * P4m-FIX2 Y7 + P4m-FIX3 Z7 (Codex P4m-REV3 finding 9): any other runtime
   * failure. Build 8 interpolated the RAW message into this line, so Romanian
   * mode still ended in English: "Căutarea nu a putut fi finalizată (socket
   * hang up)". The raw text now lives in the EXPORT's own diagnostics section
   * and nowhere else; this line says where to look.
   */
  errorUnknown: string;
  /** P4m-FIX2 Y7 + P4m-FIX3 Z7: a share that failed. The platform's own (raw) error goes to the export, never into this banner. */
  bannerShareFailed: string;
  /**
   * Ticket P4o O5 (binding): "for a 'running' target, if the app has a
   * recent telemetry sample with rpm 0 or no rpm at all, the result header
   * and the Find row show 'engine not detected running — results may be
   * meaningless' (no hard block)."
   */
  warningEngineNotDetected: string;
  /**
   * Ticket P4p G3 (binding, field test 9): a Find row whose plan is empty
   * because its discovery range was never swept stops being a dead end -- its
   * reason becomes the ACTION that fixes it, e.g. "Scan 0x29 58F3–6FFF (≈ 8
   * min, engine off)", opening the existing DID sweep with that exact range
   * prefilled. The engine state is stated because a discovery sweep needs no
   * driver action at all.
   */
  scanRange: (ecu: string, range: string, minutes: number) => string;
  scanRangeA11y: (ecu: string, range: string) => string;
  /** Ticket P4p G5: how many DIDs earlier completed finds ruled out for this target. */
  ruledOut: (count: number) => string;
  /** Ticket P4p G5: the control that puts them all back in play. */
  retestAll: string;
  retestAllA11y: (target: string) => string;
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
  notReadSilentDids: (count) => `Not read: ${count} — no answer to the probe or its one retry`,
  probing: (probed, total, seconds) => `Probing the ECUs… ${probed}/${total} (up to ${seconds} s)`,
  warningTeardownPending: 'The adapter has not confirmed the shutdown — the next find waits for it.',
  errorTeardownPending: 'The adapter is still shutting down — try again in a moment.',
  nextRound: (dids, seconds) => `Next round (${dids} DIDs, ≈ ${seconds} s)`,
  sparseSuffix: ' (sparse)',
  gradedSuffix: ' (graded)',
  gradedWeakSuffix: ' (graded — weak evidence: 1 intermediate sample per press)',
  verdicts: { found: 'found', probable: 'probable', unrelated: 'unrelated', insufficient: 'insufficient' },
  capReasons: {
    'response-baseline-changes': 'restless baseline',
    'one-sided-bipolar': 'one-sided',
    'extra-transitions': 'extra transitions',
    'never-moved': 'never moved',
    'two-level': 'switch-like, not analog',
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
  replaceAs: (previousDid, newDid) => `Replace ${previousDid} → ${newDid}`,
  replaceA11y: (previousDid, newDid, target) => `Replace ${previousDid} with ${newDid} as ${target}`,
  replaceArmed: 'Tap again to confirm the replacement.',
  replaceExistingEvidence: (ecu, did, decode) => `Currently: ${ecu} ${did} — ${decode}`,
  confirmDisabledTwoLevel: 'switch-like, not analog — confirm disabled',
  nextStep: (range, ecu, minutes, engine, note) => `Next step: sweep ${ecu} ${range}, ≈ ${minutes} min, ${engine} — ${note}`,
  everyEcuThatAnswered: 'every ECU that answered',
  share: 'Share',
  shareA11y: 'Share the Signal Finder summary',
  shareJson: 'Share JSON',
  shareJsonA11y: 'Share the Signal Finder session JSON',
  summaryHeading: 'Summary (this is what gets shared)',
  bannerNoProfileStorage: 'No profile storage on this platform — nothing was written.',
  bannerConfirmed: (channel, ecu, did) => `Confirmed ${channel} = ${ecu} ${did}`,
  bannerConfirmedRestartHint: 'Restart Telemetry (Stop → Start) to apply.',
  bannerRunFindFirst: 'Run a find first — there is nothing to share yet.',
  bannerSummaryShared: 'Summary shared. Tap "Share JSON" for the full session file.',
  bannerJsonShared: 'JSON shared.',
  bannerSharingUnavailable: 'Sharing is unavailable on this platform (the files were still built).',
  bannerProfileShared: 'Vehicle profile shared.',
  errorAdapterBusy: 'The adapter is in use (telemetry, the DID probe or a sweep) — stop that first.',
  errorNoTarget: 'This target is not defined for the selected vehicle profile.',
  errorUnknown: 'The find could not be completed. The details are in the shared JSON.',
  bannerShareFailed: 'Sharing failed. The details are in the shared JSON.',
  warningEngineNotDetected: 'engine not detected running — results may be meaningless',
  scanRange: (ecu, range, minutes) => `Scan ${ecu} ${range} (≈ ${minutes} min, engine off)`,
  scanRangeA11y: (ecu, range) => `Scan ${ecu} ${range} with the DID sweep`,
  ruledOut: (count) => `${count} ruled out from earlier finds`,
  retestAll: 'Re-test all',
  retestAllA11y: (target) => `Re-test every DID ruled out for ${target}`,
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
  notReadSilentDids: (count) => `Necitite: ${count} — fără răspuns la sondaj sau la reîncercare`,
  probing: (probed, total, seconds) => `Sondez ECU-urile… ${probed}/${total} (până la ${seconds} s)`,
  warningTeardownPending: 'Adaptorul nu a confirmat închiderea — următoarea căutare o așteaptă.',
  errorTeardownPending: 'Adaptorul încă se închide — încearcă din nou într-o clipă.',
  nextRound: (dids, seconds) => `Runda următoare (${dids} DID-uri, ≈ ${seconds} s)`,
  sparseSuffix: ' (rar)',
  gradedSuffix: ' (gradat)',
  gradedWeakSuffix: ' (gradat — dovadă slabă: o singură probă intermediară per apăsare)',
  verdicts: { found: 'găsit', probable: 'probabil', unrelated: 'fără legătură', insufficient: 'insuficient' },
  capReasons: {
    'response-baseline-changes': 'repaus neliniștit',
    'one-sided-bipolar': 'unilateral',
    'extra-transitions': 'tranziții în plus',
    'never-moved': 'nu s-a schimbat deloc',
    'two-level': 'ca un comutator, nu analog',
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
  replaceAs: (previousDid, newDid) => `Înlocuiește ${previousDid} → ${newDid}`,
  replaceA11y: (previousDid, newDid, target) => `Înlocuiește ${previousDid} cu ${newDid} ca ${target}`,
  replaceArmed: 'Apasă din nou pentru a confirma înlocuirea.',
  replaceExistingEvidence: (ecu, did, decode) => `În prezent: ${ecu} ${did} — ${decode}`,
  confirmDisabledTwoLevel: 'ca un comutator, nu analog — confirmare dezactivată',
  nextStep: (range, ecu, minutes, engine, note) => `Pasul următor: scanează ${ecu} ${range}, ≈ ${minutes} min, ${engine} — ${note}`,
  everyEcuThatAnswered: 'fiecare ECU care a răspuns',
  share: 'Partajează',
  shareA11y: 'Partajează rezumatul Signal Finder',
  shareJson: 'Partajează JSON',
  shareJsonA11y: 'Partajează sesiunea Signal Finder în format JSON',
  summaryHeading: 'Rezumat (exact ce se partajează)',
  bannerNoProfileStorage: 'Platforma nu are stocare de profil — nu s-a scris nimic.',
  bannerConfirmed: (channel, ecu, did) => `Confirmat ${channel} = ${ecu} ${did}`,
  bannerConfirmedRestartHint: 'Repornește Telemetria (Oprește → Pornește) pentru a aplica.',
  bannerRunFindFirst: 'Rulează întâi o căutare — nu există încă nimic de partajat.',
  bannerSummaryShared: 'Rezumat partajat. Apasă „Partajează JSON" pentru fișierul complet al sesiunii.',
  bannerJsonShared: 'JSON partajat.',
  bannerSharingUnavailable: 'Partajarea nu este disponibilă pe această platformă (fișierele au fost totuși create).',
  bannerProfileShared: 'Profilul vehiculului a fost partajat.',
  errorAdapterBusy: 'Adaptorul este folosit (telemetrie, sonda DID sau o scanare) — oprește-l întâi.',
  errorNoTarget: 'Această țintă nu este definită pentru profilul de vehicul selectat.',
  errorUnknown: 'Căutarea nu a putut fi finalizată. Detaliile sunt în JSON-ul partajat.',
  bannerShareFailed: 'Partajarea a eșuat. Detaliile sunt în JSON-ul partajat.',
  warningEngineNotDetected: 'motor nedetectat pornit — rezultatele pot fi eronate',
  scanRange: (ecu, range, minutes) => `Scanează ${ecu} ${range} (≈ ${minutes} min, motor oprit)`,
  scanRangeA11y: (ecu, range) => `Scanează ${ecu} ${range} cu scanarea de DID-uri`,
  ruledOut: (count) => `${count} excluse din căutările anterioare`,
  retestAll: 'Testează din nou tot',
  retestAllA11y: (target) => `Testează din nou fiecare DID exclus pentru ${target}`,
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
 * rendered in the driver's own language.
 *
 * P4m-FIX3 Z7 (Codex P4m-REV3 finding 9, PARTIAL): the raw text no longer
 * reaches this string at all. Build 8 appended it in parentheses, which meant a
 * Romanian driver still read `socket hang up` — the untranslated half being, as
 * ever, the half that says what actually happened. The raw message travels in
 * the EXPORT's `diagnostics` section instead (`signalFinderExport.ts`), where
 * whoever debugs it can read it and the driver never has to.
 *
 * A plain function of its two arguments (no React, no controller): the screen
 * calls it, and `signalFinderStrings.test.ts` pins it directly.
 */
export function signalFinderErrorMessage(
  snapshot: {
    errorCode: 'adapter-busy' | 'no-target' | 'run-failed' | 'adapter-teardown-pending' | null;
    error: string | null;
  },
  strings: SignalFinderScreenStrings,
): string | null {
  if (snapshot.errorCode === null && snapshot.error === null) return null;
  switch (snapshot.errorCode) {
    case 'adapter-busy':
      return strings.errorAdapterBusy;
    case 'no-target':
      return strings.errorNoTarget;
    case 'adapter-teardown-pending':
      return strings.errorTeardownPending;
    default:
      return strings.errorUnknown;
  }
}
