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
