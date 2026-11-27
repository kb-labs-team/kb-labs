import { expect, type APIRequestContext, type Page } from '@playwright/test'
import { loginAdmin, unwrapGatewaySuccess } from '@kb-labs/e2e-shared/auth.js'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'

const projectId = process.env.KB_PROJECT_ID

export async function connectToInstalledStudio(request: APIRequestContext): Promise<void> {
  if (projectId) await loginAdmin(request)
}

export async function openInstalledStudio(page: Page, path: string): Promise<void> {
  await connectToInstalledStudio(page.request)
  if (projectId) {
    await page.addInitScript(id => {
      localStorage.setItem('kb-studio-active-project', id)
      localStorage.setItem('kb.workflow.projectId', id)
    }, projectId)
  }
  await page.goto(`${GATEWAY}${path}`)
}

export async function readStudioRegistry(request: APIRequestContext) {
  await connectToInstalledStudio(request)
  const response = await request.get(`${GATEWAY}/api/v1/studio/registry`)
  expect(response.status(), 'The installed Gateway must serve the Studio registry').toBe(200)
  const registry = unwrapGatewaySuccess<{ plugins: { pluginId: string; remoteEntryUrl: string }[] }>(await response.json())
  expect(Array.isArray(registry.plugins)).toBe(true)
  return registry.plugins
}

export async function readRemoteChunks(request: APIRequestContext, remote: URL) {
  const manifest = await request.get(new URL('mf-manifest.json', remote).href)
  expect(manifest.status()).toBe(200)
  const { exposes } = await manifest.json() as { exposes: { assets: { js: { sync: string[]; async: string[] } } }[] }
  const chunks = [...new Set(exposes.flatMap(({ assets }) => [...assets.js.sync, ...assets.js.async]))]
  expect(chunks.length, `The remote at ${remote.pathname} must declare JavaScript chunks`).toBeGreaterThan(0)
  return chunks.map(chunk => new URL(chunk, remote).href)
}
