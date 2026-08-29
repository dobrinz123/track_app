/**
 * Signal Finder — target definitions (contracts.md "Signal Finder (Phase 4l,
 * 2026-08-29)", item 1, binding).
 *
 * User motivation (field tests 1–4): "the range-based DID sweep + generic
 * phases wasted fuel and time; I want a tool that HAS TARGETS: find the brake
 * → reads the channels we think carry the brake → tells me to press the brake
 * 5 times → shows the candidates that changed → brake found; then the next
 * missing signal."
 *
 * Item 1 (binding): "Targets are data ... never UI constants: `brakeSwitch`,
 * `brakePressure`, `steeringAngle`, `accelPedal`, `longG`, `latG`. Each target
 * declares `engineRequirement` (`off-ok` | `running`), `actionScript`
 * (metronome), `expectedShape` (`boolean-edge` | `analog-monotone` |
 * `analog-bipolar`), and `sources`: hypothesis DIDs per ECU (with provenance)
 * + `discoveryRanges` per ECU (used ONLY when the user asks for the next step,
 * with the minutes shown)."
 *
 * EVERYTHING vehicle-specific in this file lives inside
 * {@link SIGNAL_TARGET_CATALOGS} — a keyed DATA registry, mirroring
 * `data/vehicle-profiles/*.json` — and is reachable only through
 * {@link resolveSignalTargetCatalog}. No other module in this package (and no
 * UI) may hard-code an ECU address, a DID or a decode: an unknown car resolves
 * to {@link GENERIC_SIGNAL_TARGET_CATALOG}, which is hypothesis-free by
 * construction. Pure/deterministic — no I/O.
 */

export const SIGNAL_TARGET_IDS = [
  'brakeSwitch',
  'brakePressure',
  'steeringAngle',
  'accelPedal',
  'longG',
  'latG',
] as const;

export type SignalTargetId = (typeof SIGNAL_TARGET_IDS)[number];

/** `off-ok`: the signal can be produced with the engine off (ignition on). `running`: it physically cannot (the car must be moving / the engine turning). */
export type SignalEngineRequirement = 'off-ok' | 'running';

/**
 * How the target's raw value is expected to behave under the metronome:
 *  - `boolean-edge`   — a switch: one rest level, one actuated level;
 *  - `analog-monotone` — rises while actuated, returns to rest (pressure, pedal);
 *  - `analog-bipolar`  — swings BOTH ways around rest (steering angle, lateral g).
 */
export type SignalExpectedShape = 'boolean-edge' | 'analog-monotone' | 'analog-bipolar';

/** The metronome's own timing, per target (item 3: "brake = 5 × {press 2 s, release 2 s}"). */
export interface SignalActionScript {
  /** Press/release cycles the driver is paced through. */
  repetitions: number;
  /** The reference window before the first press ("hold still"). */
  baselineMs: number;
  pressMs: number;
  /** 0 to omit the hold step entirely. */
  holdMs: number;
  releaseMs: number;
  /**
   * P4k settle, carried into the metronome: how long after a prompt flips a
   * sample still reflects the PREVIOUS step (human reaction + adapter
   * round-trip). See `metronome.ts` for why this SHIFTS every evidence
   * window rather than discarding the samples inside it.
   */
  settleMs: number;
}

/** The two languages the app's own setting offers (`settingsStore.ts`'s `AppLanguage`). */
export type SignalLanguage = 'en' | 'ro';

/** The words the screen shows for each metronome step — per target, so nothing generic ever hard-codes "brake". */
export interface SignalActionVerbs {
  baseline: string;
  press: string;
  hold: string;
  release: string;
}

/**
 * P4m M4 (binding): the driver reads the prompt while looking at the pedal,
 * so it must be in HIS language — the metronome's words are data, per target,
 * in every supported language ({@link resolveSignalActionVerbs}). Nothing
 * about the run itself differs between languages.
 */
export type SignalActionVerbSet = Readonly<Record<SignalLanguage, SignalActionVerbs>>;

/** Status vocabulary is IDENTICAL to `data/vehicle-profiles/*.json`'s own `status` field, so a hypothesis can be copied in either direction without translation. */
export type SignalHypothesisStatus = 'hypothesis' | 'weak' | 'field-observed' | 'field-confirmed';

