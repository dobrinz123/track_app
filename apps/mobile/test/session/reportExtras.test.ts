import { describe, expect, it } from 'vitest';

import { collectReportExtras } from '../../src/session/reportExtras';

/**
 * Ticket P13B item 4 -- "if a tool has no report, say so in the document
 * instead of omitting it".
 */

describe('P13B item 4 -- every tool gets a row', () => {
  it('keeps a row for a tool that produced NOTHING, with the reason', () => {
    const extras = collectReportExtras([
      {
        source: 'analysis',
        description: 'post-session analysis',
        read: () => ({ state: 'empty', detail: 'never run for this session' }),
      },
    ]);
    expect(extras).toHaveLength(1);
    expect(extras[0]).toMatchObject({
      source: 'analysis',
      state: 'empty',
      data: null,
      detail: 'never run for this session',
    });
  });

  it('distinguishes "had nothing" from "could not be asked"', () => {
    const extras = collectReportExtras([
      { source: 'a', description: 'a', read: () => ({ state: 'empty', detail: 'nothing to report' }) },
      { source: 'b', description: 'b', read: () => ({ state: 'unavailable', detail: 'not a session tool' }) },
    ]);
    expect(extras.map((e) => e.state)).toEqual(['empty', 'unavailable']);
  });

  it('uses null, never undefined, for an absent payload -- JSON.stringify drops undefined', () => {
    const [extra] = collectReportExtras([
      { source: 'a', description: 'a', read: () => ({ state: 'empty', detail: 'x' }) },
    ]);
    const roundTripped = JSON.parse(JSON.stringify(extra)) as Record<string, unknown>;
    expect('data' in roundTripped).toBe(true);
    expect(roundTripped.data).toBeNull();
  });

  it('turns a throwing read into a failed row and never loses the other tools', () => {
    const extras = collectReportExtras([
      {
        source: 'broken',
        description: 'broken',
        read: () => {
          throw new Error('store is gone');
        },
      },
      { source: 'fine', description: 'fine', read: () => ({ state: 'present', data: { ok: 1 } }) },
    ]);
    expect(extras).toHaveLength(2);
    expect(extras[0]).toMatchObject({ source: 'broken', state: 'failed', data: null });
    expect(extras[0].detail).toContain('store is gone');
    expect(extras[1]).toMatchObject({ source: 'fine', state: 'present', data: { ok: 1 } });
  });

  it('keeps the order it was given, so the roll-call reads the same every time', () => {
    const extras = collectReportExtras(
      ['one', 'two', 'three'].map((source) => ({
        source,
        description: source,
        read: () => ({ state: 'present' as const, data: source }),
      })),
    );
    expect(extras.map((e) => e.source)).toEqual(['one', 'two', 'three']);
  });

  it('carries no detail on a present row -- there is nothing to explain', () => {
    const [extra] = collectReportExtras([
      { source: 'a', description: 'a', read: () => ({ state: 'present', data: 1 }) },
    ]);
    expect(extra.detail).toBeUndefined();
  });
});
