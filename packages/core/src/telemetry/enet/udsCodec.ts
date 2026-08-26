/**
 * UDS (ISO 14229) PDU codec for the ENET transport -- pure build/parse, no I/O.
 *
 * READ-ONLY MANDATE (binding, contracts.md ENET addendum): the request-SID
 * whitelist below is the hard gate. `assertAllowedRequest` is the ONLY
 * function that may wave a request PDU through to framing; every request
 * builder in this module only ever produces a whitelisted SID, and the
 * session engine calls `assertAllowedRequest` again immediately before
 * sending -- so the whitelist can never be bypassed by a spec/config typo
 * reaching a codec function that was never taught to check it.
 */

export const UDS_ALLOWED_REQUEST_SIDS: ReadonlySet<number> = new Set([0x01, 0x22, 0x3e]);

export const UDS_NRC = {
  GENERAL_REJECT: 0x10,
  SERVICE_NOT_SUPPORTED: 0x11,
  SUB_FUNCTION_NOT_SUPPORTED: 0x12,
  REQUEST_OUT_OF_RANGE: 0x31,
  RESPONSE_PENDING: 0x78,
} as const;

/** NRCs the ENET addendum designates as "channel is UNSUPPORTED, remove from plan, never retry" -- as opposed to a transient channel error. */
export const UNSUPPORTED_CHANNEL_NRCS: ReadonlySet<number> = new Set([
  UDS_NRC.SERVICE_NOT_SUPPORTED,
  UDS_NRC.SUB_FUNCTION_NOT_SUPPORTED,
  UDS_NRC.REQUEST_OUT_OF_RANGE,
]);

export class UdsMalformedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UdsMalformedResponseError';
  }
}

/** Thrown by `assertAllowedRequest` for any request SID outside `UDS_ALLOWED_REQUEST_SIDS`. */
export class UdsServiceNotAllowed extends Error {
  constructor(public readonly sid: number) {
    super(
      `UDS service 0x${sid.toString(16).padStart(2, '0').toUpperCase()} is not in the read-only whitelist {0x01, 0x22, 0x3E}`,
    );
    this.name = 'UdsServiceNotAllowed';
  }
}

/** Hard gate: throws `UdsServiceNotAllowed` unless `pdu[0]` is 0x01, 0x22, or 0x3E. */
export function assertAllowedRequest(pdu: Uint8Array): void {
  if (pdu.length === 0) throw new UdsMalformedResponseError('empty UDS request PDU');
  const sid = pdu[0] ?? 0;
  if (!UDS_ALLOWED_REQUEST_SIDS.has(sid)) throw new UdsServiceNotAllowed(sid);
}

// ---------- Request builders (each SID is, by construction, whitelisted) ----------

export function buildReadDataByIdentifierRequest(did: number): Uint8Array {
  if (!Number.isInteger(did) || did < 0 || did > 0xffff) {
    throw new RangeError(`ReadDataByIdentifier DID out of range: ${did}`);
  }
  return Uint8Array.from([0x22, (did >> 8) & 0xff, did & 0xff]);
}

export function buildObdMode01Request(pid: number): Uint8Array {
  if (!Number.isInteger(pid) || pid < 0 || pid > 0xff) {
    throw new RangeError(`OBD mode-01 PID out of range: ${pid}`);
  }
  return Uint8Array.from([0x01, pid]);
}

/** TesterPresent with the suppress-positive-response sub-function (0x80): the ECU sends NO positive response, only a negative one if it ever rejects the service. */
export function buildTesterPresentRequest(): Uint8Array {
  return Uint8Array.from([0x3e, 0x80]);
}

// ---------- Response parsing ----------

export interface UdsPositiveResponse {
  kind: 'positive';
  sid: number;
  data: Uint8Array;
}
export interface UdsNegativeResponse {
  kind: 'negative';
  requestSid: number;
  nrc: number;
}
export type UdsParsedResponse = UdsPositiveResponse | UdsNegativeResponse;

/** Parses one UDS response PDU into a positive `{sid, data}` or a `0x7F requestSid nrc` negative response (NRC 0x78 = responsePending, handled by the caller as a wait extension, not an error). */
export function parseUdsResponse(pdu: Uint8Array): UdsParsedResponse {
  if (pdu.length === 0) throw new UdsMalformedResponseError('empty UDS response PDU');
  const sid = pdu[0] ?? 0;
  if (sid === 0x7f) {
    if (pdu.length < 3) throw new UdsMalformedResponseError('negative response (0x7F) PDU shorter than 3 bytes');
    return { kind: 'negative', requestSid: pdu[1] ?? 0, nrc: pdu[2] ?? 0 };
  }
  return { kind: 'positive', sid, data: pdu.slice(1) };
}

/** Validates an OBD mode-01 positive response (`0x41 pid ...data`) and returns the data bytes after the echoed PID. */
export function extractObdMode01Data(sid: number, data: Uint8Array, expectedPid: number): Uint8Array {
  if (sid !== 0x41) {
    throw new UdsMalformedResponseError(
      `expected OBD mode-01 positive response SID 0x41, got 0x${sid.toString(16).padStart(2, '0')}`,
    );
  }
  const pid = data[0];
  if (pid !== expectedPid) {
    throw new UdsMalformedResponseError(
      `PID mismatch: expected 0x${expectedPid.toString(16).padStart(2, '0')}, got 0x${(pid ?? 0).toString(16).padStart(2, '0')}`,
    );
  }
  return data.slice(1);
}

/** Validates a ReadDataByIdentifier positive response (`0x62 didHi didLo ...data`) and returns the data bytes after the echoed DID. */
export function extractReadDataByIdentifierData(sid: number, data: Uint8Array, expectedDid: number): Uint8Array {
  if (sid !== 0x62) {
    throw new UdsMalformedResponseError(
      `expected ReadDataByIdentifier positive response SID 0x62, got 0x${sid.toString(16).padStart(2, '0')}`,
    );
  }
  if (data.length < 2) throw new UdsMalformedResponseError('ReadDataByIdentifier response missing echoed DID');
  const did = ((data[0] ?? 0) << 8) | (data[1] ?? 0);
  if (did !== expectedDid) {
    throw new UdsMalformedResponseError(
      `DID mismatch: expected 0x${expectedDid.toString(16).padStart(4, '0')}, got 0x${did.toString(16).padStart(4, '0')}`,
    );
  }
  return data.slice(2);
}
