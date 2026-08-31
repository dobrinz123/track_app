import { z } from 'zod';

import type { CircuitProfile, Corner } from '../contracts';
import { CORNER_ANALYSIS_VERSION } from '../contracts';
import { analyzeCorners } from '../corners';
import { loadProfileFromJson, type RuntimeProfile } from '../profile';

import { isLearnedGeometry } from './testLoopCircuit';

/**
 * Ticket P5d T4/T6 -- the on-disk form of a learned circuit.
 *
 * A learned circuit is worth nothing if it cannot be read back after the app
 * restarts, and it is worse than nothing if it can be read back WRONG. So the
 * profile half goes out and comes back through `loadProfileFromJson` -- the
 * same validation the bundled circuit assets get -- and the corner half is
 * schema-checked here rather than trusted.
 *
 * Corners are stored, not recomputed, because they are not purely geometric:
 * a learned corner set carries the driver's own speed-drop evidence
 * (`deriveTestLoopCorners`), which the centreline alone cannot reproduce. When
 * the stored corners are unreadable the decoder falls back to
 * `analyzeCorners` over the stored geometry and SAYS SO (`cornersRecovered`),
 * so the caller can tell a full learned circuit from a salvaged one.
 */

export const LEARNED_CIRCUIT_ENVELOPE_VERSION = 1;

const cornerSchema: z.ZodType<Corner> = z
  .object({
    id: z.number().int().positive(),
    entryDistanceM: z.number().finite().nonnegative(),
    apexDistanceM: z.number().finite().nonnegative(),
    exitDistanceM: z.number().finite().nonnegative(),
    lengthM: z.number().finite().nonnegative(),
    minRadiusM: z.number().finite().positive(),
    totalAngleDeg: z.number().finite().nonnegative(),
    direction: z.enum(['left', 'right']),
    severity: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(5),
      z.literal(6),
    ]),
    advisorySpeedKph: z.number().finite().positive(),
    speedSource: z.enum(['model', 'observed']).optional(),
  })
  .strict();

const envelopeSchema = z
  .object({
    envelopeVersion: z.number().int().positive(),
    cornerAnalysisVersion: z.number().int().nonnegative(),
    profile: z.unknown(),
    corners: z.array(cornerSchema).max(200),
  })
  .strict();

export interface LearnedCircuitEnvelope {
  envelopeVersion: number;
  cornerAnalysisVersion: number;
  profile: CircuitProfile;
  corners: Corner[];
}

export type DecodedLearnedCircuit =
  | {
      ok: true;
      profile: CircuitProfile;
      runtime: RuntimeProfile;
      corners: Corner[];
      /** True when the stored corner set could not be used and was re-derived from the geometry. */
      cornersRecovered: boolean;
      cornerAnalysisVersion: number;
    }
  | { ok: false; errors: string[] };

/** Serializes a learned circuit for storage. */
export function encodeLearnedCircuit(profile: CircuitProfile, corners: readonly Corner[]): string {
  const envelope: LearnedCircuitEnvelope = {
    envelopeVersion: LEARNED_CIRCUIT_ENVELOPE_VERSION,
    cornerAnalysisVersion: CORNER_ANALYSIS_VERSION,
    profile,
    corners: [...corners],
  };
  return JSON.stringify(envelope);
}

/** Reads a stored learned circuit back, validating the profile exactly as a bundled asset is validated. */
export function decodeLearnedCircuit(json: string): DecodedLearnedCircuit {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, errors: ['INVALID_JSON'] };
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: ['INVALID_ENVELOPE'] };
  if (parsed.data.envelopeVersion > LEARNED_CIRCUIT_ENVELOPE_VERSION) {
    return { ok: false, errors: ['UNSUPPORTED_ENVELOPE_VERSION'] };
  }

  const loaded = loadProfileFromJson(JSON.stringify(parsed.data.profile));
  if (!loaded.ok) return { ok: false, errors: loaded.errors };
  // P5d-FIX1 H2: a profile read back from storage is frozen before ANY caller
  // sees it -- the store, the catalog and every screen share this one object,
  // and geometryStatus is what the honesty gates read off it.
  Object.freeze(loaded.profile);
  if (!isLearnedGeometry(loaded.profile)) {
    // A stored learned circuit that claims surveyed geometry is refused
    // outright: this is the one field the honesty gates read.
    return { ok: false, errors: ['NOT_LEARNED_GEOMETRY'] };
  }

  const corners = parsed.data.corners;
  if (corners.length === 0) {
    return {
      ok: true,
      profile: loaded.profile,
      runtime: loaded.runtime,
      corners: analyzeCorners(loaded.runtime),
      cornersRecovered: true,
      cornerAnalysisVersion: parsed.data.cornerAnalysisVersion,
    };
  }
  return {
    ok: true,
    profile: loaded.profile,
    runtime: loaded.runtime,
    corners,
    cornersRecovered: false,
    cornerAnalysisVersion: parsed.data.cornerAnalysisVersion,
  };
}
