import { describe, expect, it } from 'vitest';
import { assertAllowedRequest, UdsServiceNotAllowed } from '@circuit/core';
import {
  buildDidProbeRequest,
  correlateDidProbeResponse,
  DID_PROBE_ENABLE_TELEMETRY_MESSAGE,
  DID_PROBE_LOG_CAP,
  DID_PROBE_STOP_TELEMETRY_MESSAGE,
  evaluateDidProbeGating,
  pushDidProbeLogEntry,
  type DidProbeLogEntry,
  type DidProbeSentRequest,
} from '../../src/session/didProbe';

describe('buildDidProbeRequest (dev DID-probe screen: request building + whitelist refusal)', () => {
  it('mode "did" builds a ReadDataByIdentifier (0x22) request for a valid 4-hex-char DID, with sid/identifier', () => {
    const result = buildDidProbeRequest('did', '1E0C');
    expect(result.ok).toBe(true);
    expect(result.pdu).toEqual(Uint8Array.from([0x22, 0x1e, 0x0c]));
    expect(result.sid).toBe(0x22);
    expect(result.identifier).toBe(0x1e0c);
  });

  it('mode "obd01" builds an OBD mode-01 (0x01) request for a valid 2-hex-char PID, with sid/identifier', () => {
    const result = buildDidProbeRequest('obd01', '0C');
    expect(result.ok).toBe(true);
    expect(result.pdu).toEqual(Uint8Array.from([0x01, 0x0c]));
    expect(result.sid).toBe(0x01);
    expect(result.identifier).toBe(0x0c);
  });

  it('ignores internal spacing and is case-insensitive', () => {
    expect(buildDidProbeRequest('did', '1e 0c').pdu).toEqual(Uint8Array.from([0x22, 0x1e, 0x0c]));
    expect(buildDidProbeRequest('obd01', ' 0c ').pdu).toEqual(Uint8Array.from([0x01, 0x0c]));
  });

  it('rejects the wrong hex length for each mode, without sending anything', () => {
    const didTooShort = buildDidProbeRequest('did', '1E');
    expect(didTooShort.ok).toBe(false);
    expect(didTooShort.pdu).toBeNull();
    expect(didTooShort.sid).toBeNull();
    expect(didTooShort.identifier).toBeNull();
    expect(didTooShort.error).toContain('4 hex characters');

    const pidTooLong = buildDidProbeRequest('obd01', '0C12');
    expect(pidTooLong.ok).toBe(false);
    expect(pidTooLong.error).toContain('2 hex characters');
  });

  it('rejects non-hex input', () => {
    const result = buildDidProbeRequest('did', 'ZZZZ');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Enter hex digits only');
  });

  it('rejects an empty draft', () => {
    expect(buildDidProbeRequest('did', '').ok).toBe(false);
  });

  /**
   * "Nothing outside {0x01, 0x22, 0x3E} can be sent -- the whitelist error is
   * shown, not bypassed" (contracts.md ENET addendum, binding). Both of
   * `buildDidProbeRequest`'s modes only ever construct a whitelisted SID by
   * construction (0x22/0x01), so the gate it re-checks (`assertAllowedRequest`,
   * the SAME core gate `enetSession.ts`'s own `executeDiagnosticRequest`
   * re-checks before every send) is exercised directly here against a
   * manually-built disallowed PDU -- proving the underlying whitelist really
   * does refuse anything else, not just that the picker happens not to offer
   * it.
   */
  it('the underlying whitelist gate (assertAllowedRequest) refuses any SID outside {0x01, 0x22, 0x3E}', () => {
    expect(() => assertAllowedRequest(Uint8Array.from([0x27, 0x01]))).toThrow(UdsServiceNotAllowed);
    expect(() => assertAllowedRequest(Uint8Array.from([0x10, 0x03]))).toThrow(UdsServiceNotAllowed);
    expect(() => assertAllowedRequest(Uint8Array.from([0x01, 0x0c]))).not.toThrow();
    expect(() => assertAllowedRequest(Uint8Array.from([0x22, 0x1e, 0x0c]))).not.toThrow();
    expect(() => assertAllowedRequest(Uint8Array.from([0x3e, 0x80]))).not.toThrow();
  });
});

