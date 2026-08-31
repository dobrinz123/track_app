import type {
  CornerInsight,
  CornerLapRow,
  LapInsight,
  Limitation,
  SessionInsights,
  TimeLossCause,
  TimeLossFinding,
} from './sessionInsights';
import type { CuePoint, CueUpdate, PitSuggestion } from './suggestions';
import type { CoachingChannelId, CornerMetrics, LapAnomalyReason, LapCheckId, LapLabel } from './types';

/**
 * Template-generated session report in Romanian and English -- Phase 5 REVISION
 * (report text is templated, every sentence carries its numbers and lap ids)
 * and safety-contract rule 6 (coach tone, the driver's own evidence, a fixed
 * disclaimer, no absolute braking markers).
 *
 * V1 is observations only: nothing here tells the driver to brake later or
 * carry more speed. Where a number was not measured the sentence is not
 * written at all -- the report never renders a placeholder, so no output can
 * ever contain "undefined" or "NaN".
 */

export type ReportLanguage = 'ro' | 'en';

export interface ReportSection {
  id: string;
  heading: string;
  lines: string[];
}

export interface CoachReport {
  language: ReportLanguage;
  title: string;
  subtitle: string;
  sections: ReportSection[];
  disclaimer: string;
  /** The whole report as plain text (headings, lines, disclaimer). */
  text: string;
}

/** How many corners the ranked sections name before stopping. */
const RANKED_LIMIT = 5;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatNumber(value: number, decimals: number, language: ReportLanguage): string {
  const safe = Math.abs(value) < 0.5 * 10 ** -decimals ? 0 : value;
  const fixed = safe.toFixed(decimals);
  return language === 'ro' ? fixed.replace('.', ',') : fixed;
}

function metres(value: number, language: ReportLanguage): string {
  return `${formatNumber(value, 0, language)} m`;
}

function kph(value: number, language: ReportLanguage): string {
  return `${formatNumber(value, 1, language)} km/h`;
}

function gForce(value: number, language: ReportLanguage): string {
  return `${formatNumber(value, 2, language)} g`;
}

function seconds(value: number, language: ReportLanguage): string {
  return `${formatNumber(value / 1_000, 2, language)} s`;
}

/**
 * A time difference always reaches the reader as a VERB plus a magnitude
 * ("you lost 0.20 s" / "you gained 0.20 s"), never as a signed number after
 * "lost", which would read as "you lost -0.20 s".
 */
function gainOrLoss(value: number, language: ReportLanguage): string {
  const magnitude = seconds(Math.abs(value), language);
  if (language === 'ro') {
    return value < 0 ? `ai câștigat ${magnitude}` : `ai pierdut ${magnitude}`;
  }
  return value < 0 ? `you gained ${magnitude}` : `you lost ${magnitude}`;
}

function lapTime(value: number, language: ReportLanguage): string {
  const totalSeconds = value / 1_000;
  const minutes = Math.floor(totalSeconds / 60);
  const rest = totalSeconds - minutes * 60;
  const restText = formatNumber(rest, 2, language).padStart(language === 'ro' ? 5 : 5, '0');
  return `${minutes}:${restText}`;
}

