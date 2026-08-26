/**
 * ENET telemetry addendum -- dev DID-probe screen (P4e-FIX2, binding: "extract
 * the probe logic into a pure module ... so it is testable without RN").
 * Everything the probe screen needs that is NOT itself I/O (opening a
 * transport, awaiting a response) lives here: request building, the gating
 * decision (when the probe is even allowed to run), response correlation,
 * and the 50-entry log's cap logic. Pure module: no react-native, no react
 * import -- only `@circuit/core` and this app's own `AdapterType`/`Elm327State`
 * types, so it is directly importable by vitest (unlike `DidProbeScreen.tsx`
 * itself, which cannot be -- see `settingsPortDraft.test.ts`'s own doc
 * comment for this repo's standing constraint on RN-importing files).
 */
import {
  assertAllowedRequest,
  buildObdMode01Request,
  buildReadDataByIdentifierRequest,
  extractObdMode01Data,
  extractReadDataByIdentifierData,
  parseUdsResponse,
  type Elm327State,
} from '@circuit/core';
import type { AdapterType } from './settingsStore';

// ---------------------------------------------------------------------------
// Request building (moved from `enetSettingsValidation.ts`, P4e-FIX2).
// ---------------------------------------------------------------------------

export type DidProbeMode = 'did' | 'obd01';

