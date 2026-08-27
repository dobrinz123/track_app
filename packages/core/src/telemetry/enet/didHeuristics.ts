/**
 * DID responder heuristics -- pure, deterministic classification of a
 * repeatedly-sampled DID sweep responder into a likely channel shape
 * (contracts.md "ENET auto-discovery & DID sweep addendum", binding):
 *
 *   temperature-like: slow monotonic drift, plausible range under u8-40/u16/10.
 *   speed-like:       correlates with GNSS speed when available.
 *   pedal-like:       fast bimodal steps (two clusters, sharp gap between).
 *   steering-like:    zero-centred, frequent sign changes.
 *
 * Every decode tried (`u8-40`, `u16/10`, `u8`, `i16`) is scored against every
 * shape it could plausibly represent; the best-scoring (kind, decode) pair
 * wins for that DID, or `'unknown'` if nothing scores confidently. No
 * suggestion here is ever "applied" -- this module only ranks; the caller
 * (mobile DID sweep screen) is what asks the user to confirm one, per the
 * addendum ("No suggestion is ever applied without confirmation").
 */

import type { TelemetryChannelId } from '../contracts';
import { validateEnetChannelSpecs, type EnetChannelDecodeSpec, type EnetChannelSpec } from './enetChannelSpecs';

export type DidHeuristicDecode = 'u8-40' | 'u16/10' | 'u8' | 'i16';
export type DidHeuristicKind = 'temperature' | 'speed' | 'pedal' | 'steering' | 'unknown';

export interface DidResponderSample {
  tMs: number;
  raw: Uint8Array;
}

export interface DidResponderSeries {
  did: number;
  samples: readonly DidResponderSample[];
}

export interface GnssSpeedSample {
  tMs: number;
  v: number;
}

export interface DidHeuristicContext {
  gnssSpeedKph?: readonly GnssSpeedSample[];
}

export interface DidHeuristicSuggestion {
  did: number;
  kind: DidHeuristicKind;
  /** 0..1. */
  confidence: number;
  decode: DidHeuristicDecode;
  rationale: string;
}

/** Below this, the best-scoring (kind, decode) pair for a DID is still reported, but as `'unknown'` rather than the shape it nominally scored highest for. */
const UNKNOWN_CONFIDENCE_THRESHOLD = 0.55;

/** Ranks every responder by its best-matching signal shape, highest confidence first (ties broken by ascending DID for determinism). */
export function classifyResponders(
  series: readonly DidResponderSeries[],
  context: DidHeuristicContext = {},
): DidHeuristicSuggestion[] {
  const suggestions = series.map((entry) => classifyOne(entry, context));
  return suggestions.sort((a, b) => b.confidence - a.confidence || a.did - b.did);
}

interface Candidate {
  kind: Exclude<DidHeuristicKind, 'unknown'>;
  decode: DidHeuristicDecode;
  confidence: number;
  rationale: string;
}

function classifyOne(entry: DidResponderSeries, context: DidHeuristicContext): DidHeuristicSuggestion {
  const samples = [...entry.samples].sort((a, b) => a.tMs - b.tMs);
  const times = samples.map((sample) => sample.tMs);

  const candidates: Candidate[] = [];

  const u8Minus40 = decodeSeries(samples, decodeU8Minus40);
  const u16Div10 = decodeSeries(samples, decodeU16Div10);
  const u8Raw = decodeSeries(samples, decodeU8Raw);
  const i16Raw = decodeSeries(samples, decodeI16Raw);

  if (u8Minus40 !== null) candidates.push(scoreTemperature(u8Minus40, times, 'u8-40', -40, 150));
  if (u16Div10 !== null) candidates.push(scoreTemperature(u16Div10, times, 'u16/10', -40, 300));

  if (u8Raw !== null) candidates.push(scoreSpeed(u8Raw, times, context, 'u8'));
  if (u16Div10 !== null) candidates.push(scoreSpeed(u16Div10, times, context, 'u16/10'));

  if (u8Raw !== null) candidates.push(scoreBimodal(u8Raw, times, 'u8'));

  if (i16Raw !== null) candidates.push(scoreSteering(i16Raw, 'i16'));

  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (best === null || candidate.confidence > best.confidence) best = candidate;
  }

  if (best === null) {
    // No decode had enough bytes at all (every sample too short) -- report
    // the smallest decode (`u8`) as a neutral default, zero confidence.
    return {
      did: entry.did,
      kind: 'unknown',
      confidence: 0,
      decode: 'u8',
      rationale: 'no sample carried enough bytes for any decode',
    };
  }

  if (best.confidence < UNKNOWN_CONFIDENCE_THRESHOLD) {
    return {
      did: entry.did,
      kind: 'unknown',
      confidence: best.confidence,
      decode: best.decode,
      rationale: `no signal shape matched confidently (best: ${best.kind} @ ${best.confidence.toFixed(2)} -- ${best.rationale})`,
    };
  }

  return { did: entry.did, kind: best.kind, confidence: best.confidence, decode: best.decode, rationale: best.rationale };
}

