import { test, expect } from '@playwright/test'
import { GATEWAY, REST, WORKFLOW, STATE } from '@kb-labs/e2e-shared/urls.js'

const services = [
  { id: 'S-01', name: 'gateway',              url: GATEWAY,     path: '/health' },
  { id: 'S-02', name: 'rest-api',             url: REST,        path: '/health' },
  { id: 'S-04', name: 'workflow',             url: WORKFLOW,    path: '/health' },
  { id: 'S-05', name: 'state-daemon',         url: STATE,       path: '/health' },
]

for (const svc of services) {
  test(`${svc.id}: ${svc.name} is healthy`, async ({ request }) => {
    const res = await request.get(`${svc.url}${svc.path}`)
    expect(res.status()).toBe(200)
    const body = await res.json()
    // REST API wraps in { ok, data }; others return status directly
    const status = body.data?.status ?? body.status
    expect(status).toMatch(/ok|healthy|ready/)
  })
}
