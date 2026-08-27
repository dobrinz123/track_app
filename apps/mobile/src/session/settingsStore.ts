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
}

export const DEFAULT_SETTINGS: AppSettings = {
  units: 'kmh',
  deltaDeadbandMs: 100,
  coverageBins: { thresholds: [0.25, 0.5, 0.75, 1] },
  coachingEnabled: true,
  voiceCoachEnabled: false,
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
