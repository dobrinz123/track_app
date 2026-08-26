/**
 * ENET telemetry addendum (contracts.md, 2026-08-27, binding, Phase 4e).
 * Shared pure validation for the ENET-specific settings fields -- same
 * "one module, imported by BOTH the on-device UI validation AND the provider
 * that re-validates whatever ends up persisted" pattern as
 * `customPidValidation.ts` (the ELM327-side equivalent for `transOilPidHex`).
 * Pure module: no react-native, no react import -- only `@circuit/core`
 * (itself dependency-free of any mobile/RN code), so this is directly
 * importable by vitest.
 *
 * The dev DID-probe screen's OWN pure logic (request building, gating
 * decision, response correlation, log cap) lives in `didProbe.ts`, not here
 * (P4e-FIX2, binding: "extract the probe logic into a pure module").
 */
import {
  DEFAULT_ENET_CHANNEL_SPECS,
  validateEnetChannelSpecs,
  type EnetChannelSpec,
} from '@circuit/core';
import { DEFAULT_SETTINGS, type AdapterType, type AppSettings } from './settingsStore';

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

/** `true` for any value that is a byte (0-255) -- used both by UI draft parsing above (through `parseHexByteDraft`) and by `repairPersistedEnetSettings` below to check an already-hydrated (not necessarily string) persisted value. */
function isByteInRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xff;
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
  /** Meaningful only when `ok` -- the specs that survived structural validation AND `validateEnetChannelSpecs`. Empty (`[]`) for an empty/whitespace-only draft ("use the built-in defaults" -- callers building an engine config substitute `DEFAULT_ENET_CHANNEL_SPECS` themselves via `resolveEnetChannelSpecs` below; this validator reports the draft's OWN content literally, so an explicit `"[]"` reads as "zero channels", not "defaults"). */
  specs: readonly EnetChannelSpec[];
  /** Per-entry warnings -- a structurally-invalid array member (P4e-FIX2 fix, below) or anything `validateEnetChannelSpecs` itself rejects (duplicate channel, channel<->PID mismatch, ...) -- shown inline, non-blocking. */
  warnings: readonly string[];
  /** Non-null exactly when `!ok`. */
  error: string | null;
}

/**
 * P4e-FIX2 HIGH fix (binding, Codex P4e-REV2 Part B): structurally validates
 * ONE array member from the parsed JSON -- `object; channel string; mode
 * 'obd01'|'did'; requestHex string; optional targetAddress a byte 0-255;
 * decode (if present) an object shape; provenance string` -- BEFORE it is
 * ever handed to `@circuit/core`'s `validateEnetChannelSpecs`, which assumes
 * an already well-typed `EnetChannelSpec` and dereferences fields like
 * `spec.requestHex.replace(...)` without its own guard. `[null]`, `[{}]`,
 * `[1]`, and members with wrong-typed fields all fail here and are reported
 * as an inline warning string instead of ever reaching core (which would
 * otherwise throw a raw `TypeError` -- "cannot read properties of null/undefined" --
 * out of `SettingsScreen`'s blur handler or `TelemetryScreen`'s render).
 * NEVER casts an unknown value to `EnetChannelSpec` -- this function IS the
 * type guard (`value is EnetChannelSpec`), narrowed field-by-field.
 */
function isStructurallyValidChannelSpec(value: unknown, index: number, problems: string[]): value is EnetChannelSpec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push(`entry ${index}: not an object`);
    return false;
  }
  const record = value as Record<string, unknown>;

  if (typeof record.channel !== 'string' || record.channel.trim() === '') {
    problems.push(`entry ${index}: "channel" must be a non-empty string`);
    return false;
  }
  if (record.mode !== 'obd01' && record.mode !== 'did') {
    problems.push(`entry ${index}: "mode" must be "obd01" or "did"`);
    return false;
  }
  if (typeof record.requestHex !== 'string') {
    problems.push(`entry ${index}: "requestHex" must be a string`);
    return false;
  }
  if (record.targetAddress !== undefined && !isByteInRange(record.targetAddress)) {
    problems.push(`entry ${index}: "targetAddress" must be a byte (0-255) when present`);
    return false;
  }
  if (typeof record.provenance !== 'string') {
    problems.push(`entry ${index}: "provenance" must be a string`);
    return false;
  }
  if (record.decode !== undefined) {
    if (typeof record.decode !== 'object' || record.decode === null || Array.isArray(record.decode)) {
      problems.push(`entry ${index}: "decode" must be an object when present`);
      return false;
    }
    const decode = record.decode as Record<string, unknown>;
    if (
      typeof decode.byteOffset !== 'number' ||
      !Number.isInteger(decode.byteOffset) ||
      decode.byteOffset < 0 ||
      (decode.byteLength !== 1 && decode.byteLength !== 2) ||
      typeof decode.scale !== 'number' ||
      !Number.isFinite(decode.scale) ||
      typeof decode.offset !== 'number' ||
      !Number.isFinite(decode.offset) ||
      (decode.signed !== undefined && typeof decode.signed !== 'boolean')
    ) {
      problems.push(`entry ${index}: "decode" has a malformed field (byteOffset/byteLength/scale/offset/signed)`);
      return false;
    }
  }
  return true;
}

