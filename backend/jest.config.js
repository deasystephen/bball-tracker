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
  // Current snapshot (2026-04-13, pass 2): global stmts 82.82 / branches 62.20 /
  // lines 83.05 / functions 87.41; services stmts 81.36 / branches 67.19 /
  // lines 81.76 / functions 88.09. Thresholds set ~1-2pt below for cushion.
  // Note: Jest's threshold-global branches computes lower than the istanbul
  // "All files" summary on CI (known quirk). Branches floor is calibrated
  // conservatively against the summary. Ratchet tracking: #51.
  coverageThreshold: {
    global: {
      branches: 57,
      functions: 86,
      lines: 82,
      statements: 82,
    },
    './src/services/': {
      branches: 65,
      functions: 86,
      lines: 80,
      statements: 80,
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