// ---------- Decodes ----------

// Each decode requires an EXACT raw byte width (not merely ">="): a real DID
// response has one fixed width, and treating a longer response's leading
// byte(s) as if they were a narrower field manufactures spurious shapes (a
// signed 16-bit oscillation's high byte alone looks deceptively bimodal, for
// instance) that don't correspond to how any real ECU actually packs a DID.

function decodeU8Minus40(raw: Uint8Array): number | null {
  if (raw.length !== 1) return null;
  return (raw[0] ?? 0) - 40;
}

function decodeU8Raw(raw: Uint8Array): number | null {
  if (raw.length !== 1) return null;
  return raw[0] ?? 0;
}

function decodeU16Div10(raw: Uint8Array): number | null {
  if (raw.length !== 2) return null;
  return (((raw[0] ?? 0) << 8) | (raw[1] ?? 0)) / 10;
}

function decodeI16Raw(raw: Uint8Array): number | null {
  if (raw.length !== 2) return null;
  let value = ((raw[0] ?? 0) << 8) | (raw[1] ?? 0);
  if (value >= 0x8000) value -= 0x10000;
  return value;
}

/** Decodes every sample; `null` if ANY sample's raw width doesn't exactly match this decode (a partial series would be misleading, not merely sparse). */
function decodeSeries(
  samples: readonly DidResponderSample[],
  decode: (raw: Uint8Array) => number | null,
): number[] | null {
  const out: number[] = [];
  for (const sample of samples) {
    const value = decode(sample.raw);
    if (value === null) return null;
    out.push(value);
  }
  return out;
}

// ---------- Shape scoring ----------

/** Minimum observation window (amendment: "slow monotonic drift over >= 30 s") -- a drift measured over anything shorter proves nothing about SLOWNESS regardless of how clean the trend looks (3 samples 1ms apart trivially "monotonic"). */
const TEMPERATURE_MIN_DURATION_MS = 30_000;
/** Maximum |slope| in decoded-units-per-second (amendment: "|slope| <= 2 C/s") -- both u8-40 and u16/10 decode to the SAME physical unit (deg C), so one bound serves both decodes. */
const TEMPERATURE_MAX_SLOPE_PER_SEC = 2;
/** Minimum fraction of steps that must agree with the overall trend's sign (amendment: "monotonic ratio >= 0.8") -- a HARD gate, not a soft multiplier: below this, the series just isn't "monotonic" in the sense the addendum means. */
const TEMPERATURE_MIN_MONOTONIC_RATIO = 0.8;

function scoreTemperature(
  values: readonly number[],
  times: readonly number[],
  decode: DidHeuristicDecode,
  plausibleMin: number,
  plausibleMax: number,
): Candidate {
  const n = values.length;
  if (n < 3) return { kind: 'temperature', decode, confidence: 0, rationale: 'too few samples' };

  const durationMs = (times[n - 1] ?? 0) - (times[0] ?? 0);
  if (durationMs < TEMPERATURE_MIN_DURATION_MS) {
    return {
      kind: 'temperature',
      decode,
      confidence: 0,
      rationale: `observation window ${durationMs}ms is under the ${TEMPERATURE_MIN_DURATION_MS}ms minimum for "slow" drift`,
    };
  }

  const first = values[0] ?? 0;
  const last = values[n - 1] ?? 0;
  const min = Math.min(...values);
  const actualMax = Math.max(...values);
  const inPlausibleRange = min >= plausibleMin && actualMax <= plausibleMax;

  const trend = last - first;
  const trendSign = Math.sign(trend);
  let monotonicSteps = 0;
  let stepCount = 0;
  let sumAbsDiff = 0;
  for (let i = 1; i < n; i += 1) {
    const diff = (values[i] ?? 0) - (values[i - 1] ?? 0);
    stepCount += 1;
    sumAbsDiff += Math.abs(diff);
    if (diff === 0 || Math.sign(diff) === trendSign || trendSign === 0) monotonicSteps += 1;
  }
  const monotonicFraction = stepCount > 0 ? monotonicSteps / stepCount : 0;
  const absTrend = Math.abs(trend);
  const smoothness = sumAbsDiff > 0 ? Math.min(1, absTrend / sumAbsDiff) : absTrend > 0 ? 1 : 0;
  const hasDrift = absTrend >= 1;
  const slopePerSec = trend / (durationMs / 1_000);
  const slopeOk = Math.abs(slopePerSec) <= TEMPERATURE_MAX_SLOPE_PER_SEC;
  const monotonicOk = monotonicFraction >= TEMPERATURE_MIN_MONOTONIC_RATIO;

  const confidence =
    inPlausibleRange && hasDrift && slopeOk && monotonicOk ? clamp01(monotonicFraction * smoothness) : 0;
  const rationale = `range [${min.toFixed(1)}, ${actualMax.toFixed(1)}] over ${durationMs}ms, slope ${slopePerSec.toFixed(3)}/s, monotonic ${(monotonicFraction * 100).toFixed(0)}%`;
  return { kind: 'temperature', decode, confidence, rationale };
}

