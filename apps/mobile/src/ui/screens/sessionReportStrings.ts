/**
 * Ticket P13B item 3 -- the RO/EN copy of the ONE-TAP export control.
 *
 * One button, one file, everything in it. The copy says "complete report"
 * rather than naming a format, because a format name is the beginning of a
 * format choice and the owner asked for there not to be one.
 *
 * The zero-lap line matters more than it looks: a session with no laps is
 * precisely the session this control exists for, and the one thing the owner
 * must not conclude from "no laps" is that the drive was lost.
 */

export type SessionReportLanguage = 'ro' | 'en';

export interface SessionReportStrings {
  /** The single control. */
  button: string;
  buttonA11y: (date: string) => string;
  busy: string;
  /** What the report contains, one line, under the button. */
  contains: string;
  /** Outcomes. `written` is a success: the file IS in the app. */
  shared: string;
  written: string;
  failed: string;
  missing: string;
  storageUnavailable: string;
  noSession: string;
  /** Said on a zero-lap session, where this button is the whole point. */
  zeroLapHint: string;
}

const EN: SessionReportStrings = {
  button: 'Export full report',
  buttonA11y: (date) => `Export the complete report of the session on ${date}, one tap`,
  busy: 'Exporting…',
  contains:
    'One file: the GPS trace, every sensor channel, every lap with the app’s verdict and yours, and every calibration attempt.',
  shared: 'Report shared.',
  written: 'Report saved in the app (no share sheet on this platform).',
  failed: 'Could not export the report.',
  missing: 'That session is no longer on this device.',
  storageUnavailable: 'Storage is not ready yet — try again in a moment.',
  noSession: 'No session from this launch to export.',
  zeroLapHint:
    'No laps were timed, but the full GPS trace and all sensor data were still recorded. Export the report to keep them.',
};

const RO: SessionReportStrings = {
  button: 'Exportează raportul complet',
  buttonA11y: (date) => `Exportează raportul complet al sesiunii din ${date}, un singur tap`,
  busy: 'Se exportează…',
  contains:
    'Un singur fișier: traseul GPS, toate canalele de senzori, fiecare tur cu verdictul aplicației și al tău, și fiecare încercare de calibrare.',
  shared: 'Raportul a fost trimis.',
  written: 'Raportul a fost salvat în aplicație (nu există meniu de partajare pe acest sistem).',
  failed: 'Nu s-a putut exporta raportul.',
  missing: 'Sesiunea nu mai este pe acest telefon.',
  storageUnavailable: 'Stocarea nu este încă pregătită — mai încearcă într-o clipă.',
  noSession: 'Nu există nicio sesiune din această pornire de exportat.',
  zeroLapHint:
    'Nu s-a cronometrat niciun tur, dar traseul GPS complet și toate datele de la senzori au fost înregistrate. Exportează raportul ca să le păstrezi.',
};

export const SESSION_REPORT_STRINGS: Readonly<Record<SessionReportLanguage, SessionReportStrings>> =
  { en: EN, ro: RO };

/** Resolves the table for the app's language setting; anything unknown falls back to English. */
export function resolveSessionReportStrings(language: string): SessionReportStrings {
  return language === 'ro' ? RO : EN;
}
