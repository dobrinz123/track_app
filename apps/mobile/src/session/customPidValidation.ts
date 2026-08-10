/**
 * F1 HIGH fix (binding, shared by defense layers L1 + L2): Circuit Timer is
 * read-only OBD telemetry -- "advisory, experimental... strictly read-only,
 * never used for lap timing or safety decisions" (`SettingsScreen.tsx`'s own
 * copy). The user-configurable `transOilPidHex` custom request is the ONE
 * place a raw hex string, typed by the user, reaches the vehicle verbatim --
 * so it must be restricted to read-only UDS/OBD services: mode 21
 * (read-by-local-ID) and mode 22 (read-by-DID, `contracts.md`'s own
 * transOilC example). Every other service -- 01 (mode-01 collisions with a
 * channel this app already decodes correctly, e.g. `015C`), 04 (clear
 * DTCs/freeze frame -- destructive), 08 (request control of an
 * onboard system -- destructive), 2F (I/O control -- destructive), 3E
 * (tester present, harmless but pointless here), or anything else -- is
 * rejected.
 *
 * This module is the SINGLE source of truth for that rule, imported by BOTH:
 *  - L1 `SettingsScreen.tsx`'s `parseHexPidDraft` (on-device UI validation,
 *    blur/submit)
 *  - L2 `telemetryProvider.ts`'s `buildCustomPids` (re-validates whatever is
 *    persisted in `settings.transOilPidHex` on every `start()`, defending a
 *    value saved before this rule existed, or written by any other future
 *    caller of `settingsStore.update`)
 *
 * `packages/core`'s `elm327Session.ts` (L3) is the THIRD, independent
 * defense layer -- it cannot import this module (mobile app code may not be
 * a dependency of the shared core package), so it re-implements the same
 * service-byte check on its own, deliberately duplicated rather than shared,
 * so no single bug in one layer can ever let a non-read request through all
 * three.
 *
 * Pure module: no react-native, no @circuit/core, no react import -- directly
 * importable by vitest under this repo's plain-Node `vitest.config.ts`
 * (unlike `SettingsScreen.tsx` itself, whose react-native import breaks the
 * parser -- see `settingsPortDraft.test.ts`'s own doc comment for that
 * constraint).
 */

/** Exact user-facing message L1 shows inline, and L2's `console.warn` prefix references. */
export const CUSTOM_PID_VALIDATION_ERROR = 'Only read services 21/22 allowed';

const ALLOWED_SERVICE_PREFIXES = new Set(['21', '22']);

export interface CustomPidHexValidation {
  /** `true` for an empty/whitespace-only draft ("disabled") or a value whose compact hex passes the read-service whitelist below. */
  ok: boolean;
  /** Meaningful only when `ok` -- outer-whitespace trimmed (`''` means "disabled"); internal spacing, if any, is preserved unchanged. */
  value: string;
  /** Non-null exactly when `!ok` -- `CUSTOM_PID_VALIDATION_ERROR` for every rejection reason (malformed hex, wrong service byte alike) so the UI never has to distinguish them. */
  error: string | null;
}

/**
 * L1/L2 shared validator for a FULL `transOilPidHex` draft string (validate
 * the whole string at once, not keystroke-by-keystroke -- same pattern as
 * `SettingsScreen.tsx`'s `parsePortDraft`). Hex characters (0-9, A-F/a-f) and
 * spaces only; a non-empty value is valid ONLY if its compact (spaces
 * removed) hex is even-length and at least 4 characters, AND its first two
 * hex characters (the service byte) are `21` or `22`.
 */
export function validateCustomPidHex(text: string): CustomPidHexValidation {
  if (!/^[0-9A-Fa-f ]*$/.test(text)) {
    return { ok: false, value: text, error: CUSTOM_PID_VALIDATION_ERROR };
  }
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: true, value: '', error: null };
  }
  if (!isAllowedCustomPidRequest(trimmed)) {
    return { ok: false, value: text, error: CUSTOM_PID_VALIDATION_ERROR };
  }
  return { ok: true, value: trimmed, error: null };
}

/**
 * L2-reusable check on an already-trimmed (but not necessarily
 * already-validated -- a persisted `transOilPidHex` may predate this rule)
 * request string: `true` only for a non-empty, even-length (>= 4 hex
 * characters) compact hex string whose service byte (first two hex
 * characters) is `21` or `22`. Internal spacing is stripped before checking,
 * same "byte-grouping notation" tolerance as `validateCustomPidHex` above.
 */
export function isAllowedCustomPidRequest(request: string): boolean {
  const compact = request.replace(/\s+/g, '');
  if (compact.length < 4 || compact.length % 2 !== 0) return false;
  if (!/^[0-9A-F]+$/i.test(compact)) return false;
  const servicePrefix = compact.slice(0, 2).toUpperCase();
  return ALLOWED_SERVICE_PREFIXES.has(servicePrefix);
}
