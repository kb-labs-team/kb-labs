import { test, expect } from '@playwright/test'

const GATEWAY = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '')
const enabled = process.env.KB_STUDIO_MARKETPLACE_JOURNEY === '1'
const accessMode = process.env.KB_ACCESS_MODE ?? 'local'

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
  test.skip(!enabled, 'Enabled by the installed Studio marketplace journey hook')
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
