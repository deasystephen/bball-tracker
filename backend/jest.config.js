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
  // Current snapshot (2026-04-13): global stmts 79.70 / branches 59.49 /
  // lines 79.99 / functions 83.09; services stmts 75.34 / branches 61.78 /
  // lines 75.82 / functions 78.57. Thresholds set ~1pt below for cushion.
  // Ratchet tracking: issue #51.
  coverageThreshold: {
    global: {
      branches: 58,
      functions: 82,
      lines: 79,
      statements: 79,
    },
    './src/services/': {
      branches: 60,
      functions: 77,
      lines: 74,
      statements: 74,
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

