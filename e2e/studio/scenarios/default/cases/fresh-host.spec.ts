import { test, expect } from '@playwright/test'
import { projectServicePath } from '@kb-labs/plugin-contracts/project-service-path'
import { runKbCommand } from '../../../kb-command'
import { errorCatalog } from '@kb-labs/core-platform/error-envelope'

const GATEWAY = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '')

const enabled = process.env.KB_STUDIO_FRESH_HOST_JOURNEY === '1'
const mode = process.env.KB_ACCESS_MODE ?? 'local'
const projectId = process.env.KB_STUDIO_PROJECT_ID
const projectName = process.env.KB_STUDIO_PROJECT_NAME
const analyticsPersistenceNotice = errorCatalog.codes.find(({ code }) => code === 'KB_ANALYTICS_PERSISTENCE_VOLATILE')

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto(`${GATEWAY}/`)
  await expect(page).toHaveURL(/\/login$/)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await expect(page).toHaveURL(`${GATEWAY}/`)
}

test('registered project exposes its Commit plugin', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the project registered by the fresh-install journey').toBeTruthy()
  await openAdminStudio(page)
  await page.goto(`${GATEWAY}/plugins`)
  await expect(page.getByText(/commit/i).first()).toBeVisible()
})

async function openAdminStudio(page: import('@playwright/test').Page) {
  await page.goto(`${GATEWAY}/`)
  if (mode === 'secured') {
    await signIn(page, process.env.KB_STUDIO_ADMIN_EMAIL!, process.env.KB_STUDIO_ADMIN_PASSWORD!)
  }
}

test('local Studio opens Dashboard @S-020.1 @S-125.1', async ({ page }) => {
  test.skip(!enabled || mode !== 'local', 'Enabled in the local fresh-host journey')
  await page.goto(`${GATEWAY}/`)
  await expect(page).not.toHaveURL(/\/login$/)
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  for (const item of ['Dashboard', 'Projects', 'Workflows', 'Marketplace', 'Analytics', 'Observability']) {
    await expect(page.getByRole('link', { name: item, exact: true })).toBeVisible()
  }
})

test('secured anonymous browser receives 401 and login form @S-020.2', async ({ page }) => {
  test.skip(!enabled || mode !== 'secured', 'Enabled in the secured fresh-host journey')
  expect(await page.context().cookies(GATEWAY)).toEqual([])
  const anonymousMe = page.waitForResponse(response => response.url() === `${GATEWAY}/api/auth/me`)
  await page.goto(`${GATEWAY}/`)
  expect((await anonymousMe).status()).toBe(401)
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByLabel('Email')).toBeVisible()
  await expect(page.getByLabel('Password')).toBeVisible()
})

test('secured login has no human signup and registration stays machine-authenticated @S-104.6', async ({ page, request }) => {
  test.skip(!enabled || mode !== 'secured', 'Enabled in the secured fresh-host journey')
  await page.goto(`${GATEWAY}/login`)
  await expect(page.getByLabel('Email')).toBeVisible()
  await expect(page.getByLabel('Password')).toBeVisible()
  await expect(page.getByRole('link', { name: /sign up|create account|register/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign up|create account|register/i })).toHaveCount(0)

  const response = await request.post(`${GATEWAY}/auth/register`, {
    data: { name: 'new-member', email: 'new-member@example.test', password: 'HumanPass123!' },
  })
  expect(response.status()).toBe(401)
  expect(await response.json()).toMatchObject({
    ok: false,
    error: {
      code: 'KB_AUTH_REQUIRED',
      message: 'Authentication is required.',
      hint: `Run "kb auth login --gateway-url ${GATEWAY} --email <email>".`,
    },
  })
})

