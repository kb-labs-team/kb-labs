import { request } from '@playwright/test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loginAdmin } from './auth.js'

export const projectAuthStatePath = join(tmpdir(), 'kb-e2e-project-auth-state.json')

/** Seed the Playwright request fixture with the secured host's admin session. */
export default async function projectAuthSetup(): Promise<void> {
  if (!process.env.KB_PROJECT_ID) return

  const context = await request.newContext()
  try {
    await loginAdmin(context)
    await context.storageState({ path: projectAuthStatePath })
  } finally {
    await context.dispose()
  }
}
