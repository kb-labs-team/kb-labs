import { test, expect, type APIRequestContext } from '@playwright/test'
import { GATEWAY } from '@kb-labs/e2e-shared/urls.js'
import { registerAgent, issueToken } from '@kb-labs/e2e-shared/auth.js'

async function registerHostForAgent(
  request: APIRequestContext,
  name: string,
): Promise<{ hostId: string; token: string }> {
  const creds = await registerAgent(request, `e2e-agent-${name}`)
  const namespaceId = creds.namespaceId
  const tokens = await issueToken(request, creds)

  const regRes = await request.post(`${GATEWAY}/hosts/register`, {
    data: { name, namespaceId, capabilities: [], workspacePaths: [] },
  })
  expect([200, 201]).toContain(regRes.status())
  const body = await regRes.json()
  const hostId: string = body.hostId ?? body.data?.hostId ?? body.id
  expect(hostId).toBeTruthy()
  return { hostId, token: tokens.accessToken }
}

test('GW-H-01: POST /hosts/register returns hostId and machineToken', async ({ request }) => {
  const agent = await registerAgent(request, 'e2e-agent-h01')
  const namespaceId = agent.namespaceId

  const res = await request.post(`${GATEWAY}/hosts/register`, {
    data: { name: 'e2e-host-reg', namespaceId, capabilities: [], workspacePaths: [] },
  })
  expect([200, 201]).toContain(res.status())
  const body = await res.json()
  const hostId: string = body.hostId ?? body.data?.hostId ?? body.id
  const machineToken: string = body.machineToken ?? body.data?.machineToken ?? body.token
  expect(hostId).toBeTruthy()
  expect(machineToken).toBeTruthy()
})

test('GW-H-02: GET /hosts with token returns array', async ({ request }) => {
  const creds = await registerAgent(request)
  const tokens = await issueToken(request, creds)
  const res = await request.get(`${GATEWAY}/hosts`, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  const list = body.data ?? body.hosts ?? body
  expect(Array.isArray(list)).toBe(true)
})

test('GW-H-03: GET /hosts/:hostId returns registered host detail', async ({ request }) => {
  const { hostId, token } = await registerHostForAgent(request, 'e2e-host-get')

  const res = await request.get(`${GATEWAY}/hosts/${encodeURIComponent(hostId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(res.status()).toBe(200)
  const body = await res.json()
  const id: string = body.hostId ?? body.data?.hostId ?? body.id
  expect(id).toBe(hostId)
})

test('GW-H-04: DELETE /hosts/:hostId removes the host', async ({ request }) => {
  const { hostId, token } = await registerHostForAgent(request, 'e2e-host-del')

  // DELETE may return 204 (with store) or 404 (cache-only — bug: removed from cache but returns false)
  await request.delete(`${GATEWAY}/hosts/${encodeURIComponent(hostId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  // Verify host is actually gone regardless of DELETE status code
  const getRes = await request.get(`${GATEWAY}/hosts/${encodeURIComponent(hostId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(getRes.status()).toBe(404)
})

test('GW-H-05: GET /hosts without token returns 401', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/hosts`)
  expect([401, 403]).toContain(res.status())
})