export interface SignalTargetHypothesis {
  /** ECU (HSFZ target) address, e.g. `0x12` (DME) or `0x29`. */
  ecu: number;
  did: number;
  /** Expected response length in bytes, or `null` when unknown. */
  length: number | null;
  /** Human-readable decode guess (never executable code — the confirmation step writes the real binding). */
  decode: string;
  status: SignalHypothesisStatus;
  /**
   * P4m-FIX1 X6 (binding, Codex P4m-REV1 finding 7): what THIS DID's raw
   * value looks like, when that differs from the target's own shape — DME
   * 0x4007 is a boolean FLAG inside a word (bit0 clears while the accelerator
   * is pressed) under an `analog-monotone` target. The scorer waives the
   * analog direction rule for a DECLARED flag; without this declaration a
   * two-level series must earn that waiver from dense, agreeing evidence, so
   * an LSB counter can no longer alternate its way to `found`. Omitted = the
   * target's own `expectedShape` applies.
   */
  expectedShape?: SignalExpectedShape;
  /** REQUIRED: where this hypothesis came from. No public DID table exists; every entry is a citation or a field observation. */
  provenance: string;
}

/** A range to sweep when nothing was found — item 4: "the next concrete step with its duration". */
export interface SignalDiscoveryRange {
  /** `null` means "every ECU that answered" (the generic, no-profile case). */
  ecu: number | null;
  fromDid: number;
  toDid: number;
  /** English note — the stable one the JSON export carries. */
  note: string;
  /** P4m-FIX1 X8: the same note per language; the driver reads it on the result screen ("Next step: ..."). Resolved only through {@link resolveDiscoveryRangeNote}. */
  notes?: Readonly<Record<SignalLanguage, string>>;
}

export interface SignalTargetDefinition {
  id: SignalTargetId;
  /** English label — also the stable name the export carries. */
  label: string;
  /** P4m-FIX1 X8: the label per language. The UI reads it only through {@link resolveSignalTargetLabel}. */
  labels?: Readonly<Record<SignalLanguage, string>>;
  engineRequirement: SignalEngineRequirement;
  expectedShape: SignalExpectedShape;
  actionScript: SignalActionScript;
  /** Per language (P4m M4) — the screen resolves them with resolveSignalActionVerbs. */
  verbs: SignalActionVerbSet;
  /** Hypothesis DIDs per ECU, with provenance. ALWAYS `[]` in the generic catalog. */
  hypotheses: readonly SignalTargetHypothesis[];
  /** Used ONLY to answer "what's the next step?" — never polled during a find. */
  discoveryRanges: readonly SignalDiscoveryRange[];
}

export interface SignalTargetCatalog {
  /** Matches `data/vehicle-profiles/<profileId>.json`'s own `profileId`; `'generic'` for the no-profile catalog. */
  profileId: string;
  label: string;
  targets: readonly SignalTargetDefinition[];
}

// ---------------------------------------------------------------------------
// Generic (unknown car) — hypothesis-free by construction.
// ---------------------------------------------------------------------------

/**
 * P4m (contracts.md item 9, binding, after field test 5 — the user: "inhuman
 * to press that many times"): "A Find = exactly one human-paced script:
 * baseline 3 s, then `repetitions` (default 3, max 5) × {press 3 s,
 * release 3 s} ≈ 21 s."
 *
 * The 3 s windows are what make the DID budget (`plan.ts`) meaningful — three
 * samples per DID per window at the field-measured ~15 req/s — and 3
 * repetitions is what a human will actually do properly. The COUNT of DIDs
 * bends to the adapter's rate now; the driver's script never does.
 */
const PEDAL_SCRIPT: SignalActionScript = {
  repetitions: 3,
  baselineMs: 3_000,
  pressMs: 3_000,
  holdMs: 0,
  releaseMs: 3_000,
  settleMs: 500,
};

/** Same one-script rule; a wheel simply needs a longer settle than a pedal (a hand moves later than a foot, and the EPS reports later still). */
const STEERING_SCRIPT: SignalActionScript = {
  repetitions: 3,
  baselineMs: 3_000,
  pressMs: 3_000,
  holdMs: 0,
  releaseMs: 3_000,
  settleMs: 700,
};

