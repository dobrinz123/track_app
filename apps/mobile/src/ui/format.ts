/** Formats milliseconds as `mm:ss.mmm` (or `m:ss.mmm` unpadded on minutes). */
export function formatLapTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--:--.---';
  const clamped = Math.max(0, ms);
  const totalMs = Math.round(clamped);
  const minutes = Math.floor(totalMs / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** Formats a signed delta in milliseconds as e.g. `-0.42` / `+1.20` (seconds, 2dp). */
export function formatDeltaSeconds(ms: number): string {
  const sign = ms < 0 ? '-' : '+';
  const seconds = Math.abs(ms) / 1000;
  return `${sign}${seconds.toFixed(2)}`;
}

export function formatDateUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ---------------------------------------------------------------------------
// Speed units (F5 fix). Every coaching speed value is modeled/stored in
// km/h ('CoachCue.advisorySpeedKph', 'Corner.advisorySpeedKph') -- this is
// the ONE place that converts for display/speech, so `CoachStrip`,
// `CornersList`, and `voiceCoach` can never independently disagree with the
// driver's `SpeedUnits` setting (or silently ignore it, as they previously
// did).
// ---------------------------------------------------------------------------

/** Mirrors `session/settingsStore.ts`'s `SpeedUnits` without importing it here, keeping this module free of session-layer dependencies. */
export type SpeedUnits = 'kmh' | 'mph';

const MPH_PER_KPH = 0.621371;

/** Converts a km/h value to the given display units, unrounded. */
export function convertSpeedKph(kph: number, units: SpeedUnits): number {
  return units === 'mph' ? kph * MPH_PER_KPH : kph;
}

/** Short unit suffix for on-screen use, e.g. `82 km/h` / `51 mph`. */
export function speedUnitLabel(units: SpeedUnits): 'km/h' | 'mph' {
  return units === 'mph' ? 'mph' : 'km/h';
}

/** Spoken-word unit phrase for voice cues -- never a bare number with no unit. */
export function speedUnitWord(units: SpeedUnits): 'kilometers per hour' | 'miles per hour' {
  return units === 'mph' ? 'miles per hour' : 'kilometers per hour';
}

/** Rounds a km/h value to the nearest whole number IN the given display units. */
export function formatSpeedValue(kph: number, units: SpeedUnits): number {
  return Math.round(convertSpeedKph(kph, units));
}

/** `82 km/h` / `51 mph` -- rounded value + short unit suffix. */
export function formatSpeedShort(kph: number, units: SpeedUnits): string {
  return `${formatSpeedValue(kph, units)} ${speedUnitLabel(units)}`;
}

/** `82 kilometers per hour` / `51 miles per hour` -- rounded value + spoken unit phrase, for voice cues. */
export function formatSpeedSpoken(kph: number, units: SpeedUnits): string {
  return `${formatSpeedValue(kph, units)} ${speedUnitWord(units)}`;
}
