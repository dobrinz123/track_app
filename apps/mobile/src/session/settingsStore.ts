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
}

export const DEFAULT_SETTINGS: AppSettings = {
  units: 'kmh',
  deltaDeadbandMs: 100,
  coverageBins: { thresholds: [0.25, 0.5, 0.75, 1] },
  coachingEnabled: true,
  voiceCoachEnabled: false,
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