/**
 * ISO 14229-1 Annex C: `0x0100–0xA5FF` and `0xA800–0xACFF` (plus the
 * `0xB000–0xB1FF`/`0xC000–0xC2FF` system-supplier windows) are
 * vehicle-manufacturer-specific data identifiers — the only place a
 * non-standard physical channel can live on ANY car. This is what "discovery
 * ranges only" means for a vehicle nobody has profiled yet: a standards-based
 * range, never a guessed DID.
 */
/** P4m-FIX1 X8: one range literal, both languages — so no caller can build a range that only speaks English. */
function range(ecu: number | null, fromDid: number, toDid: number, en: string, ro: string): SignalDiscoveryRange {
  return { ecu, fromDid, toDid, note: en, notes: { en, ro } };
}

const GENERIC_DISCOVERY_RANGES: readonly SignalDiscoveryRange[] = [
  range(
    null,
    0x0100,
    0xa5ff,
    'ISO 14229-1 Annex C vehicleManufacturerSpecific DID range — sweep every ECU that answered',
    'interval de DID-uri specifice producătorului (ISO 14229-1 Anexa C) — scanează fiecare ECU care a răspuns',
  ),
  range(
    null,
    0xa800,
    0xacff,
    'ISO 14229-1 Annex C vehicleManufacturerSpecific DID range (upper window)',
    'interval de DID-uri specifice producătorului (ISO 14229-1 Anexa C, fereastra superioară)',
  ),
];

/**
 * P4m-FIX1 X8 (Codex P4m-REV1 finding 9): the target's own NAME is something
 * the driver reads on the result screen, so it is data in both languages —
 * shared by every catalog, because "Brake switch" is not vehicle-specific.
 */
const TARGET_LABELS: Readonly<Record<SignalTargetId, Readonly<Record<SignalLanguage, string>>>> = {
  brakeSwitch: { en: 'Brake switch', ro: 'Contact de frână' },
  brakePressure: { en: 'Brake pressure', ro: 'Presiune de frânare' },
  steeringAngle: { en: 'Steering angle', ro: 'Unghi volan' },
  accelPedal: { en: 'Accelerator pedal', ro: 'Pedală de accelerație' },
  longG: { en: 'Longitudinal acceleration', ro: 'Accelerație longitudinală' },
  latG: { en: 'Lateral acceleration', ro: 'Accelerație laterală' },
};

function genericTarget(
  id: SignalTargetId,
  label: string,
  engineRequirement: SignalEngineRequirement,
  expectedShape: SignalExpectedShape,
  actionScript: SignalActionScript,
  verbs: SignalActionVerbSet,
): SignalTargetDefinition {
  return {
    id,
    label,
    labels: TARGET_LABELS[id],
    engineRequirement,
    expectedShape,
    actionScript,
    verbs,
    hypotheses: [],
    discoveryRanges: GENERIC_DISCOVERY_RANGES,
  };
}

const BRAKE_VERBS: SignalActionVerbSet = {
  en: {
    baseline: 'Hold still — foot OFF the brake',
    press: 'PRESS the brake',
    hold: 'HOLD it',
    release: 'RELEASE the brake',
  },
  ro: {
    baseline: 'Stai liniștit — piciorul LUAT de pe frână',
    press: 'APASĂ frâna',
    hold: 'ȚINE apăsat',
    release: 'ELIBEREAZĂ frâna',
  },
};

const STEERING_VERBS: SignalActionVerbSet = {
  en: {
    baseline: 'Hold still — wheel centred',
    press: 'TURN the wheel (left, then right)',
    hold: 'HOLD',
    release: 'RETURN to centre',
  },
  ro: {
    baseline: 'Stai liniștit — volanul pe centru',
    press: 'ROTEȘTE volanul (stânga, apoi dreapta)',
    hold: 'ȚINE',
    release: 'ÎNAPOI pe centru',
  },
};

const THROTTLE_VERBS: SignalActionVerbSet = {
  en: {
    baseline: 'Hold still — foot OFF the throttle',
    press: 'PRESS the throttle',
    hold: 'HOLD it',
    release: 'RELEASE the throttle',
  },
  ro: {
    baseline: 'Stai liniștit — piciorul LUAT de pe accelerație',
    press: 'APASĂ accelerația',
    hold: 'ȚINE apăsat',
    release: 'ELIBEREAZĂ accelerația',
  },
};

