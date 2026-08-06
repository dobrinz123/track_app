import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InMemorySessionRepository } from '../../src/persistence';
import type { ReferenceLap } from '../../src/contracts';

const USER_IDS = ['user-1', 'user-2'] as const;
const CIRCUIT_IDS = ['circuit-a', 'circuit-b'] as const;
const LAYOUT_IDS = ['layout-1', 'layout-2'] as const;
const LAYOUT_VERSIONS = [1, 2] as const;

interface Op {
  userId: (typeof USER_IDS)[number];
  circuitId: (typeof CIRCUIT_IDS)[number];
  layoutId: (typeof LAYOUT_IDS)[number];
  layoutVersion: (typeof LAYOUT_VERSIONS)[number];
  durationMs: number;
  tag: string;
}

function keyOf(userId: string, circuitId: string, layoutId: string, layoutVersion: number): string {
  return `${userId}|${circuitId}|${layoutId}|${layoutVersion}`;
}

function buildReferenceLap(op: Op): ReferenceLap {
  return {
    circuitId: op.circuitId,
    layoutId: op.layoutId,
    layoutVersion: op.layoutVersion,
    userId: op.userId,
    durationMs: op.durationMs,
    sectorTimes: [{ sectorIndex: 0, durationMs: op.durationMs, quality: 'good' }],
    recordedAtUtc: '2024-01-01T00:00:00.000Z',
    sessionId: `session-${op.tag}`,
    lapNumber: 1,
    distanceGridM: [0, 100],
    elapsedMsAtGrid: [0, op.durationMs],
    gnssQualitySummary: { level: 'good', reasons: [] },
    appVersion: '1.0.0',
    algorithmVersion: 1,
    profileSchemaVersion: 1,
  };
}

const opArb: fc.Arbitrary<Op> = fc.record({
  userId: fc.constantFrom(...USER_IDS),
  circuitId: fc.constantFrom(...CIRCUIT_IDS),
  layoutId: fc.constantFrom(...LAYOUT_IDS),
  layoutVersion: fc.constantFrom(...LAYOUT_VERSIONS),
  durationMs: fc.integer({ min: 1, max: 1_000_000 }),
  tag: fc.uuid(),
});

describe('InMemorySessionRepository - putReferenceLap property', () => {
  it('getReferenceLap always returns the last stored value for its exact key, never a value from a different key', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 0, maxLength: 40 }), async (ops) => {
        const repo = new InMemorySessionRepository();
        // Model: last-write-wins per composite key, tracked independently of the repo under test.
        const model = new Map<string, ReferenceLap>();

        for (const op of ops) {
          const ref = buildReferenceLap(op);
          await repo.putReferenceLap(ref);
          model.set(keyOf(op.userId, op.circuitId, op.layoutId, op.layoutVersion), ref);
        }

        for (const userId of USER_IDS) {
          for (const circuitId of CIRCUIT_IDS) {
            for (const layoutId of LAYOUT_IDS) {
              for (const layoutVersion of LAYOUT_VERSIONS) {
                const expected = model.get(keyOf(userId, circuitId, layoutId, layoutVersion)) ?? null;
                const actual = await repo.getReferenceLap(userId, circuitId, layoutId, layoutVersion);
                expect(actual).toEqual(expected);
              }
            }
          }
        }
      }),
      { numRuns: 50 },
    );
  });
});
