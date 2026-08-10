// @ts-check
import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/dist-export/**',
      '**/.expo/**',
      '**/*.config.js',
      '**/*.config.mjs',
      '**/*.config.cjs',
      'apps/mobile/expo-env.d.ts',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // packages/core must stay a pure TS domain package: zero React/RN/Expo imports.
    files: ['packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-dom', 'react-native', 'react-native/*', 'expo', 'expo/*', 'expo-*'],
              message: 'packages/core is a pure TypeScript domain package and must not import React, React Native, or Expo.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    // WP-C6: apps/mobile/scripts/generate-voice-pack.mjs is a plain Node
    // ESM CLI script (not TypeScript, so the `**/*.ts` block above doesn't
    // cover it) -- needs Node globals (process, console, fetch, Buffer, ...)
    // the same way packages/core/scripts's `.ts` generator gets them via
    // the block above.
    files: ['apps/mobile/scripts/**/*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
  prettierConfig,
];
