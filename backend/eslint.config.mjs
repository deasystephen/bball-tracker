import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // Global ignores
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'prisma/*.ts', 'tests/__mocks__/**'],
  },

  // Base ESLint recommended rules
  eslint.configs.recommended,

  // TypeScript recommended rules
  ...tseslint.configs.recommended,

  // Project-specific configuration for TypeScript files
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // Every rule is an error: `npm run lint` runs with --max-warnings 0 so
      // warnings would fail CI anyway, and keeping them as errors makes the
      // intent explicit. Do not downgrade to 'warn' to get something merged.
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        // Inline callbacks (`arr.map((x) => ...)`, option-object handlers) are
        // contextually typed; only declarations need an explicit annotation.
        { allowExpressions: true },
      ],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': ['error', { allow: ['warn', 'error', 'log'] }],
    },
  },

  // Config for JS config files (jest.config.js, etc.)
  {
    files: ['*.js', '*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