/** Least-squares gain must land within this fraction of 1 (amendment: "within +/-25% of 1") -- correlation alone can be near-perfect while the decoded NUMBER is simply wrong (e.g. reads 2x the actual km/h), which is not a usable speed channel regardless of how well it tracks shape. */
const SPEED_GAIN_TOLERANCE = 0.25;

function scoreSpeed(
  values: readonly number[],
  times: readonly number[],
  context: DidHeuristicContext,
  decode: DidHeuristicDecode,
): Candidate {
  const gnss = context.gnssSpeedKph;
  if (gnss === undefined || gnss.length < 2 || values.length < 2) {
    return { kind: 'speed', decode, confidence: 0, rationale: 'no GNSS speed reference available' };
  }
  const matched = times.map((t) => nearestValue(gnss, t));
  const r = pearsonCorrelation(values, matched);
  if (!Number.isFinite(r)) {
    return { kind: 'speed', decode, confidence: 0, rationale: 'no variation to correlate against GNSS speed' };
  }

  // Least-squares gain fitting `values ~= gain * matched` (through the
  // origin -- 0 decoded is 0 km/h for every decode this module tries).
  const sumXX = matched.reduce((sum, x) => sum + x * x, 0);
  const sumXY = matched.reduce((sum, x, i) => sum + x * (values[i] ?? 0), 0);
  const gain = sumXX > 0 ? sumXY / sumXX : NaN;
  const gainOk = Number.isFinite(gain) && Math.abs(gain - 1) <= SPEED_GAIN_TOLERANCE;

  if (!gainOk) {
    return {
      kind: 'speed',
      decode,
      confidence: 0,
      rationale: `correlation r=${r.toFixed(2)} but decode scale is wrong (gain ${Number.isFinite(gain) ? gain.toFixed(2) : 'n/a'}, need within +/-${SPEED_GAIN_TOLERANCE * 100}% of 1)`,
    };
  }

  // Confidence scaled by residual (amendment): even a gain-correct decode
  // that scatters far from the GNSS reference isn't a confident speed match.
  const residuals = values.map((v, i) => v - gain * (matched[i] ?? 0));
  const residualRms = Math.sqrt(residuals.reduce((sum, e) => sum + e * e, 0) / residuals.length);
  const referenceScale = Math.max(1, rms(matched));
  const residualScore = clamp01(1 - residualRms / referenceScale);

  const confidence = clamp01(clamp01(r) * residualScore);
  const rationale = `correlation r=${r.toFixed(2)}, gain=${gain.toFixed(2)}, residual RMS=${residualRms.toFixed(2)}`;
  return { kind: 'speed', decode, confidence, rationale };
}

/** Maximum time gap allowed between two temporally-ADJACENT samples that fall in different clusters (amendment: "fast steps (<= 2 s) between two plateaus"). Two widely-time-spaced samples landing in different clusters proves nothing about transition SPEED -- it could equally be a slow ramp we merely undersampled -- so that case must not be credited as "fast". */
const PEDAL_MAX_TRANSITION_MS = 2_000;