describe('evaluateDidProbeGating (P4e-FIX2 H2, binding: dev probe gating)', () => {
  it('disallowed with telemetryEnabled:false, regardless of adapterType/providerState', () => {
    const gating = evaluateDidProbeGating({ telemetryEnabled: false, adapterType: 'enet', providerState: 'idle' });
    expect(gating.allowed).toBe(false);
    expect(gating.reason).toBe('telemetryDisabled');
    expect(gating.message).toBe(DID_PROBE_ENABLE_TELEMETRY_MESSAGE);
  });

  it('disallowed with adapterType:"elm327", even with telemetryEnabled true (the review\'s scenario 1)', () => {
    const gating = evaluateDidProbeGating({ telemetryEnabled: true, adapterType: 'elm327', providerState: 'idle' });
    expect(gating.allowed).toBe(false);
    expect(gating.reason).toBe('wrongAdapterType');
    expect(gating.message).toBe(DID_PROBE_ENABLE_TELEMETRY_MESSAGE);
  });

  it('disallowed while the provider is connecting/initializing/polling (the review\'s scenario 2: probing during an active poll)', () => {
    for (const providerState of ['connecting', 'initializing', 'polling'] as const) {
      const gating = evaluateDidProbeGating({ telemetryEnabled: true, adapterType: 'enet', providerState });
      expect(gating.allowed).toBe(false);
      expect(gating.reason).toBe('providerBusy');
      expect(gating.message).toBe(DID_PROBE_STOP_TELEMETRY_MESSAGE);
    }
  });

  it('allowed exactly when telemetryEnabled && adapterType==="enet" && providerState is idle/stopped/failed', () => {
    for (const providerState of ['idle', 'stopped', 'failed'] as const) {
      const gating = evaluateDidProbeGating({ telemetryEnabled: true, adapterType: 'enet', providerState });
      expect(gating).toEqual({ allowed: true, reason: null, message: null });
    }
  });
});

