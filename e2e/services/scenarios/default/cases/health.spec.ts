import { test, expect, request as playwrightRequest } from '@playwright/test'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'
import { GATEWAY, REST, MARKETPLACE_DIRECT, WORKFLOW, STATE, REGISTRY } from '@kb-labs/e2e-shared/urls.js'

const services = [
  { id: 'S-01', name: 'gateway',              url: GATEWAY,     path: '/health' },
  { id: 'S-02', name: 'rest-api',             url: REST,        path: '/health' },
  { id: 'S-03', name: 'marketplace',          url: MARKETPLACE_DIRECT, path: '/health' },
  { id: 'S-04', name: 'workflow',             url: WORKFLOW,    path: '/health' },
  { id: 'S-05', name: 'state-daemon',         url: STATE,       path: '/health' },
  { id: 'S-06', name: 'marketplace-registry', url: REGISTRY,    path: '/health' },
]

for (const svc of services) {
  test(`${svc.id}: ${svc.name} is healthy`, async ({ request }) => {
    let authorization: string | undefined
    if (svc.name === 'marketplace-registry') {
      const registration = await playwrightRequest.newContext()
      try { authorization = `Bearer ${await getAccessToken(registration)}` } finally { await registration.dispose() }
    }
    const res = await request.get(`${svc.url}${svc.path}`, {
      headers: authorization ? { Authorization: authorization } : {},
    })
    expect(res.status()).toBe(200)
    const body = await res.json()
    // REST API wraps in { ok, data }; others return status directly
    const status = body.data?.status ?? body.status
    expect(status).toMatch(/ok|healthy|ready/)
  })
}
