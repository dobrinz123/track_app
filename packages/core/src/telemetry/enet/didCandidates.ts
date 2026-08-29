/**
 * DID sweep — results persistence, export & candidate filtering addendum
 * (2026-08-27, binding — Phase 4i, after sweep test 1). Field facts (Supra,
 * MHD ENET, sweep 0x0000–0x53F5): 608 responders in 21494 DIDs, including
 * very large blobs (hundreds of bytes: software/coding tables, ASCII
 * identification strings, e.g. 0x4097/0x4098/0x4113) that are not plausible
 * physical-channel candidates at all, alongside short (1–8 byte) responders
 * that plausibly ARE (e.g. 0x1002).
 *
 * "Candidate filtering (core, pure): observation and heuristics operate on a
 * FILTERED set: length 1–8 bytes, not ASCII-looking (>= 60% printable bytes
 * over length >= 4), and — after a two-sample 'changing values' pre-pass —
 * only DIDs whose bytes changed OR that decode into a plausible physical
 * range. Static responders are kept in the export but excluded from
 * observation."
 *
 * Pure, deterministic -- no I/O, no `@circuit/core` module beyond
 * `didSweep.ts`'s own `DidSweepResponder` shape. `runDidObservation`
 * (`didSweep.ts`) is UNCHANGED: it already accepts an arbitrary
 * `responders: readonly number[]` list, so the caller (mobile controller)
 * simply passes the filtered/candidate DID list through unmodified.
 */

import type { DidSweepResponder } from './didSweep';

export interface FilterSweepCandidatesOptions {
  /** Maximum response byte length still considered a plausible physical-channel candidate (addendum: "length 1-8 bytes"). Responses longer than this are large blobs (coding tables, ASCII identification strings) -- always excluded regardless of content. */
  maxLen?: number;
  /** Fraction of printable-ASCII bytes (0x20-0x7E inclusive) at or above which a response of length >= 4 is treated as an identification STRING rather than a physical value (addendum: ">= 60% printable bytes over length >= 4"). */
  asciiThreshold?: number;
}

const DEFAULT_MAX_LEN = 8;
const DEFAULT_ASCII_THRESHOLD = 0.6;
/** Below this length, a response is too short for "looks like text" to mean anything -- a 1-3 byte value is judged on length/content plausibility alone, never excluded on ASCII grounds (addendum: "over length >= 4"). */
const ASCII_MIN_LEN = 4;

/**
 * True when `bytes` reads as a printable-ASCII identification string rather
 * than a physical value: at least `threshold` (default 60%) of its bytes
 * fall in the printable-ASCII range `[0x20, 0x7E]`, AND its length is at
 * least {@link ASCII_MIN_LEN} (a response shorter than that is never judged
 * ASCII-like, regardless of content -- addendum: "over length >= 4").
 */
export function isAsciiLike(bytes: Uint8Array, threshold: number = DEFAULT_ASCII_THRESHOLD): boolean {
  if (bytes.length < ASCII_MIN_LEN) return false;
  let printable = 0;
  for (const byte of bytes) {
    if (byte >= 0x20 && byte <= 0x7e) printable += 1;
  }
  return printable / bytes.length >= threshold;
}

/**
 * Filters raw sweep responders down to the set observation/heuristics
 * operate on (addendum): length in `[1, maxLen]` (default 8) AND NOT
 * {@link isAsciiLike}. Excluded responders (large blobs, ASCII strings) are
 * still kept in the EXPORT (the mobile export builder's job, not this
 * function's) -- this is purely the candidate-selection filter for
 * observation/heuristics.
 */
export function filterSweepCandidates(
  responders: readonly DidSweepResponder[],
  options: FilterSweepCandidatesOptions = {},
): DidSweepResponder[] {
  const maxLen = options.maxLen ?? DEFAULT_MAX_LEN;
  const asciiThreshold = options.asciiThreshold ?? DEFAULT_ASCII_THRESHOLD;
  return responders.filter(
    (responder) =>
      responder.length >= 1 && responder.length <= maxLen && !isAsciiLike(responder.raw, asciiThreshold),
  );
}

/**
 * Ticket P4j (binding): "Mid-size blocks (9-32 bytes) join the candidate pool
 * with per-byte-offset diffing ... ASCII-like blocks still excluded." This is
 * the WIDENED candidate pool `filterSweepCandidates` (still 1-8 bytes,
 * unchanged, kept for every existing caller) does not cover: the SAME
 * length-floor and ASCII exclusion, just with the ceiling raised from 8 to
 * `midSizeMaxLen` (default 32) so a mid-size block (e.g. a 10-byte struct
 * with a couple of live byte offsets) is no longer dropped outright. Ranking
 * a mid-size candidate's OWN offsets is `didObservationPhases.ts`'s
 * `computeDidBlockCandidateSummaries`' job -- this function only decides
 * which responders are worth observing at all.
 */
