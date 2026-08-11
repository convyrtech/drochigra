import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}/`;

/**
 * Smoke test only: serves the production build with `vite preview` and opens it
 * in chromium. Lives in tests/e2e, which vitest excludes.
 *
 * No process.env switches here on purpose: @types/node is not a dependency of
 * this project, and the same settings work locally and in CI.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    command: `npm run preview -- --host ${HOST} --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