/**
 * Validates a FULL `enetChannelSpecsJson` draft string on blur. An
 * empty/whitespace-only draft is valid (`specs: []`, meaning "built-in
 * defaults" -- see `resolveEnetChannelSpecs`). A non-empty draft must parse as
 * a JSON array; each element is FIRST structurally validated (never cast --
 * `isStructurallyValidChannelSpec` above), THEN the surviving,
 * well-typed members are run through `@circuit/core`'s
 * `validateEnetChannelSpecs` (device-sensor channels, malformed `requestHex`,
 * channel<->PID consistency, a `did` spec missing `decode`/`provenance`,
 * duplicate channels) -- both layers drop bad entries with a warning rather
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

  const structuralWarnings: string[] = [];
  const structurallyValid: EnetChannelSpec[] = [];
  parsed.forEach((entry: unknown, index: number) => {
    if (isStructurallyValidChannelSpec(entry, index, structuralWarnings)) {
      structurallyValid.push(entry);
    }
  });

  // A NON-EMPTY array where every single member is structurally invalid
  // (`[null]`, `[{}]`, `[1]`, ...) is a malformed draft, not a deliberate
  // "zero channels" choice -- that distinction is reserved for a literal
  // `"[]"` (`parsed.length === 0`, never reaches this branch). Reported as
  // an ordinary `ok: false` error so `resolveEnetChannelSpecs` below falls
  // back to the built-in defaults, exactly like unparsable JSON.
  if (parsed.length > 0 && structurallyValid.length === 0) {
    return { ok: false, specs: [], warnings: structuralWarnings, error: ENET_CHANNEL_SPECS_JSON_ERROR };
  }

  const { valid, warnings } = validateEnetChannelSpecs(structurallyValid);
  return { ok: true, specs: valid, warnings: [...structuralWarnings, ...warnings], error: null };
}

/**
 * Resolves a persisted `enetChannelSpecsJson` value into the channel specs
 * `telemetryProvider.ts` builds the ENET engine with -- the provider's own
 * "never trust a persisted value blindly" re-validation, called fresh on
 * every `start()` (same freshness/defense rule as `buildCustomPids` for
 * `transOilPidHex`). Empty/whitespace -> `DEFAULT_ENET_CHANNEL_SPECS`.
 * Malformed JSON / non-array / structurally-invalid members (should never
 * happen through the validated UI, but may reach here from a persisted value
 * saved before this rule existed) also fall back to the built-in defaults,
 * with a `console.warn` -- ENET telemetry must never fail to start, and
 * `TelemetryScreen`'s render (which calls this directly) must never THROW,
 * because of a corrupt settings string. A syntactically valid but
 * entirely-empty array (`"[]"`) is respected literally (zero channels
 * polled) -- that is a deliberate, distinguishable user choice, not a
 * malformed draft. Wrapped in a try/catch as defense-in-depth: even an
 * unanticipated failure inside JSON parsing or validation falls back to the
 * built-in defaults rather than ever propagating out of this function.
 */
export function resolveEnetChannelSpecs(channelSpecsJson: string): readonly EnetChannelSpec[] {
  try {
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
  } catch (error) {
    console.warn(
      `[enetSettingsValidation] Unexpected error resolving enetChannelSpecsJson -- using built-in defaults: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return DEFAULT_ENET_CHANNEL_SPECS;
  }
}

// ---------------------------------------------------------------------------
// Settings hydration repair (P4e-FIX2 L1, binding: "Persisted settings are
// repaired on hydration").
// ---------------------------------------------------------------------------

/** `true` for a value that is a valid TCP port (1-65535). */
function isPortInRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/**
 * Repairs the ENET-related fields of an already-hydrated `AppSettings`
 * (i.e. `{ ...DEFAULT_SETTINGS, ...persistedPartial }`) back to their
 * defaults when a PRESENT persisted value is structurally invalid --
 * `isPartialAppSettings`'s own check (`SqlSettingsStore.create`) only proves
 * the persisted JSON was "some object", so a malformed field value (wrong
 * type, or a numeric field out of range) overwrites `DEFAULT_SETTINGS`
 * unchecked otherwise. Binding repair rules (contracts.md P4e-FIX2
 * amendment): `adapterType` not in `{'elm327','enet'}` -> `'elm327'`;
 * `enetPort` not in [1, 65535] -> the default port; `enetTesterAddress`/
 * `enetTargetAddress` not a byte [0, 255] -> their defaults; `enetChannelSpecsJson`
 * not a string, or a string that fails `validateEnetChannelSpecsJson`
 * (unparsable JSON / non-array) -> `''`. Every OTHER field (including the
 * ELM327 ones) is left exactly as hydrated -- this repairs ONLY the fields
 * this ticket's ENET addendum introduced.
 */
export function repairPersistedEnetSettings(settings: AppSettings): AppSettings {
  const adapterTypeRaw: unknown = settings.adapterType;
  const adapterType: AdapterType = adapterTypeRaw === 'enet' || adapterTypeRaw === 'elm327' ? adapterTypeRaw : 'elm327';

  const enetPortRaw: unknown = settings.enetPort;
  const enetPort = isPortInRange(enetPortRaw) ? enetPortRaw : DEFAULT_SETTINGS.enetPort;

  const enetTesterAddressRaw: unknown = settings.enetTesterAddress;
  const enetTesterAddress = isByteInRange(enetTesterAddressRaw) ? enetTesterAddressRaw : DEFAULT_SETTINGS.enetTesterAddress;

  const enetTargetAddressRaw: unknown = settings.enetTargetAddress;
  const enetTargetAddress = isByteInRange(enetTargetAddressRaw) ? enetTargetAddressRaw : DEFAULT_SETTINGS.enetTargetAddress;

  const enetChannelSpecsJsonRaw: unknown = settings.enetChannelSpecsJson;
  const enetChannelSpecsJson =
    typeof enetChannelSpecsJsonRaw === 'string' && validateEnetChannelSpecsJson(enetChannelSpecsJsonRaw).ok
      ? enetChannelSpecsJsonRaw
      : '';

  return { ...settings, adapterType, enetPort, enetTesterAddress, enetTargetAddress, enetChannelSpecsJson };
}
