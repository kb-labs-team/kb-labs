import { test, expect } from '@playwright/test'

const GATEWAY = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '')
const accessMode = process.env.KB_ACCESS_MODE ?? 'local'

const registryPackages = [
  { handle: 'kb-labs', name: 'commit', fullName: 'kb-labs/commit', identity: '@kb-labs/commit', version: '1.2.3', primaryKind: 'plugin', description: 'Commit plugin', featured: false, badges: [], trust: 'trusted', installs: 0, publishedAt: '2026-11-24T00:00:00.000Z' },
  { handle: 'kb-labs', name: 'adapters-vibeproxy', fullName: 'kb-labs/adapters-vibeproxy', identity: '@kb-labs/adapters-vibeproxy', version: '2.3.4', primaryKind: 'adapter', description: 'VibeProxy adapter', featured: false, badges: [], trust: 'trusted', installs: 0, publishedAt: '2026-11-24T00:00:00.000Z' },
]

async function mockRegistryCatalog(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/marketplace/registry/catalog/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname
    if (request.method() === 'GET' && path.endsWith('/packages')) {
      const query = url.searchParams.get('q')?.toLowerCase() ?? ''
      const packages = registryPackages.filter((item) => !query || item.name.toLowerCase().includes(query) || item.identity.toLowerCase().includes(query))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(packages) })
      return
    }
    if (request.method() === 'GET' && path.endsWith('/status')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ trustedInstallAvailable: true }) })
      return
    }
    const requestedName = decodeURIComponent(path.split('/').at(-1) ?? '')
    const summary = registryPackages.find((item) => item.name === requestedName)
    if (request.method() === 'GET' && summary) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        name: summary.name,
        authorHandle: summary.handle,
        primaryKind: summary.primaryKind,
        visibility: 'public',
        trust: 'trusted',
        deprecated: false,
        featured: false,
        badges: [],
        tags: [],
        meta: { name: summary.name, identity: summary.identity, version: summary.version, description: summary.description },
        versions: [{ version: summary.version, publishedAt: summary.publishedAt, integrity: 'sha512-test' }],
      }) })
      return
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Package not found' }) })
  })
}

async function mockMarketplaceHost(page: import('@playwright/test').Page) {
  await page.route('**/api/v1/projects', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
      { id: 'project-a', name: 'Project A' },
      { id: 'project-b', name: 'Project B' },
    ]) })
  })
  await page.route('**/api/v1/plugins?*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
  })
  await page.route('**/api/v1/marketplace/packages?*', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [], total: 0 }) })
  })
}

async function signInIfSecured(page: import('@playwright/test').Page) {
  if (accessMode !== 'secured') return
  const email = process.env.KB_STUDIO_ADMIN_EMAIL
  const password = process.env.KB_STUDIO_ADMIN_PASSWORD
  expect(email, 'KB_STUDIO_ADMIN_EMAIL is required in secured mode').toBeTruthy()
  expect(password, 'KB_STUDIO_ADMIN_PASSWORD is required in secured mode').toBeTruthy()
  await page.goto(`${GATEWAY}/`)
  await expect(page).toHaveURL(/\/login$/)
  await page.getByLabel('Email').fill(email!)
  await page.getByLabel('Password').fill(password!)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await expect(page).not.toHaveURL(/\/login$/)
}

async function openMarketplace(page: import('@playwright/test').Page) {
  await signInIfSecured(page)
  await page.goto(`${GATEWAY}/marketplace`)
  await expect(page.getByRole('heading', { name: 'Marketplace', exact: true })).toBeVisible()
}

async function selectProject(page: import('@playwright/test').Page, name: string) {
  await page.getByRole('combobox', { name: 'Active project', exact: true }).click()
  await page.getByRole('option', { name, exact: true }).click()
}

async function ensureCommitInstalled(page: import('@playwright/test').Page, projectName: string) {
  const response = await page.request.get(`${GATEWAY}/api/v1/projects`)
  expect(response.ok()).toBeTruthy()
  const payload = await response.json() as { data: Array<{ id: string; name: string }> }
  const project = payload.data.find((entry) => entry.name === projectName)
  expect(project, `Project ${projectName} must be registered`).toBeTruthy()
  const installedResponse = await page.request.get(`${GATEWAY}/api/v1/plugins`, { params: { projectId: project!.id } })
  expect(installedResponse.ok()).toBeTruthy()
  const installedPayload = await installedResponse.json() as { data: Array<{ id: string }> }
  if (installedPayload.data.some((entry) => entry.id === '@kb-labs/commit')) return
  const installResponse = await page.request.post(`${GATEWAY}/api/v1/plugins/install`, {
    data: { projectId: project!.id, spec: '@kb-labs/commit' },
  })
  expect(installResponse.ok()).toBeTruthy()
}

