import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import {
  buildRawSessionSummaryMarkdown,
  rawSessionExportFileName,
  type RawSessionExportDocument,
} from './rawSessionExport';

/**
 * Ticket P7R E1 — writing and sharing a {@link RawSessionExportDocument}.
 *
 * Split out of `rawSessionExport.ts` for one mechanical reason worth
 * recording: `composition.ts` imports that module, and `composition.ts` must
 * stay importable by vitest. `expo-file-system` and `expo-sharing` both reach
 * `react-native`, whose Flow-typed source Vite cannot parse -- one such
 * import anywhere in composition's graph fails every suite that imports it.
 * So the document, the readers and the loader are pure TypeScript over there,
 * and the two functions that actually touch the device live here, imported
 * only by the screens.
 */

// ---------------------------------------------------------------------------
// Share — the same never-throws contract `analysisExport.ts` established.
// ---------------------------------------------------------------------------

export interface RawSessionShareResult {
  /** True whenever the export succeeded in a user-facing sense — the unavailable-platform fallback included. */
  ok: boolean;
  /** True only when the OS share sheet was genuinely invoked. */
  shared: boolean;
  jsonUri: string | null;
  markdownUri: string | null;
  jsonLength: number;
  markdownLength: number;
  error?: string;
}

/**
 * One tap: writes BOTH files and hands the JSON to the share sheet.
 *
 * The opposite default from `shareAnalysisExport`, on purpose. There, the
 * human-readable summary is what the driver forwards. Here the whole reason
 * the button exists is that the raw data has to get OFF the phone and into a
 * parser — so the JSON is what the sheet gets, and the `.md` is written
 * alongside for whoever opens the folder.
 *
 * Never throws.
 */
export async function shareRawSessionExport(
  doc: RawSessionExportDocument,
): Promise<RawSessionShareResult> {
  const json = JSON.stringify(doc);
  const markdown = buildRawSessionSummaryMarkdown(doc);
  try {
    const jsonFile = new File(Paths.cache, rawSessionExportFileName(doc, 'json'));
    jsonFile.write(json);
    const markdownFile = new File(Paths.cache, rawSessionExportFileName(doc, 'md'));
    markdownFile.write(markdown);

    const available = await Sharing.isAvailableAsync();
    if (!available) {
      console.log(
        `[rawSessionExport] Sharing unavailable on this platform -- JSON ${json.length} bytes, summary ${markdown.length} bytes, both written to the cache`,
      );
      return {
        ok: true,
        shared: false,
        jsonUri: jsonFile.uri,
        markdownUri: markdownFile.uri,
        jsonLength: json.length,
        markdownLength: markdown.length,
      };
    }
    await Sharing.shareAsync(jsonFile.uri, {
      mimeType: 'application/json',
      dialogTitle: `Raw session ${doc.session.sessionId}`,
    });
    return {
      ok: true,
      shared: true,
      jsonUri: jsonFile.uri,
      markdownUri: markdownFile.uri,
      jsonLength: json.length,
      markdownLength: markdown.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[rawSessionExport] export failed -- JSON is ${json.length} bytes: ${message}`);
    return {
      ok: false,
      shared: false,
      jsonUri: null,
      markdownUri: null,
      jsonLength: json.length,
      markdownLength: markdown.length,
      error: message,
    };
  }
}

