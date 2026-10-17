import { defineConfig } from 'vitest/config';

// Node environment on purpose: `openInApp` takes its browser surface as an
// argument and the pages are rendered with react-dom/server, so no DOM is needed.
export default defineConfig({
  // tsconfig.json says `jsx: preserve` because Next compiles JSX itself; Vite
  // would honour that and hand raw JSX to the runner, so override it here.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
  },
});
