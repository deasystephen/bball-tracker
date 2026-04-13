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
  // `npm test -- --coverage`. Current mobile coverage is very low
  // (stmts 10.42 / branches 18.75 / lines 10.88 / functions 9.26 as of
  // 2026-04-12); thresholds set ~1pt below. These should ratchet up
  // aggressively before GA — see issue #51.
  coverageThreshold: {
    global: {
      branches: 17,
      functions: 8,
      lines: 9,
      statements: 9,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testEnvironment: 'jsdom',
};
