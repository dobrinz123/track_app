import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import {
  buildSessionReportMarkdown,
  sessionReportFileName,
  type SessionReportDocument,
} from './sessionReport';

/**
 * Ticket P13B item 3 (binding, owner's words: "fisierul o sa se salveze in app
 * si o sa fie exportabil la un singur tap de buton simplu si efficient").
 *
 * ONE TAP. This function is the whole export: it writes the complete document
 * into the app's own storage and hands it to the share sheet, with no format
 * choice, no picker and no second step. The `.md` companion is written beside
 * it without being asked about, because the owner forwarding the file and the
 * tool parsing it are different readers and neither should have to choose.
 *
 * Split from `sessionReport.ts` for the same mechanical reason
 * `rawSessionShare.ts` is split from `rawSessionExport.ts`: `composition.ts`
 * imports the document module and must stay importable by vitest, and both
 * `expo-file-system` and `expo-sharing` reach `react-native`, whose Flow-typed
 * source Vite cannot parse. Everything that decides anything is over there and
 * tested; this file only writes bytes.
 *
 * NEVER THROWS. A session report that cannot be shared has still been WRITTEN,
 * and the result says where -- losing the file because the share sheet was
 * unavailable would defeat the only purpose this build has.
 */

export interface SessionReportShareResult {
  /** True whenever the export succeeded in a user-facing sense -- the no-share-sheet fallback included. */
  ok: boolean;
  /** True only when the OS share sheet was genuinely invoked. */
  shared: boolean;
  jsonUri: string | null;
  markdownUri: string | null;
  jsonLength: number;
  markdownLength: number;
  error?: string;
}

export async function shareSessionReport(
  doc: SessionReportDocument,
): Promise<SessionReportShareResult> {
  const json = JSON.stringify(doc);
  const markdown = buildSessionReportMarkdown(doc);
  try {
    const jsonFile = new File(Paths.cache, sessionReportFileName(doc, 'json'));
    jsonFile.write(json);
    const markdownFile = new File(Paths.cache, sessionReportFileName(doc, 'md'));
    markdownFile.write(markdown);

    const available = await Sharing.isAvailableAsync();
    if (!available) {
      console.log(
        `[sessionReport] Sharing unavailable on this platform -- JSON ${String(json.length)} bytes, summary ${String(markdown.length)} bytes, both written to the cache`,
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
    // The JSON is what the sheet gets, exactly as the raw export decided: the
    // reason this button exists is that the DATA has to leave the phone.
    await Sharing.shareAsync(jsonFile.uri, {
      mimeType: 'application/json',
      dialogTitle: `Session report ${doc.session.sessionId}`,
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
    console.log(
      `[sessionReport] export failed -- JSON is ${String(json.length)} bytes: ${message}`,
    );
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
