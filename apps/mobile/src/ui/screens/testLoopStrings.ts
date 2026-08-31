import type { TestLoopFailureReason } from '@circuit/core';

/**
 * Test Loop mode (ticket P5d) -- the RO/EN table for everything the driver
 * reads in this flow, and nothing else. Same arrangement and the same two
 * invariants as `analysisStrings.ts`: RO carries every key EN does, and the
 * screens hold no prose of their own.
 *
 * Half-translated is worse than untranslated here for a specific reason: the
 * safety line ("legal, low speed") and the honesty line ("learned geometry")
 * are exactly the two sentences that must not be the ones left in English.
 */

export type TestLoopUiLanguage = 'ro' | 'en';

export interface TestLoopStrings {
  /** The entry point on the circuit selection screen. */
  entryTitle: string;
  entrySubtitle: string;
  entryA11y: string;
  /** The mode's own screen. */
  screenTitle: string;
  /** The safety line. Legal, low speed, public road -- said before anything else. */
  intro: string;
  howItWorks: string;
  /** The standing promise of this mode. */
  cuesOff: string;
  start: string;
  startA11y: string;
  stop: string;
  stopA11y: string;
  /** Live progress. */
  learningTitle: string;
  learningHint: string;
  travelled: (metres: string) => string;
  /** P5d-FIX1 H1/H3: the handover is running -- the track is being kept and timing started. */
  adopting: string;
  adoptFailedTitle: string;
  adoptFailed: (detail: string) => string;
  retryAdopt: string;
  retryAdoptA11y: string;
  /** The banner the moment lap 1 closes. */
  learnedBanner: (corners: number, metres: string) => string;
  learnedHint: string;
  /** Honest endings, one per closure failure. */
  failureTitle: string;
  failure: Readonly<Record<TestLoopFailureReason, string>>;
  /** P5d-FIX2 N6: the learn phase hit its own fix cap. */
  capDetail: (fixes: number) => string;
  tryAgain: string;
  /** Saving the loop as a reusable circuit (T6). */
  saveTitle: string;
  saveHint: string;
  namePlaceholder: string;
  save: string;
  saveA11y: string;
  saved: (name: string) => string;
  saveEmptyName: string;
  saveFailed: string;
  /** The label a learned circuit carries wherever it is shown. */
  learnedLabel: string;
  /** The note under a learned circuit's geometry. */
  adHocNote: string;
  /** Deleting a learned circuit. */
  deleteTitle: string;
  delete: string;
  deleteA11y: (name: string) => string;
  deleteRefused: (sessions: number) => string;
  deleted: string;
  /** The row label in session history. */
  historyLabel: string;
  /** Session flow after the track is learned (P5d-FIX1 H1: timing is ALREADY running). */
  timingStarted: string;
  openDashboard: string;
  openDashboardA11y: string;
  sessionActive: string;
  notReady: string;
}

