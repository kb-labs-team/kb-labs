import { test, expect } from '@playwright/test'
import { access, mkdtemp, mkdir, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'

/** Exercises project registration and path recovery through the Studio REST ingress. */
test('PM-E2E-01: register a project, move its path, and unregister it', async ({ request }) => {
  const token = await getAccessToken(request)
  const headers = { Authorization: `Bearer ${token}` }
  const sandbox = await mkdtemp(join(tmpdir(), 'kb-project-management-e2e-'))
  const firstPath = join(sandbox, 'first')
  const movedPath = join(sandbox, 'moved')
  await mkdir(join(firstPath, '.kb'), { recursive: true })
  const canonicalFirstPath = await realpath(firstPath)

  let projectId: string | undefined
  try {
    const created = await request.post(`${GATEWAY}/api/v1/projects`, {
      headers,
      data: { path: canonicalFirstPath, title: 'Project management E2E', description: 'Host REST lifecycle' },
    })
    expect(created.status()).toBe(201)
    const createdBody = await created.json()
    expect(createdBody.ok).toBe(true)
    expect(createdBody.data).toMatchObject({
      title: 'Project management E2E',
      description: 'Host REST lifecycle',
      path: canonicalFirstPath,
      pathExists: true,
    })
    projectId = createdBody.data.id
    expect(projectId).toMatch(/^prj_[a-f\d]{32}$/)

    await rename(firstPath, movedPath)
    const unavailable = await request.get(`${GATEWAY}/api/v1/projects/${projectId}`, { headers })
    expect(unavailable.status()).toBe(200)
    expect((await unavailable.json()).data).toMatchObject({ id: projectId, path: canonicalFirstPath, pathExists: false })
    const canonicalMovedPath = await realpath(movedPath)
    const moved = await request.patch(`${GATEWAY}/api/v1/projects/${projectId}`, { headers, data: { path: canonicalMovedPath } })
    expect(moved.status()).toBe(200)
    expect((await moved.json()).data).toMatchObject({
      id: projectId,
      title: 'Project management E2E',
      description: 'Host REST lifecycle',
      path: canonicalMovedPath,
      pathExists: true,
    })

    const listed = await request.get(`${GATEWAY}/api/v1/projects`, { headers })
    expect(listed.status()).toBe(200)
    expect((await listed.json()).data).toEqual(expect.arrayContaining([expect.objectContaining({ id: projectId, path: canonicalMovedPath })]))

    const removed = await request.delete(`${GATEWAY}/api/v1/projects/${projectId}`, { headers })
    expect(removed.status()).toBe(200)
    expect((await removed.json()).data).toEqual({ id: projectId })
    projectId = undefined
  } finally {
    if (projectId) await request.delete(`${GATEWAY}/api/v1/projects/${projectId}`, { headers }).catch(() => undefined)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('PM-E2E-03: switch active project in Studio and restore it after reload', async ({ request, page }) => {
  const token = await getAccessToken(request)
  const headers = { Authorization: `Bearer ${token}` }
  const sandbox = await mkdtemp(join(tmpdir(), 'kb-project-switch-e2e-'))
  const projectPaths = [join(sandbox, 'project-a'), join(sandbox, 'project-b')]
  await Promise.all(projectPaths.map((path) => mkdir(join(path, '.kb'), { recursive: true })))
  const canonicalPaths = await Promise.all(projectPaths.map((path) => realpath(path)))
  const createdIds: string[] = []

  try {
    for (const [index, path] of canonicalPaths.entries()) {
      const response = await request.post(`${GATEWAY}/api/v1/projects`, {
        headers,
        data: { path, title: `PM Project ${index === 0 ? 'A' : 'B'}` },
      })
      expect(response.status()).toBe(201)
      createdIds.push((await response.json()).data.id)
    }

    await page.route('**/api/v1/**', (route) => route.continue({
      headers: { ...route.request().headers(), authorization: `Bearer ${token}` },
    }))
    await page.addInitScript((projectId) => localStorage.setItem('kb-studio-active-project-id', projectId), createdIds[0])
    await page.goto(`${GATEWAY}/`)
    const selector = page.getByRole('combobox', { name: 'Active project' })
    await expect(selector).toBeVisible()
    await selector.click()
    await page.getByRole('option', { name: 'PM Project B' }).click()

    await expect.poll(() => page.evaluate(() => localStorage.getItem('kb-studio-active-project-id'))).toBe(createdIds[1])
    const projectPluginsRequest = page.waitForRequest((request) => request.url().includes('/api/v1/plugins?projectId='))
    await page.goto(`${GATEWAY}/plugins`)
    expect(new URL((await projectPluginsRequest).url()).searchParams.get('projectId')).toBe(createdIds[1])
    await expect(page.getByText('Project: PM Project B', { exact: false })).toBeVisible()
    await expect.poll(async () => {
      const stored = await page.evaluate(() => localStorage.getItem('kb-studio-active-project-id'))
      return stored
    }).toBe(createdIds[1])

    const restoredPluginsRequest = page.waitForRequest((request) => request.url().includes('/api/v1/plugins?projectId='))
    await page.reload()
    expect(new URL((await restoredPluginsRequest).url()).searchParams.get('projectId')).toBe(createdIds[1])
    await expect(page.getByText('Project: PM Project B', { exact: false })).toBeVisible()
  } finally {
    await Promise.all(createdIds.map((id) => request.delete(`${GATEWAY}/api/v1/projects/${id}`, { headers }).catch(() => undefined)))
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('PM-E2E-02: create and initialize a project without deleting it on unregister', async ({ request }) => {
  const token = await getAccessToken(request)
  const headers = { Authorization: `Bearer ${token}` }
  const sandbox = await mkdtemp(join(tmpdir(), 'kb-project-create-e2e-'))
  const projectPath = join(await realpath(sandbox), 'new-project')

  let projectId: string | undefined
  try {
    await mkdir(projectPath)
    const response = await request.post(`${GATEWAY}/api/v1/projects`, {
      headers,
      data: { path: projectPath, init: true, title: 'Created project', description: 'Initialized through Host REST' },
    })
    expect(response.status()).toBe(201)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.data).toMatchObject({
      title: 'Created project',
      description: 'Initialized through Host REST',
      path: projectPath,
      pathExists: true,
    })
    projectId = body.data.id
    expect(projectId).toMatch(/^prj_[a-f\d]{32}$/)
    await access(join(projectPath, '.kb', 'kb.config.yaml'))

    const removed = await request.delete(`${GATEWAY}/api/v1/projects/${projectId}`, { headers })
    expect(removed.status()).toBe(200)
    projectId = undefined
    await access(join(projectPath, '.kb', 'kb.config.yaml'))
  } finally {
    if (projectId) await request.delete(`${GATEWAY}/api/v1/projects/${projectId}`, { headers }).catch(() => undefined)
    await rm(sandbox, { recursive: true, force: true })
  }
})

test('PM-E2E-04: Studio uses the Host folder chooser result for creation', async ({ request, page }) => {
  const token = await getAccessToken(request)
  const headers = { Authorization: `Bearer ${token}` }
  const sandbox = await mkdtemp(join(tmpdir(), 'kb-project-picker-e2e-'))
  const selectedPath = join(await realpath(sandbox), 'selected-project')
  await mkdir(selectedPath)
  let projectId: string | undefined

  try {
    await page.route('**/api/v1/**', async (route) => {
      if (route.request().url().endsWith('/projects/pick-folder')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, data: { path: selectedPath } }),
        })
        return
      }
      await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${token}` } })
    })
    await page.goto(`${GATEWAY}/projects`)
    await page.getByRole('button', { name: /add project/i }).first().click()
    await page.getByLabel(/project title/i).fill('Native picker E2E')
    await page.getByRole('button', { name: /choose project folder/i }).click()
    await expect(page.getByLabel(/project folder/i)).toHaveValue(selectedPath)
    await page.getByRole('button', { name: /create project/i }).click()

    const card = page.getByRole('article', { name: 'Native picker E2E project' })
    await expect(card).toBeVisible()
    await expect(card.getByText(selectedPath)).toBeVisible()
    const projects = await request.get(`${GATEWAY}/api/v1/projects`, { headers })
    const project = (await projects.json()).data.find((entry: { title: string }) => entry.title === 'Native picker E2E')
    projectId = project?.id
    expect(project?.path).toBe(selectedPath)
  } finally {
    if (projectId) await request.delete(`${GATEWAY}/api/v1/projects/${projectId}`, { headers }).catch(() => undefined)
    await rm(sandbox, { recursive: true, force: true })
  }
})
