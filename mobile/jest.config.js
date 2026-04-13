module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|react-native-reanimated|react-native-gesture-handler|react-native-confetti-cannon|react-native-worklets|moti|lottie-react-native|@tanstack/.*|zustand)',
  ],
  testMatch: [
    '**/__tests__/**/*.test.{ts,tsx}',
    '**/*.test.{ts,tsx}',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  collectCoverageFrom: [
    'components/**/*.{ts,tsx}',
    'hooks/**/*.{ts,tsx}',
    'store/**/*.{ts,tsx}',
    'services/**/*.{ts,tsx}',
    '!**/*.d.ts',
    '!**/index.ts',
  ],
  // Coverage thresholds — floors, not aspirations. CI enforces via
  // `npm test -- --coverage`. Target before GA is 70/60/70/70 per #51.
  // Current mobile coverage as of 2026-04-12 (after store + services +
  // useTeams helper tests): stmts 27.36 / branches 34.48 / funcs 21.21 /
  // lines 27.83. Thresholds set ~1pt below actuals to tolerate trivial
  // churn. These must only ratchet upward — see issue #51.
  coverageThreshold: {
    global: {
      branches: 33,
      functions: 20,
      lines: 26,
      statements: 26,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testEnvironment: 'jsdom',
};