export interface DidProbeRequestResult {
  ok: boolean;
  /** Non-null exactly when `ok` -- the whitelisted UDS request PDU, ready to frame and send. */
  pdu: Uint8Array | null;
  /** Non-null exactly when `ok` -- the request SID (0x22 or 0x01), needed by `correlateDidProbeResponse` below. */
  sid: number | null;
  /** Non-null exactly when `ok` -- the parsed PID/DID value, needed by `correlateDidProbeResponse` below (identifier echo). */
  identifier: number | null;
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
    return { ok: false, pdu: null, sid: null, identifier: null, error: 'Enter hex digits only' };
  }

  const expectedLength = mode === 'did' ? 4 : 2;
  if (compact.length !== expectedLength) {
    return {
      ok: false,
      pdu: null,
      sid: null,
      identifier: null,
      error:
        mode === 'did'
          ? `DID request must be exactly 4 hex characters, got ${compact.length}`
          : `PID request must be exactly 2 hex characters, got ${compact.length}`,
    };
  }

  try {
    const identifier = Number.parseInt(compact, 16);
    const pdu = mode === 'did' ? buildReadDataByIdentifierRequest(identifier) : buildObdMode01Request(identifier);
    assertAllowedRequest(pdu);
    const sid = pdu[0] ?? 0;
    return { ok: true, pdu, sid, identifier, error: null };
  } catch (error) {
    return { ok: false, pdu: null, sid: null, identifier: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// Gating decision (P4e-FIX2 H2, binding: "poll plan, probe & robustness
// amendment" -- "DID probe (dev): allowed ONLY when telemetryEnabled &&
// adapterType === 'enet' and the telemetry provider is idle/stopped/failed
// (never while connecting/polling) -- the MHD adapter accepts one ECU
// client; the probe shows a 'stop telemetry first' message otherwise").
// ---------------------------------------------------------------------------

/**
 * The provider's OWN public state vocabulary (`TelemetryProvider.onStateChange`,
 * `telemetryProvider.ts`) -- ENET's `handshake` is already mapped onto
 * `Elm327State`'s `initializing` there, so this reuses that SAME shared type
 * rather than importing `EnetState` (which the provider deliberately never
 * exposes on its public surface).
 */
export type DidProbeProviderState = Elm327State;

const STATES_ALLOWING_PROBE: ReadonlySet<DidProbeProviderState> = new Set(['idle', 'stopped', 'failed']);

export type DidProbeGatingReason = 'telemetryDisabled' | 'wrongAdapterType' | 'providerBusy';

export interface DidProbeGating {
  allowed: boolean;
  reason: DidProbeGatingReason | null;
  /** User-facing message, non-null exactly when `!allowed`. */
  message: string | null;
}

export const DID_PROBE_ENABLE_TELEMETRY_MESSAGE = 'Enable ENET telemetry first (Settings → Telemetry).';
export const DID_PROBE_STOP_TELEMETRY_MESSAGE = 'Stop telemetry first -- the adapter allows one ECU client at a time.';

/**
 * Pure gating decision: the probe is allowed ONLY while ENET telemetry is
 * the active configuration AND the shared provider is NOT using the adapter
 * right now (`idle`/`stopped`/`failed` -- never `connecting`/`initializing`/
 * `polling`). Checked BEFORE the screen ever constructs a transport --
 * "the dev probe violates ... the adapter's single-client rule" (P4e-REV2
 * HIGH finding) is fixed by refusing to send at all, not by racing a second
 * connection alongside the provider's.
 */
export function evaluateDidProbeGating(params: {
  telemetryEnabled: boolean;
  adapterType: AdapterType;
  providerState: DidProbeProviderState;
}): DidProbeGating {
  if (!params.telemetryEnabled || params.adapterType !== 'enet') {
    return { allowed: false, reason: !params.telemetryEnabled ? 'telemetryDisabled' : 'wrongAdapterType', message: DID_PROBE_ENABLE_TELEMETRY_MESSAGE };
  }
  if (!STATES_ALLOWING_PROBE.has(params.providerState)) {
    return { allowed: false, reason: 'providerBusy', message: DID_PROBE_STOP_TELEMETRY_MESSAGE };
  }
  return { allowed: true, reason: null, message: null };
}

// ---------------------------------------------------------------------------
// Response correlation (P4e-FIX2 M3, binding: "swapped addresses, SID+0x40 /
// 0x7F echo, identifier echo ... unmatched -> logged UNMATCHED, never as OK").
// ---------------------------------------------------------------------------

/** The request this probe sent, as needed to correlate a later response to it -- built from a successful `buildDidProbeRequest` result plus the addresses the frame was sent with. */
export interface DidProbeSentRequest {
  mode: DidProbeMode;
  sid: number;
  identifier: number;
  testerAddress: number;
  targetAddress: number;
}

/** Structural subset of `@circuit/core`'s `HsfzDiagnosticFrame` this module needs -- avoids importing the full discriminated `HsfzFrame` union just for these three fields. */
export interface DidProbeResponseFrame {
  source: number;
  target: number;
  payload: Uint8Array;
}

export type DidProbeCorrelation =
  | { kind: 'matched'; nrc?: number }
  | { kind: 'unmatched' };

/**
 * Correlates one incoming diagnostic-control frame to `sent`: addresses must
 * be swapped (`frame.source === sent.targetAddress`, `frame.target ===
 * sent.testerAddress`), and the UDS payload must be either a negative
 * response (`0x7F`) echoing `sent.sid`, or a positive response whose SID is
 * `sent.sid + 0x40` AND whose echoed PID/DID matches `sent.identifier`
 * (reusing `@circuit/core`'s own `extractObdMode01Data`/
 * `extractReadDataByIdentifierData`, the SAME identifier-echo check the ENET
 * session engine itself relies on -- a mismatch there throws, caught here and
 * reported as `'unmatched'`, never as a match). Anything else -- wrong
 * addresses, a payload that fails to parse as a UDS response, a SID/identifier
 * mismatch -- is `'unmatched'`, which the screen logs as UNMATCHED, never OK
 * (the review's exact scenario: request DID `F190` to `0x12`; a frame from
 * `0x13` is `'unmatched'` on the address check alone; a frame from `0x12`
 * carrying `62 F1 91 ...` is `'matched'`).
 */
export function correlateDidProbeResponse(sent: DidProbeSentRequest, frame: DidProbeResponseFrame): DidProbeCorrelation {
  if (frame.source !== sent.targetAddress || frame.target !== sent.testerAddress) {
    return { kind: 'unmatched' };
  }

  let parsed: ReturnType<typeof parseUdsResponse>;
  try {
    parsed = parseUdsResponse(frame.payload);
  } catch {
    return { kind: 'unmatched' };
  }

  if (parsed.kind === 'negative') {
    if (parsed.requestSid !== sent.sid) return { kind: 'unmatched' };
    return { kind: 'matched', nrc: parsed.nrc };
  }

  try {
    if (sent.mode === 'obd01') {
      extractObdMode01Data(parsed.sid, parsed.data, sent.identifier);
    } else {
      extractReadDataByIdentifierData(parsed.sid, parsed.data, sent.identifier);
    }
  } catch {
    return { kind: 'unmatched' };
  }
  return { kind: 'matched' };
}

// ---------------------------------------------------------------------------
// 50-entry log (pure array operation).
// ---------------------------------------------------------------------------

export const DID_PROBE_LOG_CAP = 50;

export type DidProbeLogStatus = 'ok' | 'unmatched' | 'error';

export interface DidProbeLogEntry {
  id: number;
  atEpochMs: number;
  mode: DidProbeMode;
  targetAddressHex: string;
  requestHex: string;
  status: DidProbeLogStatus;
  detail: string;
  roundTripMs?: number;
}

/** Prepends `entry` (newest first) and caps the result at `DID_PROBE_LOG_CAP` entries -- pure, so the cap behavior itself is directly testable without mounting the screen. */
export function pushDidProbeLogEntry(
  log: readonly DidProbeLogEntry[],
  entry: DidProbeLogEntry,
): DidProbeLogEntry[] {
  return [entry, ...log].slice(0, DID_PROBE_LOG_CAP);
}
