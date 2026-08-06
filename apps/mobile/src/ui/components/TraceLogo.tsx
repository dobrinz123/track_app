import React from 'react';
import { Image, ImageStyle, StyleProp, StyleSheet, View } from 'react-native';

interface TraceLogoProps {
  size?: number;
  style?: StyleProp<ImageStyle>;
}

export const TraceLogo: React.FC<TraceLogoProps> = ({ size = 44, style }) => {
  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Image
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        source={require('../../../assets/trace_logo_mark.png')}
        style={[{ width: size, height: size }, style]}
        resizeMode="contain"
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
});
