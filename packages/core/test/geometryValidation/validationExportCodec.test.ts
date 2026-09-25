import { describe, expect, it } from 'vitest';

import {
  decodeValidationExport,
  encodeValidationExport,
  MAX_VALIDATION_EXPORT_BYTES,
  toValidationTrace,
  VALIDATION_EXPORT_VERSION,
} from '../../src/geometryValidation';
import type { ValidationExportInput } from '../../src/geometryValidation';

function validInput(): ValidationExportInput {
  return {
    circuitId: 'transilvania-motor-ring',
    layoutVersion: 2,
    driverId: 'a1b2c3',
    cleanLapCount: 7,
    createdAtUtc: '2026-09-25T10:00:00.000Z',
    samples: [
      { tMono: 0, lat: 46.5, lon: 24.5, accuracyM: 3, speedMps: 40, source: 'gnss' },
      {
        tMono: 1000,
        tUtc: 1790330400000,
        lat: 46.5001,
        lon: 24.5002,
        accuracyM: 4,
        source: 'gnss',
      },
    ],
  };
}

describe('validation export codec', () => {
  it('round-trips a valid export', () => {
    const json = encodeValidationExport(validInput());
    const decoded = decodeValidationExport(json);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.version).toBe(VALIDATION_EXPORT_VERSION);
    expect(decoded.value.samples).toHaveLength(2);
    expect(toValidationTrace(decoded.value)).toEqual({
      driverId: 'a1b2c3',
      cleanLapCount: 7,
      samples: validInput().samples,
    });
  });

  it('refuses to encode invalid input', () => {
    expect(() => encodeValidationExport({ ...validInput(), driverId: '' })).toThrow(RangeError);
    expect(() => encodeValidationExport({ ...validInput(), cleanLapCount: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      encodeValidationExport({
        ...validInput(),
        samples: [{ tMono: 0, lat: 120, lon: 0, source: 'gnss' }],
      }),
    ).toThrow(RangeError);
  });

  it('reports malformed JSON and schema errors instead of throwing', () => {
    expect(decodeValidationExport('{not json')).toEqual({
      ok: false,
      errors: ['JSON: validation export is not valid JSON'],
    });

    const wrongVersion = decodeValidationExport(JSON.stringify({ ...validInput(), version: 99 }));
    expect(wrongVersion.ok).toBe(false);

    const extraField = decodeValidationExport(
      JSON.stringify({ version: VALIDATION_EXPORT_VERSION, ...validInput(), driverName: 'Ion' }),
    );
    expect(extraField.ok).toBe(false);
  });

  it('rejects oversized input before parsing', () => {
    const decoded = decodeValidationExport(' '.repeat(MAX_VALIDATION_EXPORT_BYTES + 1));
    expect(decoded).toEqual({
      ok: false,
      errors: ['SIZE: validation export exceeds the maximum size'],
    });
  });
});