test('secured admin login opens Dashboard @S-020.3 @S-125.3', async ({ page }) => {
  test.skip(!enabled || mode !== 'secured', 'Enabled in the secured fresh-host journey')
  await signIn(page, process.env.KB_STUDIO_ADMIN_EMAIL!, process.env.KB_STUDIO_ADMIN_PASSWORD!)
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Projects', exact: true })).toBeVisible()
  await expect(page.getByText(process.env.KB_STUDIO_ADMIN_EMAIL!, { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Active project' })).toBeVisible()
  await expect(page.getByText(projectName!, { exact: true }).first()).toBeVisible()
})

test('incorrect secured password keeps login visible @S-020.4', async ({ page }) => {
  test.skip(!enabled || mode !== 'secured', 'Enabled in the secured fresh-host journey')
  await page.goto(`${GATEWAY}/`)
  await expect(page).toHaveURL(/\/login$/)
  await page.getByLabel('Email').fill(process.env.KB_STUDIO_ADMIN_EMAIL!)
  await page.getByLabel('Password').fill('incorrect-journey-password')
  await page.getByRole('button', { name: /sign in|log in/i }).click()
  await expect(page.getByText('Invalid credentials', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})

test('secured refresh restores the dashboard session @S-020.5', async ({ page }) => {
  test.skip(!enabled || mode !== 'secured', 'Enabled in the secured fresh-host journey')
  await signIn(page, process.env.KB_STUDIO_ADMIN_EMAIL!, process.env.KB_STUDIO_ADMIN_PASSWORD!)
  await page.reload()
  await expect(page.getByText(process.env.KB_STUDIO_ADMIN_EMAIL!, { exact: true }).first()).toBeVisible()
  await expect(page.getByText('Healthy', { exact: true })).toBeVisible()
})

test('Studio navigation opens first-tier pages @S-020.6 @S-125.2', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered project').toBeTruthy()
  expect(projectName, 'KB_STUDIO_PROJECT_NAME must identify the registered project').toBeTruthy()
  await page.addInitScript((id) => localStorage.setItem('kb.workflow.projectId', id), projectId)
  await openAdminStudio(page)
  for (const [route, heading] of [
    ['/projects', 'Projects'],
    ['/p/workflows/definitions', 'Workflow Definitions'],
    ['/marketplace', 'Marketplace'],
    ['/analytics/overview', 'Analytics Overview'],
    ['/observability/logs', 'Logs'],
  ]) {
    await page.goto(`${GATEWAY}${route}`)
    await expect(page.getByRole('heading', { name: heading, exact: true }).first()).toBeVisible()
    await expect(page.getByText(projectName!, { exact: true }).first()).toBeVisible()
  }
})

test('fresh-host analytics uses durable default history @S-121.6', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered project').toBeTruthy()
  expect(analyticsPersistenceNotice).toBeDefined()
  await page.addInitScript((id) => localStorage.setItem('kb-studio-active-project', id), projectId)
  await openAdminStudio(page)

  const statsResponse = page.waitForResponse(response => response.url().includes('/analytics/stats'))
  await page.goto(`${GATEWAY}/analytics/overview`)
  const stats = await (await statsResponse).json()
  expect(stats.data.totalEvents).toEqual(expect.any(Number))
  expect(stats.data.persistence).toEqual({ kind: 'durable' })
  await expect(page.getByRole('heading', { name: 'Analytics Overview', exact: true })).toBeVisible()
  await expect(page.getByText('Total Events', { exact: true })).toBeVisible()
  await expect(page.getByText(analyticsPersistenceNotice!.message, { exact: true })).toHaveCount(0)
  await expect(page.getByText(analyticsPersistenceNotice!.hint, { exact: true })).toHaveCount(0)
})

test('secured logout returns to login @S-020.7', async ({ page }) => {
  test.skip(!enabled || mode !== 'secured', 'Enabled in the secured fresh-host journey')
  await signIn(page, process.env.KB_STUDIO_ADMIN_EMAIL!, process.env.KB_STUDIO_ADMIN_PASSWORD!)
  await page.getByRole('button', { name: new RegExp(process.env.KB_STUDIO_ADMIN_EMAIL!, 'i') }).click()
  await page.getByRole('menuitem', { name: 'Logout', exact: true }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto(`${GATEWAY}/`)
  await expect(page).toHaveURL(/\/login$/)
})

test('member lacks user administration navigation @S-108.1', async ({ browser }) => {
  test.skip(!enabled || mode !== 'secured', 'Enabled in the secured fresh-host journey')
  const context = await browser.newContext()
  const memberPage = await context.newPage()
  await signIn(memberPage, process.env.KB_STUDIO_MEMBER_EMAIL!, process.env.KB_STUDIO_MEMBER_PASSWORD!)
  await expect(memberPage.getByRole('link', { name: 'Settings' })).toHaveCount(0)
  await expect(memberPage.getByRole('link', { name: 'Users' })).toHaveCount(0)
  await expect(memberPage.getByRole('link', { name: 'Invites' })).toHaveCount(0)
  await context.close()
})

test('member cannot open user or invite administration @S-108.2', async ({ browser }) => {
  test.skip(!enabled || mode !== 'secured', 'Enabled in the secured fresh-host journey')
  const context = await browser.newContext()
  const memberPage = await context.newPage()
  await signIn(memberPage, process.env.KB_STUDIO_MEMBER_EMAIL!, process.env.KB_STUDIO_MEMBER_PASSWORD!)
  for (const route of ['/admin/users', '/admin/invites']) {
    await memberPage.goto(`${GATEWAY}${route}`)
    await expect(memberPage.getByTestId('forbidden-page')).toBeVisible()
    await expect(memberPage.getByText('403 — Forbidden')).toBeVisible()
    await expect(memberPage.getByText('You do not have permission to view this page.')).toBeVisible()
  }
  await context.close()
})

test('member retains project access @S-108.3', async ({ browser }) => {
  test.skip(!enabled || mode !== 'secured', 'Enabled in the secured fresh-host journey')
  const context = await browser.newContext()
  const memberPage = await context.newPage()
  await signIn(memberPage, process.env.KB_STUDIO_MEMBER_EMAIL!, process.env.KB_STUDIO_MEMBER_PASSWORD!)
  await memberPage.goto(`${GATEWAY}/projects`)
  await expect(memberPage.getByText(projectName!, { exact: true })).toBeVisible()
  await context.close()
})

async function assertSelectedProjectDashboard(page: import('@playwright/test').Page) {
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered project').toBeTruthy()
  expect(projectName, 'KB_STUDIO_PROJECT_NAME must identify the registered project').toBeTruthy()
  await page.addInitScript((id) => localStorage.setItem('kb.workflow.projectId', id), projectId)
  await openAdminStudio(page)
  await expect(page.getByText(projectName!, { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Intelligence Dashboard', exact: true })).toBeVisible()
  await expect(page.getByText('Real-time platform observability and performance analytics', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  await expect(page.getByText('Gateway health', { exact: true })).toBeVisible()
  await expect(page.getByText('Healthy', { exact: true })).toBeVisible()
  await expect(page.getByText(/project activity|recent runs/i)).toHaveCount(0)
}

test('local selected project keeps dashboard platform scoped @S-120.2', async ({ page }) => {
  test.skip(!enabled || mode !== 'local', 'Enabled in the local fresh-host journey')
  await assertSelectedProjectDashboard(page)
})

test('secured selected project keeps dashboard platform scoped @S-120.4', async ({ page }) => {
  test.skip(!enabled || mode !== 'secured', 'Enabled in the secured fresh-host journey')
  await assertSelectedProjectDashboard(page)
})

test('dashboard explains degraded and not-ready gateway states @S-120.5', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  let ready = true
  await page.route('**/api/observability/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status: 'degraded',
      state: 'partial_observability',
      observedAt: new Date().toISOString(),
      checks: [{ id: 'fixture-store', status: 'error', message: 'fixture storage unavailable' }],
    }),
  }))
  await page.route('**/api/ready', route => route.fulfill({
    status: ready ? 200 : 503,
    contentType: 'application/json',
    body: JSON.stringify(ready ? { ready: true } : { ready: false, reason: 'fixture maintenance' }),
  }))
  await openAdminStudio(page)
  await expect(page.getByText('Gateway degraded', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Details' }).click()
  await expect(page.getByText('fixture-store', { exact: true })).toBeVisible()
  await expect(page.getByText('fixture storage unavailable', { exact: true })).toBeVisible()
  await expect(page.getByTitle('Retry')).toBeVisible()
  await expect(page.getByText('Gateway is ready.', { exact: true })).toBeVisible()

  ready = false
  await page.reload()
  await expect(page.getByText('Gateway unavailable', { exact: true })).toBeVisible()
  await expect(page.getByText('Not ready at /api/ready', { exact: false })).toBeVisible()
  await expect(page.getByText('fixture maintenance', { exact: true })).toBeVisible()
  await expect(page.getByText('Gateway is running but not ready.', { exact: true })).toBeVisible()
})

test('notifications show empty and error log states @S-120.6', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered project').toBeTruthy()
  await page.addInitScript((id) => localStorage.setItem('kb.workflow.projectId', id), projectId)
  let sendError = false
  await page.route('**/logs/stream**', route => {
    const event = sendError
      ? `event: log\ndata: ${JSON.stringify({
        id: 'fixture-log-1206',
        time: new Date().toISOString(),
        level: 'error',
        msg: 'fixture notification failure',
        plugin: '@kb-labs/workflow',
        executionId: '0123456789abcdef',
      })}\n\n`
      : ''
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: event,
    })
  })
  await openAdminStudio(page)
  const bell = page.locator('button').filter({ has: page.locator('svg.lucide-bell') })
  await bell.click()
  await expect(page.getByText('No critical logs', { exact: true })).toBeVisible()

  sendError = true
  await page.reload()
  await bell.click()
  await expect(page.getByText('ERROR', { exact: true })).toBeVisible()
  await expect(page.getByText('fixture notification failure', { exact: true })).toBeVisible()
  await expect(page.getByText('@kb-labs/workflow', { exact: true })).toBeVisible()
  await expect(page.getByText('exec: 01234567', { exact: true })).toBeVisible()
  await page.getByText('fixture notification failure', { exact: true }).click()
  await expect(page).toHaveURL(/\/observability\/logs\/fixture-log-1206$/)
})

test('project selector scopes plugin attachments @S-046.1 @S-046.2 @S-046.3', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered project A').toBeTruthy()
  const projectBId = process.env.KB_STUDIO_PROJECT_B_ID
  const projectAName = process.env.KB_STUDIO_PROJECT_A_NAME
  const projectBName = process.env.KB_STUDIO_PROJECT_B_NAME
  expect(projectBId, 'KB_STUDIO_PROJECT_B_ID must identify the registered project B').toBeTruthy()
  expect(projectAName, 'KB_STUDIO_PROJECT_A_NAME must come from real fixture setup').toBeTruthy()
  expect(projectBName, 'KB_STUDIO_PROJECT_B_NAME must come from real fixture setup').toBeTruthy()
  await page.addInitScript((id) => localStorage.setItem('kb.workflow.projectId', id), projectId)
  await openAdminStudio(page)
  await page.goto(`${GATEWAY}/plugins`)
  await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(page.getByText('No plugins found', { exact: true })).toBeVisible()
  await expect(page.getByText(projectAName!, { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('row')).toHaveCount(0)
  await expect(page.getByText(/adapter settings/i)).toHaveCount(0)
  await page.getByRole('combobox', { name: 'Active project' }).click()
  await page.getByRole('option', { name: projectBName!, exact: true }).click()
  await page.goto(`${GATEWAY}/plugins`)
  await expect(page.getByRole('heading', { name: 'Plugins', exact: true })).toBeVisible()
  await expect(page.getByText('@kb-labs/commit', { exact: true })).toBeVisible()
  await expect(page.getByText(projectBName!, { exact: true }).first()).toBeVisible()
  await expect(page.getByRole('row')).toHaveCount(2)
  await expect(page.getByText(/adapter settings/i)).toHaveCount(0)
})

async function openGreetDefinitions(page: import('@playwright/test').Page) {
  expect(process.env.KB_STUDIO_GREET_WORKFLOW_ID, 'Studio fixture must install greet').toBe('greet')
  await page.addInitScript((id) => localStorage.setItem('kb.workflow.projectId', id), projectId)
  await openAdminStudio(page)
  await page.goto(`${GATEWAY}/p/workflows/definitions`)
  return page.getByRole('row').filter({ hasText: 'greet' })
}

test('greet run form identifies required name @S-022.1', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  const row = await openGreetDefinitions(page)
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByText('Run Workflow: greet', { exact: true })).toBeVisible()
  await expect(page.getByText('name', { exact: true })).toBeVisible()
  await expect(page.getByText('*', { exact: true })).toBeVisible()
})

test('greet run submits Ada and opens a run @S-022.2', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  const row = await openGreetDefinitions(page)
  await row.getByRole('button', { name: 'Run' }).click()
  await page.getByLabel('name').fill('Ada')
  await page.getByRole('button', { name: 'Run', exact: true }).last().click()
  await expect(page).toHaveURL(/\/p\/workflows\/runs\/.+/, { timeout: 30_000 })
  await expect(page.getByText(/Run [\w-]{8,}/).first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Queued|Pending|Running|Success/i).first()).toBeVisible()
})

