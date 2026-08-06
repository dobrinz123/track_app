import { z } from 'zod';

import type { CircuitProfile, Gate, LatLon } from '../contracts';

export const CURRENT_SCHEMA_VERSION = 1 as const;

const finiteNumber = z.number().finite();

const latLonSchema: z.ZodType<LatLon> = z
  .object({
    lat: finiteNumber.min(-90).max(90),
    lon: finiteNumber.min(-180).max(180),
  })
  .strict();

const gateSchema: z.ZodType<Gate> = z
  .object({
    id: z.string(),
    kind: z.enum(['startFinish', 'sector', 'pitEntry', 'pitExit']),
    a: latLonSchema,
    b: latLonSchema,
    sectorIndex: z.number().int().optional(),
  })
  .strict();

export const circuitProfileSchema: z.ZodType<CircuitProfile> = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    circuitId: z.string(),
    displayName: z.string(),
    country: z.string(),
    locality: z.string(),
    layoutId: z.string(),
    layoutVersion: z.number().int(),
    source: z
      .object({
        name: z.string(),
        url: z.string().optional(),
        license: z.string().optional(),
        retrievedAt: z.string().optional(),
      })
      .strict(),
    geometryStatus: z.enum(['official', 'community-derived', 'dev-only']),
    sectorStatus: z.enum(['official', 'app-defined']),
    direction: z.enum(['clockwise', 'counterclockwise']),
    centerline: z.array(latLonSchema).max(5000),
    totalLengthM: finiteNumber,
    startFinishGate: gateSchema,
    sectorGates: z.array(gateSchema).max(50),
    pitLane: z
      .object({
        polyline: z.array(latLonSchema).max(1000),
        entryGate: gateSchema,
        exitGate: gateSchema,
      })
      .strict()
      .optional(),
    boundingRegion: z
      .object({ center: latLonSchema, radiusM: finiteNumber })
      .strict(),
    corridorWidthM: finiteNumber,
    alternateLayoutIds: z.array(z.string()).optional(),
    createdAtUtc: z.string(),
    updatedAtUtc: z.string(),
    confidenceNotes: z.string().optional(),
  })
  .strict();