function scoreBimodal(values: readonly number[], times: readonly number[], decode: DidHeuristicDecode): Candidate {
  const n = values.length;
  if (n < 6) return { kind: 'pedal', decode, confidence: 0, rationale: 'too few samples' };

  const sorted = [...values].sort((a, b) => a - b);
  const range = (sorted[n - 1] ?? 0) - (sorted[0] ?? 0);
  if (range <= 0) return { kind: 'pedal', decode, confidence: 0, rationale: 'no variation' };

  let maxGap = -1;
  let splitIndex = 0;
  for (let i = 1; i < n; i += 1) {
    const gap = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0);
    if (gap > maxGap) {
      maxGap = gap;
      splitIndex = i;
    }
  }
  const low = sorted.slice(0, splitIndex);
  const high = sorted.slice(splitIndex);
  const balance = Math.min(low.length, high.length) / n; // 0.5 = perfectly balanced two clusters
  const gapRatio = maxGap / range;
  const spread = (stdev(low) + stdev(high)) / 2;
  const tightness = clamp01(1 - spread / (range || 1));

  // Cluster threshold sits in the gap itself (values <= threshold -> "low").
  const threshold = ((sorted[splitIndex - 1] ?? 0) + (sorted[splitIndex] ?? 0)) / 2;
  let maxTransitionMs = 0;
  let sawTransition = false;
  for (let i = 1; i < n; i += 1) {
    const prevLow = (values[i - 1] ?? 0) <= threshold;
    const currLow = (values[i] ?? 0) <= threshold;
    if (prevLow !== currLow) {
      sawTransition = true;
      maxTransitionMs = Math.max(maxTransitionMs, (times[i] ?? 0) - (times[i - 1] ?? 0));
    }
  }
  const transitionsAreFast = sawTransition && maxTransitionMs <= PEDAL_MAX_TRANSITION_MS;

  if (!transitionsAreFast) {
    return {
      kind: 'pedal',
      decode,
      confidence: 0,
      rationale: sawTransition
        ? `slowest observed transition ${maxTransitionMs}ms exceeds the ${PEDAL_MAX_TRANSITION_MS}ms "fast step" bound`
        : 'no plateau-to-plateau transition observed in time order',
    };
  }

  const confidence = balance >= 0.15 ? clamp01(gapRatio * tightness * (balance / 0.5)) : 0;
  const rationale = `bimodal gap ${maxGap.toFixed(1)}/${range.toFixed(1)} range, clusters ${low.length}/${high.length}, tightness ${tightness.toFixed(2)}, max transition ${maxTransitionMs}ms`;
  return { kind: 'pedal', decode, confidence, rationale };
}

/**
 * "Zero-centred sign changes" (addendum) does NOT mean the value flips sign
 * on nearly every sample -- a real steering trace crosses zero only a
 * handful of times across an observation window (once per corner), most
 * samples sitting solidly on one side or the other in between. The
 * discriminating property is that BOTH signs occur in a healthy proportion
 * (`balance`, unlike a one-sided temperature/pedal-style signal), the mean
 * sits near zero, AND the series actually crosses zero at least once.
 *
 * A crossing is counted with `prev <= 0 < curr` (amendment) -- NOT
 * `prev * curr < 0` -- so a sample landing on EXACT zero between a negative
 * and a positive neighbor (`[-100, 0, 100]`) still counts: `prev*curr<0`
 * would miss it entirely (0 * anything = 0, never < 0). The crossing count
 * itself CONTRIBUTES to confidence (not merely a pass/fail gate) via
 * `crossingScore`.
 */
function scoreSteering(values: readonly number[], decode: DidHeuristicDecode): Candidate {
  const n = values.length;
  if (n < 4) return { kind: 'steering', decode, confidence: 0, rationale: 'too few samples' };

  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const actualMax = Math.max(...values.map((v) => Math.abs(v)));
  if (actualMax === 0) return { kind: 'steering', decode, confidence: 0, rationale: 'constant zero' };

  let crossings = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  for (const value of values) {
    if (value > 0) positiveCount += 1;
    else if (value < 0) negativeCount += 1;
  }
  for (let i = 1; i < n; i += 1) {
    const prev = values[i - 1] ?? 0;
    const curr = values[i] ?? 0;
    if (prev <= 0 && curr > 0) crossings += 1;
  }

  if (crossings === 0) {
    return { kind: 'steering', decode, confidence: 0, rationale: 'never crosses zero (prev <= 0 < curr)' };
  }

  const balance = (2 * Math.min(positiveCount, negativeCount)) / n; // 1.0 = perfectly split between + and -
  const meanNearZeroScore = clamp01(1 - Math.abs(mean) / actualMax);
  // At least 1 crossing already gated entry above (0.5 baseline credit for
  // that alone); each additional crossing (up to 3) raises this further,
  // since repeated crossings are stronger evidence of a genuinely
  // oscillating (rather than one-off) signal.
  const crossingScore = clamp01(0.5 + 0.5 * Math.min(1, crossings / 3));

  const confidence = clamp01(0.4 * balance + 0.3 * meanNearZeroScore + 0.3 * crossingScore);
  const rationale = `mean ${mean.toFixed(1)} (max |v| ${actualMax.toFixed(1)}), ${crossings} crossing(s), +/- balance ${(balance * 100).toFixed(0)}%`;
  return { kind: 'steering', decode, confidence, rationale };
}

