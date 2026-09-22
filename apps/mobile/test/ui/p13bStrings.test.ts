import { describe, expect, it } from 'vitest';

import {
  LAP_VERDICT_STRINGS,
  resolveLapVerdictStrings,
} from '../../src/ui/screens/lapVerdictStrings';
import {
  CALIBRATION_REPORT_STRINGS,
  resolveCalibrationReportStrings,
} from '../../src/ui/screens/calibrationReportStrings';
import {
  SESSION_REPORT_STRINGS,
  resolveSessionReportStrings,
} from '../../src/ui/screens/sessionReportStrings';

/**
 * Ticket P13B -- the RO/EN tables for the three surfaces this build adds.
 *
 * Two standing invariants of this repo (`analysisStrings.test.ts`,
 * `signalFinderStrings.test.ts`): RO carries every key EN does with the same
 * shape, and no long EN sentence is left sitting in the RO table.
 *
 * Plus one that is specific to this ticket and is the reason the whole build
 * exists: the verdict control must say it is judging the APP. A label that can
 * be read as "was this lap good?" gives the opposite answer on an invalid lap
 * the app correctly invalidated, and every row collected under it would be
 * unusable.
 */

type Shape = Record<string, unknown>;

function assertSameShape(en: Shape, ro: Shape, path: string): void {
  for (const key of Object.keys(en)) {
    expect(ro[key], `${path}.${key} is missing from the RO table`).toBeDefined();
    expect(typeof ro[key], `${path}.${key} has a different shape in RO`).toBe(typeof en[key]);
    const enValue = en[key];
    if (typeof enValue === 'object' && enValue !== null) {
      assertSameShape(enValue as Shape, ro[key] as Shape, `${path}.${key}`);
    }
  }
  for (const key of Object.keys(ro)) {
    expect(Object.keys(en), `${path}.${key} exists only in RO`).toContain(key);
  }
}

function assertNotStillEnglish(en: Shape, ro: Shape, path: string): void {
  for (const key of Object.keys(en)) {
    const enValue = en[key];
    if (typeof enValue === 'object' && enValue !== null) {
      assertNotStillEnglish(enValue as Shape, ro[key] as Shape, `${path}.${key}`);
      continue;
    }
    if (typeof enValue !== 'string' || enValue.split(' ').length < 3) continue;
    expect(ro[key], `${path}.${key} is still English in the RO table`).not.toBe(enValue);
  }
}

describe('P13B -- string table parity', () => {
  it.each([
    ['lapVerdict', LAP_VERDICT_STRINGS],
    ['calibrationReport', CALIBRATION_REPORT_STRINGS],
    ['sessionReport', SESSION_REPORT_STRINGS],
  ])('%s: RO has every key EN has, with the same shape', (name, table) => {
    assertSameShape(table.en as unknown as Shape, table.ro as unknown as Shape, name);
  });

  it.each([
    ['lapVerdict', LAP_VERDICT_STRINGS],
    ['calibrationReport', CALIBRATION_REPORT_STRINGS],
    ['sessionReport', SESSION_REPORT_STRINGS],
  ])('%s: no long English sentence survives untranslated in RO', (name, table) => {
    assertNotStillEnglish(table.en as unknown as Shape, table.ro as unknown as Shape, name);
  });

  it('resolves the app language setting, defaulting anything unknown to English', () => {
    expect(resolveLapVerdictStrings('ro')).toBe(LAP_VERDICT_STRINGS.ro);
    expect(resolveLapVerdictStrings('de')).toBe(LAP_VERDICT_STRINGS.en);
    expect(resolveCalibrationReportStrings('ro')).toBe(CALIBRATION_REPORT_STRINGS.ro);
    expect(resolveCalibrationReportStrings('')).toBe(CALIBRATION_REPORT_STRINGS.en);
    expect(resolveSessionReportStrings('ro')).toBe(SESSION_REPORT_STRINGS.ro);
    expect(resolveSessionReportStrings('en')).toBe(SESSION_REPORT_STRINGS.en);
  });
});

