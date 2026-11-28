import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '/opt/kb-studio-playwright/specs',
  testMatch: ['**/*.spec.js'],
  workers: 1,
  reporter: [
    ['json', { outputFile: process.env.KB_STUDIO_PLAYWRIGHT_JSON }],
    ['line'],
  ],
  timeout: 120_000,
  // Several case specs run in one journey step (fresh host, first tier, schedules).
  globalTimeout: 600_000,
  expect: { timeout: 10_000 },
  use: {
    headless: true,
    ignoreHTTPSErrors: process.env.KB_STUDIO_OAUTH_JOURNEY === '1',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
});