test('greet details show Ada input and successful output @S-022.3', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  const row = await openGreetDefinitions(page)
  await row.getByRole('button', { name: 'Run' }).click()
  await page.getByLabel('name').fill('Ada')
  await page.getByRole('button', { name: 'Run', exact: true }).last().click()
  await expect(page).toHaveURL(/\/p\/workflows\/runs\/.+/, { timeout: 30_000 })
  const runId = new URL(page.url()).pathname.split('/').at(-1)!
  await expect(page.getByRole('heading', { name: 'greet', exact: true })).toBeVisible()
  await expect(page.getByText(`Run ${runId.slice(0, 12)}...`, { exact: true })).toBeVisible()
  await expect(page.getByText('Success', { exact: true })).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Engineering', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Inputs', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Inputs', exact: true }).click()
  await expect(page.getByText(/name\s*:?\s*Ada/i)).toBeVisible()
  await expect(page.getByText('Ada', { exact: false }).last()).toBeVisible()
})

test('greet keeps form open and creates no run with empty name @S-022.4', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  const row = await openGreetDefinitions(page)
  await row.getByRole('button', { name: 'Run' }).click()
  await expect(page.getByText('Run Workflow: greet', { exact: true })).toBeVisible()
  const runRequests: string[] = []
  page.on('request', request => {
    if (request.method() === 'POST' && /workflows\/greet\/runs/.test(request.url())) runRequests.push(request.url())
  })
  await page.getByRole('button', { name: 'Run', exact: true }).last().click()
  await expect(page.getByText('Run Workflow: greet', { exact: true })).toBeVisible()
  await expect(page.getByText('name', { exact: true })).toBeVisible()
  expect(runRequests).toHaveLength(0)
})

