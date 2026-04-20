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
  // Pass 2 (2026-04-12): added React-Query runtime tests for useGames,
  // useGameEvents, useSeasons, useStats, useInvitations via a new
  // QueryClient test wrapper; covered services/sentry.ts; added StatRow
  // + SeasonAverages component tests. Observed: stmts 48.94 /
  // branches 49.24 / funcs 47.56 / lines 48.81.
  // Pass 3 (2026-04-19): added React-Query runtime tests for
  // useAnnouncements + useNotifications (full effect path: device gating,
  // permission flow, push-token registration, deep-link routing on tap),
  // and component tests for game/OpponentScoreButtons, ShotButtons,
  // StatButtons, UndoBanner, ScoreDisplay, PlayerRoster. Observed:
  // stmts 62.94 / branches 59.72 / funcs 60.48 / lines 62.77.
  // Thresholds set ~1pt below actuals to tolerate trivial churn. These
  // must only ratchet upward — see issue #51.
  coverageThreshold: {
    global: {
      branches: 58,
      functions: 59,
      lines: 61,
      statements: 61,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
  testEnvironment: 'jsdom',
};