const LONG_G_VERBS: SignalActionVerbSet = {
  en: {
    baseline: 'Hold still — car stationary',
    press: 'ACCELERATE, then brake',
    hold: 'HOLD',
    release: 'COAST — let it settle',
  },
  ro: {
    baseline: 'Stai liniștit — mașina oprită',
    press: 'ACCELEREAZĂ, apoi frânează',
    hold: 'ȚINE',
    release: 'RULEAZĂ liber — lasă să se stabilizeze',
  },
};

const LAT_G_VERBS: SignalActionVerbSet = {
  en: {
    baseline: 'Hold still — straight ahead',
    press: 'TURN (a steady circle)',
    hold: 'HOLD the turn',
    release: 'STRAIGHTEN up',
  },
  ro: {
    baseline: 'Stai liniștit — drept înainte',
    press: 'VIREAZĂ (un cerc constant)',
    hold: 'ȚINE virajul',
    release: 'ÎNDREAPTĂ volanul',
  },
};

export const GENERIC_SIGNAL_TARGET_CATALOG: SignalTargetCatalog = {
  profileId: 'generic',
  label: 'Unknown vehicle (no profile)',
  targets: [
    genericTarget('brakeSwitch', 'Brake switch', 'off-ok', 'boolean-edge', PEDAL_SCRIPT, BRAKE_VERBS),
    genericTarget('brakePressure', 'Brake pressure', 'off-ok', 'analog-monotone', PEDAL_SCRIPT, BRAKE_VERBS),
    genericTarget('steeringAngle', 'Steering angle', 'off-ok', 'analog-bipolar', STEERING_SCRIPT, STEERING_VERBS),
    genericTarget('accelPedal', 'Accelerator pedal', 'off-ok', 'analog-monotone', PEDAL_SCRIPT, THROTTLE_VERBS),
    genericTarget('longG', 'Longitudinal acceleration', 'running', 'analog-bipolar', PEDAL_SCRIPT, LONG_G_VERBS),
    genericTarget('latG', 'Lateral acceleration', 'running', 'analog-bipolar', STEERING_SCRIPT, LAT_G_VERBS),
  ],
};

// ---------------------------------------------------------------------------
// Vehicle catalogs — DATA, copied from `data/vehicle-profiles/*.json` with the
// profile's own provenance strings. Nothing here is referenced by name from
// generic code; the registry below is the only way in.
// ---------------------------------------------------------------------------

