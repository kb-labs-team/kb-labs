import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectServicePath } from '@kb-labs/plugin-contracts/project-service-path'
import { runKbCommand, runProcessSync } from '../../../kb-command'

const GATEWAY = (process.env.GATEWAY_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '')
const enabled = process.env.KB_STUDIO_FIRST_TIER_JOURNEY === '1'
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

test('dashboard frame and first-tier navigation @S-120.1 @S-020.6', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio journey hook')
  await signInIfSecured(page)

  await page.goto(`${GATEWAY}/`)
  await expect(page.getByText('Intelligence Dashboard', { exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  await expect(page.getByText('Gateway health', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible()

  for (const [label, path, title] of [
    ['Projects', '/projects', 'Projects'],
    ['Analytics', '/analytics/overview', 'Analytics Overview'],
    ['Observability', '/observability/logs', 'Logs'],
  ]) {
    await page.getByRole('link', { name: label, exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`${path.replaceAll('/', '\\/')}$`))
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
})

test('inspect, register, and safely unregister a project @S-046.4 @S-124.7', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio journey hook')
  await signInIfSecured(page)
  const projectPath = await mkdtemp(join(tmpdir(), 'studio-project-case-'))
  const projectName = projectPath.split('/').at(-1)!

  try {
    await page.goto(`${GATEWAY}/projects`)
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
    await expect(page.getByText('Name', { exact: true })).toBeVisible()
    await expect(page.getByText('Status', { exact: true })).toBeVisible()
    await expect(page.getByText('.kb/', { exact: true })).toBeVisible()
    await expect(page.getByText('Last used', { exact: true })).toBeVisible()

    await page.getByRole('button', { name: 'Add project', exact: true }).click()
    await page.getByLabel('Folder path').fill(projectPath)
    await page.getByRole('button', { name: 'Register', exact: true }).click()
    expect(await readdir(projectPath)).toEqual([])
    await expect(page.getByText(projectPath, { exact: true })).toBeVisible()
    await expect(page.getByText(`Registered ${projectPath}`, { exact: true })).toBeVisible()

    const row = page.getByRole('row').filter({ hasText: projectName })
    await row.getByRole('button', { name: 'Remove', exact: true }).click()
    await page.getByRole('button', { name: 'Unregister', exact: true }).click()
    await expect(page.getByText(`Unregistered ${projectName}; files were not touched.`, { exact: true })).toBeVisible()
    await expect(row).toHaveCount(0)
    expect(await readdir(join(projectPath, '.kb'))).toEqual([])
  } finally {
    await rm(projectPath, { recursive: true, force: true })
  }
})

test('unregister an initialized project without deleting files or runtime state @S-046.5 @S-046.6', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio journey hook')
  await signInIfSecured(page)
  const projectPath = await mkdtemp(join(tmpdir(), 'studio-initialized-project-case-'))
  const projectName = projectPath.split('/').at(-1)!
  const projectMarker = join(projectPath, '.kb', 'preserve-me.txt')
  const markerContent = 'project configuration remains after unregister\n'
  let runtimeStateDir: string | undefined

  try {
    await mkdir(join(projectPath, '.kb'), { recursive: true })
    writeFileSync(projectMarker, markerContent)
    await page.goto(`${GATEWAY}/projects`)
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add project', exact: true }).click()
    await page.getByLabel('Folder path').fill(projectPath)
    await page.getByRole('button', { name: 'Register', exact: true }).click()
    await expect(page.getByText(projectPath, { exact: true })).toBeVisible()
    await expect(page.getByText(`Registered ${projectPath}`, { exact: true })).toBeVisible()

    const response = await page.request.get(`${GATEWAY}/api/v1/projects`)
    expect(response.status()).toBe(200)
    const payload = await response.json() as { data?: Array<{ id: string; path: string; stateDir: string }> }
    const project = payload.data?.find(entry => entry.path === projectPath)
    expect(project, 'registered project response must expose its runtime state directory').toBeTruthy()
    runtimeStateDir = project!.stateDir
    const stateMarker = join(project!.stateDir, 'studio-journey-state.txt')
    await mkdir(project!.stateDir, { recursive: true })
    writeFileSync(stateMarker, 'runtime state remains after unregister\n')

    const row = page.getByRole('row').filter({ hasText: projectName })
    await row.getByRole('button', { name: 'Remove', exact: true }).click()
    await page.getByRole('button', { name: 'Unregister', exact: true }).click()
    await expect(page.getByText(`Unregistered ${projectName}; files were not touched.`, { exact: true })).toBeVisible()
    await expect(row).toHaveCount(0)
    expect(readFileSync(projectMarker, 'utf8')).toBe(markerContent)
    expect(readFileSync(stateMarker, 'utf8')).toBe('runtime state remains after unregister\n')
  } finally {
    await rm(projectPath, { recursive: true, force: true })
    if (runtimeStateDir) await rm(runtimeStateDir, { recursive: true, force: true })
  }
})

test('S-121.1: analytics overview summarizes events and adapter usage', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio journey hook')

  await page.goto(`${GATEWAY}/analytics/overview`)
  await expect(page.getByRole('heading', { name: 'Analytics Overview', exact: true })).toBeVisible()
  await expect(page.getByText('Total Events', { exact: true })).toBeVisible()
  await expect(page.getByText('Event Types', { exact: true })).toBeVisible()
  await expect(page.getByText('Sources', { exact: true })).toBeVisible()
  await expect(page.getByText('Actors', { exact: true })).toBeVisible()
  await expect(page.getByText('LLM Usage', { exact: true })).toBeVisible()
  await expect(page.getByText('Embeddings', { exact: true })).toBeVisible()
  await expect(page.getByText('VectorStore', { exact: true })).toBeVisible()
  await expect(page.getByText('Cache', { exact: true })).toBeVisible()
  await expect(page.getByText('Storage', { exact: true })).toBeVisible()
})

test('unavailable analytics service names its source and recovery command @S-125.5', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio journey hook')
  await signInIfSecured(page)
  const projectId = process.env.KB_STUDIO_PROJECT_ID
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered project').toBeTruthy()
  await page.addInitScript((id) => localStorage.setItem('kb-studio-active-project', id), projectId!)
  await page.route(`**${projectServicePath(projectId!, 'rest', 'analytics/stats')}`, async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'unavailable' }) })
  })

  await page.goto(`${GATEWAY}/analytics/overview`)
  await expect(page.getByText('Analytics source unavailable', { exact: true })).toBeVisible()
  await expect(page.getByText('Source: REST API analytics endpoint.', { exact: false })).toBeVisible()
  await expect(page.getByText('kb-create doctor --platform-root <platform-root>', { exact: false })).toBeVisible()
})

