import { TMR_CIRCUIT_PROFILE } from './tmrProfile';

export type SpeedUnits = 'kmh' | 'mph';

/**
 * ENET telemetry addendum (contracts.md, 2026-08-27, binding, Phase 4e). The
 * second OBD transport, next to ELM327: BMW ENET (HSFZ framing over TCP
 * carrying UDS PDUs). Defaults to `'elm327'` -- every existing install (and
 * every field below this one) hydrates unchanged, and the ELM327 path stays
 * byte-identical in behavior regardless of this addendum (`telemetryProvider.ts`
 * only ever builds ENET machinery when this is `'enet'`).
 */
export type AdapterType = 'elm327' | 'enet';

/**
 * Ticket P4l-FIX1 F2 (binding, the P4l worker's own concern 4): the app's ONE
 * language. The exportable Signal Finder summary was already written in both
 * RO and EN (`signalFinderExport.ts`), but the screen hard-coded `'en'`
 * because no language setting existed. Same two-value vocabulary as
 * `@circuit/core`'s coaching `ReportLanguage`, so one setting drives every
 * user-facing text this app renders in more than one language.
 */
export type AppLanguage = 'ro' | 'en';

/**
 * The DEFAULT language for a device locale (BCP-47 tag or a legacy
 * underscore form): Romanian for a `ro` PRIMARY subtag -- `ro`, `ro-RO`,
 * `ro_RO`, `ro-MD` -- English for everything else, including an absent or
 * unreadable locale. Matched on the primary subtag alone, never a prefix, so
 * `roa`/`rom` (other languages that merely start with "ro") stay English,
 * and `hu-RO` (Hungarian spoken in Romania) is Hungarian, not Romanian.
 * Pure: takes the locale rather than reading one, so the rule can be pinned
 * by a test without any native locale API.
 */
export function defaultLanguageForLocale(locale: string | null | undefined): AppLanguage {
  if (typeof locale !== 'string') return 'en';
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return primary === 'ro' ? 'ro' : 'en';
}

/**
 * The device's own locale, read through the `Intl` global (present in Hermes
 * and in Node/vitest -- no new native dependency, and no `react-native`
 * import, so this module stays directly importable by vitest). Any failure
 * -- a runtime built without full ICU, a throwing resolver -- degrades to
 * `null`, which `defaultLanguageForLocale` maps to `'en'`.
 */
export function readDeviceLocale(): string | null {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale ?? null;
  } catch {
    return null;
  }
}

export interface CoverageBinsSetting {
  /** Fraction thresholds, ascending, in (0,1), used to bucket calibration coverage for display. */
  thresholds: readonly number[];
}

