import { describe, expect, it } from 'vitest';

import { buildVinRequest, decodeVinResponse, readVinFromChannel, VIN_DATA_IDENTIFIER } from '../../../src/telemetry/enet/vinRead';
import type { SweepTransport } from '../../../src/telemetry/enet/didSweep';

/**
 * Ticket P4q Q1/Q4 (binding): the ENET VIN read -- UDS 0x22 DID 0xF190
 * addressed to ECU 0x12, ASCII-decoded with padding stripped, garbage/NRC
 * rejected as `null` (never a fabricated VIN).
 */

function asciiBytes(text: string): number[] {
  return [...text].map((ch) => ch.charCodeAt(0));
}

describe('buildVinRequest', () => {
  it('builds ReadDataByIdentifier for DID 0xF190', () => {
    expect(VIN_DATA_IDENTIFIER).toBe(0xf190);
    expect(buildVinRequest()).toEqual(Uint8Array.from([0x22, 0xf1, 0x90]));
  });
});

describe('decodeVinResponse', () => {
  it('decodes a clean positive response (0x62 F1 90 + 17 ASCII bytes)', () => {
    const vin = 'JTHKD5BH*02100001'.replace('*', '1'); // 17 chars, ASCII only
    const pdu = Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes(vin)]);
    expect(decodeVinResponse(pdu)).toBe(vin);
  });

  it('strips trailing 0x00 padding around a well-formed 17-char VIN', () => {
    const pdu = Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes('WBA12345678901234'), 0x00, 0x00, 0x00]);
    expect(decodeVinResponse(pdu)).toBe('WBA12345678901234');
  });

  it('strips trailing 0x20 (space) padding around a well-formed 17-char VIN', () => {
    const pdu = Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes('WBA12345678901234'), 0x20, 0x20]);
    expect(decodeVinResponse(pdu)).toBe('WBA12345678901234');
  });

  /**
   * Codex R1 fix (binding, MEDIUM): 17 printable ASCII bytes is necessary but
   * NOT sufficient -- only a strict ISO 3779 shape (17 chars, uppercase,
   * excluding I/O/Q) is ever returned, matched against a catalog, or
   * persisted. Everything else here decodes to 17 printable bytes yet is
   * still rejected.
   */
  it('rejects a decoded string shorter than 17 characters (not padding -- genuinely short)', () => {
    const pdu = Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes('ABC123')]);
    expect(decodeVinResponse(pdu)).toBeNull();
  });

  it('rejects a decoded string longer than 17 characters', () => {
    const pdu = Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes('WBA123456789012345678')]);
    expect(decodeVinResponse(pdu)).toBeNull();
  });

  it('rejects a lowercase 17-char string (VINs are uppercase)', () => {
    const pdu = Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes('wba12345678901234')]);
    expect(decodeVinResponse(pdu)).toBeNull();
  });

  it('rejects a 17-char string containing I, O, or Q (never valid VIN characters)', () => {
    for (const bad of ['WBAI2345678901234', 'WBAO2345678901234', 'WBAQ2345678901234']) {
      expect(decodeVinResponse(Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes(bad)]))).toBeNull();
    }
  });

  it('rejects a 17-char string containing punctuation/whitespace', () => {
    const pdu = Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes('WBA-2345678901234')]);
    expect(decodeVinResponse(pdu)).toBeNull();
  });

  it('rejects a response containing a non-printable byte (garbage)', () => {
    const pdu = Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes('ABC'), 0x01, ...asciiBytes('DEF')]);
    expect(decodeVinResponse(pdu)).toBeNull();
  });

  it('rejects an NRC (negative response)', () => {
    const pdu = Uint8Array.from([0x7f, 0x22, 0x31]); // requestOutOfRange on 0x22
    expect(decodeVinResponse(pdu)).toBeNull();
  });

  it('rejects a positive response for the wrong DID', () => {
    const pdu = Uint8Array.from([0x62, 0x40, 0x02, 0x01]);
    expect(decodeVinResponse(pdu)).toBeNull();
  });

  it('rejects a positive response for the wrong SID', () => {
    const pdu = Uint8Array.from([0x41, 0x0c, 0x1a, 0x2b]);
    expect(decodeVinResponse(pdu)).toBeNull();
  });

  it('rejects an all-padding (empty after stripping) response', () => {
    const pdu = Uint8Array.from([0x62, 0xf1, 0x90, 0x00, 0x00, 0x20]);
    expect(decodeVinResponse(pdu)).toBeNull();
  });

  it('rejects a malformed (empty) PDU', () => {
    expect(decodeVinResponse(Uint8Array.from([]))).toBeNull();
  });
});

/** A fake `SweepTransport` that answers exactly one queued response (or 'timeout'), for `readVinFromChannel`. */
function fakeChannel(answer: Uint8Array | 'timeout'): SweepTransport {
  const sent: Uint8Array[] = [];
  return {
    async send(pdu: Uint8Array): Promise<void> {
      sent.push(pdu);
    },
    async nextResponse(): Promise<Uint8Array | 'timeout'> {
      return answer;
    },
    async keepAlive(): Promise<void> {},
  };
}

describe('readVinFromChannel', () => {
  it('sends the VIN request and decodes a positive answer', async () => {
    const pdu = Uint8Array.from([0x62, 0xf1, 0x90, ...asciiBytes('WBA12345678901234')]);
    const channel = fakeChannel(pdu);
    await expect(readVinFromChannel(channel)).resolves.toBe('WBA12345678901234');
  });

  it('resolves null on a timeout', async () => {
    const channel = fakeChannel('timeout');
    await expect(readVinFromChannel(channel)).resolves.toBeNull();
  });

  it('resolves null on an NRC', async () => {
    const channel = fakeChannel(Uint8Array.from([0x7f, 0x22, 0x31]));
    await expect(readVinFromChannel(channel)).resolves.toBeNull();
  });

  it('resolves null (never throws) if send() rejects', async () => {
    const channel: SweepTransport = {
      async send(): Promise<void> {
        throw new Error('socket gone');
      },
      async nextResponse(): Promise<Uint8Array | 'timeout'> {
        return 'timeout';
      },
      async keepAlive(): Promise<void> {},
    };
    await expect(readVinFromChannel(channel)).resolves.toBeNull();
  });
});