// ---------- Numeric helpers ----------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function stdev(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

function rms(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  return Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / n);
}

function pearsonCorrelation(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return NaN;
  const meanA = a.reduce((sum, v) => sum + v, 0) / n;
  const meanB = b.reduce((sum, v) => sum + v, 0) / n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return NaN;
  return cov / Math.sqrt(varA * varB);
}

/** Nearest-neighbor lookup by `tMs` (linear scan -- GNSS reference series are small in practice). */
function nearestValue(series: readonly GnssSpeedSample[], tMs: number): number {
  let best = series[0] ?? { tMs: 0, v: 0 };
  let bestDist = Math.abs(best.tMs - tMs);
  for (const sample of series) {
    const dist = Math.abs(sample.tMs - tMs);
    if (dist < bestDist) {
      best = sample;
      bestDist = dist;
    }
  }
  return best.v;
}

// ---------- Confirmed suggestion -> channel spec ----------

/** `decode` -> the `EnetChannelDecodeSpec` this module's own decode functions above implement (single source of truth so a produced spec always matches what `classifyResponders` actually scored). */
const DECODE_SPECS: Readonly<Record<DidHeuristicDecode, EnetChannelDecodeSpec>> = {
  'u8-40': { byteOffset: 0, byteLength: 1, scale: 1, offset: -40 },
  'u16/10': { byteOffset: 0, byteLength: 2, scale: 0.1, offset: 0 },
  u8: { byteOffset: 0, byteLength: 1, scale: 1, offset: 0 },
  i16: { byteOffset: 0, byteLength: 2, signed: true, scale: 1, offset: 0 },
};

/**
 * Builds the `EnetChannelSpec` for a user-CONFIRMED suggestion (addendum:
 * "the user confirms with one tap, which writes an `EnetChannelSpec` with
 * provenance `in-car sweep <date>, DID <hex>, decode <...>` into the channel
 * specs"). `channel` is the caller's mapping from the suggestion's `kind` to
 * an actual `TelemetryChannelId` (the confirmation UI's job, not this pure
 * module's -- a `kind` alone is not a channel).
 *
 * Validates before returning anything (amendment: "validates through
 * `validateEnetChannelSpecs` and rejects forbidden channels, out-of-range
 * DIDs and empty dates") -- throws rather than silently handing back a spec
 * that would just be dropped with a warning downstream.
 */
export function enetSpecsFromSuggestion(
  suggestion: DidHeuristicSuggestion,
  channel: TelemetryChannelId,
  date: string,
): EnetChannelSpec {
  if (!Number.isInteger(suggestion.did) || suggestion.did < 0 || suggestion.did > 0xffff) {
    throw new RangeError(`enetSpecsFromSuggestion: DID out of range [0, 0xFFFF]: ${suggestion.did}`);
  }
  if (date.trim() === '') {
    throw new Error('enetSpecsFromSuggestion: date must not be empty');
  }

  const didHex = `0x${suggestion.did.toString(16).toUpperCase().padStart(4, '0')}`;
  const spec: EnetChannelSpec = {
    channel,
    mode: 'did',
    requestHex: suggestion.did.toString(16).toUpperCase().padStart(4, '0'),
    decode: DECODE_SPECS[suggestion.decode],
    provenance: `in-car sweep ${date}, DID ${didHex}, decode ${suggestion.decode}`,
  };

  const { valid, warnings } = validateEnetChannelSpecs([spec]);
  const validated = valid[0];
  if (validated === undefined) {
    throw new Error(`enetSpecsFromSuggestion: produced an invalid channel spec (${warnings.join('; ')})`);
  }
  return validated;
}