test('unavailable gateway keeps Dashboard visible with recovery commands @S-120.7 @S-125.4', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio journey hook')
  await signInIfSecured(page)
  await page.route('**/api/observability/health', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'gateway offline' }) })
  })
  await page.route('**/api/ready', async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ready: false, reason: 'gateway unavailable' }) })
  })

  await page.goto(`${GATEWAY}/`)
  await expect(page.getByRole('heading', { name: 'Intelligence Dashboard', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible()
  await expect(page.getByText('Gateway health is unavailable', { exact: true })).toBeVisible()
  await expect(page.getByText('Gateway unavailable', { exact: true })).toBeVisible()
  await expect(page.getByText('kb-create status --platform-root <platform-root>', { exact: false }).first()).toBeVisible()
  await expect(page.getByText('kb-create doctor --platform-root <platform-root>', { exact: false }).first()).toBeVisible()
  await expect(page.getByRole('progressbar')).toHaveCount(0)
})

test('S-122.2 and S-122.3: failed workflow detail carries its project and run to Logs', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio journey hook')
  const projectId = process.env.KB_STUDIO_PROJECT_ID
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered project').toBeTruthy()
  await page.addInitScript((id) => localStorage.setItem('kb.workflow.projectId', id), projectId!)
  await page.route(`**${projectServicePath(projectId!, 'workflow', 'runs/run-studio-diagnostic')}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run: {
          id: 'run-studio-diagnostic',
          name: 'studio-diagnostic-fixture',
          version: 1,
          status: 'failed',
          jobs: [{
            id: 'job-diagnostic',
            jobName: 'diagnostics',
            status: 'failed',
            steps: [{ id: 'step-diagnostic', name: 'diagnostic failure', status: 'failed', error: { message: 'STUDIO_DIAGNOSTIC_MARKER' } }],
          }],
        },
      }),
    })
  })

  await page.goto(`${GATEWAY}/p/workflows/runs/run-studio-diagnostic`)
  const logsLink = page.getByRole('link', { name: 'Inspect run logs', exact: true })
  await expect(logsLink).toBeVisible()
  await expect(logsLink).toHaveAttribute('href', `/observability/logs?projectId=${encodeURIComponent(projectId!)}&executionId=run-studio-diagnostic`)
  const logsRequest = page.waitForRequest(request => request.url().includes(projectServicePath(projectId!, 'rest', 'logs/stream')))
  await logsLink.click()
  await expect(page).toHaveURL(new RegExp(`/observability/logs\\?projectId=${encodeURIComponent(projectId!)}&executionId=run-studio-diagnostic$`))
  expect((await logsRequest).url()).toContain('executionId=run-studio-diagnostic')
})

test('S-122.5: unavailable observability logs name the source and doctor command', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio journey hook')
  const projectId = process.env.KB_STUDIO_PROJECT_ID
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered project').toBeTruthy()
  await page.addInitScript((id) => localStorage.setItem('kb-studio-active-project', id), projectId!)
  await page.route(`**${projectServicePath(projectId!, 'rest', 'logs')}**`, async (route) => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'unavailable' }) })
  })

  await page.goto(`${GATEWAY}/observability/logs?projectId=${encodeURIComponent(projectId!)}&executionId=run-studio-diagnostic`)
  await page.getByText('History', { exact: true }).click()
  await expect(page.getByText('Observability logs unavailable', { exact: true })).toBeVisible()
  await expect(page.getByText('Source: REST API observability logs.', { exact: false })).toBeVisible()
  await expect(page.getByText('kb-create doctor --platform-root <platform-root>', { exact: false })).toBeVisible()
})

test('install Commit, inspect real changes, generate a plan, and uninstall it @S-123.1 @S-123.2 @S-123.3 @S-123.4 @S-123.5 @S-123.6', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio journey hook')
  await signInIfSecured(page)
  const projectId = process.env.KB_STUDIO_PROJECT_ID
  const projectRoot = process.env.KB_STUDIO_PROJECT_ROOT
  const kb = process.env.KB_STUDIO_KB_BIN
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered project').toBeTruthy()
  expect(projectRoot, 'KB_STUDIO_PROJECT_ROOT must identify the isolated journey project').toBeTruthy()
  expect(kb, 'KB_STUDIO_KB_BIN must identify the isolated platform CLI').toBeTruthy()
  const processOptions = { cwd: projectRoot!, env: process.env }
  const marker = join(projectRoot!, 'studio-commit-journey.txt')
  const lockFile = join(projectRoot!, '.kb', 'marketplace.lock')

  runProcessSync('git', ['init'], processOptions)
  runProcessSync('git', ['config', 'user.email', 'journey@example.test'], processOptions)
  runProcessSync('git', ['config', 'user.name', 'Studio Journey'], processOptions)
  writeFileSync(marker, 'baseline\n')
  runProcessSync('git', ['add', 'studio-commit-journey.txt'], processOptions)
  runProcessSync('git', ['commit', '-m', 'test: create Studio journey baseline'], processOptions)
  const baselineCommit = runProcessSync('git', ['rev-parse', 'HEAD'], processOptions).trim()
  writeFileSync(marker, 'baseline\nchanged for the deterministic plan\n')

  runKbCommand(['marketplace', 'install', '@kb-labs/commit', '--json'], processOptions, kb!)
  const lock = JSON.parse(readFileSync(lockFile, 'utf8')) as {
    plugins?: Record<string, { version?: string; resolvedPath?: string }>
  }
  const commitPin = lock.plugins?.['@kb-labs/commit']
  const commitVersion = commitPin?.version
  expect(commitVersion, 'marketplace lock must contain the installed Commit version').toBeTruthy()
  const extensionEntry = join(
    process.env.KB_HOME ?? join(process.env.HOME ?? '', '.kb'),
    'store', 'entries', `@kb-labs+commit@${commitVersion!}`,
    'node_modules', '@kb-labs', 'commit', 'dist', 'index.js',
  )
  expect(commitPin?.resolvedPath).toBe(`store:${encodeURIComponent('@kb-labs/commit')}@${encodeURIComponent(commitVersion!)}`)
  expect(existsSync(extensionEntry), `installed Commit entry should exist at ${extensionEntry}`).toBe(true)

  await page.addInitScript((id) => localStorage.setItem('kb-studio-active-project', id), projectId!)
  await page.goto(`${GATEWAY}/p/commit`)
  await expect(page.getByRole('tab', { name: 'Commit Plan', exact: true })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Files', exact: true }).click()
  await expect(page.getByText('studio-commit-journey.txt', { exact: true })).toBeVisible()
  await expect(page.getByText('Modified: 1', { exact: true })).toBeVisible()

  await page.getByRole('tab', { name: 'Commit Plan', exact: true }).click()
  const failedGenerate = page.waitForResponse(response => response.url().includes('/api/v1/plugins/commit/generate'))
  await page.getByRole('button', { name: 'Generate plan', exact: true }).click()
  const errorResponse = await failedGenerate
  expect(errorResponse.status()).toBeGreaterThanOrEqual(400)
  const errorEnvelope = await errorResponse.json() as { error?: { code?: string } }
  expect(errorEnvelope.error?.code).toBe('KB_ADAPTER_NOT_CONFIGURED')
  await expect(page.getByText('LLM adapter required', { exact: true })).toBeVisible()
  await expect(page.getByText('kb adapter bind llm @kb-labs/adapters-openai', { exact: false })).toBeVisible()
  expect(runProcessSync('git', ['rev-parse', 'HEAD'], processOptions).trim()).toBe(baselineCommit)

  runKbCommand(['marketplace', 'install', '@kb-labs/e2e-llm-deterministic', '--scope', 'platform', '--json'], processOptions, kb!)
  runKbCommand(['adapter', 'bind', 'llm', '@kb-labs/e2e-llm-deterministic'], processOptions, kb!)
  await page.reload()
  await page.getByRole('button', { name: 'Generate plan', exact: true }).click()
  await expect(page.getByText('use deterministic journey plan', { exact: false })).toBeVisible()
  await expect(page.getByText('studio-commit-journey.txt', { exact: true })).toBeVisible()
  expect(runProcessSync('git', ['rev-parse', 'HEAD'], processOptions).trim()).toBe(baselineCommit)

  runKbCommand(['marketplace', 'uninstall', '@kb-labs/commit', '--json'], processOptions, kb!)
  const afterUninstall = JSON.parse(readFileSync(lockFile, 'utf8')) as { plugins?: Record<string, unknown> }
  expect(afterUninstall.plugins?.['@kb-labs/commit']).toBeUndefined()
  await page.goto(`${GATEWAY}/`)
  await expect(page.getByRole('link', { name: /commit/i })).toHaveCount(0)
  const pluginsResponse = await page.request.get(`${GATEWAY}/api/v1/plugins?projectId=${encodeURIComponent(projectId!)}`)
  const plugins = await pluginsResponse.json() as { data?: Array<{ id?: string }> }
  expect(plugins.data?.some(plugin => plugin.id === '@kb-labs/commit' || plugin.id === 'commit')).toBe(false)
  await page.goto(`${GATEWAY}/p/commit`)
  await expect(page.getByRole('tab', { name: 'Commit Plan', exact: true })).toHaveCount(0)
})

test('S-121.2-.5: filter real analytics events and inspect LLM usage by date and model', async ({ page }) => {
  test.skip(!enabled, 'Enabled by the installed Studio journey hook')
  const projectId = process.env.KB_STUDIO_PROJECT_ID
  expect(projectId, 'KB_STUDIO_PROJECT_ID must identify the registered project').toBeTruthy()
  await page.addInitScript((id) => localStorage.setItem('kb-studio-active-project', id), projectId!)

  const base = `${GATEWAY}${projectServicePath(projectId!, 'rest')}`
  const seedResponse = await page.request.get(`${base}/analytics/events?type=llm.completion.completed&limit=10`)
  expect(seedResponse.ok()).toBe(true)
  const seed = await seedResponse.json() as {
    events?: Array<{
      type: string
      ts: string
      source: { product: string; version: string }
      actor?: { name?: string; type: string }
      payload?: Record<string, unknown>
    }>
  }
  const completion = seed.events?.find(event => event.type === 'llm.completion.completed')
  expect(completion, 'deterministic Commit generation should record a real completion event').toBeTruthy()
  const source = completion!.source.product

  await page.goto(`${GATEWAY}/analytics/events`)
  await expect(page.getByRole('heading', { name: 'Event Log', exact: true })).toBeVisible()
  const typeFilter = page.getByRole('combobox').nth(0)
  await typeFilter.click()
  await page.getByText('llm.completion.completed', { exact: true }).last().click()
  const sourceFilter = page.getByRole('combobox').nth(1)
  await sourceFilter.click()
  await page.getByText(source, { exact: true }).last().click()
  const filteredEventsRequest = page.waitForResponse(response => response.url().includes('/analytics/events?')
    && response.url().includes('type=llm.completion.completed') && response.url().includes(`source=${encodeURIComponent(source)}`))
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  const filteredResponse = await filteredEventsRequest
  expect(filteredResponse.ok()).toBe(true)
  await expect(page.getByText('llm.completion.completed', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(source, { exact: true }).last()).toBeVisible()
  const filteredRows = await page.locator('tbody tr').allTextContents()
  expect(filteredRows.length).toBeGreaterThan(0)
  for (const row of filteredRows) {
    expect(row).toContain('llm.completion.completed')
    expect(row).toContain(source)
  }

  await page.getByText('llm.completion.completed', { exact: true }).first().click()
  await expect(page.getByText('Payload', { exact: true })).toBeVisible()
  await expect(page.getByText(source, { exact: true }).last()).toBeVisible()
  await expect(page.getByText(`v${completion!.source.version}`, { exact: true })).toBeVisible()
  await expect(page.getByText(new Date(completion!.ts).toLocaleString(), { exact: true })).toBeVisible()
  if (completion!.actor?.name) await expect(page.getByText(completion!.actor.name, { exact: true })).toBeVisible()
  await expect(page.getByText('e2e-deterministic', { exact: false }).last()).toBeVisible()

  await page.goto(`${GATEWAY}/analytics/llm`)
  await expect(page.getByRole('heading', { name: 'LLM Usage Analytics', exact: true })).toBeVisible()
  const sevenDayRequest = page.waitForResponse(response => response.url().includes('/adapters/llm/usage?')
    && response.url().includes('from=') && response.url().includes('to='))
  await page.getByRole('combobox').first().click()
  await page.getByText('Last 7 days', { exact: true }).click()
  const sevenDayResponse = await sevenDayRequest
  expect(sevenDayResponse.ok()).toBe(true)
  const rangeUrl = new URL(sevenDayResponse.url())
  expect(Date.now() - Date.parse(rangeUrl.searchParams.get('from')!)).toBeLessThan(8 * 24 * 60 * 60 * 1000)

  const dailyRequest = page.waitForResponse(response => response.url().includes('/adapters/llm/daily-stats?')
    && response.url().includes('models=e2e-deterministic'))
  await page.getByRole('combobox').nth(1).click()
  await page.getByText(/e2e-deterministic \(/).click()
  const dailyResponse = await dailyRequest
  expect(dailyResponse.ok()).toBe(true)
  expect(new URL(dailyResponse.url()).searchParams.get('models')).toBe('e2e-deterministic')
  await expect(page.getByText('Usage by Model', { exact: true })).toBeVisible()
  await expect(page.getByText('Daily Usage Trend', { exact: true })).toBeVisible()
  const allModelsRequest = page.waitForResponse(response => response.url().includes('/adapters/llm/daily-stats?')
    && !new URL(response.url()).searchParams.has('models'))
  await page.locator('.ant-select-selection-item-remove').last().click()
  const allModelsResponse = await allModelsRequest
  expect(allModelsResponse.ok()).toBe(true)
})