describe('correlateDidProbeResponse (P4e-FIX2 M3, binding: swapped addresses, SID+0x40/0x7F echo, identifier echo)', () => {
  const sentDid: DidProbeSentRequest = { mode: 'did', sid: 0x22, identifier: 0xf190, testerAddress: 0xf4, targetAddress: 0x12 };

  /** The review's exact scenario: request DID F190 to 0x12; a frame from 0x13 is unmatched on the address check alone. */
  it('a frame from the wrong source address is unmatched (review scenario: request to 0x12, frame from 0x13)', () => {
    const result = correlateDidProbeResponse(sentDid, {
      source: 0x13,
      target: 0xf4,
      payload: Uint8Array.from([0x62, 0xf1, 0x90, 0x00]),
    });
    expect(result).toEqual({ kind: 'unmatched' });
  });

  it('a frame to the wrong target (tester) address is unmatched', () => {
    const result = correlateDidProbeResponse(sentDid, {
      source: 0x12,
      target: 0xf1, // not the tester address (0xF4) this request was sent from.
      payload: Uint8Array.from([0x62, 0xf1, 0x90, 0x00]),
    });
    expect(result).toEqual({ kind: 'unmatched' });
  });

  /** The review's exact scenario: a positive `62 F1 91 ...` (wrong echoed DID, F191 not F190) from the correct addresses. */
  it('a positive response with the wrong echoed DID is unmatched (review scenario: 62 F1 91 from correct addresses)', () => {
    const result = correlateDidProbeResponse(sentDid, {
      source: 0x12,
      target: 0xf4,
      payload: Uint8Array.from([0x62, 0xf1, 0x91, 0x00]),
    });
    expect(result).toEqual({ kind: 'unmatched' });
  });

  it('a positive response with the correct echoed DID from the correct addresses is matched', () => {
    const result = correlateDidProbeResponse(sentDid, {
      source: 0x12,
      target: 0xf4,
      payload: Uint8Array.from([0x62, 0xf1, 0x90, 0x2a]),
    });
    expect(result).toEqual({ kind: 'matched' });
  });

  it('a positive response with the wrong SID (e.g. echoing obd01\'s 0x41 for a did request) is unmatched', () => {
    const result = correlateDidProbeResponse(sentDid, {
      source: 0x12,
      target: 0xf4,
      payload: Uint8Array.from([0x41, 0xf1, 0x90, 0x2a]),
    });
    expect(result).toEqual({ kind: 'unmatched' });
  });

  it('a negative response (0x7F) echoing the sent SID is matched, with the NRC surfaced', () => {
    const result = correlateDidProbeResponse(sentDid, {
      source: 0x12,
      target: 0xf4,
      payload: Uint8Array.from([0x7f, 0x22, 0x11]),
    });
    expect(result).toEqual({ kind: 'matched', nrc: 0x11 });
  });

  it('a negative response echoing a DIFFERENT SID (not this request\'s) is unmatched', () => {
    const result = correlateDidProbeResponse(sentDid, {
      source: 0x12,
      target: 0xf4,
      payload: Uint8Array.from([0x7f, 0x01, 0x11]), // echoes 0x01 (obd01), this request sent 0x22.
    });
    expect(result).toEqual({ kind: 'unmatched' });
  });

  it('a payload that fails to parse as a UDS response at all is unmatched, never throws', () => {
    expect(() =>
      correlateDidProbeResponse(sentDid, { source: 0x12, target: 0xf4, payload: new Uint8Array(0) }),
    ).not.toThrow();
    const result = correlateDidProbeResponse(sentDid, { source: 0x12, target: 0xf4, payload: new Uint8Array(0) });
    expect(result).toEqual({ kind: 'unmatched' });
  });

  it('obd01 mode: identifier echo (PID) is checked the same way', () => {
    const sentObd01: DidProbeSentRequest = { mode: 'obd01', sid: 0x01, identifier: 0x0c, testerAddress: 0xf4, targetAddress: 0x12 };
    const matched = correlateDidProbeResponse(sentObd01, {
      source: 0x12,
      target: 0xf4,
      payload: Uint8Array.from([0x41, 0x0c, 0x1a, 0xf8]),
    });
    expect(matched).toEqual({ kind: 'matched' });

    const wrongPid = correlateDidProbeResponse(sentObd01, {
      source: 0x12,
      target: 0xf4,
      payload: Uint8Array.from([0x41, 0x0d, 0x1a]), // echoes PID 0x0D, request was 0x0C.
    });
    expect(wrongPid).toEqual({ kind: 'unmatched' });
  });
});

describe('pushDidProbeLogEntry (50-entry cap)', () => {
  function entry(id: number): DidProbeLogEntry {
    return { id, atEpochMs: id, mode: 'did', targetAddressHex: '12', requestHex: 'F190', status: 'ok', detail: 'ok' };
  }

  it('prepends the new entry (newest first)', () => {
    const log = pushDidProbeLogEntry([entry(1)], entry(2));
    expect(log.map((e) => e.id)).toEqual([2, 1]);
  });

  it(`caps the log at DID_PROBE_LOG_CAP (${DID_PROBE_LOG_CAP}) entries, dropping the oldest`, () => {
    let log: DidProbeLogEntry[] = [];
    for (let i = 0; i < DID_PROBE_LOG_CAP + 10; i += 1) {
      log = pushDidProbeLogEntry(log, entry(i));
    }
    expect(log).toHaveLength(DID_PROBE_LOG_CAP);
    expect(log[0]!.id).toBe(DID_PROBE_LOG_CAP + 9); // newest.
    expect(log.at(-1)!.id).toBe(10); // oldest surviving entry (10 dropped: 0..9).
  });
});
