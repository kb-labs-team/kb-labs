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
  await page.getByPlaceholder('Search Studio plugins...').fill('@kb-labs/commit')
  await expect(page.getByText('@kb-labs/commit', { exact: true }).first()).toBeVisible()
}

test('find Commit in the Studio plugin projection', async ({ page }) => {
  await openMarketplace(page)
  await expect(page.getByText(/available version/i)).toBeVisible()
})

test('browse the public Registry catalog and inspect canonical identity @S-322.1 @S-322.2', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio marketplace journey hook')
  await signInIfSecured(page)
  await page.goto(`${GATEWAY}/marketplace/catalog`)
  await expect(page.getByRole('heading', { name: 'Marketplace catalog', exact: true })).toBeVisible()
  await expect(page.getByText('plugin', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('adapter', { exact: true }).first()).toBeVisible()
  await page.getByLabel('Search Marketplace Registry').fill('@kb-labs/commit')
  await page.getByRole('button', { name: 'View package', exact: true }).first().click()
  await expect(page.getByText('Canonical identity', { exact: false })).toContainText('@kb-labs/commit')
})

test('install a Registry plugin using its canonical identity @S-322.3', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio marketplace journey hook')
  await signInIfSecured(page)
  await page.goto(`${GATEWAY}/marketplace/catalog`)
  await page.getByLabel('Search Marketplace Registry').fill('@kb-labs/commit')
  await page.getByRole('button', { name: 'View package', exact: true }).first().click()
  await page.getByRole('combobox', { name: 'Active project', exact: true }).click()
  await page.getByText('Project A', { exact: true }).last().click()
  await page.getByRole('button', { name: 'Install plugin', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Installed @kb-labs/commit')
})

test('install a Registry adapter using its canonical identity @S-322.4', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio marketplace journey hook')
  await signInIfSecured(page)
  await page.goto(`${GATEWAY}/marketplace/catalog`)
  await page.getByLabel('Search Marketplace Registry').fill('@kb-labs/adapters-vibeproxy')
  await page.getByRole('button', { name: 'View package', exact: true }).first().click()
  await page.getByRole('button', { name: 'Install adapter', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('@kb-labs/adapters-vibeproxy')
})

test('inspect Commit details in the Studio plugin projection', async ({ page }) => {
  await openMarketplace(page)
  await page.getByText('@kb-labs/commit', { exact: true }).first().click()
  await expect(page.getByRole('heading', { name: '@kb-labs/commit', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Overview', exact: true }).click()
  await expect(page.getByText('Package details', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Permissions', exact: true }).click()
  await expect(page.getByText('Declared permissions', { exact: true })).toBeVisible()
})

test('install Commit from its Studio plugin detail into project A', async ({ page }) => {
  await openMarketplace(page)
  await page.getByText('@kb-labs/commit', { exact: true }).first().click()
  await page.getByRole('combobox', { name: 'Project', exact: true }).click()
  await page.getByText('Project A', { exact: true }).last().click()
  await page.getByRole('button', { name: 'Install Commit', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Installed Commit for Project A')
  await page.getByRole('link', { name: 'Marketplace', exact: true }).first().click()
  await page.getByRole('tab', { name: 'Installed', exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: '@kb-labs/commit' })).toContainText(/\d+\.\d+\.\d+/)
  await page.getByRole('link', { name: 'Commit', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Commit', exact: true })).toBeVisible()
})

test('keep project B unchanged in Marketplace installed view @S-182.4', async ({ page }) => {
  await openMarketplace(page)
  await page.getByText('@kb-labs/commit', { exact: true }).first().click()
  await page.getByRole('combobox', { name: 'Project', exact: true }).click()
  await page.getByText('Project B', { exact: true }).last().click()
  await page.getByRole('link', { name: 'Marketplace', exact: true }).first().click()
  await page.getByRole('tab', { name: 'Installed', exact: true }).click()
  await expect(page.getByRole('row').filter({ hasText: '@kb-labs/commit' })).toHaveCount(0)
})

test('show actionable error when installing an unknown package @S-182.5', async ({ page }) => {
  await openMarketplace(page)
  await page.getByRole('combobox', { name: 'Active project', exact: true }).click()
  await page.getByText('Project A', { exact: true }).last().click()
  await page.getByRole('tab', { name: 'Installed', exact: true }).click()
  await page.getByLabel('Plugin package and version').fill('@kb-labs/unknown-package')
  await page.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/package.*not found/i)
  await expect(page.getByRole('alert')).toContainText(/kb marketplace search/i)
  await expect(page.getByRole('row').filter({ hasText: '@kb-labs/unknown-package' })).toHaveCount(0)
})

test('manage installed Commit from Marketplace @S-182.6', async ({ page }) => {
  await openMarketplace(page)
  await page.getByText('@kb-labs/commit', { exact: true }).first().click()
  await page.getByRole('combobox', { name: 'Project', exact: true }).click()
  await page.getByText('Project A', { exact: true }).last().click()
  const installButton = page.getByRole('button', { name: 'Install Commit', exact: true })
  if (await installButton.isVisible()) {
    await installButton.click()
    await expect(page.getByRole('status')).toContainText('Installed Commit for Project A')
  }
  await page.getByRole('link', { name: 'Marketplace', exact: true }).first().click()
  await page.getByRole('tab', { name: 'Installed', exact: true }).click()
  const commitRow = page.getByRole('row').filter({ hasText: '@kb-labs/commit' })
  await expect(commitRow).toBeVisible()
  await commitRow.getByRole('switch').click()
  await expect(commitRow.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  await commitRow.getByRole('switch').click()
  await expect(commitRow.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  await commitRow.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(commitRow).toHaveCount(0)
})
