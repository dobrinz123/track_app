/**
 * VIN read (ticket P4q Q1, binding): "the app should know the car from OBD
 * from the start if possible; if not, let the user choose." The ENET path --
 * UDS 0x22 ReadDataByIdentifier, DID 0xF190 (ISO 14229-1 standard VIN DID),
 * addressed to ECU 0x12 (the DME) by the caller.
 *
 * Pure decode + a one-shot send/read over an already-open `SweepTransport`
 * channel (the SAME abstraction `didSweep.ts`'s runner and the mobile
 * `createRawUdsChannel` already speak) -- no I/O of its own beyond that one
 * channel, no reservation/transport lifecycle, which stays the caller's job
 * (mirrors `signalFinderController.ts`'s own `sendEngineRpmRequest`/
 * `pollEngineRpm` one-shot pattern).
 *
 * NEVER fabricates a VIN: an NRC, a SID/DID mismatch, a malformed PDU, a
 * response that is all padding, or any non-printable byte all decode to
 * `null` -- "not read", never a guess.
 */
import { buildReadDataByIdentifierRequest, extractReadDataByIdentifierData, parseUdsResponse } from './udsCodec';
import type { SweepTransport } from './didSweep';

/** ISO 14229-1 standard DataIdentifier for the Vehicle Identification Number. */
export const VIN_DATA_IDENTIFIER = 0xf190;

/** Default bound for the one-shot read below -- generous for a single exchange, short enough never to be felt as a stall. */
const DEFAULT_VIN_READ_TIMEOUT_MS = 300;

/** `0x22 0xF1 0x90` -- the whitelisted ReadDataByIdentifier request for the VIN. */
export function buildVinRequest(): Uint8Array {
  return buildReadDataByIdentifierRequest(VIN_DATA_IDENTIFIER);
}

/**
 * Decodes one UDS response PDU as a VIN read answer, or `null` when it is not
 * usable evidence of one: an NRC (`0x7F ...`), a positive response for the
 * wrong SID/DID, a malformed PDU, all-padding, or any non-printable byte
 * anywhere in the (padding-stripped) data.
 *
 * Padding: a short/padded ECU response trails the ASCII VIN with `0x00`
 * and/or `0x20` (space) bytes -- stripped from the END only (a VIN never
 * starts with padding) before the printability check.
 */
export function decodeVinResponse(pdu: Uint8Array): string | null {
  let parsed: ReturnType<typeof parseUdsResponse>;
  try {
    parsed = parseUdsResponse(pdu);
  } catch {
    return null; // malformed PDU -- no evidence either way.
  }
  if (parsed.kind !== 'positive') return null; // an NRC proves nothing about the VIN.

  let data: Uint8Array;
  try {
    data = extractReadDataByIdentifierData(parsed.sid, parsed.data, VIN_DATA_IDENTIFIER);
  } catch {
    return null; // wrong SID/echoed DID -- not this request's answer.
  }

  let end = data.length;
  while (end > 0 && (data[end - 1] === 0x00 || data[end - 1] === 0x20)) end -= 1;
  const trimmed = data.slice(0, end);
  if (trimmed.length === 0) return null; // all padding -- nothing was actually read.

  let vin = '';
  for (const byte of trimmed) {
    if (byte < 0x20 || byte > 0x7e) return null; // non-printable -- reject the WHOLE reading, never garbage-decode it.
    vin += String.fromCharCode(byte);
  }
  return vin;
}

/**
 * One-shot: sends {@link buildVinRequest} on `channel` and decodes whatever
 * comes back (or `'timeout'`) via {@link decodeVinResponse}. Never throws --
 * a `send()`/`nextResponse()` failure resolves `null`, exactly like an NRC or
 * a timeout does, so a caller can fire this without its own try/catch.
 */
export async function readVinFromChannel(
  channel: SweepTransport,
  timeoutMs: number = DEFAULT_VIN_READ_TIMEOUT_MS,
): Promise<string | null> {
  try {
    await channel.send(buildVinRequest());
  } catch {
    return null;
  }
  let response: Uint8Array | 'timeout';
  try {
    response = await channel.nextResponse(timeoutMs);
  } catch {
    return null;
  }
  if (response === 'timeout') return null;
  return decodeVinResponse(response);
}