async function openCrons(page: import('@playwright/test').Page) {
  await page.addInitScript((selectedProjectId: string | undefined) => {
    if (selectedProjectId) localStorage.setItem('kb.workflow.projectId', selectedProjectId)
  }, projectId)
  await page.goto(`${GATEWAY}/`)
  if (mode === 'secured') {
    await signIn(page, process.env.KB_STUDIO_ADMIN_EMAIL!, process.env.KB_STUDIO_ADMIN_PASSWORD!)
  }
  await page.goto(`${GATEWAY}/p/workflows/crons`)
  await expect(page.getByText('Workflow Crons', { exact: true })).toBeVisible()
}

test('Studio schedules @S-055.1 shows user and read-only plugin crons', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  await openCrons(page)
  const cronId = process.env.KB_STUDIO_CRON_ID!
  await expect(page.getByText(cronId, { exact: true })).toBeVisible()
  for (const column of ['Schedule', 'Target', 'Status', 'Last Run', 'Next Run', 'Source', 'Action']) {
    await expect(page.getByRole('columnheader', { name: column })).toBeVisible()
  }
  const userRow = page.getByRole('row').filter({ hasText: cronId })
  await expect(userRow).toContainText('0 0 * * *')
  await expect(userRow).toContainText('journey-hello')
  await expect(userRow).toContainText('Enabled')
  await expect(userRow.locator('td').nth(5)).toContainText('-')
  await expect(userRow.locator('td').nth(6)).not.toContainText('-')
  const pluginRow = page.getByRole('row').filter({ hasText: 'Read only' })
  await expect(pluginRow).toContainText('plugin')
  await expect(pluginRow.locator('td').nth(1)).not.toBeEmpty()
  await expect(pluginRow.locator('td').nth(2)).not.toBeEmpty()
  await expect(pluginRow.locator('td').nth(6)).not.toBeEmpty()
})

