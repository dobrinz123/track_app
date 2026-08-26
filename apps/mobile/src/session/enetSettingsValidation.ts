/**
 * ENET telemetry addendum (contracts.md, 2026-08-27, binding, Phase 4e).
 * Shared pure validation for the ENET-specific settings fields and the
 * dev-only DID-probe screen's request builder -- same "one module, imported
 * by BOTH the on-device UI validation AND the provider that re-validates
 * whatever ends up persisted" pattern as `customPidValidation.ts` (the
 * ELM327-side equivalent for `transOilPidHex`). Pure module: no react-native,
 * no react import -- only `@circuit/core` (itself dependency-free of any
 * mobile/RN code), so this is directly importable by vitest.
 */
import {
  assertAllowedRequest,
  buildObdMode01Request,
  buildReadDataByIdentifierRequest,
  DEFAULT_ENET_CHANNEL_SPECS,
  validateEnetChannelSpecs,
  type EnetChannelSpec,
} from '@circuit/core';

// ---------------------------------------------------------------------------
// Hex-byte fields (enetTesterAddress / enetTargetAddress): 00-FF.
// ---------------------------------------------------------------------------

/** Exact user-facing message shown inline for an invalid hex-byte draft. */
export const HEX_BYTE_VALIDATION_ERROR = 'Enter a hex byte, 00-FF';

/**
 * Validates a FULL hex-byte draft string (same "validate the whole string on
 * blur, not keystroke-by-keystroke" pattern as `SettingsScreen.tsx`'s
 * `parsePortDraft`/`parseHexPidDraft`). Accepts an optional leading `0x`/`0X`
 * and 1-2 hex digits; `null` for anything else (empty, too long, non-hex, out
 * of the 00-FF byte range).
 */
export function parseHexByteDraft(text: string): number | null {
  const compact = text.trim().replace(/^0[Xx]/, '');
  if (!/^[0-9A-Fa-f]{1,2}$/.test(compact)) return null;
  const value = Number.parseInt(compact, 16);
  if (!Number.isInteger(value) || value < 0 || value > 0xff) return null;
  return value;
}

/** Renders a byte as the 2-digit uppercase hex `SettingsScreen`'s address fields display (e.g. `0xf4` -> `"F4"`). */
export function formatHexByte(value: number): string {
  return value.toString(16).toUpperCase().padStart(2, '0');
}

// ---------------------------------------------------------------------------
// enetChannelSpecsJson: a JSON array of `EnetChannelSpec`, or '' for defaults.
// ---------------------------------------------------------------------------

/** Exact user-facing message shown inline when the draft is not valid JSON, or not an array. */
export const ENET_CHANNEL_SPECS_JSON_ERROR = 'Not a valid JSON array of channel specs';

export interface EnetChannelSpecsJsonValidation {
  /** `false` only for malformed JSON or a non-array result -- an array of individually-invalid entries is still `ok: true` (each bad entry is dropped, not the whole draft rejected), matching `validateEnetChannelSpecs`'s own per-entry warnings model. */
  ok: boolean;
  /** Meaningful only when `ok` -- the specs that survived `validateEnetChannelSpecs`. Empty (`[]`) for an empty/whitespace-only draft ("use the built-in defaults" -- callers building an engine config substitute `DEFAULT_ENET_CHANNEL_SPECS` themselves via `resolveEnetChannelSpecs` below; this validator reports the draft's OWN content literally, so an explicit `"[]"` reads as "zero channels", not "defaults"). */
  specs: readonly EnetChannelSpec[];
  /** Per-entry warnings from `validateEnetChannelSpecs` (duplicate channel, rejected spec, ...) -- shown inline, non-blocking. */
  warnings: readonly string[];
  /** Non-null exactly when `!ok`. */
  error: string | null;
}

/**
 * Validates a FULL `enetChannelSpecsJson` draft string on blur. An
 * empty/whitespace-only draft is valid (`specs: []`, meaning "built-in
 * defaults" -- see `resolveEnetChannelSpecs`). A non-empty draft must parse as
 * a JSON array; each element is then run through `@circuit/core`'s
 * `validateEnetChannelSpecs` (device-sensor channels, malformed `requestHex`,
 * a `did` spec missing `decode`/`provenance`, duplicate channels -- see that
 * function's own doc comment) which drops bad entries with a warning rather
 * than rejecting the whole draft.
 */
