import { describe, expect, it } from 'vitest';

import {
  convertSpeedKph,
  formatSpeedShort,
  formatSpeedSpoken,
  formatSpeedValue,
  speedUnitLabel,
  speedUnitWord,
} from '../../src/ui/format';

describe('speed unit formatting (F5 fix)', () => {
  it('km/h default: value passes through unchanged, short label "km/h"', () => {
    expect(convertSpeedKph(160, 'kmh')).toBe(160);
    expect(formatSpeedValue(159.6, 'kmh')).toBe(160);
    expect(speedUnitLabel('kmh')).toBe('km/h');
    expect(formatSpeedShort(159.6, 'kmh')).toBe('160 km/h');
  });

  it('mph setting: converts and rounds correctly, short label "mph"', () => {
    // 160 km/h * 0.621371 = 99.42 -> rounds to 99.
    expect(formatSpeedValue(160, 'mph')).toBe(99);
    expect(speedUnitLabel('mph')).toBe('mph');
    expect(formatSpeedShort(160, 'mph')).toBe('99 mph');

    // 112 km/h (a real TMR C9 advisory) -> ~69.6 mph -> rounds to 70.
    expect(formatSpeedValue(112, 'mph')).toBe(70);
  });

  it('spoken phrase always includes a full unit word, never a bare number', () => {
    expect(speedUnitWord('kmh')).toBe('kilometers per hour');
    expect(speedUnitWord('mph')).toBe('miles per hour');
    expect(formatSpeedSpoken(90, 'kmh')).toBe('90 kilometers per hour');
    expect(formatSpeedSpoken(70, 'mph')).toBe('43 miles per hour');
  });

  it('mph and kmh diverge for the same input (proves the setting is actually honored, not ignored)', () => {
    const kph = 180;
    expect(formatSpeedValue(kph, 'kmh')).not.toBe(formatSpeedValue(kph, 'mph'));
  });
});
