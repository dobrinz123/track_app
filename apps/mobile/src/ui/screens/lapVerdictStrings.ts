import type { LapVerdictAnswer } from '@circuit/core';

/**
 * Ticket P13B item 1 (binding) -- THE WORDING OF THE TRUE/FALSE CONTROL.
 *
 * The owner asked for "un buton cu adevarat sau fals pe care o sa apas eu"
 * beside each lap, and the protocol promises that the button answers ONE
 * question: was the app's VALID/INVALID call on this lap correct? It does NOT
 * ask whether the lap was a good lap. Those two readings give opposite answers
 * on an invalid lap the app correctly invalidated -- the app was right, the lap
 * was bad -- so a label that leaves the question implicit poisons the entire
 * data set this build exists to collect.
 *
 * Every string below therefore names the APP as the subject. "Da" and "Nu"
 * never stand alone: each carries the clause that says what is being agreed
 * with. The screens hold no prose of their own, and RO carries every key EN
 * does -- the `lapVerdictStrings.test.ts` suite asserts both.
 */

export type LapVerdictLanguage = 'ro' | 'en';

export interface LapVerdictStrings {
  /** Section heading over the lap list's verdict controls. */
  sectionHeading: string;
  /**
   * The question, spelled out once per lap directly above the two buttons.
   * Short enough to read in a helmet; unambiguous about the subject.
   */
  question: string;
  /**
   * The disambiguation, stated once per screen. This is the sentence that
   * stops the control being read as "rate this lap".
   */
  questionHint: string;
  /** What the app itself decided, shown next to the control. */
  appVerdictValid: string;
  appVerdictInvalid: string;
  /** Heading over the app's reasons for an invalid call. */
  appReasonsHeading: string;
  /** An invalid lap whose reason list came back empty. */
  appReasonsNone: string;
  /** The two buttons. `agreed` = the app was right; `disagreed` = the app was wrong. */
  agreeButton: string;
  disagreeButton: string;
  agreeButtonA11y: (lapNumber: number) => string;
  disagreeButtonA11y: (lapNumber: number) => string;
  /** The stored answer, read back. */
  answeredAgreed: string;
  answeredDisagreed: string;
  /** The visible difference between a lap he has done and one he has not. */
  unanswered: string;
  unansweredBadge: string;
  /** Shown when he has changed his answer; `revision` is 2 for the first change. */
  revised: (revision: number) => string;
  /** The summary, where he is working. */
  summary: (counts: Record<LapVerdictAnswer, number>) => string;
  summaryA11y: (counts: Record<LapVerdictAnswer, number>) => string;
  /** All laps answered. */
  summaryComplete: string;
  /** Feedback after a tap. A tap that did not persist must never look like one that did. */
  saved: string;
  saveFailed: string;
  saveUnsupported: string;
  /** The store cannot hold answers at all -- said before he taps, not after. */
  unsupportedNotice: string;
  /** No lap in this session, so nothing to judge. */
  noLaps: string;
}

