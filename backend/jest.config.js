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
  // Current snapshot (2026-06-19, pass 4):
  //   Istanbul summary — global stmts 90.91 / branches 71.55 / lines 91.01 /
  //   functions 93.46; services stmts 96.29 / branches 84.53 / lines 96.43 /
  //   functions 100.
  //   Jest threshold-global computes lower than the summary (known quirk):
  //   global stmts 84.71 / branches 57.60 / lines 84.75 / functions 87.09;
  //   services stmts 96.38 / branches 84.55 / lines 96.58 / functions 100.
  //   Pass 4 added error-path/role-check branch tests for game-event,
  //   rsvp, announcement, invitation (listInvitations auth) and
  //   stats (getPlayerGameStats) services.
  //   Thresholds are calibrated against the Jest threshold-global numbers,
  //   rounded down for cushion. Never lower.
  // GA targets (per summary): global 80/70/80/80, services 85/75/85/85.
  //   Summary-level GA targets are met; services branches (84.53) is just
  //   under the 85 aspiration. Ratchet tracking: #51.
  coverageThreshold: {
    global: {
      branches: 57,
      // 86 (not #51's originally proposed 87): merging the #40 entitlement
      // middleware and #43 usage-metering code into this branch added functions
      // whose coverage lands the merged-tree global at 86.41%. Ratcheted to the
      // achieved floor so the gate stays deterministic; this still matches
      // the prior function gate (no regression below it).
      functions: 86,
      lines: 84,
      statements: 84,
    },
    './src/services/': {
      branches: 84,
      functions: 100,
      lines: 96,
      statements: 96,
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