export function validateEnetChannelSpecsJson(text: string): EnetChannelSpecsJsonValidation {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, specs: [], warnings: [], error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, specs: [], warnings: [], error: ENET_CHANNEL_SPECS_JSON_ERROR };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, specs: [], warnings: [], error: ENET_CHANNEL_SPECS_JSON_ERROR };
  }

  const { valid, warnings } = validateEnetChannelSpecs(parsed as EnetChannelSpec[]);
  return { ok: true, specs: valid, warnings, error: null };
}

/**
 * Resolves a persisted `enetChannelSpecsJson` value into the channel specs
 * `telemetryProvider.ts` builds the ENET engine with -- the provider's own
 * "never trust a persisted value blindly" re-validation, called fresh on
 * every `start()` (same freshness/defense rule as `buildCustomPids` for
 * `transOilPidHex`). Empty/whitespace -> `DEFAULT_ENET_CHANNEL_SPECS`.
 * Malformed JSON / non-array (should never happen through the validated UI,
 * but may reach here from a persisted value saved before this rule existed)
 * also falls back to the built-in defaults, with a `console.warn` -- ENET
 * telemetry must never fail to start because of a corrupt settings string.
 * A syntactically valid but entirely-empty array (`"[]"`) is respected
 * literally (zero channels polled) -- that is a deliberate, distinguishable
 * user choice, not a malformed draft.
 */
export function resolveEnetChannelSpecs(channelSpecsJson: string): readonly EnetChannelSpec[] {
  if (channelSpecsJson.trim() === '') return DEFAULT_ENET_CHANNEL_SPECS;
  const result = validateEnetChannelSpecsJson(channelSpecsJson);
  if (!result.ok) {
    console.warn(
      `[enetSettingsValidation] Dropping persisted enetChannelSpecsJson: ${result.error} -- using built-in defaults`,
    );
    return DEFAULT_ENET_CHANNEL_SPECS;
  }
  for (const warning of result.warnings) console.warn(`[enetSettingsValidation] ${warning}`);
  return result.specs;
}

// ---------------------------------------------------------------------------
// Dev-only DID-probe screen (`DidProbeScreen.tsx`): request PDU building.
// ---------------------------------------------------------------------------

export type DidProbeMode = 'did' | 'obd01';

export interface DidProbeRequestResult {
  ok: boolean;
  /** Non-null exactly when `ok` -- the whitelisted UDS request PDU, ready to frame and send. */
  pdu: Uint8Array | null;
  /** Non-null exactly when `!ok`. */
  error: string | null;
}

/**
 * Builds the ONE UDS request PDU the DID-probe screen's "Send" button fires:
 * mode `'did'` (ReadDataByIdentifier, SID 0x22) needs exactly 4 hex
 * characters (one DID); mode `'obd01'` (SID 0x01) needs exactly 2 hex
 * characters (one PID). Internal spaces in the draft are ignored; the
 * comparison is case-insensitive.
 *
 * Read-only mandate (contracts.md ENET addendum, binding): re-checks
 * `assertAllowedRequest` on the built PDU before returning it -- the SAME
 * defense-in-depth re-check `enetSession.ts`'s own `executeDiagnosticRequest`
 * performs immediately before sending, even though `buildReadDataByIdentifierRequest`/
 * `buildObdMode01Request` only ever emit a whitelisted SID (0x22/0x01) by
 * construction. "Nothing outside {0x01, 0x22, 0x3E} can be sent -- the
 * whitelist error is shown, not bypassed": a rejection surfaces here as an
 * ordinary `{ ok: false, error }` result, exactly like a malformed hex draft,
 * so the screen can show it inline without any special-casing.
 */
export function buildDidProbeRequest(mode: DidProbeMode, requestHexDraft: string): DidProbeRequestResult {
  const compact = requestHexDraft.replace(/\s+/g, '');
  if (compact.length === 0 || !/^[0-9A-Fa-f]+$/.test(compact)) {
    return { ok: false, pdu: null, error: 'Enter hex digits only' };
  }

  const expectedLength = mode === 'did' ? 4 : 2;
  if (compact.length !== expectedLength) {
    return {
      ok: false,
      pdu: null,
      error:
        mode === 'did'
          ? `DID request must be exactly 4 hex characters, got ${compact.length}`
          : `PID request must be exactly 2 hex characters, got ${compact.length}`,
    };
  }

  try {
    const value = Number.parseInt(compact, 16);
    const pdu = mode === 'did' ? buildReadDataByIdentifierRequest(value) : buildObdMode01Request(value);
    assertAllowedRequest(pdu);
    return { ok: true, pdu, error: null };
  } catch (error) {
    return { ok: false, pdu: null, error: error instanceof Error ? error.message : String(error) };
  }
}