export interface AppSettings {
  units: SpeedUnits;
  /** Live delta magnitude (ms) below which the dashboard shows neutral/gray instead of faster/slower. */
  deltaDeadbandMs: number;
  coverageBins: CoverageBinsSetting;
  /**
   * Phase 3 coaching addendum toggle. When `false`, `composition.ts` builds
   * every `SessionController` (production AND DevReplay) with coaching
   * disabled -- no `CoachEngine` is instantiated and `FacadeState.coachCue`
   * stays `null` for the whole session, regardless of the TMR corner data
   * being available. Advisory-only either way (contracts.md's Coaching
   * addendum); this only controls whether cues are computed/surfaced at all.
   * Defaults to `true` -- UI rendering of the cue itself is a later work
   * package, this ticket only plumbs the data.
   */
  coachingEnabled: boolean;
  /**
   * Phase 3 coaching addendum sub-toggle (voice cues via `session/voiceCoach.ts`
   * + expo-speech). Only meaningful while `coachingEnabled` is also `true` --
   * `voiceCoach.ts` gates on BOTH fields, never speaks with `coachingEnabled`
   * `false` regardless of this value, and `SettingsScreen` only shows this
   * row when `coachingEnabled` is on. Defaults to `false`: voice is opt-in,
   * unlike the on-screen coach cues themselves.
   */
  voiceCoachEnabled: boolean;
  /**
   * Ticket P5c-B (contracts.md "Phase 5 REVISION 2" R2-3, user-ratified): the
   * opt-in gate for the whole trackday suggestion stage — the between-stint
   * pit view, its bounded per-corner suggestions, and the live brake-cue
   * updates between laps. Defaults to `false`, and OFF means OFF everywhere:
   * no lap boundary reads the recording, no cue ever moves, no suggestion is
   * computed or exported, and the pit-view entry point is not shown. Turning
   * it on never lifts a bound — a cue may still only move to a point a clean
   * lap of the SAME outing already demonstrated, by at most 10 m / +3 km/h,
   * once per corner per stint. Advice is never shown while driving.
   */
  suggestionsEnabled: boolean;
  /**
   * Telemetry addendum (Phase 4 / P4a, docs/architecture/contracts.md).
   * Advisory/experimental: reads vehicle telemetry (RPM, speed, throttle,
   * coolant temperature) from a local WiFi OBD-II adapter, strictly
   * read-only on the vehicle bus. Defaults to `false` -- opt-in, and never
   * required for lap timing (`composition.ts`'s session integration MUST
   * leave every session 100% functional with this on and the adapter
   * dead/absent).
   */
  telemetryEnabled: boolean;
  /**
   * Dev-only: when `true` (and `telemetryEnabled`), `telemetryProvider.ts`
   * builds a `SimulatedElm327Transport` (`@circuit/core`) instead of the real
   * `TcpObdTransport`, so telemetry can be exercised without a physical
   * adapter. `SettingsScreen` only shows this toggle in `__DEV__`. Defaults
   * to `false`.
   */
  telemetrySimulate: boolean;
  /** WiFi OBD-II adapter host (Telemetry addendum: adapter is a local WiFi AP). */
  adapterHost: string;
  /** WiFi OBD-II adapter TCP port. */
  adapterPort: number;
  /**
   * Telemetry addendum — channel revision (2026-08-11, binding). Advanced,
   * vehicle-specific setting: the raw hex OBD/mode-22 request for
   * transmission oil temperature, sent verbatim (no standard mode-01 PID
   * exists for this channel). Decoded as the last response data byte minus
   * 40, same as every other OBD temperature channel. Empty string (the
   * default) means "not configured" -- `telemetryProvider.ts`'s poll plan
   * then omits `transOilC` entirely rather than polling a request nobody
   * supplied. Hex characters and spaces only; validated on blur by
   * `SettingsScreen`'s `parseHexPidDraft()`.
   */
  transOilPidHex: string;
  /**
   * Multi-circuit selection addendum (contracts.md, 2026-08-26, ticket
   * CN-W3): the ONE circuit every production `SessionController`, the
   * session-history store, coaching corners, the calibration track map, and
   * the circuit/PB screens are built for. Defaults to Transilvania Motor
   * Ring (`DEFAULT_SETTINGS`, below) -- existing installs with no persisted
   * value hydrate to this exact default, so TMR's behavior is unchanged.
   * An id absent from the bundled catalog resolves back to this default with
   * a `console.warn` (`circuitCatalog.ts`'s `resolveSelectedCircuit`) --
   * never a crash, never a fetch.
   */
  selectedCircuitId: string;
  /**
   * ENET telemetry addendum (binding, Phase 4e): which OBD transport
   * `telemetryProvider.ts` builds. Defaults to `'elm327'` -- existing behavior
   * unchanged for every install with no persisted value.
   */
  adapterType: AdapterType;
  /**
   * ENET adapter IP (its own local WiFi AP, same "adapter is a local WiFi
   * AP" model as the ELM327 `adapterHost` above, but a SEPARATE field -- the
   * two adapter types are never conflated, so switching `adapterType` back
   * and forth never clobbers either adapter's own remembered address).
   * Defaults to `''`: unlike the ELM327 adapter (a fixed default AP address),
   * the user reads the ENET adapter's IP from its own web UI -- `SettingsScreen`'s
   * copy explains this, there is no sane universal default to pre-fill.
   */
  enetHost: string;
  /** ENET adapter TCP port (contracts.md addendum: HSFZ over TCP 6801, verified). */
  enetPort: number;
  /** UDS tester (source) address ENET frames are sent from. EMPIRICAL (addendum: default 0xF4, alt 0xF1) -- never hardcoded without this override. */
  enetTesterAddress: number;
  /** UDS target (destination) address ENET frames are sent to. EMPIRICAL (addendum: default 0x12 = DME) -- never hardcoded without this override. */
  enetTargetAddress: number;
  /**
   * Advanced, vehicle-specific: a JSON array of `EnetChannelSpec` (`@circuit/core`),
   * each entry a `mode: 'obd01' | 'did'` request plus (for `did`) a decode
   * formula and REQUIRED provenance -- see the ENET addendum's own
   * `EnetChannelSpec` doc comment. Empty string (the default) means "use the
   * built-in defaults" (`DEFAULT_ENET_CHANNEL_SPECS`: obd01 rpm/speedKph/
   * throttlePct/coolantC/engineOilC, all EMPIRICAL on the ENET path, no
   * default `did` specs). Validated through `@circuit/core`'s
   * `validateEnetChannelSpecs` (`enetSettingsValidation.ts`'s
   * `resolveEnetChannelSpecs`/`validateEnetChannelSpecsJson`) both by
   * `SettingsScreen` (inline warnings on blur) and by `telemetryProvider.ts`
   * (re-validated on every `start()`, same "never trust a persisted value
   * blindly" rule as `transOilPidHex`/`buildCustomPids` above) -- malformed
   * JSON falls back to the built-in defaults with a `console.warn`, never a
   * crash.
   */
  enetChannelSpecsJson: string;
  /**
   * ENET auto-discovery & DID sweep addendum (binding, Phase 4f): where
   * `enetHost`/`enetPort` came from -- `''` (the default) means "entered
   * manually" (or never set); `discovered <date>` (ISO date) means a "Find
   * adapter" tap or the provider's own auto-discovery-on-connect-failure
   * detour applied a discovery hit. Display-only (SettingsScreen shows it
   * next to the host/port fields) -- never read by `telemetryProvider.ts`'s
   * connection logic itself.
   */
  enetHostProvenance: string;
  /**
   * ENET auto-discovery addendum (binding, Phase 4f): when `true` (the
   * default) and `adapterType === 'enet'`, `telemetryProvider.ts` runs
   * discovery ONCE per `start()` -- immediately when no host is configured,
   * or after the first connect attempt to a configured host fails -- and
   * applies a level-2 hit automatically. `false` reverts to the pre-addendum
   * behavior: a configured host is dialed directly, and a failure gets the
   * plain single reconnect retry, with no discovery involved at all.
   */
  enetAutoDiscover: boolean;
  /**
   * Field revision (2026-08-27, binding, "hidden developer mode"): when
   * `true` (or the build is `__DEV__`), `SettingsScreen` shows "Dev: DID
   * Probe (ENET)"/"Dev: DID Sweep (ENET)" -- the dev-only ENET diagnostic
   * tools stay REGISTERED as routes in every build, release included (App
   * Store review sees one binary), only their Settings-screen entry points
   * are hidden until this is on. Toggled by 7 taps on the About section's
   * version text within a short window (`registerDevTap`, below) -- never
   * shown as its own settings row. `DevReplay` is UNAFFECTED: it stays
   * `__DEV__`-only regardless of this setting. Defaults to `false`.
   */
  developerModeEnabled: boolean;
  /**
   * Ticket P4l-FIX1 F2 (binding): the app language (`'ro' | 'en'`). The
   * static default below is `'en'`; the DEVICE-LOCALE default
   * (`defaultLanguageForLocale(readDeviceLocale())`) is applied once, at
   * hydration, ONLY when nothing was ever persisted -- so a user who chose a
   * language keeps it even when they travel, and an existing install with no
   * stored value adopts its device's language on first launch after this
   * ticket rather than being forced to English.
   */
  language: AppLanguage;
  /**
   * Ticket P4p G1 (binding, field test 9 BUG-A): the ONE vehicle profile the
   * whole app works against -- the Signal Finder's target catalog AND the
   * confirmed bindings `telemetryProvider.ts` polls
   * (`composition.ts`'s binding cache reads `listBindings(THIS id)`).
   *
   * Bindings have always been stored per profile
   * (`vehicle_profile_bindings.profile_id`), but nothing persisted WHICH
   * profile the app was using: the Signal Finder screen defaulted its chip to
   * `'generic'` in React state, and the composition layer hard-coded
   * `'generic'` for telemetry. Field test 9: the user confirmed
   * brakePressure = 0x12/0x58B7 under `toyota-supra-b58` (export
   * `2026-08-31-steeringAngle-2.json`) while the monitor kept polling
   * 0x12/0x4002 from the generic profile (export `-1.json`) and showed a
   * meaningless 0/100 %.
   *
   * Defaults to `'generic'` -- the hypothesis-free catalog. An id with no
   * bundled catalog resolves back to the generic catalog at read time
   * (`resolveSignalTargetCatalog`), exactly like `selectedCircuitId` does.
   */
  activeVehicleProfileId: string;
}

