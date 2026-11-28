import { defineConfig } from '@playwright/test'
import path from 'path'
import { projectAuthStatePath } from '@kb-labs/e2e-shared/project-auth-setup.js'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

process.env.CHECKLIST_OUT ??= path.join(__dirname, 'report', 'CHECKLIST.md')

export default defineConfig({
  globalSetup: '../shared/src/project-auth-setup.ts',
  testDir: './scenarios',
  testMatch: '**/cases/**/*.spec.ts',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'report', open: 'never' }],
    ['@kb-labs/e2e-shared/reporter.js'],
  ],
  use: { actionTimeout: 10_000, storageState: process.env.KB_PROJECT_ID ? projectAuthStatePath : undefined },
})