const EN: TestLoopStrings = {
  entryTitle: 'New circuit — learn the track',
  entrySubtitle: 'Drive one lap of any loop and the app builds the circuit from it.',
  entryA11y: 'New circuit. Learn a track by driving one lap of it.',
  screenTitle: 'Test loop',
  intro:
    'For LEGAL, low-speed testing only. Stay within the speed limit, obey every traffic rule, and never use this on a public road as a race. It exists so the analysis can be tried out without a trackday.',
  howItWorks:
    'Start, drive one full loop, and come back past where you started. That first lap becomes the track; the laps after it are timed against it.',
  cuesOff: 'No coaching cues and no voice in this mode — the geometry has not been validated.',
  start: 'Start learning',
  startA11y: 'Start learning the track from this lap',
  stop: 'Stop',
  stopA11y: 'Stop learning the track',
  learningTitle: 'Learning the track…',
  learningHint: 'Drive the loop and come back to where you started.',
  travelled: (metres) => `${metres} m driven`,
  adopting: 'Keeping the track and starting timing…',
  adoptFailedTitle: 'The track could not be kept',
  adoptFailed: (detail) => `The lap was learned, but storing and selecting it failed: ${detail}`,
  retryAdopt: 'Try again',
  retryAdoptA11y: 'Try keeping the learned track again',
  learnedBanner: (corners, metres) => `Track learned — ${corners} corners, ${metres} m`,
  learnedHint: 'Timing is already running — keep driving and this lap is timed against the track.',
  failureTitle: 'No track was learned',
  failure: {
    'not-returned':
      'You never came back to where you started, so there is no loop to time. Drive a route that returns to its start point.',
    'too-short':
      'That is not a loop — it came back too soon (a lap has to be at least 300 m). An out-and-back or a U-turn cannot be a circuit.',
    'heading-mismatch':
      'You passed the start point going the other way, so this is not a lap of the same loop.',
    'insufficient-samples':
      'Too few usable GPS fixes to build a track -- the ones that arrived were too inaccurate, or the car was not moving. Check that location is allowed, and drive.',
    'closure-unconfirmed':
      'You stopped right at the start point instead of driving through it. Keep going a few car lengths past where you began and the lap will close.',
    'self-overlapping':
      'That route runs back over itself -- an out-and-back, or the same short loop lapped more than once. A circuit has to be a single loop of at least 300 m.',
    'profile-invalid':
      'The lap could not be turned into a usable track — its shape is too irregular to time against.',
  },
  capDetail: (fixes) =>
    `Learning stopped after ${fixes} position fixes without a closed loop, and the recording was released.`,
  tryAgain: 'Try again',
  saveTitle: 'Save this as a circuit',
  saveHint:
    'Saved circuits appear in the circuit list and can be used again — sessions, history and analysis all work on them.',
  namePlaceholder: 'Name this circuit',
  save: 'Save circuit',
  saveA11y: 'Save this learned track as a circuit',
  saved: (name) => `Saved as “${name}”.`,
  saveEmptyName: 'Give the circuit a name first.',
  saveFailed: 'The circuit could not be saved.',
  learnedLabel: 'learned (ad-hoc geometry)',
  adHocNote:
    'Learned from one lap on this phone. Not surveyed and not validated on track, so no advice is given for it.',
  deleteTitle: 'Delete circuit',
  delete: 'Delete',
  deleteA11y: (name) => `Delete the learned circuit ${name}`,
  deleteRefused: (sessions) =>
    `This circuit still has ${sessions} recorded ${sessions === 1 ? 'session' : 'sessions'}. Delete those first — without the geometry they could no longer be analysed.`,
  deleted: 'Circuit deleted.',
  historyLabel: 'Test loop',
  timingStarted: 'Recording and timing continue without interruption — the learning lap is stored as the out lap.',
  openDashboard: 'Open timing screen',
  openDashboardA11y: 'Open the timing screen for the session already running',
  sessionActive: 'Finish the running session first.',
  notReady: 'The app is still starting up.',
};

