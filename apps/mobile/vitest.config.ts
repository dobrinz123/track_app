import { defineConfig } from 'vitest/config';

// Mirrors packages/core/vitest.config.ts (the model this ticket follows).
// PURE-TS session/persistence modules only -- no React Native test renderer,
// no expo runtime; see apps/mobile/test/support/** for how expo-* imports
// are kept out of the modules under test. The generated voiceClips.gen.ts
// guards its Metro asset requires with safeRequire, so it loads under
// vite-node without any asset-stubbing plugin or alias here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
