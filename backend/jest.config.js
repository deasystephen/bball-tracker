// Packages in pdfkit's dependency tree that ship ES modules with no CommonJS
// entry. When a pdfkit bump fails with "Cannot use import statement outside a
// module", the file named in the error belongs to a package missing from here.
// @noble/* (PDF encryption) and brotli (WOFF2 fonts) load only on paths no test
// reaches today; they are listed because they are ES modules only as well.
const ESM_ONLY_PACKAGES = [
  '@noble/ciphers',
  '@noble/hashes',
  'brotli',
  'dfa',
  'fontkit',
  'linebreak',
  'unicode-properties',
  'unicode-trie',
];

const ESM_PACKAGE_TSCONFIG = {
  allowJs: true,
  module: 'commonjs',
  target: 'ES2022',
  esModuleInterop: true,
  isolatedModules: true,
};

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  // The real-Redis suite (tests/redis/*.redis.test.ts, #452) needs a running
  // Redis, which plain `npm test` does not assume; `npm run test:redis` runs it
  // (it overrides this list), and CI runs that script in the job with the
  // Redis service.
  testPathIgnorePatterns: ['/node_modules/', '\\.redis\\.test\\.ts$'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    // pdfkit 0.21 depends on fontkit 3, which is published as ES modules only,
    // like several packages under it. Node 22 can require() those, so the
    // server needs nothing; Jest's CommonJS runtime cannot, so the packages in
    // ESM_ONLY_PACKAGES are compiled to CommonJS for the tests. This keeps the
    // real PDF code under test instead of a mock.
    '^.+\\.m?js$': ['ts-jest', { tsconfig: ESM_PACKAGE_TSCONFIG, diagnostics: false }],
  },
  transformIgnorePatterns: [`/node_modules/(?!(?:${ESM_ONLY_PACKAGES.join('|')})/)`],
  // Setup file for global mocks
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    '!src/config/**',
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
    // unicode-properties picks its trie loader through a `#binary-trie`
    // subpath import; the Node variant reads `import.meta.url`, which does not
    // exist in CommonJS. The browser variant decodes the same data from base64.
    '^#binary-trie$': '<rootDir>/node_modules/unicode-properties/binaryTrie.browser.js',
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