/** `data/vehicle-profiles/toyota-supra-b58.draft.json` (2026-08-29 draft). Every `provenance` below is that file's own. */
const SUPRA_B58_CATALOG: SignalTargetCatalog = {
  profileId: 'toyota-supra-b58',
  label: 'Toyota GR Supra (A90/J29), BMW B58',
  targets: [
    {
      id: 'brakeSwitch',
      label: 'Brake switch',
      labels: TARGET_LABELS.brakeSwitch,
      engineRequirement: 'off-ok',
      expectedShape: 'boolean-edge',
      actionScript: PEDAL_SCRIPT,
      verbs: BRAKE_VERBS,
      hypotheses: [
        {
          // FIELD TEST 5 (2026-08-29, engine off / ignition on): the DME's own
          // brake pedal. Read 22 times across the run, 0x01 in every baseline
          // and release window, 0x19 in EVERY press window, 0 baseline
          // changes, 0 extra transitions — and flat 0x01 through the whole
          // accelerator run of the same evening. First because it is on the
          // DME (0x12), the ECU everything else is already read from: no
          // second address is needed to get a brake signal at all.
          ecu: 0x12,
          did: 0x4002,
          length: 1,
          decode: 'boolean: 0x01 at rest → 0x19 while the brake pedal is pressed',
          status: 'field-observed',
          provenance:
            'field test 5 2026-08-29 (Signal Finder, engine off, ignition on): data/field/signal-finder/2026-08-29-brakeSwitch.json — 0x01→0x19 in all 5 press windows, 0x01 in all release windows; flat 0x01 in 2026-08-29-accelPedal.json',
        },
        {
          ecu: 0x29,
          did: 0x500c,
          length: 1,
          decode: 'bit0 (0x04 released → 0x05 pressed)',
          status: 'field-observed',
          provenance:
            'test 4 2026-08-29 (engine off, ignition on, batched observation 5 samples/phase): 0x04 in baseline/throttle, 0x05 in 3/5 brake-phase samples; 2026-08-29-test4-ecu29-0x5000-0x58F2.json',
        },
        {
          ecu: 0x29,
          did: 0x500b,
          length: 2,
          decode: 'bitfield; 0x0002 at rest, 0x0006 (bit2) seen once during the brake phase',
          status: 'weak',
          provenance:
            'test 4 2026-08-29: single 0x0006 sample out of 5 in the brake phase, never elsewhere — plausible "firm press" / brake-light bit',
        },
      ],
      discoveryRanges: [
        range(0x29, 0x58f3, 0x6fff, 'the part of 0x29 test 4 stopped short of', 'partea din 0x29 la care testul 4 nu a ajuns'),
      ],
    },
    {
      id: 'brakePressure',
      label: 'Brake pressure',
      labels: TARGET_LABELS.brakePressure,
      // Field fact (user, 2026-08-29): with the engine off the booster has no
      // vacuum and hydraulic pressure barely builds -- pressure DIDs are only
      // testable with the engine running.
      engineRequirement: 'running',
      expectedShape: 'analog-monotone',
      actionScript: PEDAL_SCRIPT,
      verbs: BRAKE_VERBS,
      hypotheses: [
        {
          ecu: 0x12,
          did: 0x4a1d,
          length: 2,
          decode: 'u16 * 5 / 1024 V',
          status: 'hypothesis',
          provenance:
            'https://thesecretingredient.neocities.org/bmw/dme/b58 ("Brake booster pressure sensor voltage", fetched 2026-08-29); field sweep: answers, 0x0000 at idle',
        },
        {
          ecu: 0x12,
          did: 0x5892,
          length: 2,
          decode: 'i16 * 10 / 256 hPa',
          status: 'hypothesis',
          provenance:
            'same page ("Difference between ambient pressure and brake booster pressure"); test 4 sweep: answers 0x0000 (engine off)',
        },
        {
          ecu: 0x12,
          did: 0x58b7,
          length: 1,
          decode: 'u8 hPa (as listed; coarse — verify)',
          status: 'hypothesis',
          provenance: 'same page ("Current brake pressure"); test 4 sweep: answers 0x00 (engine off)',
        },
      ],
      discoveryRanges: [
        range(0x12, 0x6000, 0x6fff, 'DME range beyond the 0x5000–0x5FFF test 4 covered', 'interval DME dincolo de 0x5000–0x5FFF, acoperit de testul 4'),
      ],
    },
    {
      id: 'steeringAngle',
      label: 'Steering angle',
      labels: TARGET_LABELS.steeringAngle,
      // Field fact (user, 2026-08-29): the EPS is unpowered with the engine
      // off -- the wheel cannot be turned, so steering needs the engine running.
      engineRequirement: 'running',
      expectedShape: 'analog-bipolar',
      actionScript: STEERING_SCRIPT,
      verbs: STEERING_VERBS,
      hypotheses: [],
      discoveryRanges: [
        range(
          0x29,
          0x58f3,
          0x6fff,
          'test 4 stopped at 0x58F2; 0x29 is the only ECU that carried a confirmed brake bit',
          'testul 4 s-a oprit la 0x58F2; 0x29 este singurul ECU cu un bit de frână confirmat',
        ),
        range(0x30, 0x4000, 0x5fff, 'EPS candidate address (public sources, unverified for J29)', 'adresă candidată EPS (surse publice, neverificată pentru J29)'),
        range(0x65, 0x4000, 0x5fff, 'SZL/steering-column candidate address (public sources, unverified)', 'adresă candidată SZL/coloană de direcție (surse publice, neverificată)'),
      ],
    },
    {
      id: 'accelPedal',
      label: 'Accelerator pedal',
      labels: TARGET_LABELS.accelPedal,
      engineRequirement: 'off-ok',
      expectedShape: 'analog-monotone',
      actionScript: PEDAL_SCRIPT,
      verbs: THROTTLE_VERBS,
      hypotheses: [
        {
          // FIELD TEST 5: a FLAG, not a pedal position — bit 0 of a 2-byte
          // word clears while the accelerator is pressed (0x9001 → 0x9000) in
          // 3 of 5 press windows and returns to 0x9001 in every release
          // window, with 0 baseline changes; flat 0x9001 through the brake run.
          // It says "off idle", which is exactly what a coaching timeline
          // needs when no analog pedal channel answers with the engine off.
          ecu: 0x12,
          did: 0x4007,
          length: 2,
          decode: 'bit0 of a 2-byte word: 0x9001 at idle → 0x9000 while the accelerator is pressed (0 = off idle)',
          status: 'field-observed',
          // P4m-FIX1 X6: DECLARED a flag, so the scorer waives the analog
          // direction rule for it (bit 0 CLEARS when the pedal is pressed).
          // Everything else under this analog target has to prove itself.
          expectedShape: 'boolean-edge',
          provenance:
            'field test 5 2026-08-29 (Signal Finder, engine off, ignition on): data/field/signal-finder/2026-08-29-accelPedal.json — 0x9001→0x9000 in the press windows, back in every release window; flat 0x9001 in 2026-08-29-brakeSwitch.json',
        },
        {
          ecu: 0x12,
          did: 0x4659,
          length: 2,
          decode: 'u16 0–4095 (12-bit)',
          status: 'weak',
          provenance:
            'guided observation 2026-08-29 (test 3, ENGINE RUNNING): 0 → 4095 only in the throttle phase. Field test 5 (engine off) read a constant 0x27FF in all 17 samples — the 0→4095 swing was engine-running throttle, so this is not testable with the engine off.',
        },
      ],
      discoveryRanges: [range(0x12, 0x6000, 0x6fff, 'DME range beyond test 4', 'interval DME dincolo de testul 4')],
    },
    {
      id: 'longG',
      label: 'Longitudinal acceleration',
      labels: TARGET_LABELS.longG,
      engineRequirement: 'running',
      expectedShape: 'analog-bipolar',
      actionScript: PEDAL_SCRIPT,
      verbs: LONG_G_VERBS,
      hypotheses: [
        {
          ecu: 0x12,
          did: 0x4811,
          length: 1,
          decode: 'i8 * 0.217 m/s²',
          status: 'hypothesis',
          provenance:
            'https://thesecretingredient.neocities.org/bmw/dme/b58 ("Vehicle longitudinal acceleration"); field sweep: answers 0x00 at rest',
        },
      ],
      discoveryRanges: [range(0x12, 0x6000, 0x6fff, 'DME range beyond test 4', 'interval DME dincolo de testul 4')],
    },
    {
      id: 'latG',
      label: 'Lateral acceleration',
      labels: TARGET_LABELS.latG,
      engineRequirement: 'running',
      expectedShape: 'analog-bipolar',
      actionScript: STEERING_SCRIPT,
      verbs: LAT_G_VERBS,
      hypotheses: [
        {
          ecu: 0x12,
          did: 0x4812,
          length: 2,
          decode: 'i16 / 640 m/s²',
          status: 'hypothesis',
          provenance:
            'same page ("Vehicle lateral acceleration"); field sweep: answers 0xFF4A = −0.28 m/s² at rest (plausible)',
        },
      ],
      discoveryRanges: [range(0x12, 0x6000, 0x6fff, 'DME range beyond test 4', 'interval DME dincolo de testul 4')],
    },
  ],
};

