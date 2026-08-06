import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radii, spacing, typography } from '../theme';

export interface SectorBarProps {
  /** 0-based index of the current sector. */
  currentSector: number;
  sectorCount?: number;
}

/** Sector indicator (S1/S2/S3…), highlighting the current sector. */
export function SectorBar({ currentSector, sectorCount = 3 }: SectorBarProps): React.JSX.Element {
  const sectors = Array.from({ length: sectorCount }, (_, i) => i);
  return (
    <View style={styles.row} accessibilityRole="tablist" accessibilityLabel={`Sector ${currentSector + 1} of ${sectorCount}`}>
      {sectors.map((i) => {
        const active = i === currentSector;
        return (
          <View
            key={i}
            style={[styles.chip, active ? styles.chipActive : styles.chipInactive]}
            accessibilityLabel={`Sector ${i + 1}${active ? ', current' : ''}`}
          >
            <Text style={[styles.label, active ? styles.labelActive : styles.labelInactive]} maxFontSizeMultiplier={1.3}>
              S{i + 1}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  chip: {
    flex: 1,
    borderRadius: radii.sm,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderWidth: 1,
  },
  chipActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  chipInactive: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
  },
  label: {
    ...typography.subtitle,
  },
  labelActive: {
    color: '#06101F',
  },
  labelInactive: {
    color: colors.textSecondary,
  },
});
