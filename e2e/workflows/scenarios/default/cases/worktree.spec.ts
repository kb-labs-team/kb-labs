import { test, expect, type APIRequestContext } from '@playwright/test'
import { WORKFLOW } from '@kb-labs/e2e-shared/urls.js'

/**
 * WWT — Worktree workspace isolation tests.
 *
 * These tests verify that shell steps executed inside a worktree workspace:
 *   - run with CWD set to the worktree (not the platform root)
 *   - receive KB_PLATFORM_ROOT pointing at the platform root
 *   - receive KB_WORKSPACE_ROOT pointing at the worktree
 *   - can resolve `pnpm kb` via the cli/bin/dist symlink from the platform
 *   - do NOT leak agent build artefacts back into the platform dist directories
 *
 * Depends on: .kb/workflows/test-paths.yaml (committed to the repo).
 * Requires:   kb-dev start (workflow daemon on :7778).
 */

// ── helpers ───────────────────────────────────────────────────────────────────

type RunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'skipped' | 'dlq'

interface RunData {
  status?: RunStatus
  jobs?: Array<{
    steps?: Array<{
      outputs?: { stdout?: string; stderr?: string; exitCode?: number }
    }>
  }>
}

async function findWorkflow(
  request: APIRequestContext,
  name: string,
): Promise<{ id?: string; name?: string } | undefined> {
  const res = await request.get(`${WORKFLOW}/api/v1/workflows`)
  if (!res.ok()) return undefined
  const body = await res.json()
  const list: { id?: string; name?: string }[] = body.data?.workflows ?? body.data ?? body.workflows ?? []
  return list.find(w => w.name === name || w.id === name)
}

async function startRun(
  request: APIRequestContext,
  workflowId: string,
): Promise<string | undefined> {
  const res = await request.post(
    `${WORKFLOW}/api/v1/workflows/${encodeURIComponent(workflowId)}/runs`,
    { data: {} },
  )
  if (!res.ok()) return undefined
  const body = await res.json()
  return body.data?.runId ?? body.data?.id ?? body.runId ?? body.id
}

async function fetchRun(
  request: APIRequestContext,
  runId: string,
): Promise<RunData> {
  const res = await request.get(`${WORKFLOW}/api/v1/runs/${runId}`)
  const body = await res.json()
  // API wraps run in { ok, data: { run: {...} } }
  return body.data?.run ?? body.data ?? body
}

/** Poll until run reaches a terminal status, then return the final run data. */
async function waitForRun(
  request: APIRequestContext,
  runId: string,
  timeoutMs = 60_000,
): Promise<RunData> {
  const deadline = Date.now() + timeoutMs
  const intervals = [1000, 2000, 3000, 5000]
  let attempt = 0

  while (Date.now() < deadline) {
    const run = await fetchRun(request, runId)
    if (/^(success|failed|cancelled|skipped|dlq)$/.test(run.status ?? '')) {
      return run
    }
    const delay = intervals[Math.min(attempt++, intervals.length - 1)]
    await new Promise(r => setTimeout(r, delay))
  }

  return fetchRun(request, runId)
}

function extractStdout(run: RunData): string {
  for (const job of run.jobs ?? []) {
    for (const step of job.steps ?? []) {
      const out = step.outputs?.stdout ?? ''
      if (out) return out
    }
  }
  return ''
}

// ── shared setup: start one run per test ─────────────────────────────────────

async function runTestPathsWorkflow(
  request: APIRequestContext,
): Promise<{ stdout: string; status: string }> {
  const wf = await findWorkflow(request, 'test-paths')
  if (!wf) expect(true, 'test-paths workflow not found — check .kb/workflows/test-paths.yaml').toBe(false)

  const runId = await startRun(request, wf!.id ?? wf!.name!)
  expect(runId).toBeTruthy()

  const run = await waitForRun(request, runId!)
  return {
    status: run.status ?? 'unknown',
    stdout: extractStdout(run),
  }
}

// ── WWT-01: worktree CWD is NOT the platform root ────────────────────────────

test('WWT-01: shell step CWD is worktree, not the platform root', async ({ request }) => {
  test.setTimeout(90_000)
  const { status, stdout } = await runTestPathsWorkflow(request)

  expect(status).toMatch(/^success$/)
  expect(stdout).toBeTruthy()

  const cwdMatch = stdout.match(/=== CWD ===\n([^\n]+)/)
  expect(cwdMatch, 'CWD section missing from stdout').toBeTruthy()
  expect(cwdMatch![1]).toContain('.worktrees/')
})

// ── WWT-02: KB_PLATFORM_ROOT is injected and points to the platform ──────────

test('WWT-02: KB_PLATFORM_ROOT is set and does not contain .worktrees', async ({ request }) => {
  test.setTimeout(90_000)
  const { status, stdout } = await runTestPathsWorkflow(request)

  expect(status).toMatch(/^success$/)

  const match = stdout.match(/=== KB_PLATFORM_ROOT ===\n([^\n]+)/)
  expect(match, 'KB_PLATFORM_ROOT section missing from stdout').toBeTruthy()
  const platformRoot = match![1]
  expect(platformRoot).not.toBe('not set')
  expect(platformRoot).not.toContain('.worktrees')
})

// ── WWT-03: KB_WORKSPACE_ROOT is injected and points to the worktree ─────────

test('WWT-03: KB_WORKSPACE_ROOT is set and points inside .worktrees', async ({ request }) => {
  test.setTimeout(90_000)
  const { status, stdout } = await runTestPathsWorkflow(request)

  expect(status).toMatch(/^success$/)

  const match = stdout.match(/=== KB_WORKSPACE_ROOT ===\n([^\n]+)/)
  expect(match, 'KB_WORKSPACE_ROOT section missing from stdout').toBeTruthy()
  const workspaceRoot = match![1]
  expect(workspaceRoot).not.toBe('not set')
  expect(workspaceRoot).toContain('.worktrees/')
})

// ── WWT-04: cli/bin/dist symlink resolves back into the platform ──────────────

test('WWT-04: cli/bin/dist symlink target resolves into the platform, not the worktree', async ({ request }) => {
  test.setTimeout(90_000)
  const { status, stdout } = await runTestPathsWorkflow(request)

  expect(status).toMatch(/^success$/)

  const match = stdout.match(/=== cli\/bin\/dist symlink target ===\n([^\n]+)/)
  expect(match, 'symlink section missing from stdout').toBeTruthy()
  const symlinkTarget = match![1]
  expect(symlinkTarget).not.toBe('no cli/bin/dist/bin.js')
  expect(symlinkTarget).not.toContain('.worktrees')
})

// ── WWT-05: pnpm kb resolves correctly via the symlink ───────────────────────

test('WWT-05: pnpm kb --version succeeds in the worktree', async ({ request }) => {
  test.setTimeout(90_000)
  const { status, stdout } = await runTestPathsWorkflow(request)

  expect(status).toMatch(/^success$/)
  expect(stdout).not.toContain('pnpm kb failed')
})

// ── WWT-06: agent build artefacts do not leak into the platform ───────────────

test('WWT-06: files written to worktree dist/ do not appear in the platform', async ({ request }) => {
  test.setTimeout(90_000)
  const { status, stdout } = await runTestPathsWorkflow(request)

  expect(status).toMatch(/^success$/)
  expect(stdout).toContain('not in platform (correct)')
  expect(stdout).not.toContain('LEAKED TO PLATFORM!')
})