/** The registry (data). A profile absent from here resolves to {@link GENERIC_SIGNAL_TARGET_CATALOG}. */
export const SIGNAL_TARGET_CATALOGS: readonly SignalTargetCatalog[] = [GENERIC_SIGNAL_TARGET_CATALOG, SUPRA_B58_CATALOG];

/** The catalog for `profileId`, or the hypothesis-free generic one for an unknown/absent profile. */
export function resolveSignalTargetCatalog(profileId: string | null | undefined): SignalTargetCatalog {
  if (profileId === null || profileId === undefined) return GENERIC_SIGNAL_TARGET_CATALOG;
  return SIGNAL_TARGET_CATALOGS.find((catalog) => catalog.profileId === profileId) ?? GENERIC_SIGNAL_TARGET_CATALOG;
}

export function findSignalTarget(catalog: SignalTargetCatalog, id: SignalTargetId): SignalTargetDefinition | null {
  return catalog.targets.find((target) => target.id === id) ?? null;
}

/**
 * P4m M4 (binding): the metronome's prompts in the app's own language, from
 * the TARGET (data) — never a UI constant, and never a hard-coded pedal name.
 * An unknown/absent language falls back to English rather than to a blank
 * prompt: a driver mid-run must always be told what to do.
 */
export function resolveSignalActionVerbs(
  target: SignalTargetDefinition,
  language: SignalLanguage | null | undefined,
): SignalActionVerbs {
  if (language === 'ro') return target.verbs.ro;
  return target.verbs.en;
}