test('Marketplace opens on installed project plugins @S-182.1', async ({ page }) => {
  await openMarketplace(page)
  await selectProject(page, 'Project A')
  await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open marketplace', exact: true })).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(0)
})

test('browse the public Registry catalog and inspect canonical identity @S-322.1 @S-322.2', async ({ page }) => {
  await mockMarketplaceHost(page)
  await mockRegistryCatalog(page)
  await openMarketplace(page)
  await page.getByRole('button', { name: 'Open marketplace', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Marketplace catalog', exact: true })).toBeVisible()
  await expect(page.getByText('plugin', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('adapter', { exact: true }).first()).toBeVisible()
  await page.getByLabel('Search Marketplace Registry').fill('@kb-labs/commit')
  await page.getByRole('button', { name: 'View package', exact: true }).first().click()
  await expect(page.getByText('Canonical identity', { exact: false })).toContainText('@kb-labs/commit')
})

test('install a Registry plugin using its canonical identity @S-322.3', async ({ page }) => {
  await mockMarketplaceHost(page)
  await mockRegistryCatalog(page)
  let installRequest: { projectId?: string; spec?: string } | undefined
  await page.route('**/api/v1/plugins/install-from-registry', async (route) => {
    installRequest = route.request().postDataJSON() as { projectId?: string; spec?: string }
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { installed: [{ id: installRequest.spec, version: '1.2.3' }] } }) })
  })
  await openMarketplace(page)
  await page.getByRole('button', { name: 'Open marketplace', exact: true }).click()
  await page.getByLabel('Search Marketplace Registry').fill('@kb-labs/commit')
  await page.getByRole('button', { name: 'View package', exact: true }).first().click()
  await selectProject(page, 'Project A')
  await page.getByRole('button', { name: 'Install plugin', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Installed @kb-labs/commit')
  expect(installRequest).toMatchObject({ projectId: expect.any(String), spec: '@kb-labs/commit@1.2.3' })
})

test('install a Registry adapter using its canonical identity @S-322.4', async ({ page }) => {
  await mockMarketplaceHost(page)
  await mockRegistryCatalog(page)
  let installRequest: { spec?: string } | undefined
  await page.route('**/api/v1/marketplace/packages/adapters/install', async (route) => {
    installRequest = route.request().postDataJSON() as { spec?: string }
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true, data: { installed: [{ id: installRequest.spec, version: '2.3.4' }] } }) })
  })
  await openMarketplace(page)
  await page.getByRole('button', { name: 'Open marketplace', exact: true }).click()
  await page.getByLabel('Search Marketplace Registry').fill('@kb-labs/adapters-vibeproxy')
  await page.getByRole('button', { name: 'View package', exact: true }).first().click()
  await page.getByRole('button', { name: 'Install adapter', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('@kb-labs/adapters-vibeproxy')
  expect(installRequest).toMatchObject({ spec: '@kb-labs/adapters-vibeproxy@2.3.4' })
})

test('keep project B unchanged in Marketplace @S-182.4', async ({ page }) => {
  await openMarketplace(page)
  await selectProject(page, 'Project B')
  await expect(page.getByRole('row').filter({ hasText: '@kb-labs/commit' })).toHaveCount(0)
})

test('manage installed Commit from Marketplace @S-182.6', async ({ page }) => {
  await openMarketplace(page)
  await ensureCommitInstalled(page, 'Project A')
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Marketplace', exact: true })).toBeVisible()
  await selectProject(page, 'Project A')
  const commitRow = page.getByRole('row').filter({ hasText: '@kb-labs/commit' })
  await expect(commitRow).toBeVisible()
  await commitRow.getByRole('switch').click()
  await expect(commitRow.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await commitRow.getByRole('switch').click()
  await expect(commitRow.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  await commitRow.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(commitRow).toHaveCount(0)
})