const RO: TestLoopStrings = {
  entryTitle: 'Circuit nou — învață traseul',
  entrySubtitle: 'Condu un tur al oricărei bucle, iar aplicația construiește circuitul din el.',
  entryA11y: 'Circuit nou. Învață un traseu conducând un tur.',
  screenTitle: 'Buclă de test',
  intro:
    'Doar pentru testare LEGALĂ, la viteză mică. Respectă limita de viteză și toate regulile de circulație și nu folosi asta ca pe o cursă pe drum public. Există ca să poți încerca analiza fără o zi de circuit.',
  howItWorks:
    'Pornește, condu o buclă completă și treci înapoi pe lângă locul de plecare. Primul tur devine traseul; turele următoare sunt cronometrate pe el.',
  cuesOff: 'Fără indicații și fără voce în acest mod — geometria nu este validată.',
  start: 'Începe învățarea',
  startA11y: 'Începe învățarea traseului din acest tur',
  stop: 'Oprește',
  stopA11y: 'Oprește învățarea traseului',
  learningTitle: 'Se învață traseul…',
  learningHint: 'Condu bucla și întoarce-te de unde ai plecat.',
  travelled: (metres) => `${metres} m parcurși`,
  adopting: 'Se păstrează traseul și pornește cronometrarea…',
  adoptFailedTitle: 'Traseul nu a putut fi păstrat',
  adoptFailed: (detail) => `Turul a fost învățat, dar salvarea și selectarea lui au eșuat: ${detail}`,
  retryAdopt: 'Încearcă din nou',
  retryAdoptA11y: 'Încearcă din nou să păstrezi traseul învățat',
  learnedBanner: (corners, metres) => `Traseu învățat — ${corners} viraje, ${metres} m`,
  learnedHint: 'Cronometrarea a pornit deja — continuă să conduci și turul acesta este cronometrat pe traseu.',
  failureTitle: 'Niciun traseu învățat',
  failure: {
    'not-returned':
      'Nu te-ai întors la locul de plecare, deci nu există o buclă de cronometrat. Condu un traseu care revine la punctul de start.',
    'too-short':
      'Nu este o buclă — te-ai întors prea repede (un tur trebuie să aibă cel puțin 300 m). Un dus-întors sau o întoarcere în loc nu poate fi circuit.',
    'heading-mismatch':
      'Ai trecut pe la punctul de plecare în sens invers, deci nu este un tur al aceleiași bucle.',
    'insufficient-samples':
      'Prea puține poziții GPS utilizabile pentru a construi un traseu -- cele primite au fost prea imprecise sau mașina nu se mișca. Verifică permisiunea de localizare și condu.',
    'closure-unconfirmed':
      'Te-ai oprit chiar în punctul de plecare, fără să treci prin el. Mai mergi câțiva metri dincolo de locul de start și bucla se va închide.',
    'self-overlapping':
      'Traseul trece de două ori peste el însuși -- un dus-întors sau aceeași buclă scurtă parcursă de mai multe ori. Un circuit trebuie să fie o singură buclă de cel puțin 300 m.',
    'profile-invalid':
      'Turul nu a putut fi transformat într-un traseu utilizabil — forma lui este prea neregulată pentru cronometrare.',
  },
  capDetail: (fixes) =>
    `Învățarea s-a oprit după ${fixes} poziții GPS fără o buclă închisă, iar înregistrarea a fost eliberată.`,
  tryAgain: 'Încearcă din nou',
  saveTitle: 'Salvează ca circuit',
  saveHint:
    'Circuitele salvate apar în lista de circuite și pot fi folosite din nou — sesiunile, istoricul și analiza funcționează pe ele.',
  namePlaceholder: 'Denumește circuitul',
  save: 'Salvează circuitul',
  saveA11y: 'Salvează traseul învățat ca circuit',
  saved: (name) => `Salvat ca „${name}”.`,
  saveEmptyName: 'Dă-i mai întâi un nume circuitului.',
  saveFailed: 'Circuitul nu a putut fi salvat.',
  learnedLabel: 'învățat (geometrie ad-hoc)',
  adHocNote:
    'Învățat dintr-un singur tur pe acest telefon. Nemăsurat și nevalidat pe circuit, deci nu se dau sfaturi pentru el.',
  deleteTitle: 'Șterge circuitul',
  delete: 'Șterge',
  deleteA11y: (name) => `Șterge circuitul învățat ${name}`,
  deleteRefused: (sessions) =>
    `Circuitul are încă ${sessions} ${sessions === 1 ? 'sesiune înregistrată' : 'sesiuni înregistrate'}. Șterge-le mai întâi — fără geometrie nu ar mai putea fi analizate.`,
  deleted: 'Circuit șters.',
  historyLabel: 'Buclă de test',
  timingStarted: 'Înregistrarea și cronometrarea continuă fără întrerupere — turul de învățare este salvat ca tur de ieșire.',
  openDashboard: 'Deschide ecranul de cronometrare',
  openDashboardA11y: 'Deschide ecranul de cronometrare al sesiunii deja pornite',
  sessionActive: 'Termină întâi sesiunea în curs.',
  notReady: 'Aplicația încă pornește.',
};

/** Both tables, exported so a test can pin that RO carries every key EN does. */
export const TEST_LOOP_STRINGS: Readonly<Record<TestLoopUiLanguage, TestLoopStrings>> = {
  en: EN,
  ro: RO,
};

/** The table for the app's `language` setting; anything unknown reads as English. */
export function resolveTestLoopStrings(language: string | null | undefined): TestLoopStrings {
  return language === 'ro' ? RO : EN;
}
