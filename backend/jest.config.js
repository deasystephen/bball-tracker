module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  // Setup file for global mocks
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/config/**',
    '!src/kafka/**',
    '!src/flink/**',
    '!src/websocket/**',
  ],
  // Coverage thresholds — floors, not aspirations. CI enforces these via
  // `npm test -- --coverage`. Ratchet upward over time; never lower.
  // Current snapshot (2026-04-12): global stmts 75.55 / branches 55.74 /
  // lines 75.73 / functions 79.13; services stmts 67.38 / branches 54.45 /
  // lines 67.65 / functions 69.84. Thresholds set ~1pt below for cushion.
  // Ratchet tracking: issue #51.
  coverageThreshold: {
    global: {
      branches: 54,
      functions: 78,
      lines: 74,
      statements: 74,
    },
    './src/services/': {
      branches: 53,
      functions: 68,
      lines: 66,
      statements: 66,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^expo-server-sdk$': '<rootDir>/tests/__mocks__/expo-server-sdk.js',
  },
  // Force Jest to exit after tests complete
  forceExit: true,
  // Increase timeout for server cleanup
  testTimeout: 10000,
  // Clear mocks between tests
  clearMocks: true,
  // Verbose output
  verbose: true,
};

