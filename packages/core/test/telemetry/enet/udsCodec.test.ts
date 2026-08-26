import { describe, expect, it } from 'vitest';

import {
  assertAllowedRequest,
  buildObdMode01Request,
  buildReadDataByIdentifierRequest,
  buildTesterPresentRequest,
  extractObdMode01Data,
  extractReadDataByIdentifierData,
  parseUdsResponse,
  UdsMalformedResponseError,
  UdsServiceNotAllowed,
  UNSUPPORTED_CHANNEL_NRCS,
  UDS_NRC,
} from '../../../src/telemetry/enet/udsCodec';

describe('UDS request builders', () => {
  it('builds ReadDataByIdentifier as 0x22 + 2-byte DID', () => {
    expect(buildReadDataByIdentifierRequest(0x1e1c)).toEqual(Uint8Array.from([0x22, 0x1e, 0x1c]));
  });

  it('builds OBD mode-01 as 0x01 + 1-byte PID', () => {
    expect(buildObdMode01Request(0x0c)).toEqual(Uint8Array.from([0x01, 0x0c]));
  });

  it('builds TesterPresent as 0x3E 0x80 (suppress-positive-response)', () => {
    expect(buildTesterPresentRequest()).toEqual(Uint8Array.from([0x3e, 0x80]));
  });

  it('rejects an out-of-range DID or PID', () => {
    expect(() => buildReadDataByIdentifierRequest(0x1_0000)).toThrow(RangeError);
    expect(() => buildObdMode01Request(0x100)).toThrow(RangeError);
  });
});

describe('assertAllowedRequest (read-only whitelist)', () => {
  it.each([0x01, 0x22, 0x3e])('allows SID 0x%s', (sid) => {
    expect(() => assertAllowedRequest(Uint8Array.from([sid, 0x00]))).not.toThrow();
  });

  // Binding: 0x10 DiagnosticSessionControl, 0x27 SecurityAccess, 0x2E
  // WriteDataByIdentifier, 0x31 RoutineControl, 0x34 RequestDownload, 0x3D
  // WriteMemoryByAddress, 0x85 ControlDTCSetting -- every one must be refused.
  it.each([0x10, 0x27, 0x2e, 0x31, 0x34, 0x3d, 0x85])('refuses SID 0x%s with a typed UdsServiceNotAllowed', (sid) => {
    expect(() => assertAllowedRequest(Uint8Array.from([sid, 0x00]))).toThrow(UdsServiceNotAllowed);
    try {
      assertAllowedRequest(Uint8Array.from([sid, 0x00]));
    } catch (error) {
      expect((error as UdsServiceNotAllowed).sid).toBe(sid);
    }
  });

  it('rejects an empty PDU as malformed, not as an allowed/disallowed service', () => {
    expect(() => assertAllowedRequest(new Uint8Array(0))).toThrow(UdsMalformedResponseError);
  });
});

describe('parseUdsResponse', () => {
  it('parses a positive ReadDataByIdentifier response (0x62)', () => {
    const parsed = parseUdsResponse(Uint8Array.from([0x62, 0x1e, 0x1c, 0x00, 0x4b]));
    expect(parsed).toEqual({ kind: 'positive', sid: 0x62, data: Uint8Array.from([0x1e, 0x1c, 0x00, 0x4b]) });
  });

  it('parses a negative response (0x7F sid nrc)', () => {
    const parsed = parseUdsResponse(Uint8Array.from([0x7f, 0x22, 0x31]));
    expect(parsed).toEqual({ kind: 'negative', requestSid: 0x22, nrc: 0x31 });
  });

  it('parses a 0x78 responsePending negative response', () => {
    const parsed = parseUdsResponse(Uint8Array.from([0x7f, 0x01, 0x78]));
    expect(parsed).toEqual({ kind: 'negative', requestSid: 0x01, nrc: 0x78 });
    expect(parsed.kind === 'negative' && parsed.nrc === UDS_NRC.RESPONSE_PENDING).toBe(true);
  });

  it('throws on an empty PDU or a truncated negative response', () => {
    expect(() => parseUdsResponse(new Uint8Array(0))).toThrow(UdsMalformedResponseError);
    expect(() => parseUdsResponse(Uint8Array.from([0x7f, 0x22]))).toThrow(UdsMalformedResponseError);
  });
});

describe('UNSUPPORTED_CHANNEL_NRCS', () => {
  it('contains exactly 0x11, 0x12, 0x31', () => {
    expect(UNSUPPORTED_CHANNEL_NRCS.has(0x11)).toBe(true);
    expect(UNSUPPORTED_CHANNEL_NRCS.has(0x12)).toBe(true);
    expect(UNSUPPORTED_CHANNEL_NRCS.has(0x31)).toBe(true);
    expect(UNSUPPORTED_CHANNEL_NRCS.has(0x78)).toBe(false);
    expect(UNSUPPORTED_CHANNEL_NRCS.has(0x22)).toBe(false);
  });
});

describe('extractObdMode01Data / extractReadDataByIdentifierData', () => {
  it('strips the echoed PID from a mode-01 positive response', () => {
    expect(extractObdMode01Data(0x41, Uint8Array.from([0x0c, 0x1a, 0xf8]), 0x0c)).toEqual(
      Uint8Array.from([0x1a, 0xf8]),
    );
  });

  it('rejects a mode-01 response whose echoed PID does not match', () => {
    expect(() => extractObdMode01Data(0x41, Uint8Array.from([0x0d, 0x00]), 0x0c)).toThrow(UdsMalformedResponseError);
  });

  it('rejects a mode-01 response with the wrong SID', () => {
    expect(() => extractObdMode01Data(0x40, Uint8Array.from([0x0c, 0x00]), 0x0c)).toThrow(UdsMalformedResponseError);
  });

  it('strips the echoed DID from a ReadDataByIdentifier positive response', () => {
    expect(extractReadDataByIdentifierData(0x62, Uint8Array.from([0x1e, 0x1c, 0x00, 0x4b]), 0x1e1c)).toEqual(
      Uint8Array.from([0x00, 0x4b]),
    );
  });

  it('rejects a ReadDataByIdentifier response whose echoed DID does not match', () => {
    expect(() => extractReadDataByIdentifierData(0x62, Uint8Array.from([0x1e, 0x1d, 0x00]), 0x1e1c)).toThrow(
      UdsMalformedResponseError,
    );
  });
});
