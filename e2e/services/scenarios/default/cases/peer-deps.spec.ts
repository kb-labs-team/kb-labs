import { test, expect } from '@playwright/test'
import { GATEWAY, REST, MARKETPLACE_DIRECT } from '@kb-labs/e2e-shared/urls.js'

// PD-01: gateway /health doesn't report version conflicts
test('PD-01: gateway health reports consistent version', async ({ request }) => {
  const res = await request.get(`${GATEWAY}/health`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const bodyStr = JSON.stringify(body)

  // Must not contain 'unmet' (peer dep warning leaked into health response)
  expect(bodyStr).not.toContain('unmet')

  // Must not report the old version that caused peer dep issues
  const version: string | undefined = body.version ?? body.data?.version
  if (version) {
    expect(version).not.toContain('2.54')
  }
})

// PD-02: all services report same major version
test('PD-02: services report consistent platform version', async ({ request }) => {
  const endpoints = [
    { name: 'gateway',     url: `${GATEWAY}/health` },
    { name: 'rest-api',    url: `${REST}/health` },
    { name: 'marketplace', url: `${MARKETPLACE_DIRECT}/health` },
  ]

  const versions: string[] = []

  for (const ep of endpoints) {
    const res = await request.get(ep.url)
    expect(res.status()).toBe(200)
    const body = await res.json()
    const version: unknown = body.version ?? body.data?.version
    if (typeof version === 'string') {
      versions.push(version)
    }
  }

  // If any version fields were returned, they must all share the same major.minor
  if (versions.length > 1) {
    const majorMinor = (v: string) => v.split('.').slice(0, 2).join('.')
    const base = majorMinor(versions[0])
    for (const v of versions.slice(1)) {
      expect(majorMinor(v)).toBe(base)
    }
  }
})