/**
 * Ticket P4p G1: the only thing the initial-profile heuristic below needs to
 * know about a persisted binding. Deliberately NOT
 * `VehicleProfileBinding` (`persistence/didSweepStore.ts`): this module is the
 * settings vocabulary and must not depend on the persistence layer.
 */
export interface VehicleProfileBindingSummary {
  profileId: string;
  channel: string;
  status: string;
}

/** The profile id every install starts on, and the one an unresolvable id falls back to. */
export const GENERIC_VEHICLE_PROFILE_ID = 'generic';

/**
 * Ticket P4p G1 (binding): the ONE-TIME migration heuristic, run only on the
 * first launch after this setting existed (i.e. only when the persisted
 * settings row never carried a choice of its own -- see
 * `SqlSettingsStore.activeVehicleProfileIdWasStored`) and never afterwards.
 *
 * The situation it exists for is exactly field test 9's: the user confirmed
 * the same CHANNEL under two profiles, and the newer, engine-running confirm
 * lives on the car-specific profile while the app was reading generic. So:
 * a non-generic profile is preferred when it carries `field-confirmed`
 * bindings AND generic carries a binding for at least one of the SAME
 * channels -- the only case where the two stores actually contradict each
 * other about a channel the monitor polls.
 *
 * `null` means "no migration" (keep `'generic'`): nothing confirmed, only
 * generic confirmed, or a car profile whose channels generic never touched
 * (nothing contradicts, so nothing is guessed). Ties break on the number of
 * overlapping field-confirmed channels, then alphabetically, so the result is
 * deterministic. Pure -- it decides, it never writes, and NOTHING is ever
 * deleted either way.
 */