describe('P13B item 1 -- the control says it is judging the APP', () => {
  it('names the app in both button labels, in both languages', () => {
    expect(LAP_VERDICT_STRINGS.en.agreeButton).toMatch(/App/);
    expect(LAP_VERDICT_STRINGS.en.disagreeButton).toMatch(/App/);
    expect(LAP_VERDICT_STRINGS.ro.agreeButton).toMatch(/Aplicația/);
    expect(LAP_VERDICT_STRINGS.ro.disagreeButton).toMatch(/Aplicația/);
  });

  it('never offers a bare yes/no that could be read as "was this lap good?"', () => {
    for (const language of ['en', 'ro'] as const) {
      const strings = LAP_VERDICT_STRINGS[language];
      for (const label of [strings.agreeButton, strings.disagreeButton]) {
        expect(label.trim().split(/\s+/).length, `"${label}" is a bare answer`).toBeGreaterThan(1);
      }
    }
  });

  it('spells out, in the hint, that a bad lap the app called correctly is still "app was right"', () => {
    expect(LAP_VERDICT_STRINGS.en.questionHint).toMatch(/even if the lap itself was a bad one/);
    expect(LAP_VERDICT_STRINGS.ro.questionHint).toMatch(/chiar dacă turul în sine a fost slab/);
  });

  it('asks about the app in the per-lap question and in both accessibility labels', () => {
    expect(LAP_VERDICT_STRINGS.en.question).toMatch(/app/i);
    expect(LAP_VERDICT_STRINGS.ro.question).toMatch(/aplicației/i);
    expect(LAP_VERDICT_STRINGS.en.agreeButtonA11y(3)).toMatch(/the app judged this lap correctly/);
    expect(LAP_VERDICT_STRINGS.en.disagreeButtonA11y(3)).toMatch(/the app judged this lap wrongly/);
    expect(LAP_VERDICT_STRINGS.ro.agreeButtonA11y(3)).toMatch(/aplicația a judecat corect/);
    expect(LAP_VERDICT_STRINGS.ro.disagreeButtonA11y(3)).toMatch(/aplicația a judecat greșit/);
  });

  it('makes an unanswered lap say so, with its own badge, in both languages', () => {
    for (const language of ['en', 'ro'] as const) {
      expect(LAP_VERDICT_STRINGS[language].unanswered.length).toBeGreaterThan(0);
      expect(LAP_VERDICT_STRINGS[language].unansweredBadge.length).toBeGreaterThan(0);
    }
  });

  it('shouts when an answer did NOT reach storage, in both languages', () => {
    expect(LAP_VERDICT_STRINGS.en.saveFailed).toMatch(/NOT SAVED/);
    expect(LAP_VERDICT_STRINGS.en.saveUnsupported).toMatch(/NOT SAVED/);
    expect(LAP_VERDICT_STRINGS.ro.saveFailed).toMatch(/NU S-A SALVAT/);
    expect(LAP_VERDICT_STRINGS.ro.saveUnsupported).toMatch(/NU S-A SALVAT/);
    // ...and stays quiet when it did.
    expect(LAP_VERDICT_STRINGS.en.saved).not.toMatch(/NOT/);
  });

  it('renders the summary with all three counts in it', () => {
    const counts = { agreed: 2, disagreed: 1, unanswered: 4 };
    for (const language of ['en', 'ro'] as const) {
      const text = LAP_VERDICT_STRINGS[language].summary(counts);
      expect(text).toContain('2');
      expect(text).toContain('1');
      expect(text).toContain('4');
    }
  });
});

describe('P13B item 3 -- the one-tap export offers no format choice', () => {
  it('names no file format in the button label', () => {
    for (const language of ['en', 'ro'] as const) {
      expect(SESSION_REPORT_STRINGS[language].button).not.toMatch(/json|markdown|\.md|csv/i);
    }
  });

  it('says the drive survived a zero-lap session', () => {
    expect(SESSION_REPORT_STRINGS.en.zeroLapHint).toMatch(/still recorded/);
    expect(SESSION_REPORT_STRINGS.ro.zeroLapHint).toMatch(/înregistrate/);
  });

  it('treats "written, not shared" as a success rather than a failure', () => {
    for (const language of ['en', 'ro'] as const) {
      expect(SESSION_REPORT_STRINGS[language].written).not.toBe(
        SESSION_REPORT_STRINGS[language].failed,
      );
    }
  });
});
