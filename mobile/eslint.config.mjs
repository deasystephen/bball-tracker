import expoConfig from 'eslint-config-expo/flat.js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

// Flat ESLint config for the Expo / React Native mobile app.
// Mirrors backend/eslint.config.mjs conventions (typescript-eslint helper,
// project-specific rule block, no blanket eslint-disable suppressions) while
// layering on Expo's RN-aware preset.
export default tseslint.config(
  // Global ignores. `eslint.config.mjs` is excluded because the import resolver
  // bundled with eslint-config-expo cannot resolve its own bare specifiers from
  // this file (false-positive import/no-unresolved on `typescript-eslint`).
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '.expo/**',
      'android/**',
      'ios/**',
      'assets/**',
      'scripts/**',
      'eslint.config.mjs',
    ],
  },

  // Expo / React Native recommended flat config. Bundles @typescript-eslint,
  // eslint-plugin-react, react-hooks (incl. the React Compiler rules),
  // eslint-plugin-import and the RN-aware resolver.
  ...expoConfig,

  // Project-wide rule tuning for TS/TSX source.
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Mirror backend: ignore intentionally-unused names prefixed with `_`.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',

      // react-hooks@7 ships the React Compiler lint rules. The two below fire
      // heavily on idiomatic Reanimated code (mutating `.value` of a shared
      // value inside a worklet/effect) and on legitimate one-shot effect
      // setState, where eliminating them would require a large, risky refactor
      // of working animation/UI code. Downgraded to `warn` (not disabled) so the
      // signal stays visible without blocking CI. See issue #132.
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',

      // Stylistic; flags valid function components passed inline (e.g. as render
      // props / list item renderers). Downgraded to `warn` to avoid a broad
      // rename refactor across existing components. See issue #132.
      'react/display-name': 'warn',
    },
  },

  // Test files and jest setup run under the Jest runtime; expose its globals so
  // `jest`, `describe`, `expect`, etc. are not flagged as no-undef. These files
  // also define throwaway inline mock components, so display-name is relaxed.
  {
    files: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx', '**/*.test.js', 'jest.setup.js'],
    languageOptions: {
      globals: {
        ...globals.jest,
        ...globals.node,
      },
    },
    rules: {
      'react/display-name': 'warn',
    },
  },
);