export function chooseInitialActiveVehicleProfileId(
  bindings: readonly VehicleProfileBindingSummary[],
): string | null {
  const genericChannels = new Set(
    bindings.filter((binding) => binding.profileId === GENERIC_VEHICLE_PROFILE_ID).map((binding) => binding.channel),
  );
  if (genericChannels.size === 0) return null;
  const overlapByProfile = new Map<string, number>();
  for (const binding of bindings) {
    if (binding.profileId === GENERIC_VEHICLE_PROFILE_ID) continue;
    if (binding.status !== 'field-confirmed') continue;
    if (!genericChannels.has(binding.channel)) continue;
    overlapByProfile.set(binding.profileId, (overlapByProfile.get(binding.profileId) ?? 0) + 1);
  }
  const ranked = [...overlapByProfile.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return ranked[0]?.[0] ?? null;
}

/**
 * Field revision (2026-08-27, binding; window semantics corrected P4g-FIX1):
 * pure tap-counter for the "7 taps on the About version text toggles
 * developer mode" gesture -- `state` is `null` before the first tap (or
 * after a toggle just fired, resetting the count). `firstTapAtMs` anchors
 * the window to the FIRST tap of the current run: the whole sequence (tap 1
 * through the tap that reaches `threshold`) must land within `windowMs` of
 * THAT first tap, not merely within `windowMs` of the immediately preceding
 * tap -- otherwise taps spaced just under the window apart (e.g. 1.9s, each
 * individually "recent") would accumulate indefinitely and the gesture would
 * effectively have no time limit. A tap that arrives after the current run's
 * window has elapsed restarts the count at 1 and becomes the new anchor (so
 * idle taps spread across a session, e.g. 3 taps now and 4 taps an hour
 * later, never silently accumulate into an accidental toggle). `toggled` is
 * `true` exactly on the tap that reaches `threshold` -- the caller
 * (`SettingsScreen`) flips `developerModeEnabled` and shows the toast on
 * THAT tap only, never on every tap past the threshold while the user keeps
 * tapping.
 */
export interface DevTapState {
  count: number;
  firstTapAtMs: number;
}

export const DEV_TAP_THRESHOLD = 7;
export const DEV_TAP_WINDOW_MS = 2_000;

export function registerDevTap(
  state: DevTapState | null,
  nowMs: number,
  threshold: number = DEV_TAP_THRESHOLD,
  windowMs: number = DEV_TAP_WINDOW_MS,
): { state: DevTapState; toggled: boolean } {
  const withinWindow = state !== null && nowMs - state.firstTapAtMs <= windowMs;
  if (!withinWindow) {
    const toggled = threshold <= 1;
    return { state: { count: toggled ? 0 : 1, firstTapAtMs: nowMs }, toggled };
  }
  const state2 = state as DevTapState;
  const count = state2.count + 1;
  const toggled = count >= threshold;
  return { state: { count: toggled ? 0 : count, firstTapAtMs: toggled ? nowMs : state2.firstTapAtMs }, toggled };
}

export const DEFAULT_SETTINGS: AppSettings = {
  units: 'kmh',
  deltaDeadbandMs: 100,
  coverageBins: { thresholds: [0.25, 0.5, 0.75, 1] },
  coachingEnabled: true,
  voiceCoachEnabled: false,
  suggestionsEnabled: false,
  telemetryEnabled: false,
  telemetrySimulate: false,
  adapterHost: '192.168.0.10',
  adapterPort: 35_000,
  transOilPidHex: '',
  selectedCircuitId: TMR_CIRCUIT_PROFILE.circuitId,
  adapterType: 'elm327',
  enetHost: '',
  enetPort: 6_801,
  enetTesterAddress: 0xf4,
  enetTargetAddress: 0x12,
  enetChannelSpecsJson: '',
  enetHostProvenance: '',
  enetAutoDiscover: true,
  developerModeEnabled: false,
  language: 'en',
  activeVehicleProfileId: GENERIC_VEHICLE_PROFILE_ID,
};

/**
 * Persistence-agnostic settings surface consumed by `SettingsScreen` (S12).
 * `InMemorySettingsStore` is a dev-only stand-in; a later work package swaps
 * it (in `apps/mobile/src/session/composition.ts`) for one backed by durable
 * on-device storage without changing this interface or any screen.
 */
export interface SettingsStore {
  getSettings(): AppSettings;
  subscribe(cb: (s: AppSettings) => void): () => void;
  update(patch: Partial<AppSettings>): void;
}

/** In-memory settings store — DEV-ONLY, resets on app restart. */
export class InMemorySettingsStore implements SettingsStore {
  private settings: AppSettings = { ...DEFAULT_SETTINGS };
  private readonly listeners = new Set<(s: AppSettings) => void>();

  getSettings(): AppSettings {
    return this.settings;
  }

  subscribe(cb: (s: AppSettings) => void): () => void {
    this.listeners.add(cb);
    cb(this.settings);
    return () => {
      this.listeners.delete(cb);
    };
  }

  update(patch: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...patch };
    for (const listener of this.listeners) listener(this.settings);
  }
}
