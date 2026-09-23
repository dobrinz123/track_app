import type { GeometryProvenance } from '@circuit/core';

import type { AnalysisUiLanguage } from './analysisStrings';

/**
 * Ticket P5c-B — the RO/EN chrome for the trackday stage: the Settings row
 * that opts into it, and the between-stint Pit view.
 *
 * The same two invariants as `analysisStrings.ts` / `signalFinderStrings.ts`:
 * RO carries every key EN does, and the screens hold no prose of their own.
 * The SENTENCES about driving are not written here either — they come from
 * `@circuit/core`'s `pitSuggestionLine` / `cueUpdateLine`, already localised
 * with their numbers and the lap that proves each one.
 */

export interface PitScreenStrings {
  /** Navigator header + screen title. */
  screenTitle: string;
  /** The entry point on the driving dashboard. */
  entryButton: string;
  entryButtonA11y: string;
  loading: string;
  loadingHint: string;
  /** Honest dead ends. */
  noSession: string;
  noLaps: string;
  noTrace: string;
  failed: string;
  retry: string;
  retryA11y: string;
  close: string;
  closeA11y: string;
  /** Section chrome. */
  header: (circuit: string, lapCount: number) => string;
  focusHeading: string;
  cueUpdatesHeading: string;
  noCueUpdates: string;
  suggestionsHeading: string;
  /** Compact session chips. */
  lapsChip: (count: number) => string;
  cleanLapsChip: (count: number) => string;
  /** The standing status line under the heading — exactly one of these. */
  suggestionsOff: string;
  insufficientCleanLaps: string;
  nothingToSuggest: string;
  suggestionsShown: (count: number) => string;
  /**
   * Ticket P17: the same line when the circuit's geometry is `'mapped'` or
   * `'learned'` — the suggestions stand (they are bounded by the driver's own
   * laps through the same windows), but the corner NUMBERS are the app's.
   */
  suggestionsShownSelfReferential: (count: number, geometry: GeometryProvenance) => string;
  /**
   * Ticket P17: the engine was handed no statement at all about where this
   * circuit's geometry came from, so it produced nothing. A bug, not a state
   * the driver can fix — but silence with a reason beats silence.
   */
  geometryUnstated: string;
  /** Interaction. */
  expandCornerA11y: (corner: string) => string;
  collapseCornerA11y: (corner: string) => string;
  /** The standing promise, restated where the driver reads advice. */
  disclaimer: string;
}

export interface SuggestionSettingStrings {
  title: string;
  help: string;
  helpBounds: string;
  a11y: string;
}

const EN: PitScreenStrings = {
  screenTitle: 'Pit view',
  entryButton: 'Pit view',
  entryButtonA11y: 'Open the pit view for the laps you have driven so far',
  loading: 'Reading the laps you have driven…',
  loadingHint: 'Everything runs on this phone; nothing is sent anywhere.',
  noSession: 'Nothing has been recorded for this session yet.',
  noLaps: 'No completed laps yet — come back after your first lap.',
  noTrace: 'No GPS trace was stored for these laps, so no corner analysis is possible.',
  failed: 'The pit view could not be prepared.',
  retry: 'Try again',
  retryA11y: 'Prepare the pit view again',
  close: 'Back to the dashboard',
  closeA11y: 'Close the pit view and return to the driving dashboard',
  header: (circuit, lapCount) => `${circuit} · ${lapCount} laps so far`,
  focusHeading: 'Where you are losing the most',
  cueUpdatesHeading: 'Cues that moved this session',
  noCueUpdates: 'No cue has moved this session.',
  suggestionsHeading: 'Suggestions',
  lapsChip: (count) => `${count} laps`,
  cleanLapsChip: (count) => `${count} clean`,
  suggestionsOff:
    'Suggestions are off — this is what you did, not what to do. Turn them on under Settings › Coaching.',
  insufficientCleanLaps:
    'Fewer than two clean laps so far, so nothing is suggested yet — only what you have driven.',
  nothingToSuggest:
    'Nothing to suggest: on these corners your typical lap is already at what you have demonstrated.',
  suggestionsShown: (count) =>
    `${count} suggestions, every one inside what your own clean laps have already done.`,
  suggestionsShownSelfReferential: (count, geometry) =>
    `${count} suggestions, every one inside what your own clean laps have already done. ` +
    `The corner numbers are ours: this track was ${
      geometry === 'learned' ? 'learned from one lap you drove' : 'traced from a map'
    }, not surveyed, so compare yourself with yourself — not with a corner sign.`,
  geometryUnstated:
    "Nothing is suggested: the app could not establish where this circuit's geometry came from.",
  expandCornerA11y: (corner) => `Show the numbers for ${corner}`,
  collapseCornerA11y: (corner) => `Hide the numbers for ${corner}`,
  disclaimer:
    'Generated from your own laps. It is not driving instruction and does not replace an instructor; you are responsible for your safety on track.',
};