export interface FilterCandidatePoolOptions extends FilterSweepCandidatesOptions {
  /** Default 32 (ticket: "Mid-size blocks (9-32 bytes)"). */
  midSizeMaxLen?: number;
}

const DEFAULT_MID_SIZE_MAX_LEN = 32;

export function filterCandidatePool(
  responders: readonly DidSweepResponder[],
  options: FilterCandidatePoolOptions = {},
): DidSweepResponder[] {
  return filterSweepCandidates(responders, { ...options, maxLen: options.midSizeMaxLen ?? DEFAULT_MID_SIZE_MAX_LEN });
}

/** One DID's two-sample "changing values" pre-pass input (addendum: "each candidate read twice ~2s apart while the user blips the throttle/steers"). */
export interface DidChangeSamplePair {
  did: number;
  first: Uint8Array;
  second: Uint8Array;
}

/**
 * "Plausible physical range" reuses the SAME temperature-like decode bounds
 * `didHeuristics.ts`'s `scoreTemperature` already establishes (u8-40:
 * -40..150; u16/10: -40..300) -- a length-matched decode landing in either
 * range is treated as a plausible real reading even from a single (static)
 * sample, rather than the sentinel-looking values (`0x00`/`0x00`,
 * `0xFF`/`0xFF`, etc.) a placeholder/uninitialized/error field tends to
 * report. Duplicated here (not imported) rather than reaching into
 * `didHeuristics.ts`'s private scoring internals -- these two constants are
 * the only piece this module needs, and re-deriving them keeps this module
 * usable standalone (it must run BEFORE any multi-sample series exists for
 * `classifyResponders` to score).
 */
function decodesToPlausiblePhysicalValue(raw: Uint8Array): boolean {
  if (raw.length === 1) {
    const value = (raw[0] ?? 0) - 40;
    return value >= -40 && value <= 150;
  }
  if (raw.length === 2) {
    const value = (((raw[0] ?? 0) << 8) | (raw[1] ?? 0)) / 10;
    return value >= -40 && value <= 300;
  }
  return false;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/**
 * The two-sample "changing values" pre-pass (addendum): a DID is selected as
 * a genuine observation candidate if its bytes CHANGED between the two
 * samples, OR (for a STATIC responder) its (length-matched) decode falls
 * into a plausible physical range. A static responder that decodes to
 * nothing plausible (or whose length matches no known decode at all) is
 * dropped from observation -- it is still kept in the full EXPORT.
 */
/**
 * Coordinator addendum to P4j-FIX1 (binding, from field evidence): "the
 * pre-pass is ADVISORY only -- it may ORDER candidates (changed-first) but
 * must never EXCLUDE a DID from the batched phases."
 *
 * Field evidence: in the user's guided run, DME DIDs 0x4A1D (brake booster
 * sensor), 0x4811/0x4812 (accelerator) all answered the sweep but were NEVER
 * observed in the phases -- {@link selectChangingCandidates} dropped them as
 * "static" because the user simply did not press the brake during the
 * two-sample pre-pass. A pre-pass that runs BEFORE the guided prompts cannot
 * possibly know whether a DID would have moved; using it as a filter throws
 * away exactly the DIDs the guided phases exist to find.
 *
 * Returns EVERY DID in `allDids` (a permutation, never a subset), with the
 * DIDs whose bytes changed between the two pre-pass reads first, each group
 * keeping its original relative order (deterministic). A DID with no pre-pass
 * pair at all (it never answered either round) sorts with the unchanged group
 * -- observed last, but always observed.
 */
export function orderChangingCandidatesFirst(
  pairs: readonly DidChangeSamplePair[],
  allDids: readonly number[],
): number[] {
  const changedDids = new Set(selectChangingCandidates(pairs.filter((pair) => !bytesEqual(pair.first, pair.second))));
  const changed: number[] = [];
  const rest: number[] = [];
  for (const did of allDids) (changedDids.has(did) ? changed : rest).push(did);
  return [...changed, ...rest];
}

export function selectChangingCandidates(pairs: readonly DidChangeSamplePair[]): number[] {
  const kept: number[] = [];
  for (const pair of pairs) {
    const changed = !bytesEqual(pair.first, pair.second);
    if (changed || decodesToPlausiblePhysicalValue(pair.second)) kept.push(pair.did);
  }
  return kept;
}
