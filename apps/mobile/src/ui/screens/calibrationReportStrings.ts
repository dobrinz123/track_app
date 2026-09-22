import type { CalibrationAttemptOutcome } from '@circuit/core';

import type { CalibrationReportFigure } from '../../session/calibrationReportViewModel';

/**
 * Ticket P13B item 2 -- the RO/EN copy of the automatic calibration report.
 *
 * Two rules, both from the owner:
 *
 *  1. A CANCEL IS A FAILURE. `outcomeHeading.cancelled` says so in as many
 *     words in both languages. Nothing here describes a cancel as "stopped",
 *     "not started" or "skipped".
 *  2. PLAIN LANGUAGE. Every sentence names a measured value AND the bar it was
 *     judged against, because "insufficient coverage" only repeats the
 *     question.
 *
 * The engine's authored `explanation` lines are shown UNDER these, verbatim
 * and in English, behind a heading that says so (`detailHeading`). Reprinting
 * them in Romanian would mean two places that can disagree about what a
 * threshold was; a labelled English detail block is honest, a silently
 * half-translated one is not.
 */

export type CalibrationReportLanguage = 'ro' | 'en';

export interface CalibrationReportStrings {
  /** Card title. */
  title: string;
  /** One line per outcome -- the headline verdict. */
  outcomeHeading: Readonly<Record<CalibrationAttemptOutcome, string>>;
  /** The standing statement that a failed Learn lap does not lose the drive. */
  dataStillRecorded: string;
  /** Renders one figure of the model. */
  figure: (figure: CalibrationReportFigure) => string;
  /** Heading over the engine's own English reason lines. */
  detailHeading: string;
  /** The escape-hatch note. */
  forceFinished: string;
  /** Nothing to show -- no Learn lap has run in this launch. */
  noAttempt: string;
  /** Accessibility label for the whole card. */
  a11y: (outcome: string) => string;
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

const EN_FIGURES: Readonly<Record<CalibrationReportFigure['key'], string>> = {
  neverConcluded:
    'This Learn lap never finished — it was still running when the record was written, so the figures below are a live reading, not a verdict.',
  coverage:
    'Coverage reached {coverage}. The bar to be accepted is {bar}; the lap finishes on its own at {autoFinish}.',
  gap: 'The longest stretch never driven was {length} m, from {start} m to {end} m past the start/finish line. The limit is {limit} m.',
  gapUnmeasured:
    'No uncovered stretch was measured — the engine never produced a verdict for this attempt. That is not the same as "there was no gap".',
  duration: 'The lap ran for {seconds} s.',
  samples: '{fed} GPS fix(es) were fed to the calibration.',
  rejected: '{rejected} of {fed} fixes were rejected as unusable. The limit is {limit}.',
  thresholds:
    'Judged against: coverage {coverageBar}, longest gap {gapLimit} m, fix rate {rateHz} Hz, corridor {corridor} m.',
};

const RO_FIGURES: Readonly<Record<CalibrationReportFigure['key'], string>> = {
  neverConcluded:
    'Acest tur de recunoaștere nu s-a terminat niciodată — încă rula când s-a scris înregistrarea, deci cifrele de mai jos sunt o citire în timp real, nu un verdict.',
  coverage:
    'Acoperirea a ajuns la {coverage}. Pragul de acceptare este {bar}; turul se încheie singur la {autoFinish}.',
  gap: 'Cea mai lungă porțiune nestrăbătută a fost de {length} m, de la {start} m la {end} m după linia de start/sosire. Limita este {limit} m.',
  gapUnmeasured:
    'Nicio porțiune neacoperită nu a fost măsurată — motorul nu a produs niciodată un verdict pentru această încercare. Nu înseamnă că "nu a existat nicio porțiune".',
  duration: 'Turul a rulat {seconds} s.',
  samples: 'S-au alimentat {fed} fix-uri GPS în calibrare.',
  rejected: '{rejected} din {fed} fix-uri au fost respinse ca inutilizabile. Limita este {limit}.',
  thresholds:
    'Judecat față de: acoperire {coverageBar}, porțiune maximă {gapLimit} m, rată fix-uri {rateHz} Hz, coridor {corridor} m.',
};

const EN: CalibrationReportStrings = {
  title: 'WHY CALIBRATION DID NOT SUCCEED',
  outcomeHeading: {
    accepted: 'Calibration was accepted.',
    rejected:
      'FAILED — the Learn lap ran to the end and the quality checks refused it.',
    stalled:
      'FAILED — the Learn lap stalled: it never reached the coverage at which it finishes on its own.',
    cancelled:
      'FAILED — you cancelled the Learn lap. A cancel is recorded as a failed calibration, not as an attempt that never happened.',
  },
  dataStillRecorded:
    'The drive itself was still recorded. The GPS trace and all sensor data are kept and go into the exported report.',
  figure: (figure) => fill(EN_FIGURES[figure.key], figure.values),
  detailHeading: 'Technical detail (English, from the calibration engine)',
  forceFinished:
    'You force-finished this lap with "start anyway". The verdict above is the engine’s own, computed from what was actually driven — no threshold was lowered.',
  noAttempt: 'No Learn lap has run since the app started, so there is no calibration report yet.',
  a11y: (outcome) => `Calibration report: ${outcome}`,
};

const RO: CalibrationReportStrings = {
  title: 'DE CE NU A REUȘIT CALIBRAREA',
  outcomeHeading: {
    accepted: 'Calibrarea a fost acceptată.',
    rejected:
      'EȘEC — turul de recunoaștere a mers până la capăt, iar verificările de calitate l-au refuzat.',
    stalled:
      'EȘEC — turul de recunoaștere s-a blocat: nu a atins niciodată acoperirea la care se încheie singur.',
    cancelled:
      'EȘEC — ai anulat turul de recunoaștere. Anularea se înregistrează ca o calibrare eșuată, nu ca o încercare care nu a avut loc.',
  },
  dataStillRecorded:
    'Cursa în sine a fost înregistrată oricum. Traseul GPS și toate datele de la senzori se păstrează și intră în raportul exportat.',
  figure: (figure) => fill(RO_FIGURES[figure.key], figure.values),
  detailHeading: 'Detalii tehnice (în engleză, de la motorul de calibrare)',
  forceFinished:
    'Ai forțat încheierea turului cu "start anyway". Verdictul de mai sus este al motorului, calculat din ce s-a condus efectiv — niciun prag nu a fost coborât.',
  noAttempt:
    'Niciun tur de recunoaștere nu a rulat de la pornirea aplicației, deci nu există încă un raport de calibrare.',
  a11y: (outcome) => `Raport de calibrare: ${outcome}`,
};

export const CALIBRATION_REPORT_STRINGS: Readonly<
  Record<CalibrationReportLanguage, CalibrationReportStrings>
> = { en: EN, ro: RO };

/** Resolves the table for the app's language setting; anything unknown falls back to English. */
export function resolveCalibrationReportStrings(language: string): CalibrationReportStrings {
  return language === 'ro' ? RO : EN;
}