/**
 * P4m-FIX1 X8 (binding, Codex P4m-REV1 finding 9): the target's name in the
 * app's own language. The UI must call this — never `target.label`, which is
 * the English/export name. A catalog entry without `labels` falls back to it
 * rather than rendering blank.
 */
export function resolveSignalTargetLabel(
  target: SignalTargetDefinition,
  language: SignalLanguage | null | undefined,
): string {
  if (language === 'ro') return target.labels?.ro ?? target.label;
  return target.labels?.en ?? target.label;
}

/** P4m-FIX1 X8: the discovery range's note in the app's own language ({@link resolveSignalTargetLabel}'s own discipline). */
export function resolveDiscoveryRangeNote(
  discoveryRange: SignalDiscoveryRange,
  language: SignalLanguage | null | undefined,
): string {
  if (language === 'ro') return discoveryRange.notes?.ro ?? discoveryRange.note;
  return discoveryRange.notes?.en ?? discoveryRange.note;
}

/** P4m-FIX1 X6: every `(ecu, did)` this target DECLARES to be a boolean flag — what `scoreSignalCandidates` takes as `declaredFlagDids`. */
export function targetDeclaredFlagDids(target: SignalTargetDefinition): Array<{ ecu: number; did: number }> {
  return target.hypotheses
    .filter((hypothesis) => hypothesis.expectedShape === 'boolean-edge')
    .map((hypothesis) => ({ ecu: hypothesis.ecu, did: hypothesis.did }));
}

/** Every ECU address this target has a hypothesis on, each once, ascending — the pass order the finder iterates. */
export function targetHypothesisEcus(target: SignalTargetDefinition): number[] {
  return [...new Set(target.hypotheses.map((h) => h.ecu))].sort((a, b) => a - b);
}

/**
 * Field-measured baseline request rate on the real MHD ENET adapter
 * (contracts.md P4i addendum: "~15.8 req/s"). Used ONLY when the caller has
 * no measured rate of its own — a duration must never be reported as if it
 * were measured when it was assumed.
 */
export const ASSUMED_SWEEP_REQ_PER_SEC = 15.8;

/** Item 4 (binding): "the next concrete step with its duration (e.g. 'sweep 0x29 0x58F3–0x6FFF, ≈ 7 min, engine off')". */
export function estimateSweepMinutes(didCount: number, reqPerSec: number): number {
  if (!Number.isFinite(didCount) || didCount <= 0) return 0;
  const rate = Number.isFinite(reqPerSec) && reqPerSec > 0 ? reqPerSec : ASSUMED_SWEEP_REQ_PER_SEC;
  return didCount / rate / 60;
}

export interface NextDiscoveryStep {
  ecu: number | null;
  fromDid: number;
  toDid: number;
  didCount: number;
  estimatedMinutes: number;
  engineRequirement: SignalEngineRequirement;
  note: string;
}

/**
 * The FIRST discovery range of `target` whose ECU is not in `coveredEcus`,
 * sized from the measured request rate. `null` when every range has been
 * covered — the screen then says so rather than inventing another step.
 */
export function nextDiscoveryStep(
  target: SignalTargetDefinition,
  measuredReqPerSec: number,
  coveredEcus: readonly number[] = [],
  /** P4m-FIX1 X8: which language the returned `note` is in. Defaults to English (the export's own). */
  language: SignalLanguage | null | undefined = 'en',
): NextDiscoveryStep | null {
  const covered = new Set(coveredEcus);
  for (const range of target.discoveryRanges) {
    if (range.ecu !== null && covered.has(range.ecu)) continue;
    const didCount = range.toDid - range.fromDid + 1;
    return {
      ecu: range.ecu,
      fromDid: range.fromDid,
      toDid: range.toDid,
      didCount,
      estimatedMinutes: estimateSweepMinutes(didCount, measuredReqPerSec),
      // A discovery SWEEP needs no driver action, so it is always engine-off
      // testable (field protocol 2026-08-29: sweep engine off, act with the
      // engine running only once the shortlist exists) -- independent of the
      // target's own action requirement.
      engineRequirement: 'off-ok',
      note: resolveDiscoveryRangeNote(range, language),
    };
  }
  return null;
}
