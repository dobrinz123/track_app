import type { CoachingChannelId, LimitationCode } from '@circuit/core';

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
  /** P5b-FIX1 C3: the session was recorded on other geometry than the catalog's. */
  layoutIncompatible: string;
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
  limitationsHeading: string;
  /** A corner the engine could not measure on any lap. */
  cornerNotMeasured: string;
  /** "loses 0.42 s" / "pierde 0,42 s" — the badge on a corner row. */
  timeLossBadge: (seconds: string) => string;
  timeGainBadge: (seconds: string) => string;
  /** "consistency 78/100" — the badge shown only when the engine scored it. */
  consistencyBadge: (score: number) => string;
  /** "82.4 km/h → 104.0 km/h" — minimum speed through the corner, then exit. */
  speedBadge: (minSpeed: string, exit: string) => string;
  /** Compact session chips (R2-2: minimal prose on the screen). */
  lapsChip: (count: number) => string;
  cleanLapsChip: (count: number) => string;
  bestLapChip: (time: string, lapNumber: number) => string;
  /** One short chip per engine limitation code; the sentence stays in the export. */
  limitationChips: Readonly<Record<LimitationCode, string>>;
  /** The expandable per-corner detail (R2-2). */
  detailColumns: Readonly<{
    lap: string;
    brake: string;
    lift: string;
    minSpeed: string;
    exit: string;
    peakDecel: string;
    latG: string;
  }>;
  expandCornerA11y: (corner: string) => string;
  collapseCornerA11y: (corner: string) => string;
  cleanLapMark: string;
  /**
   * Ticket P5-FIX2 W4 (contracts.md R2-2): the chrome of the compact VISUAL in
   * the expanded corner — a mark row per lap along the approach to the corner.
   * Labels only: the marks themselves are positions the view model computed
   * from the engine's own measurements, and the engine's sentences are not
   * rendered in the app at all any more (they stay in the export).
   */
  markBrake: string;
  markLift: string;
  /** The right-hand end of the axis: the corner entry itself. */
  markAxisEntry: string;
  /** The left-hand end: how far before the entry the axis starts ("180 m before"). */
  markAxisStart: (distance: string) => string;
  /** Says the unit once, so each lap's figures can stay bare numbers. */
  markSpeedCaption: string;
  /** One spoken line per lap's mark row. */
  markRowA11y: (lapNumber: number, detail: string) => string;
  /** What a metric the engine could not measure prints as. */
  noValue: string;
  /** The demonstrated envelope, assembled from the engine's own measurements. */
  envelopeFromCleanLaps: (parts: string, laps: string) => string;
  envelopeLatestBrake: (distance: string, lapNumber: number) => string;
  envelopeHighestMinSpeed: (speed: string, lapNumber: number) => string;
  envelopeEarliestLift: (distance: string, lapNumber: number) => string;
  /** Notes the SCREEN makes about the recording (never about the driving). */
  channelTooSparse: (channel: string, percent: number) => string;
  /** P5b-FIX1 C2: the channel was used, but not on these laps. */
  channelMissingOnLaps: (channel: string, laps: string) => string;
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
  layoutIncompatible:
    'This session was recorded on a different layout of this circuit than the one stored today, so its laps cannot be compared with these corners.',
  noLaps: 'No laps were recorded in this session, so there is nothing to analyse.',
  noTrace: 'No GPS trace was stored for these laps, so no corner analysis is possible.',
  duringSession: 'Finish the session first — the analysis only runs once a session has ended.',
  failed: 'The analysis could not be completed.',
  retry: 'Try again',
  retryA11y: 'Run the analysis again',
  sessionHeader: (circuit, date) => `${circuit} · ${date}`,
  cornersHeading: 'Corner by corner',
  notesHeading: 'About this recording',
  limitationsHeading: 'What this data cannot tell you',
  cornerNotMeasured: 'Not measured on any lap of this session.',
  timeLossBadge: (seconds) => `loses ${seconds}`,
  timeGainBadge: (seconds) => `gains ${seconds}`,
  consistencyBadge: (score) => `consistency ${score}/100`,
  speedBadge: (minSpeed, exit) => `${minSpeed} → ${exit}`,
  lapsChip: (count) => `${count} laps`,
  cleanLapsChip: (count) => `${count} clean`,
  bestLapChip: (time, lapNumber) => `best ${time} (lap ${lapNumber})`,
  limitationChips: {
    NO_CLEAN_LAPS: 'no clean laps',
    FEW_CLEAN_LAPS: 'few clean laps',
    UNVERIFIED_LAPS: 'unverified laps',
    UNSUPPORTED_CHANNELS: 'channels not provided',
    MISSING_CHANNELS: 'channels missing',
    GNSS_QUALITY: 'GPS quality',
    GEOMETRY_UNVALIDATED: 'map geometry',
    CORNER_COVERAGE: 'corner coverage',
    TIME_INTEGRATION_DRIFT: 'time drift',
  },
  detailColumns: {
    lap: 'Lap',
    brake: 'Brake',
    lift: 'Lift',
    minSpeed: 'Min speed',
    exit: 'Exit',
    peakDecel: 'Peak decel',
    latG: 'Lateral G',
  },
  expandCornerA11y: (corner) => `Show the per-lap values of ${corner}`,
  collapseCornerA11y: (corner) => `Hide the per-lap values of ${corner}`,
  cleanLapMark: 'clean',
  markBrake: 'brake',
  markLift: 'lift',
  markAxisEntry: 'entry',
  markAxisStart: (distance) => `${distance} before`,
  markSpeedCaption: 'min speed → exit (km/h)',
  markRowA11y: (lapNumber, detail) => `Lap ${lapNumber}: ${detail}`,
  noValue: '—',
  envelopeFromCleanLaps: (parts, laps) => `From your own clean laps (${laps}): ${parts}.`,
  envelopeLatestBrake: (distance, lapNumber) =>
    `latest braking point ${distance} (lap ${lapNumber})`,
  envelopeHighestMinSpeed: (speed, lapNumber) =>
    `highest minimum speed ${speed} (lap ${lapNumber})`,
  envelopeEarliestLift: (distance, lapNumber) => `earliest lift ${distance} (lap ${lapNumber})`,
  channelTooSparse: (channel, percent) =>
    `${channel} was recorded on ${percent} % of this session — too little to analyse, so it was left out.`,
  channelMissingOnLaps: (channel, laps) =>
    `${channel} was not recorded on laps ${laps}, so it was left out of those laps only.`,
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
  share: 'Share report (JSON saved alongside)',
  shareA11y: 'Share the analysis summary; the full JSON file is written alongside it',
  shareJson: 'Share the JSON file',
  shareJsonA11y: 'Share the full analysis report as JSON',
  shareDone: 'Report shared — the JSON file was saved alongside it.',
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
  layoutIncompatible:
    'Sesiunea a fost înregistrată pe altă configurație a acestui circuit decât cea salvată acum, deci tururile ei nu pot fi comparate cu aceste viraje.',
  noLaps: 'Nu s-a înregistrat niciun tur în această sesiune, deci nu am ce analiza.',
  noTrace: 'Nu există traseu GPS salvat pentru aceste tururi, deci analiza pe viraje nu este posibilă.',
  duringSession: 'Termină întâi sesiunea — analiza rulează doar după ce sesiunea s-a încheiat.',
  failed: 'Analiza nu a putut fi finalizată.',
  retry: 'Încearcă din nou',
  retryA11y: 'Rulează analiza din nou',
  sessionHeader: (circuit, date) => `${circuit} · ${date}`,
  cornersHeading: 'Viraj cu viraj',
  notesHeading: 'Despre această înregistrare',
  limitationsHeading: 'Ce nu putem spune din aceste date',
  cornerNotMeasured: 'Nu a fost măsurat pe niciun tur din această sesiune.',
  timeLossBadge: (seconds) => `pierzi ${seconds}`,
  timeGainBadge: (seconds) => `câștigi ${seconds}`,
  consistencyBadge: (score) => `constanță ${score}/100`,
  speedBadge: (minSpeed, exit) => `${minSpeed} → ${exit}`,
  lapsChip: (count) => `${count} tururi`,
  cleanLapsChip: (count) => `${count} curate`,
  bestLapChip: (time, lapNumber) => `cel mai bun ${time} (turul ${lapNumber})`,
  limitationChips: {
    NO_CLEAN_LAPS: 'niciun tur curat',
    FEW_CLEAN_LAPS: 'puține tururi curate',
    UNVERIFIED_LAPS: 'tururi neverificate',
    UNSUPPORTED_CHANNELS: 'canale lipsă din mașină',
    MISSING_CHANNELS: 'canale lipsă',
    GNSS_QUALITY: 'calitate GPS',
    GEOMETRY_UNVALIDATED: 'geometrie de pe hartă',
    CORNER_COVERAGE: 'acoperire viraje',
    TIME_INTEGRATION_DRIFT: 'derivă de timp',
  },
  detailColumns: {
    lap: 'Tur',
    brake: 'Frână',
    lift: 'Ridicat piciorul',
    minSpeed: 'Viteză minimă',
    exit: 'Ieșire',
    peakDecel: 'Decelerație maximă',
    latG: 'Accelerație laterală',
  },
  expandCornerA11y: (corner) => `Arată valorile pe tururi pentru ${corner}`,
  collapseCornerA11y: (corner) => `Ascunde valorile pe tururi pentru ${corner}`,
  cleanLapMark: 'curat',
  markBrake: 'frână',
  markLift: 'ridicat',
  markAxisEntry: 'intrare',
  markAxisStart: (distance) => `${distance} înainte`,
  markSpeedCaption: 'viteză minimă → ieșire (km/h)',
  markRowA11y: (lapNumber, detail) => `Turul ${lapNumber}: ${detail}`,
  noValue: '—',
  envelopeFromCleanLaps: (parts, laps) => `Din tururile tale curate (${laps}): ${parts}.`,
  envelopeLatestBrake: (distance, lapNumber) =>
    `cel mai târziu ai frânat la ${distance} (turul ${lapNumber})`,
  envelopeHighestMinSpeed: (speed, lapNumber) =>
    `cea mai mare viteză minimă ${speed} (turul ${lapNumber})`,
  envelopeEarliestLift: (distance, lapNumber) =>
    `cel mai devreme ai ridicat piciorul la ${distance} (turul ${lapNumber})`,
  channelTooSparse: (channel, percent) =>
    `${channel} a fost înregistrat pe ${percent} % din sesiune — prea puțin pentru analiză, așa că a fost lăsat deoparte.`,
  channelMissingOnLaps: (channel, laps) =>
    `${channel} nu a fost înregistrat în tururile ${laps}, așa că a fost lăsat deoparte doar în acele tururi.`,
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
  share: 'Trimite raportul (JSON salvat alături)',
  shareA11y: 'Trimite rezumatul analizei; fișierul JSON complet este scris alături',
  shareJson: 'Trimite fișierul JSON',
  shareJsonA11y: 'Trimite raportul complet de analiză în format JSON',
  shareDone: 'Raportul a fost trimis — fișierul JSON a fost salvat alături.',
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
