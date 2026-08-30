import type { CoachingChannelId } from '@circuit/core';

/**
 * Analysis screen (ticket P5b B3) — the RO/EN table for the screen's own
 * CHROME, and nothing else.
 *
 * The report itself is not written here: `@circuit/core`'s `reportText`
 * already renders every observation, limitation and corner sentence in the
 * driver's language, with its numbers in it. What this file holds is the frame
 * around that text — the screen title, the empty/loading/failure states, the
 * share controls, the accessibility labels, and the two notes the SCREEN is
 * the one making (a decoded channel that covered too little of the session to
 * be used, and laps with no stored trace).
 *
 * Same arrangement, and the same two invariants, as `signalFinderStrings.ts`:
 * RO carries every key EN does, and `AnalysisScreen.tsx` holds no prose of its
 * own. Half-translated is worse than untranslated, because the half that stays
 * English is exactly the half that says what the tool concluded.
 */

export type AnalysisUiLanguage = 'ro' | 'en';

export interface AnalysisScreenStrings {
  /** Navigator header + screen title. */
  screenTitle: string;
  /** The entry-point button on the results/history screens. */
  entryButton: string;
  entryButtonA11y: (session: string) => string;
  /** The standing V1 promise: facts, never instruction. */
  observationsOnly: string;
  loading: string;
  loadingHint: string;
  /** Honest dead ends. */
  sessionNotFound: string;
  circuitNotInCatalog: string;
  noLaps: string;
  noTrace: string;
  duringSession: string;
  failed: string;
  retry: string;
  retryA11y: string;
  /** Section chrome around the engine's own sections. */
  sessionHeader: (circuit: string, date: string) => string;
  cornersHeading: string;
  notesHeading: string;
  /** A corner the engine could not measure on any lap. */
  cornerNotMeasured: string;
  /** "loses 0.42 s" / "pierde 0,42 s" — the badge on a corner row. */
  timeLossBadge: (seconds: string) => string;
  timeGainBadge: (seconds: string) => string;
  /** Notes the SCREEN makes about the recording (never about the driving). */
  channelTooSparse: (channel: string, percent: number) => string;
  lapsWithoutTrace: (laps: string) => string;
  channelNames: Readonly<Record<CoachingChannelId, string>>;
  /** Share controls (B4). */
  share: string;
  shareA11y: string;
  shareJson: string;
  shareJsonA11y: string;
  shareDone: string;
  shareUnavailable: string;
  shareFailed: string;
}

const EN: AnalysisScreenStrings = {
  screenTitle: 'Session analysis',
  entryButton: 'Analysis',
  entryButtonA11y: (session) => `Analyse the session of ${session}`,
  observationsOnly: 'Observations only — this report states what you did, not what to do.',
  loading: 'Analysing your laps…',
  loadingHint: 'Everything runs on this phone; nothing is sent anywhere.',
  sessionNotFound: 'That session is no longer stored on this phone.',
  circuitNotInCatalog: 'This session was recorded on a circuit that is not in the catalog, so its corners are unknown.',
  noLaps: 'No laps were recorded in this session, so there is nothing to analyse.',
  noTrace: 'No GPS trace was stored for these laps, so no corner analysis is possible.',
  duringSession: 'Finish the session first — the analysis only runs once a session has ended.',
  failed: 'The analysis could not be completed.',
  retry: 'Try again',
  retryA11y: 'Run the analysis again',
  sessionHeader: (circuit, date) => `${circuit} · ${date}`,
  cornersHeading: 'Corner by corner',
  notesHeading: 'About this recording',
  cornerNotMeasured: 'Not measured on any lap of this session.',
  timeLossBadge: (seconds) => `loses ${seconds}`,
  timeGainBadge: (seconds) => `gains ${seconds}`,
  channelTooSparse: (channel, percent) =>
    `${channel} was recorded on ${percent} % of this session — too little to analyse, so it was left out.`,
  lapsWithoutTrace: (laps) => `Laps ${laps} have no stored GPS trace and are not part of this analysis.`,
  channelNames: {
    speedKph: 'Speed',
    accelPedalPct: 'Accelerator pedal',
    throttlePct: 'Throttle plate',
    brakePct: 'Brake',
    brakeSwitch: 'Brake switch',
    longG: 'Longitudinal G',
    latG: 'Lateral G',
    yawRateDps: 'Yaw rate',
    steeringDeg: 'Steering angle',
    rpm: 'Engine rpm',
    coolantC: 'Coolant temperature',
    intakeC: 'Intake air temperature',
    engineLoadPct: 'Engine load',
    engineOilC: 'Engine oil temperature',
    transOilC: 'Transmission oil temperature',
  },
  share: 'Share report',
  shareA11y: 'Share the analysis summary; the full JSON is written alongside it',
  shareJson: 'Share JSON',
  shareJsonA11y: 'Share the full analysis report as JSON',
  shareDone: 'Report shared.',
  shareUnavailable: 'Sharing is not available on this device — the report stays on screen.',
  shareFailed: 'The report could not be shared.',
};

