import { defineConfig } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'
import { projectAuthStatePath } from '@kb-labs/e2e-shared/project-auth-setup.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Each domain writes its own checklist into report/CHECKLIST.md
process.env.CHECKLIST_OUT ??= path.join(__dirname, 'report', 'CHECKLIST.md')
process.env.FLAKY_REPORT_OUT ??= path.join(__dirname, 'flaky-report.json')

export default defineConfig({
  globalSetup: '../shared/src/project-auth-setup.ts',
  testDir: './specs',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'report', open: 'never' }],
    ['@kb-labs/e2e-shared/reporter.js'],
    ['@kb-labs/e2e-shared/flaky-reporter.js', { suite: 'mcp' }],
  ],
  use: { actionTimeout: 10_000, storageState: process.env.KB_PROJECT_ID ? projectAuthStatePath : undefined },
})
