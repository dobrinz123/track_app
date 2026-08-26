import { TMR_CIRCUIT_PROFILE } from './tmrProfile';

export type SpeedUnits = 'kmh' | 'mph';

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
