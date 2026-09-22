import type { SessionReportExtra } from './sessionReport';

/**
 * Ticket P13B item 4 (binding, owner's words: "in rest restul toolurilor care
 * sunt in aplicatie trebuie sa faca un raport la export" -- and "if a tool has
 * no report, say so in the document instead of omitting it").
 *
 * The rule this module exists to enforce: EVERY tool in the app gets a row in
 * the session report, whether or not it produced anything. A tool that ran and
 * found nothing, a tool that cannot be asked on this device, and a tool whose
 * read threw are three different facts, and the previous shape -- a bare array
 * of payloads -- could express none of them. An omitted row reads as "no such
 * tool", which is the one thing none of the three mean.
 *
 * Pure, and deliberately generic: this module knows nothing about Signal
 * Finder, learned circuits or the analysis engine. `composition.ts` owns the
 * enumeration (it is the only file that can reach those stores); this owns the
 * discipline that the enumeration is complete and honest.
 */

/** What one tool has to say about one session. */
export type ToolOutcome =
  /** It produced this. `data` goes into the file verbatim. */
  | { state: 'present'; data: unknown }
  /** It was asked and genuinely had nothing for this session. */
  | { state: 'empty'; detail: string }
  /** It could not be asked at all on this device / in this build. */
  | { state: 'unavailable'; detail: string };

export interface ToolExtraSpec {
  /** Stable machine name, e.g. `'signalFinder'`. Becomes the `extras:<source>` availability row. */
  source: string;
  /** One line for a human opening the file: what this tool is. */
  description: string;
  /** Reads the tool. May throw -- a throw becomes a `'failed'` row, never a lost row. */
  read: () => ToolOutcome;
}

/**
 * Runs every spec and returns one extra per spec, in the order given.
 *
 * NEVER THROWS and never drops an entry, for the same reason
 * `loadSessionReportDocument` never rejects on a partial failure: the point of
 * the document is getting what exists off the device, and one tool's broken
 * read must not cost the other five their rows.
 */
export function collectReportExtras(specs: readonly ToolExtraSpec[]): SessionReportExtra[] {
  return specs.map((spec) => {
    let outcome: ToolOutcome | { state: 'failed'; detail: string };
    try {
      outcome = spec.read();
    } catch (error) {
      outcome = {
        state: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      source: spec.source,
      description: spec.description,
      // `null` and not `undefined`: JSON.stringify drops an undefined value
      // and the row would come back out of the file with no `data` key at
      // all, which is exactly the silent omission this module forbids.
      data: outcome.state === 'present' ? outcome.data : null,
      state: outcome.state,
      ...(outcome.state === 'present' ? {} : { detail: outcome.detail }),
    };
  });
}