const EN: LapVerdictStrings = {
  sectionHeading: 'DID THE APP GET IT RIGHT?',
  question: 'Was the app’s call on this lap correct?',
  questionHint:
    'You are judging the APP, not the lap. Tap "App was right" when its VALID/INVALID call matches what actually happened — even if the lap itself was a bad one.',
  appVerdictValid: 'App says: VALID',
  appVerdictInvalid: 'App says: INVALID',
  appReasonsHeading: 'App’s reasons',
  appReasonsNone: 'The app recorded no reason for this call.',
  agreeButton: 'App was right',
  disagreeButton: 'App was wrong',
  agreeButtonA11y: (lapNumber) =>
    `Lap ${String(lapNumber)}: the app judged this lap correctly`,
  disagreeButtonA11y: (lapNumber) =>
    `Lap ${String(lapNumber)}: the app judged this lap wrongly`,
  answeredAgreed: 'You said: the app was RIGHT',
  answeredDisagreed: 'You said: the app was WRONG',
  unanswered: 'Not answered yet',
  unansweredBadge: 'TO DO',
  revised: (revision) => `answer ${String(revision)}`,
  summary: (counts) =>
    `${String(counts.agreed)} right · ${String(counts.disagreed)} wrong · ${String(counts.unanswered)} to do`,
  summaryA11y: (counts) =>
    `${String(counts.agreed)} lap(s) marked the app right, ${String(counts.disagreed)} marked the app wrong, ${String(counts.unanswered)} still to answer`,
  summaryComplete: 'Every lap answered.',
  saved: 'Saved.',
  saveFailed: 'NOT SAVED — the answer is only in memory. Export the report now to keep it.',
  saveUnsupported: 'NOT SAVED — this device cannot store answers.',
  unsupportedNotice:
    'This device cannot store lap answers, so the buttons are off. The app’s own verdicts and reasons are still in the exported report.',
  noLaps: 'No lap was timed in this session, so there is nothing to judge.',
};

const RO: LapVerdictStrings = {
  sectionHeading: 'A JUDECAT APLICAȚIA CORECT?',
  question: 'Verdictul aplicației pentru acest tur a fost corect?',
  questionHint:
    'Judeci APLICAȚIA, nu turul. Apasă "Aplicația a avut dreptate" când verdictul VALID/INVALID se potrivește cu ce s-a întâmplat — chiar dacă turul în sine a fost slab.',
  appVerdictValid: 'Aplicația spune: VALID',
  appVerdictInvalid: 'Aplicația spune: INVALID',
  appReasonsHeading: 'Motivele aplicației',
  appReasonsNone: 'Aplicația nu a înregistrat niciun motiv pentru acest verdict.',
  agreeButton: 'Aplicația a avut dreptate',
  disagreeButton: 'Aplicația a greșit',
  agreeButtonA11y: (lapNumber) =>
    `Turul ${String(lapNumber)}: aplicația a judecat corect acest tur`,
  disagreeButtonA11y: (lapNumber) =>
    `Turul ${String(lapNumber)}: aplicația a judecat greșit acest tur`,
  answeredAgreed: 'Ai spus: aplicația a avut DREPTATE',
  answeredDisagreed: 'Ai spus: aplicația a GREȘIT',
  unanswered: 'Fără răspuns',
  unansweredBadge: 'DE FĂCUT',
  revised: (revision) => `răspunsul ${String(revision)}`,
  summary: (counts) =>
    `${String(counts.agreed)} corecte · ${String(counts.disagreed)} greșite · ${String(counts.unanswered)} de făcut`,
  summaryA11y: (counts) =>
    `${String(counts.agreed)} tur(e) marcate cu aplicația corectă, ${String(counts.disagreed)} cu aplicația greșită, ${String(counts.unanswered)} fără răspuns`,
  summaryComplete: 'Toate turele au răspuns.',
  saved: 'Salvat.',
  saveFailed: 'NU S-A SALVAT — răspunsul e doar în memorie. Exportează raportul acum ca să-l păstrezi.',
  saveUnsupported: 'NU S-A SALVAT — acest telefon nu poate stoca răspunsuri.',
  unsupportedNotice:
    'Acest telefon nu poate stoca răspunsuri, deci butoanele sunt oprite. Verdictele și motivele aplicației rămân în raportul exportat.',
  noLaps: 'Nu s-a cronometrat niciun tur în această sesiune, deci nu e nimic de judecat.',
};

export const LAP_VERDICT_STRINGS: Readonly<Record<LapVerdictLanguage, LapVerdictStrings>> = {
  en: EN,
  ro: RO,
};

/** Resolves the table for the app's language setting; anything unknown falls back to English. */
export function resolveLapVerdictStrings(language: string): LapVerdictStrings {
  return language === 'ro' ? RO : EN;
}
