import { z } from 'zod';

import type { LocationSample } from '../contracts';

import type { ValidationTrace } from './assessGeometryDeviation';

export const VALIDATION_EXPORT_VERSION = 1;
export const MAX_VALIDATION_EXPORT_BYTES = 20 * 1024 * 1024;

export interface ValidationExport {
  version: typeof VALIDATION_EXPORT_VERSION;
  circuitId: string;
  layoutVersion: number;
  driverId: string;
  cleanLapCount: number;
  createdAtUtc: string;
  samples: LocationSample[];
}

export type ValidationExportInput = Omit<ValidationExport, 'version'>;

export type ValidationExportDecodeResult =
  { ok: true; value: ValidationExport } | { ok: false; errors: string[] };

const finite = z.number().finite();

const sampleSchema = z
  .object({
    tMono: finite,
    tUtc: finite.optional(),
    lat: finite.min(-90).max(90),
    lon: finite.min(-180).max(180),
    accuracyM: finite.nonnegative().optional(),
    speedMps: finite.nonnegative().optional(),
    headingDeg: finite.min(0).max(360).optional(),
    altitudeM: finite.optional(),
    source: z.enum(['gnss', 'replay', 'fused']),
  })
  .strict();

const exportSchema = z
  .object({
    version: z.literal(VALIDATION_EXPORT_VERSION),
    circuitId: z.string().trim().min(1).max(200),
    layoutVersion: z.number().int().positive(),
    driverId: z.string().trim().min(1).max(200),
    cleanLapCount: z.number().int().nonnegative(),
    createdAtUtc: z.string().datetime(),
    samples: z.array(sampleSchema),
  })
  .strict();

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length === 0 ? '<root>' : issue.path.join('.');
    return `STRUCTURE:${path}: ${issue.message}`;
  });
}

export function encodeValidationExport(input: ValidationExportInput): string {
  const parsed = exportSchema.safeParse({ version: VALIDATION_EXPORT_VERSION, ...input });
  if (!parsed.success) {
    throw new RangeError(`invalid validation export: ${issuesOf(parsed.error).join('; ')}`);
  }
  const json = JSON.stringify(parsed.data);
  if (json.length > MAX_VALIDATION_EXPORT_BYTES) {
    throw new RangeError('validation export exceeds the maximum size');
  }
  return json;
}

export function decodeValidationExport(json: string): ValidationExportDecodeResult {
  if (json.length > MAX_VALIDATION_EXPORT_BYTES) {
    return { ok: false, errors: ['SIZE: validation export exceeds the maximum size'] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, errors: ['JSON: validation export is not valid JSON'] };
  }
  const parsed = exportSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: issuesOf(parsed.error) };
  return { ok: true, value: parsed.data as ValidationExport };
}

export function toValidationTrace(value: ValidationExport): ValidationTrace {
  return {
    driverId: value.driverId,
    cleanLapCount: value.cleanLapCount,
    samples: value.samples,
  };
}