const RO: PitScreenStrings = {
  screenTitle: 'Vedere din boxă',
  entryButton: 'Vedere din boxă',
  entryButtonA11y: 'Deschide vederea din boxă pentru tururile făcute până acum',
  loading: 'Citim tururile făcute până acum…',
  loadingHint: 'Totul rulează pe telefonul tău; nimic nu pleacă nicăieri.',
  noSession: 'Nu s-a înregistrat încă nimic pentru această sesiune.',
  noLaps: 'Niciun tur complet încă — revino după primul tur.',
  noTrace: 'Nu s-a salvat traseu GPS pentru aceste tururi, deci nu putem analiza virajele.',
  failed: 'Nu am putut pregăti vederea din boxă.',
  retry: 'Încearcă din nou',
  retryA11y: 'Pregătește din nou vederea din boxă',
  close: 'Înapoi la bord',
  closeA11y: 'Închide vederea din boxă și revino la ecranul de condus',
  header: (circuit, lapCount) => `${circuit} · ${lapCount} tururi până acum`,
  focusHeading: 'Unde pierzi cel mai mult',
  cueUpdatesHeading: 'Repere mutate în această sesiune',
  noCueUpdates: 'Niciun reper nu s-a mutat în această sesiune.',
  suggestionsHeading: 'Sugestii',
  lapsChip: (count) => `${count} tururi`,
  cleanLapsChip: (count) => `${count} curate`,
  suggestionsOff:
    'Sugestiile sunt oprite — aici vezi ce ai făcut, nu ce să faci. Le pornești din Setări › Coaching.',
  insufficientCleanLaps:
    'Mai puțin de două tururi curate până acum, deci nu sugerăm nimic — doar ce ai condus.',
  nothingToSuggest:
    'Nimic de sugerat: pe aceste viraje turul tău obișnuit este deja la ce ai demonstrat.',
  suggestionsShown: (count) =>
    `${count} sugestii, toate în limita a ce au făcut deja tururile tale curate.`,
  suggestionsShownSelfReferential: (count, geometry) =>
    `${count} sugestii, toate în limita a ce au făcut deja tururile tale curate. ` +
    `Numerele virajelor sunt ale noastre: traseul ${
      geometry === 'learned' ? 'a fost învățat dintr-un tur condus de tine' : 'e trasat de pe hartă'
    }, nu măsurat, așa că te compari cu tine — nu cu un indicator de pe circuit.`,
  geometryUnstated:
    'Nu sugerăm nimic: aplicația n-a putut stabili de unde vine geometria acestui circuit.',
  expandCornerA11y: (corner) => `Arată cifrele pentru ${corner}`,
  collapseCornerA11y: (corner) => `Ascunde cifrele pentru ${corner}`,
  disclaimer:
    'Generat din propriile tale tururi. Nu este un ghid de pilotaj și nu înlocuiește instructorul; tu ești responsabil pentru siguranța ta pe circuit.',
};

/** Both tables, exported so a test can pin that RO carries every label EN does. */
export const PIT_SCREEN_STRINGS: Readonly<Record<AnalysisUiLanguage, PitScreenStrings>> = {
  en: EN,
  ro: RO,
};

export function resolvePitScreenStrings(language: AnalysisUiLanguage): PitScreenStrings {
  return PIT_SCREEN_STRINGS[language];
}

/**
 * The Settings row (ticket P5c-B D2). Its copy states the bounds in the same
 * words the safety contract does, because that is what the driver is opting
 * into: never past what they have already driven.
 */
export const SUGGESTION_SETTING_STRINGS: Readonly<
  Record<AnalysisUiLanguage, SuggestionSettingStrings>
> = {
  en: {
    title: 'Trackday suggestions',
    help: 'Between stints, show what you could try in each corner — and let the brake cue follow the latest point one of your own clean laps of this outing already reached.',
    helpBounds:
      'Never beyond what you have driven: at most 10 m later, at most +3 km/h, one change per corner per stint. No advice while driving. Off by default.',
    a11y: 'Trackday suggestions',
  },
  ro: {
    title: 'Sugestii de trackday',
    help: 'Între stinturi îți arătăm ce poți încerca în fiecare viraj — iar reperul de frânare poate urma cel mai târziu punct atins deja de un tur curat al tău din această ieșire.',
    helpBounds:
      'Niciodată dincolo de ce ai condus: cel mult 10 m mai târziu, cel mult +3 km/h, o singură schimbare per viraj per stint. Niciun sfat în timpul condusului. Oprit implicit.',
    a11y: 'Sugestii de trackday',
  },
};
