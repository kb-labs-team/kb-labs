import { defineConfig } from '@playwright/test'
import path from 'path'

// Each domain writes its own checklist into report/CHECKLIST.md
process.env.CHECKLIST_OUT ??= path.join(__dirname, 'report', 'CHECKLIST.md')
process.env.FLAKY_REPORT_OUT ??= path.join(__dirname, 'flaky-report.json')

export default defineConfig({
  testDir: './scenarios',
  testMatch: ['**/cases/**/*.spec.ts', '**/cases/**/*.spec.mjs'],
  timeout: 120_000,
  // Marketplace mutations share one scope lock. Exercise the public API
  // deterministically here; concurrency safety is covered at the service layer.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'report', open: 'never' }],
    ['@kb-labs/e2e-shared/reporter.js'],
    ['@kb-labs/e2e-shared/flaky-reporter.js', { suite: 'marketplace' }],
  ],
  use: { actionTimeout: 10_000 },
})
