/**
 * Auth E2E — readiness diagnostics (`GET /health/auth`).
 * Scenarios: 38, 39, 40, 41
 *
 * Every login failure is deliberately identical (CD-8), so an install with auth
 * enabled but no admin cannot be diagnosed from the login response. The gateway
 * therefore reports its auth readiness — but the body says things an attacker
 * would love to know ("no admin exists", "tokens are signed with the public dev
 * secret"), so the route answers ONLY a request that originates on the gateway's
 * own machine and was not proxied. Everyone else gets a plain 404.
 *
 * In this stack the public path is browser -> nginx (:4001, /api/ stripped) ->
 * gateway (:4000). nginx rewrites Host to the tenant name and adds X-Forwarded-*,
 * so a proxied request must never be served. The positive case runs `curl`
 * inside the platform container, where the gateway sees a genuine local caller.
 *
 * See services/gateway/app/src/auth/health-route.ts.
 */

import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { GATEWAY } from '../fixtures/auth.js'

const DIRECT_GATEWAY = process.env.GATEWAY_DIRECT_URL ?? 'http://localhost:4000'
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME ?? 'kb-e2e-auth'

interface Readiness {
  ok: boolean
  authEnabled: boolean
  tenantId: string
  activeAdmins: number
  bootstrap: string
  issues: Array<{ code: string; severity: string; hint: string }>
}

/** Runs curl inside the platform container; undefined when docker is not reachable. */
function curlInsidePlatform(path: string): string | undefined {
  try {
    const id = execFileSync('docker', [
      'ps', '-q',
      '--filter', `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
      '--filter', 'label=com.docker.compose.service=platform',
    ], { encoding: 'utf8' }).trim().split('\n')[0]
    if (!id) {return undefined}
    return execFileSync('docker', ['exec', id, 'curl', '-s', '-m', '5', `http://localhost:4000${path}`], { encoding: 'utf8' })
  } catch {
    return undefined
  }
}

test('AUTH-38: /health/auth is not served through the public proxy', async ({ request }) => {
  // Control: the public health route works through the very same proxy path, so a
  // 404 below cannot be blamed on a wrong URL.
  const control = await request.get(`${GATEWAY}/api/health`)
  expect(control.status()).toBe(200)

  const res = await request.get(`${GATEWAY}/api/health/auth`)
  expect(res.status()).toBe(404)
  const body = await res.text()
  for (const secret of ['activeAdmins', 'no_active_admin', 'jwt_secret_default', 'bootstrap']) {
    expect(body).not.toContain(secret)
  }
})

test('AUTH-39: claiming to be local through the proxy does not unlock it', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/api/health/auth`, {
    headers: { 'X-Forwarded-For': '127.0.0.1', 'X-Real-IP': '127.0.0.1', Host: 'localhost' },
  })
  expect(res.status()).toBe(404)
  expect(await res.text()).not.toContain('activeAdmins')
})

test('AUTH-40: a remote caller reaching the gateway port directly is refused too', async ({ request }) => {
  // The TCP peer is the docker bridge, not loopback, so this is not a local operator.
  let res
  try {
    res = await request.get(`${DIRECT_GATEWAY}/health/auth`, { timeout: 5_000 })
  } catch {
    test.skip(true, `gateway port not reachable directly at ${DIRECT_GATEWAY}`)
    return
  }
  expect(res.status()).toBe(404)
  expect(await res.text()).not.toContain('activeAdmins')
})

test('AUTH-41: the local operator sees a healthy install — the bootstrap admin exists', async () => {
  const raw = curlInsidePlatform('/health/auth')
  // In CI the runner always has docker and the compose project: an unreachable
  // container there is a broken environment, not a reason to skip silently.
  if (process.env.CI) {
    expect(raw, 'platform container must be reachable via docker exec in CI').toBeDefined()
  } else {
    test.skip(raw === undefined, 'docker / platform container not reachable from the test runner')
  }

  const readiness = JSON.parse(raw as string) as Readiness
  expect(readiness.authEnabled).toBe(true)
  // The stack seeds exactly this admin (docker-compose.auth-ci.yml); readiness must agree with login.
  expect(readiness.tenantId).toBe('kb-cloud')
  expect(readiness.activeAdmins).toBeGreaterThanOrEqual(1)
  expect(['provisioned', 'exists-active']).toContain(readiness.bootstrap)
  expect(readiness.issues.map((i) => i.code)).not.toContain('no_active_admin')
  expect(readiness.issues.map((i) => i.code)).not.toContain('bootstrap_failed')
})