function lapList(numbers: readonly number[], language: ReportLanguage): string {
  const values = [...numbers].sort((a, b) => a - b).map((value) => String(value));
  if (values.length === 0) return language === 'ro' ? 'niciun tur' : 'no laps';
  if (values.length === 1) return values[0] ?? '';
  const last = values[values.length - 1] ?? '';
  const head = values.slice(0, -1).join(', ');
  return language === 'ro' ? `${head} și ${last}` : `${head} and ${last}`;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

const CHANNEL_LABELS: Record<ReportLanguage, Partial<Record<CoachingChannelId, string>>> = {
  ro: {
    speedKph: 'viteză',
    accelPedalPct: 'pedala de accelerație',
    throttlePct: 'clapeta de accelerație',
    brakePct: 'frâna',
    brakeSwitch: 'contactul de frână',
    longG: 'accelerație longitudinală (G)',
    latG: 'accelerație laterală (G)',
    yawRateDps: 'viteza de girație',
    steeringDeg: 'unghiul volanului',
    rpm: 'turația motorului',
  },
  en: {
    speedKph: 'speed',
    accelPedalPct: 'accelerator pedal',
    throttlePct: 'throttle plate',
    brakePct: 'brake',
    brakeSwitch: 'brake switch',
    longG: 'longitudinal G',
    latG: 'lateral G',
    yawRateDps: 'yaw rate',
    steeringDeg: 'steering angle',
    rpm: 'engine rpm',
  },
};

const BRAKE_SOURCE_LABELS: Record<
  ReportLanguage,
  Record<NonNullable<CornerMetrics['brakeSource']>, string>
> = {
  ro: {
    brakePct: 'din canalul de frână',
    brakeSwitch: 'din contactul de frână',
    longG: 'din accelerometru',
    gpsSpeed: 'estimat din viteza GPS',
  },
  en: {
    brakePct: 'from the brake channel',
    brakeSwitch: 'from the brake switch',
    longG: 'from the accelerometer',
    gpsSpeed: 'estimated from GPS speed',
  },
};

const LIFT_SOURCE_LABELS: Record<
  ReportLanguage,
  Record<NonNullable<CornerMetrics['liftSource']>, string>
> = {
  ro: {
    accelPedalPct: 'din pedala de accelerație',
    throttlePct: 'din clapeta de accelerație',
    decelOnset: 'estimat din începutul decelerării',
  },
  en: {
    accelPedalPct: 'from the accelerator pedal',
    throttlePct: 'from the throttle plate',
    decelOnset: 'estimated from the start of deceleration',
  },
};

/**
 * Anomaly reasons in the report's own language. `LapClassification.detail`
 * stays machine-facing English for diagnostics; a Romanian report must never
 * paste it into a sentence.
 */
const REASON_LABELS: Record<ReportLanguage, Record<LapAnomalyReason, string>> = {
  ro: {
    incomplete: 'tur incomplet',
    offTrack: 'ieșire de pe traseu',
    gnssPoor: 'semnal GPS slab',
  },
  en: {
    incomplete: 'incomplete lap',
    offTrack: 'off-track excursion',
    gnssPoor: 'poor GPS signal',
  },
};

/**
 * Informative lap labels (R2-1, `contracts.md` "Phase 5 REVISION 2"): heavy
 * braking, ABS-like oscillation and a slide/rotation are NORMAL circuit
 * driving, rendered as neutral facts -- never as a reason the lap was
 * excluded. The base word for each is here; the numeric detail (g, deg/s) is
 * appended by `labelSummary` when it was measured.
 */
const LABEL_LABELS: Record<ReportLanguage, Record<LapLabel, string>> = {
  ro: {
    HEAVY_BRAKING: 'frânare foarte tare',
    ABS_SUSPECTED: 'ABS activat (probabil)',
    SLIDE_ROTATION: 'derapaj / rotație controlată',
  },
  en: {
    HEAVY_BRAKING: 'very hard braking',
    ABS_SUSPECTED: 'ABS likely active',
    SLIDE_ROTATION: 'slide / controlled rotation',
  },
};

/** What each safety check actually looks at, for the "unverified" sentence. */
const CHECK_LABELS: Record<ReportLanguage, Record<LapCheckId, string>> = {
  ro: {
    offTrack: 'poziția față de traseu',
    yawSpike: 'derapaj / rotire',
    decelSpike: 'decelerare',
    gnssPoor: 'calitatea semnalului GPS',
    coverage: 'acoperirea turului',
  },
  en: {
    offTrack: 'position relative to the track',
    yawSpike: 'slide or spin',
    decelSpike: 'deceleration',
    gnssPoor: 'GPS signal quality',
    coverage: 'lap coverage',
  },
};

const CAUSE_LABELS: Record<ReportLanguage, Record<TimeLossCause, string>> = {
  ro: {
    EARLIER_BRAKE: 'ai frânat mai devreme',
    EARLIER_LIFT: 'ai ridicat piciorul mai devreme',
    LOWER_MIN_SPEED: 'ai avut viteză minimă mai mică',
    LOWER_EXIT_SPEED: 'ai ieșit mai încet din viraj',
    LATER_THROTTLE: 'ai reluat accelerația mai târziu',
  },
  en: {
    EARLIER_BRAKE: 'you braked earlier',
    EARLIER_LIFT: 'you lifted earlier',
    LOWER_MIN_SPEED: 'you carried a lower minimum speed',
    LOWER_EXIT_SPEED: 'you exited the corner slower',
    LATER_THROTTLE: 'you got back on the throttle later',
  },
};

const TEXT: Record<
  ReportLanguage,
  {
    title: string;
    subtitle: (circuit: string, laps: number, clean: number) => string;
    disclaimer: string;
    headings: Record<string, string>;
    cornerHeading: (id: number, direction: string) => string;
    directions: { left: string; right: string };
  }
> = {
  ro: {
    title: 'Raport de sesiune — analiză pe viraje',
    subtitle: (circuit, laps, clean) =>
      `${circuit}: ${laps} tururi înregistrate, ${clean} tururi curate folosite ca reper.`,
    disclaimer:
      'Raport informativ, generat automat din datele tale. Nu este un ghid de pilotaj și nu ' +
      'înlocuiește instructorul; tu ești responsabil pentru siguranța ta pe circuit.',
    headings: {
      overview: 'Pe scurt',
      limitations: 'Ce nu putem spune din aceste date',
      timeLoss: 'Unde pierzi timp',
      consistency: 'Constanță',
      sectors: 'Sectoare',
      corners: 'Viraj cu viraj',
    },
    cornerHeading: (id, direction) => `Virajul ${id} (${direction})`,
    directions: { left: 'stânga', right: 'dreapta' },
  },
  en: {
    title: 'Session report — corner by corner',
    subtitle: (circuit, laps, clean) =>
      `${circuit}: ${laps} laps recorded, ${clean} clean laps used as the reference.`,
    disclaimer:
      'Informational report, generated automatically from your own data. It is not driving ' +
      'instruction and does not replace an instructor; you are responsible for your safety on track.',
    headings: {
      overview: 'At a glance',
      limitations: 'What this data cannot tell you',
      timeLoss: 'Where you lose time',
      consistency: 'Consistency',
      sectors: 'Sectors',
      corners: 'Corner by corner',
    },
    cornerHeading: (id, direction) => `Corner ${id} (${direction})`,
    directions: { left: 'left', right: 'right' },
  },
};

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function channelNames(
  channels: readonly CoachingChannelId[],
  language: ReportLanguage,
): string {
  return channels.map((channel) => CHANNEL_LABELS[language][channel] ?? channel).join(', ');
}

function checkNames(checks: readonly LapCheckId[], language: ReportLanguage): string {
  const names = checks.map((check) => CHECK_LABELS[language][check] ?? check);
  return names.length === 0 ? (language === 'ro' ? 'verificările de siguranță' : 'the safety checks') : names.join(', ');
}

/**
 * One neutral-observation sentence per labelled lap (R2-1): heavy braking,
 * ABS-like oscillation and a slide/rotation are stated as facts about the
 * lap, WITH their own measured number when there is one, never as a reason it
 * was excluded -- the lap this describes is clean (or unverified) by
 * definition, and the sentence says so.
 */
function labelSummary(lap: LapInsight, language: ReportLanguage): string | null {
  if (lap.labels.length === 0) return null;
  const ro = language === 'ro';
  const parts = lap.labels.map((label) => {
    const base = LABEL_LABELS[language][label];
    if (label === 'HEAVY_BRAKING' && lap.peakDecelG !== null) {
      return `${base} (${gForce(lap.peakDecelG, language)})`;
    }
    if (label === 'SLIDE_ROTATION' && lap.yawExcessDps !== null) {
      const dps = Math.round(lap.yawExcessDps);
      return ro ? `${base} (${dps} °/s peste traseu)` : `${base} (${dps} deg/s beyond the track)`;
    }
    return base;
  });
  return ro
    ? `Turul ${lap.lapNumber}: ${parts.join(', ')} — condus normal pe circuit.`
    : `Lap ${lap.lapNumber}: ${parts.join(', ')} — normal circuit driving.`;
}

function overviewLines(insights: SessionInsights, language: ReportLanguage): string[] {
  const lines: string[] = [];
  const ro = language === 'ro';
  if (insights.referenceLapNumber !== null && insights.referenceDurationMs !== null) {
    lines.push(
      ro
        ? `Turul de referință este turul ${insights.referenceLapNumber}, în ${lapTime(insights.referenceDurationMs, language)} — toate comparațiile de mai jos sunt față de el.`
        : `Your reference lap is lap ${insights.referenceLapNumber} at ${lapTime(insights.referenceDurationMs, language)} — every comparison below is against it.`,
    );
  } else {
    lines.push(
      ro
        ? 'Nu există niciun tur curat în această sesiune, așa că raportul rămâne la fapte per tur.'
        : 'This session has no clean lap, so the report stays at per-lap facts.',
    );
  }
  const consistency = insights.lapTimeConsistency;
  if (consistency !== null) {
    lines.push(
      ro
        ? `Timpii tăi curați se întind pe ${seconds(consistency.spreadMs, language)} (cel mai bun ${lapTime(consistency.bestMs, language)} în turul ${consistency.bestLapNumber}, cel mai lent ${lapTime(consistency.worstMs, language)} în turul ${consistency.worstLapNumber}) — scor de constanță ${consistency.score}/100 pe ${consistency.lapCount} tururi.`
        : `Your clean lap times span ${seconds(consistency.spreadMs, language)} (best ${lapTime(consistency.bestMs, language)} on lap ${consistency.bestLapNumber}, slowest ${lapTime(consistency.worstMs, language)} on lap ${consistency.worstLapNumber}) — consistency score ${consistency.score}/100 over ${consistency.lapCount} laps.`,
    );
  }
  const anomalous = insights.laps.filter((lap) => lap.status === 'anomalous');
  if (anomalous.length > 0) {
    const why = anomalous.map((lap) => {
      const reasons = lap.reasons.map((reason) => REASON_LABELS[language][reason]).join(', ');
      const listed = reasons.length > 0 ? reasons : ro ? 'motiv nespecificat' : 'unspecified reason';
      return ro ? `turul ${lap.lapNumber}: ${listed}` : `lap ${lap.lapNumber}: ${listed}`;
    });
    lines.push(
      ro
        ? `Tururi excluse din comparații: ${lapList(anomalous.map((lap) => lap.lapNumber), language)} (${why.join('; ')}).`
        : `Laps excluded from the comparisons: ${lapList(anomalous.map((lap) => lap.lapNumber), language)} (${why.join('; ')}).`,
    );
  }
  // An unverified lap is not an anomalous lap: nothing went wrong on it, the
  // data simply cannot prove it was clean. Saying "unspecified reason" would be
  // an invented fault.
  const unverified = insights.laps.filter((lap) => lap.status === 'unverified');
  if (unverified.length > 0) {
    const checks = [...new Set(unverified.flatMap((lap) => lap.unavailableChecks))];
    const coverages = unverified.flatMap((lap) =>
      lap.unavailableChecks.map((check) => lap.checkCoverage[check] ?? 0),
    );
    // "No data" is only true at 0 %: a check that ran over part of the lap
    // (§3) has PARTIAL evidence, and saying "no data" about it would
    // contradict the coverage percentage the limitations section gives for
    // the very same lap.
    const percent = coverages.length > 0 ? Math.round(Math.min(...coverages, 1) * 100) : 0;
    const evidenceRo =
      percent <= 0
        ? `lipsesc datele pentru ${checkNames(checks, language)}`
        : `${checkNames(checks, language)}: date insuficiente (acoperă ${percent} %)`;
    const evidenceEn =
      percent <= 0
        ? `no data for ${checkNames(checks, language)}`
        : `${checkNames(checks, language)}: insufficient data (covers ${percent} %)`;
    lines.push(
      ro
        ? `Tururile ${lapList(unverified.map((lap) => lap.lapNumber), language)} nu au putut fi verificate (${evidenceRo}), așa că nu intră în comparații.`
        : `Laps ${lapList(unverified.map((lap) => lap.lapNumber), language)} could not be verified (${evidenceEn}), so they stay out of the comparisons.`,
    );
  }
  // R2-1: heavy braking / ABS / slide are neutral facts about an otherwise
  // clean (or unverified) lap, never a reason it was excluded -- so this is
  // listed separately from the anomalous/unverified sentences above.
  for (const lap of insights.laps) {
    const line = labelSummary(lap, language);
    if (line !== null) lines.push(line);
  }
  if (insights.availability.available.length > 0) {
    lines.push(
      ro
        ? `Canale folosite: ${channelNames(insights.availability.available, language)}.`
        : `Channels used: ${channelNames(insights.availability.available, language)}.`,
    );
  }
  return lines;
}

function limitationLine(limitation: Limitation, language: ReportLanguage): string {
  const ro = language === 'ro';
  switch (limitation.code) {
    case 'NO_CLEAN_LAPS':
      return ro
        ? 'Niciun tur curat: nu pot compara tururi între ele, doar raporta ce s-a măsurat pe fiecare.'
        : 'No clean lap: laps cannot be compared with each other, only reported one by one.';
    case 'FEW_CLEAN_LAPS':
      return ro
        ? `Doar ${limitation.count ?? 0} tur curat: comparațiile și scorurile de constanță au nevoie de cel puțin 2, așa că raportul rămâne la fapte.`
        : `Only ${limitation.count ?? 0} clean lap: comparisons and consistency scores need at least 2, so the report stays at facts.`;
    case 'UNVERIFIED_LAPS': {
      const laps = limitation.lapNumbers ?? [];
      const one = laps.length === 1;
      const checks = checkNames(limitation.checks ?? [], language);
      const percent = limitation.coveragePercent ?? 0;
      // Evidence that stops after a tenth of the lap is not "no data": the
      // report says how much of the lap it actually covered.
      const evidenceRo =
        percent <= 0
          ? `lipsesc datele pentru ${checks}`
          : `datele pentru ${checks} acoperă doar ${percent} % din tur`;
      const evidenceEn =
        percent <= 0
          ? `there is no data for ${checks}`
          : `the data for ${checks} covers only ${percent} % of the lap`;
      return ro
        ? `${one ? 'Turul' : 'Tururile'} ${lapList(laps, language)} nu ${one ? 'a putut fi verificat' : 'au putut fi verificate'}: ${evidenceRo}, așa că ${one ? 'nu poate fi declarat curat' : 'nu pot fi declarate curate'} și ${one ? 'nu intră' : 'nu intră'} în comparații.`
        : `${one ? 'Lap' : 'Laps'} ${lapList(laps, language)} could not be verified: ${evidenceEn}, so ${one ? 'it cannot be called clean' : 'they cannot be called clean'} and ${one ? 'it stays' : 'they stay'} out of the comparisons.`;
    }
    case 'UNSUPPORTED_CHANNELS':
      return ro
        ? `Mașina/adaptorul nu oferă: ${channelNames(limitation.channels ?? [], language)} — metricile care depind de ele lipsesc.`
        : `Your car/adapter does not provide: ${channelNames(limitation.channels ?? [], language)} — the metrics that need them are absent.`;
    case 'MISSING_CHANNELS':
      return ro
        ? `Nu au fost înregistrate: ${channelNames(limitation.channels ?? [], language)} — s-a folosit estimarea din GPS/IMU acolo unde există.`
        : `Not recorded in this session: ${channelNames(limitation.channels ?? [], language)} — the GPS/IMU estimator was used where one exists.`;
    case 'GNSS_QUALITY': {
      const laps = limitation.lapNumbers ?? [];
      const one = laps.length === 1;
      return ro
        ? `Calitate GPS slabă în ${one ? 'turul' : 'tururile'} ${lapList(laps, language)} — punctele de frânare de acolo sunt aproximative.`
        : `Poor GPS quality on ${one ? 'lap' : 'laps'} ${lapList(laps, language)} — braking points there are approximate.`;
    }
    case 'TIME_INTEGRATION_DRIFT': {
      const laps = limitation.lapNumbers ?? [];
      const one = laps.length === 1;
      const gap = seconds(Math.abs(limitation.driftMs ?? 0), language);
      return ro
        ? `În ${one ? 'turul' : 'tururile'} ${lapList(laps, language)} viteza înregistrată și ceasul nu sunt de acord (${gap} pe tur), așa că timpii pe distanță de acolo sunt la fel de buni ca semnalul de viteză.`
        : `On ${one ? 'lap' : 'laps'} ${lapList(laps, language)} the recorded speed and the clock disagree (${gap} over the lap), so the time-at-distance there is only as good as the speed signal.`;
    }
    case 'GEOMETRY_UNVALIDATED':
      return ro
        ? 'Geometria circuitului nu este validată pe teren, deci pozițiile virajelor (și distanțele față de ele) sunt aproximative.'
        : 'This circuit geometry has not been validated on track, so corner positions (and the distances to them) are approximate.';
    case 'CORNER_COVERAGE': {
      const cornerIds = limitation.cornerIds ?? [];
      const one = cornerIds.length === 1;
      return ro
        ? `${one ? 'Virajul' : 'Virajele'} ${lapList(cornerIds, language)} nu ${one ? 'a fost măsurat' : 'au fost măsurate'} curat în niciun tur.`
        : `${one ? 'Corner' : 'Corners'} ${lapList(cornerIds, language)} ${one ? 'was' : 'were'} not cleanly measured on any lap.`;
    }
    default:
      return '';
  }
}

function timeLossLine(finding: TimeLossFinding, language: ReportLanguage): string | null {
  const ro = language === 'ro';
  const parts: string[] = [];
  if (finding.deltaMs !== null) {
    parts.push(
      ro
        ? `pe turul ${finding.comparisonLapNumber} ${gainOrLoss(finding.deltaMs, language)} față de turul ${finding.referenceLapNumber}`
        : `on lap ${finding.comparisonLapNumber} ${gainOrLoss(finding.deltaMs, language)} against lap ${finding.referenceLapNumber}`,
    );
  }
  if (
    finding.sectorLossMs !== null &&
    finding.bestSectorMs !== null &&
    finding.bestSectorLapNumber !== null &&
    finding.comparisonSectorMs !== null
  ) {
    parts.push(
      finding.sectorLossMs > 0
        ? ro
          ? `ai trecut virajul în ${seconds(finding.comparisonSectorMs, language)}, cu ${seconds(finding.sectorLossMs, language)} mai mult decât cel mai bun al tău (${seconds(finding.bestSectorMs, language)}, turul ${finding.bestSectorLapNumber})`
          : `you took ${seconds(finding.comparisonSectorMs, language)} through it, ${seconds(finding.sectorLossMs, language)} more than your own best (${seconds(finding.bestSectorMs, language)} on lap ${finding.bestSectorLapNumber})`
        : ro
          ? `ai trecut virajul în ${seconds(finding.comparisonSectorMs, language)}, cel mai bun timp al tău prin el`
          : `you took ${seconds(finding.comparisonSectorMs, language)} through it, your own best time there`,
    );
  }
  if (parts.length === 0) return null;
  const causes =
    finding.causes.length === 0
      ? ''
      : ro
        ? ` Acolo ${finding.causes.map((cause) => CAUSE_LABELS.ro[cause]).join(', ')}.`
        : ` There ${finding.causes.map((cause) => CAUSE_LABELS.en[cause]).join(', ')}.`;
  const prefix = ro ? `Virajul ${finding.cornerId}` : `Corner ${finding.cornerId}`;
  return `${prefix}: ${parts.join('; ')}.${causes}`;
}

function brakeLine(corner: CornerInsight, row: CornerLapRow, language: ReportLanguage): string | null {
  const ro = language === 'ro';
  const parts: string[] = [];
  if (row.brakeStartM !== null) {
    const source = row.brakeSource === null ? '' : ` (${BRAKE_SOURCE_LABELS[language][row.brakeSource]})`;
    // P4l-FIX4 N3 (binding): a brake SWITCH sampled at 1-5 Hz can only place
    // the onset to within one sampling interval. The report says so rather
    // than printing a metre reading it cannot support.
    const band =
      row.brakeOnsetUncertaintyM === null ? '' : ` ±${metres(row.brakeOnsetUncertaintyM, language)}`;
    parts.push(
      ro
        ? `ai frânat cu ${metres(row.brakeStartM, language)}${band} înainte de intrare${source}`
        : `you braked ${metres(row.brakeStartM, language)}${band} before the entry${source}`,
    );
  }
  // With no pedal channel the lift and the braking onset are the same
  // measurement; saying it twice would pretend there are two facts.
  const liftIsBrakeOnset =
    row.liftSource === 'decelOnset' && row.liftPointM !== null && row.liftPointM === row.brakeStartM;
  if (row.liftPointM !== null && !liftIsBrakeOnset) {
    const source = row.liftSource === null ? '' : ` (${LIFT_SOURCE_LABELS[language][row.liftSource]})`;
    parts.push(
      ro
        ? `ai ridicat piciorul cu ${metres(row.liftPointM, language)} înainte${source}`
        : `you lifted ${metres(row.liftPointM, language)} before it${source}`,
    );
  }
  if (row.peakDecelG !== null) {
    parts.push(
      ro ? `frânare maximă ${gForce(row.peakDecelG, language)}` : `peak braking ${gForce(row.peakDecelG, language)}`,
    );
  }
  if (row.minSpeedKph !== null) {
    parts.push(
      ro ? `viteză minimă ${kph(row.minSpeedKph, language)}` : `minimum speed ${kph(row.minSpeedKph, language)}`,
    );
  }
  if (row.exitSpeedKph !== null) {
    parts.push(
      ro ? `ieșire ${kph(row.exitSpeedKph, language)}` : `exit ${kph(row.exitSpeedKph, language)}`,
    );
  }
  if (row.maxLatG !== null) {
    parts.push(ro ? `${gForce(row.maxLatG, language)} lateral` : `${gForce(row.maxLatG, language)} lateral`);
  }
  if (parts.length === 0) {
    return ro
      ? `Turul ${row.lapNumber}: virajul ${corner.cornerId} nu a fost măsurat (date insuficiente).`
      : `Lap ${row.lapNumber}: corner ${corner.cornerId} was not measured (not enough data).`;
  }
  const flag = row.clean ? '' : ro ? ' [tur necurat]' : ' [anomalous lap]';
  return ro
    ? `Turul ${row.lapNumber}${flag}: ${parts.join(', ')}.`
    : `Lap ${row.lapNumber}${flag}: ${parts.join(', ')}.`;
}

function envelopeLine(corner: CornerInsight, language: ReportLanguage): string | null {
  const envelope = corner.envelope;
  if (envelope === null || envelope.evidenceLapIds.length === 0) return null;
  const ro = language === 'ro';
  const parts: string[] = [];
  if (envelope.latestBrakeStartM !== null && envelope.latestBrakeStartLapNumber !== null) {
    parts.push(
      ro
        ? `cel mai târziu ai frânat la ${metres(envelope.latestBrakeStartM, language)} (turul ${envelope.latestBrakeStartLapNumber})`
        : `your latest braking point is ${metres(envelope.latestBrakeStartM, language)} (lap ${envelope.latestBrakeStartLapNumber})`,
    );
  }
  if (envelope.highestMinSpeedKph !== null && envelope.highestMinSpeedLapNumber !== null) {
    parts.push(
      ro
        ? `cea mai mare viteză minimă dusă prin viraj este ${kph(envelope.highestMinSpeedKph, language)} (turul ${envelope.highestMinSpeedLapNumber})`
        : `the highest minimum speed you have carried is ${kph(envelope.highestMinSpeedKph, language)} (lap ${envelope.highestMinSpeedLapNumber})`,
    );
  }
  if (envelope.earliestLiftM !== null && envelope.earliestLiftLapNumber !== null) {
    parts.push(
      ro
        ? `cel mai devreme ai ridicat piciorul la ${metres(envelope.earliestLiftM, language)} (turul ${envelope.earliestLiftLapNumber})`
        : `your earliest lift is ${metres(envelope.earliestLiftM, language)} (lap ${envelope.earliestLiftLapNumber})`,
    );
  }
  if (parts.length === 0) return null;
  return ro
    ? `Din tururile tale curate (${lapList(envelope.evidenceLapIds, language)}): ${parts.join('; ')}.`
    : `From your own clean laps (${lapList(envelope.evidenceLapIds, language)}): ${parts.join('; ')}.`;
}

function consistencyLine(corner: CornerInsight, language: ReportLanguage): string | null {
  const consistency = corner.consistency;
  if (consistency === null || consistency.score === null) return null;
  const ro = language === 'ro';
  const parts: string[] = [];
  if (consistency.brakeSpreadM !== null) {
    parts.push(
      ro
        ? `punctul de frânare variază cu ${metres(consistency.brakeSpreadM, language)}`
        : `your braking point varies by ${metres(consistency.brakeSpreadM, language)}`,
    );
  }
  if (consistency.minSpeedSpreadKph !== null) {
    parts.push(
      ro
        ? `viteza minimă cu ${kph(consistency.minSpeedSpreadKph, language)}`
        : `minimum speed by ${kph(consistency.minSpeedSpreadKph, language)}`,
    );
  }
  if (consistency.sectorSpreadMs !== null) {
    parts.push(
      ro
        ? `timpul prin viraj cu ${seconds(consistency.sectorSpreadMs, language)}`
        : `corner time by ${seconds(consistency.sectorSpreadMs, language)}`,
    );
  }
  const detail = parts.length === 0 ? '' : `${parts.join(', ')} — `;
  return ro
    ? `Constanță pe ${consistency.lapCount} tururi curate: ${detail}scor ${consistency.score}/100.`
    : `Consistency over ${consistency.lapCount} clean laps: ${detail}score ${consistency.score}/100.`;
}

function cornerSection(
  corner: CornerInsight,
  language: ReportLanguage,
  insights: SessionInsights,
): ReportSection {
  const ro = language === 'ro';
  const vocabulary = TEXT[language];
  const lines: string[] = [];
  lines.push(
    ro
      ? `Poziție pe tur: intrare la ${metres(corner.entryDistanceM, language)}, apex la ${metres(corner.apexDistanceM, language)}, ieșire la ${metres(corner.exitDistanceM, language)} de la linia de start/finish.`
      : `Position on the lap: entry at ${metres(corner.entryDistanceM, language)}, apex at ${metres(corner.apexDistanceM, language)}, exit at ${metres(corner.exitDistanceM, language)} from the start/finish line.`,
  );
  if (corner.bestSectorMs !== null && corner.bestSectorLapNumber !== null) {
    const worst =
      corner.worstSectorMs !== null && corner.worstSectorLapNumber !== null
        ? ro
          ? `, cel mai lent ${seconds(corner.worstSectorMs, language)} în turul ${corner.worstSectorLapNumber}`
          : `, slowest ${seconds(corner.worstSectorMs, language)} on lap ${corner.worstSectorLapNumber}`
        : '';
    lines.push(
      ro
        ? `Cel mai bun timp prin viraj: ${seconds(corner.bestSectorMs, language)} în turul ${corner.bestSectorLapNumber}${worst}.`
        : `Best time through the corner: ${seconds(corner.bestSectorMs, language)} on lap ${corner.bestSectorLapNumber}${worst}.`,
    );
  }
  for (const row of corner.perLap) {
    const line = brakeLine(corner, row, language);
    if (line !== null) lines.push(line);
  }
  const envelope = envelopeLine(corner, language);
  if (envelope !== null) lines.push(envelope);
  const consistency = consistencyLine(corner, language);
  if (consistency !== null) lines.push(consistency);
  if (corner.timeLoss !== null) {
    const loss = timeLossLine(corner.timeLoss, language);
    if (loss !== null) lines.push(loss);
  }
  if (!insights.geometryValidated) {
    lines.push(
      ro
        ? 'Geometria acestui viraj vine din hartă, nevalidată pe teren — distanțele sunt aproximative.'
        : 'This corner geometry comes from the map and is not field-validated — the distances are approximate.',
    );
  }
  return {
    id: `corner-${corner.cornerId}`,
    heading: vocabulary.cornerHeading(corner.cornerId, vocabulary.directions[corner.direction]),
    lines,
  };
}

/** Builds the report as structured sections (the mobile screen renders these). */
export function buildReport(insights: SessionInsights, language: ReportLanguage): CoachReport {
  if (language !== 'ro' && language !== 'en') {
    throw new RangeError(`unsupported report language: ${String(language)}`);
  }
  const vocabulary = TEXT[language];
  const ro = language === 'ro';
  const circuit = insights.circuitName ?? insights.circuitId;
  const sections: ReportSection[] = [];

  sections.push({
    id: 'overview',
    heading: vocabulary.headings.overview ?? 'Overview',
    lines: overviewLines(insights, language),
  });

  if (insights.limitations.length > 0) {
    sections.push({
      id: 'limitations',
      heading: vocabulary.headings.limitations ?? 'Limitations',
      lines: insights.limitations
        .map((limitation) => limitationLine(limitation, language))
        .filter((line) => line.length > 0),
    });
  }

  const ranked = insights.timeLossRanking
    .slice(0, RANKED_LIMIT)
    .map((finding) => timeLossLine(finding, language))
    .filter((line): line is string => line !== null);
  if (ranked.length > 0) {
    sections.push({
      id: 'time-loss',
      heading: vocabulary.headings.timeLoss ?? 'Time loss',
      lines: ranked,
    });
  }

  const consistencyLines = insights.consistencyRanking
    .slice(0, RANKED_LIMIT)
    .map((finding) => {
      const corner = insights.corners.find((entry) => entry.cornerId === finding.cornerId);
      const line = corner === undefined ? null : consistencyLine(corner, language);
      if (line === null) return null;
      return ro ? `Virajul ${finding.cornerId}: ${line}` : `Corner ${finding.cornerId}: ${line}`;
    })
    .filter((line): line is string => line !== null);
  if (consistencyLines.length > 0) {
    sections.push({
      id: 'consistency',
      heading: vocabulary.headings.consistency ?? 'Consistency',
      lines: consistencyLines,
    });
  }

  if (insights.sectorTimeLoss.length > 0) {
    sections.push({
      id: 'sectors',
      heading: vocabulary.headings.sectors ?? 'Sectors',
      lines: insights.sectorTimeLoss.map((sector) =>
        ro
          ? `Sectorul ${sector.sectorIndex + 1}: pe turul ${sector.comparisonLapNumber} ai făcut ${seconds(sector.comparisonMs, language)}, față de ${seconds(sector.referenceMs, language)} pe turul de referință ${sector.referenceLapNumber} — ${gainOrLoss(sector.lostMs, language)}.`
          : `Sector ${sector.sectorIndex + 1}: on lap ${sector.comparisonLapNumber} you did ${seconds(sector.comparisonMs, language)} against ${seconds(sector.referenceMs, language)} on reference lap ${sector.referenceLapNumber} — ${gainOrLoss(sector.lostMs, language)}.`,
      ),
    });
  }

  for (const corner of insights.corners) {
    sections.push(cornerSection(corner, language, insights));
  }

  const title = vocabulary.title;
  const subtitle = vocabulary.subtitle(circuit, insights.lapCount, insights.cleanLapCount);
  const disclaimer = vocabulary.disclaimer;
  const text = [
    title,
    subtitle,
    '',
    ...sections.flatMap((section) => [section.heading, ...section.lines, '']),
    disclaimer,
  ].join('\n');

  return { language, title, subtitle, sections, disclaimer, text };
}

/** The whole report as plain text, in the requested language. */
export function renderReport(insights: SessionInsights, language: ReportLanguage): string {
  return buildReport(insights, language).text;
}

// ---------------------------------------------------------------------------
// Suggestion text (ticket P5c-B D1, contracts.md R2-3)
// ---------------------------------------------------------------------------

/**
 * The ONLY sentences in this engine that name a change of driving, and they
 * are bounded by construction: `computeSuggestions` never produces a target
 * past what a clean lap of the same outing demonstrated, so every sentence
 * below cites the driver's own lap as its evidence (safety-contract rule 6).
 * The observation half of the report is unchanged and stays observations-only.
 */
const SUGGESTION_TEXT: Record<
  ReportLanguage,
  {
    corner: (id: number) => string;
    brakeLater: (typical: string, target: string, demonstrated: string, lap: number) => string;
    liftLater: (typical: string, target: string, demonstrated: string, lap: number) => string;
    carryMoreMinSpeed: (typical: string, target: string, demonstrated: string, lap: number) => string;
    cueUpdate: (
      point: string,
      moved: string,
      from: string,
      to: string,
      demonstrated: string,
      lap: number,
    ) => string;
    cuePoints: Record<CuePoint, string>;
  }
> = {
  ro: {
    corner: (id) => `Virajul ${id}`,
    brakeLater: (typical, target, demonstrated, lap) =>
      `frânează mai târziu: de obicei frânezi la ${typical} înainte de viraj, iar în turul ${lap} ai frânat deja la ${demonstrated} — țintește ${target}.`,
    liftLater: (typical, target, demonstrated, lap) =>
      `ridică piciorul mai târziu: de obicei ridici la ${typical} înainte de viraj, iar în turul ${lap} ai ridicat la ${demonstrated} — țintește ${target}.`,
    carryMoreMinSpeed: (typical, target, demonstrated, lap) =>
      `du mai multă viteză prin viraj: de obicei cobori la ${typical}, iar în turul ${lap} ai trecut cu ${demonstrated} — țintește ${target}.`,
    cueUpdate: (point, moved, from, to, demonstrated, lap) =>
      `${point} s-a mutat cu ${moved} mai târziu, de la ${from} la ${to} înainte de viraj, pentru că în turul ${lap} ai făcut ${demonstrated}.`,
    cuePoints: { brake: 'Reperul de frânare', lift: 'Reperul de ridicat piciorul' },
  },
  en: {
    corner: (id) => `Corner ${id}`,
    brakeLater: (typical, target, demonstrated, lap) =>
      `brake later: you usually brake ${typical} before the corner, and on lap ${lap} you already braked at ${demonstrated} — aim for ${target}.`,
    liftLater: (typical, target, demonstrated, lap) =>
      `lift later: you usually lift ${typical} before the corner, and on lap ${lap} you lifted at ${demonstrated} — aim for ${target}.`,
    carryMoreMinSpeed: (typical, target, demonstrated, lap) =>
      `carry more speed through the corner: you usually drop to ${typical}, and on lap ${lap} you carried ${demonstrated} — aim for ${target}.`,
    cueUpdate: (point, moved, from, to, demonstrated, lap) =>
      `${point} moved ${moved} later, from ${from} to ${to} before the corner, because on lap ${lap} you did ${demonstrated}.`,
    cuePoints: { brake: 'The brake cue', lift: 'The lift cue' },
  },
};

/**
 * One pit suggestion as a sentence, with its numbers and the lap that proves
 * it. Never rendered while driving (R2-3a) and never for a suggestion the
 * engine did not generate — this function only formats what it is given.
 */
export function pitSuggestionLine(suggestion: PitSuggestion, language: ReportLanguage): string {
  const vocabulary = SUGGESTION_TEXT[language];
  const format = (value: number): string =>
    suggestion.unit === 'm' ? metres(value, language) : kph(value, language);
  const typical = format(suggestion.typicalValue);
  const target = format(suggestion.targetValue);
  const demonstrated = format(suggestion.demonstratedValue);
  const body =
    suggestion.kind === 'brakeLater'
      ? vocabulary.brakeLater(typical, target, demonstrated, suggestion.evidenceLapNumber)
      : suggestion.kind === 'liftLater'
        ? vocabulary.liftLater(typical, target, demonstrated, suggestion.evidenceLapNumber)
        : vocabulary.carryMoreMinSpeed(
            typical,
            target,
            demonstrated,
            suggestion.evidenceLapNumber,
          );
  return `${vocabulary.corner(suggestion.cornerId)} — ${body}`;
}

/**
 * One APPLIED cue move, with before, after and the demonstrating lap — the
 * line the pit view and the exported report use to state what the app changed
 * on the driver's behalf (R2-3a: the change is never silent).
 */
export function cueUpdateLine(update: CueUpdate, language: ReportLanguage): string {
  const vocabulary = SUGGESTION_TEXT[language];
  return `${vocabulary.corner(update.cornerId)} — ${vocabulary.cueUpdate(
    vocabulary.cuePoints[update.point],
    metres(update.movedLaterM, language),
    metres(update.fromM, language),
    metres(update.toM, language),
    metres(update.demonstratedM, language),
    update.evidenceLapNumber,
  )}`;
}
