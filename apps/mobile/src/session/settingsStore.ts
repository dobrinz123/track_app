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
}

export const DEFAULT_SETTINGS: AppSettings = {
  units: 'kmh',
  deltaDeadbandMs: 100,
  coverageBins: { thresholds: [0.25, 0.5, 0.75, 1] },
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