test('Studio schedules @S-055.2 toggles a project cron', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  await openCrons(page)
  const row = page.getByRole('row').filter({ hasText: process.env.KB_STUDIO_CRON_ID! })
  await row.getByRole('button', { name: 'Disable' }).click()
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible()
  const response = await page.request.get(`${GATEWAY}${projectServicePath(projectId!, 'workflow', 'crons')}`)
  expect(response.status()).toBe(200)
  const payload = await response.json() as { data?: { crons?: Array<{ id: string; enabled: boolean }> } }
  expect(payload.data?.crons?.find(cron => cron.id === process.env.KB_STUDIO_CRON_ID)?.enabled).toBe(false)
})

test('Studio schedules @S-055.3 reflects a CLI disable', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  await openCrons(page)
  runKbCommand(['workflow', 'crons', 'disable'], {
    cwd: process.env.KB_STUDIO_CRON_PROJECT_ROOT,
    env: process.env,
    stdio: 'pipe',
  }, 'kb', [process.env.KB_STUDIO_CRON_ID!])
  await page.reload()
  const row = page.getByRole('row').filter({ hasText: process.env.KB_STUDIO_CRON_ID! })
  await expect(row.getByText('Disabled', { exact: true })).toBeVisible()
})

test('Studio schedules @S-055.4 isolates schedules by project', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the fresh-install journey hook')
  await openCrons(page)
  await page.getByLabel('Workflow project').selectOption(process.env.KB_STUDIO_PROJECT_B_ID!)
  await expect(page.getByText(process.env.KB_STUDIO_PROJECT_B_CRON_ID!, { exact: true })).toBeVisible()
  for (const cronId of (process.env.KB_STUDIO_PROJECT_A_USER_CRON_IDS ?? '').split(',').filter(Boolean)) {
    await expect(page.getByText(cronId, { exact: true })).toHaveCount(0)
  }
  for (const cronId of (process.env.KB_STUDIO_PROJECT_A_PLUGIN_CRON_IDS ?? '').split(',').filter(Boolean)) {
    await expect(page.getByText(cronId, { exact: true })).toBeVisible()
  }
})