const RO: AnalysisScreenStrings = {
  screenTitle: 'Analiza sesiunii',
  entryButton: 'Analiză',
  entryButtonA11y: (session) => `Analizează sesiunea din ${session}`,
  observationsOnly: 'Doar observații — raportul spune ce ai făcut, nu ce să faci.',
  loading: 'Îți analizez tururile…',
  loadingHint: 'Totul rulează pe acest telefon; nu se trimite nimic nicăieri.',
  sessionNotFound: 'Sesiunea nu mai este salvată pe acest telefon.',
  circuitNotInCatalog: 'Sesiunea a fost înregistrată pe un circuit care nu este în catalog, așa că virajele lui nu sunt cunoscute.',
  noLaps: 'Nu s-a înregistrat niciun tur în această sesiune, deci nu am ce analiza.',
  noTrace: 'Nu există traseu GPS salvat pentru aceste tururi, deci analiza pe viraje nu este posibilă.',
  duringSession: 'Termină întâi sesiunea — analiza rulează doar după ce sesiunea s-a încheiat.',
  failed: 'Analiza nu a putut fi finalizată.',
  retry: 'Încearcă din nou',
  retryA11y: 'Rulează analiza din nou',
  sessionHeader: (circuit, date) => `${circuit} · ${date}`,
  cornersHeading: 'Viraj cu viraj',
  notesHeading: 'Despre această înregistrare',
  cornerNotMeasured: 'Nu a fost măsurat pe niciun tur din această sesiune.',
  timeLossBadge: (seconds) => `pierzi ${seconds}`,
  timeGainBadge: (seconds) => `câștigi ${seconds}`,
  channelTooSparse: (channel, percent) =>
    `${channel} a fost înregistrat pe ${percent} % din sesiune — prea puțin pentru analiză, așa că a fost lăsat deoparte.`,
  lapsWithoutTrace: (laps) => `Tururile ${laps} nu au traseu GPS salvat și nu intră în această analiză.`,
  channelNames: {
    speedKph: 'Viteză',
    accelPedalPct: 'Pedala de accelerație',
    throttlePct: 'Clapeta de accelerație',
    brakePct: 'Frâna',
    brakeSwitch: 'Contactul de frână',
    longG: 'Accelerație longitudinală (G)',
    latG: 'Accelerație laterală (G)',
    yawRateDps: 'Viteza de girație',
    steeringDeg: 'Unghiul volanului',
    rpm: 'Turația motorului',
    coolantC: 'Temperatura lichidului de răcire',
    intakeC: 'Temperatura aerului admis',
    engineLoadPct: 'Sarcina motorului',
    engineOilC: 'Temperatura uleiului de motor',
    transOilC: 'Temperatura uleiului de transmisie',
  },
  share: 'Trimite raportul',
  shareA11y: 'Trimite rezumatul analizei; fișierul JSON complet este scris alături',
  shareJson: 'Trimite JSON',
  shareJsonA11y: 'Trimite raportul complet de analiză în format JSON',
  shareDone: 'Raportul a fost trimis.',
  shareUnavailable: 'Trimiterea nu este disponibilă pe acest dispozitiv — raportul rămâne pe ecran.',
  shareFailed: 'Raportul nu a putut fi trimis.',
};

/** Both tables, exported so a test can pin that RO carries every key EN does. */
export const ANALYSIS_SCREEN_STRINGS: Readonly<Record<AnalysisUiLanguage, AnalysisScreenStrings>> = {
  en: EN,
  ro: RO,
};

/** The table for the app's `language` setting; anything unknown reads as English. */
export function resolveAnalysisScreenStrings(
  language: string | null | undefined,
): AnalysisScreenStrings {
  return language === 'ro' ? RO : EN;
}
