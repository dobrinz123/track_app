import { defineConfig } from 'vitest/config';

// Mirrors packages/core/vitest.config.ts (the model this ticket follows).
// PURE-TS session/persistence modules only -- no React Native test renderer,
// no expo runtime; see apps/mobile/test/support/** for how expo-* imports
// are kept out of the modules under test.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
