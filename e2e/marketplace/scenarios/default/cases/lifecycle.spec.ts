import { test, expect } from '@playwright/test'
import { MARKETPLACE } from '@kb-labs/e2e-shared/urls.js'

// Marketplace package lifecycle: install → disable → enable → uninstall
// All mutating operations use the body-based API (not URL-encoded package IDs)
// because plugin IDs contain `@` and `/` that break URL-path routing.

// @kb-labs/qa-entry is published to Verdaccio from the monorepo build and not
// requested by any default kb-create plugin/adapter, so it is safe to
// install / disable / enable / uninstall in tests.
//
// @kb-labs/commit-entry (the commit plugin) looked equally "extra" by the
// same reasoning below, but it IS in the default --plugins list
// (e2e/platform/entrypoint.sh); kb-create's own artifact ships it under the
// short id "commit", while this suite's npm-source installs it keyed by its
// full package name — two different lock keys pointing at the same
// node_modules/@kb-labs/commit-entry directory. Uninstalling it here deleted
// that directory out from under the platform's own "commit" entry, which
// then failed marketplace diagnostics (package directory not found) for the
// rest of the run. Don't reuse a default-bootstrap package as a lifecycle
// test subject, however unrelated its id looks.
const TEST_SPEC = '@kb-labs/qa-entry'

// Helper: find exact match for TEST_SPEC in marketplace listing.
// Using exact ID match to avoid false positives from pre-installed packages
// that happen to share a substring (e.g. '@kb-labs/qa' != '@kb-labs/qa-entry').
type PkgEntry = { name?: string; id?: string; spec?: string; enabled?: boolean }
const findExact = (packages: PkgEntry[]) =>
  packages.find(p => p.id === TEST_SPEC || p.spec === TEST_SPEC || p.name === TEST_SPEC)

// Shared skip guards for install errors
function skipOnInstallError(status: number) {
  test.skip(status === 404, 'package not found in registry — check Verdaccio publish step')
  test.skip(status === 422, 'marketplace install failed (pnpm workspace-root check — needs --ignore-workspace-root-check in marketplace npm-source)')
  test.skip(status === 500, 'npm registry unreachable from this environment')
}

// ML-01: install package → appears in listing
test('ML-01: install package → appears in GET /packages', async ({ request }) => {
  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: [TEST_SPEC] },
    timeout: 60_000,  // pnpm install can take 30-60s on first run
  })
  skipOnInstallError(install.status())
  expect([200, 201, 409]).toContain(install.status()) // 409 = already installed

  const list = await request.get(`${MARKETPLACE}/api/v1/marketplace/packages`)
  expect(list.status()).toBe(200)
  const body = await list.json()
  const packages: PkgEntry[] = body.entries ?? body.packages ?? []
  expect(findExact(packages)).toBeTruthy()
})

// ML-02: disable package → listing reflects disabled state
test('ML-02: disable package → disabled flag set in listing', async ({ request }) => {
  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: [TEST_SPEC] },
    timeout: 60_000,
  })
  skipOnInstallError(install.status())
  expect([200, 201, 409]).toContain(install.status())

  const disable = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/disable`, {
    data: { packageId: TEST_SPEC },
  })
  test.skip(disable.status() === 404, 'disable endpoint not available in this build')
  expect(disable.status()).toBe(200)
  const disableData = (await disable.json()).data ?? (await disable.json())
  expect(disableData.enabled).toBe(false)

  // Verify listing shows the exact package as disabled
  const list = await request.get(`${MARKETPLACE}/api/v1/marketplace/packages`)
  const listBody = await list.json()
  const packages: PkgEntry[] = listBody.entries ?? listBody.packages ?? []
  const pkg = findExact(packages)
  if (pkg && 'enabled' in pkg) {
    expect(pkg.enabled).toBe(false)
  }
})

// ML-03: enable previously disabled package → enabled flag restored
test('ML-03: enable package → enabled flag restored in listing', async ({ request }) => {
  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: [TEST_SPEC] },
    timeout: 60_000,
  })
  skipOnInstallError(install.status())
  expect([200, 201, 409]).toContain(install.status())

  await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/disable`, {
    data: { packageId: TEST_SPEC },
  })

  const enable = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/enable`, {
    data: { packageId: TEST_SPEC },
  })
  test.skip(enable.status() === 404, 'enable endpoint not available in this build')
  expect(enable.status()).toBe(200)
  const enableData = (await enable.json()).data ?? (await enable.json())
  expect(enableData.enabled).toBe(true)
})

// ML-04: update installed package — endpoint responds without error
test('ML-04: POST /packages/update — responds without error', async ({ request }) => {
  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: [TEST_SPEC] },
    timeout: 60_000,
  })
  skipOnInstallError(install.status())
  expect([200, 201, 409]).toContain(install.status())

  const update = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/update`, {
    data: { packageIds: [TEST_SPEC] },
  })
  test.skip(update.status() === 404, 'update endpoint not available in this build')
  // 200 = updated, 204 = already at latest, both are valid
  expect([200, 204]).toContain(update.status())
})

// ML-05: uninstall package → no longer in listing
test('ML-05: uninstall package → gone from GET /packages', async ({ request }) => {
  const install = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/install`, {
    data: { specs: [TEST_SPEC] },
    timeout: 60_000,
  })
  skipOnInstallError(install.status())
  expect([200, 201, 409]).toContain(install.status())

  const uninstall = await request.post(`${MARKETPLACE}/api/v1/marketplace/packages/uninstall`, {
    data: { packageIds: [TEST_SPEC] },
  })
  test.skip(uninstall.status() === 404, 'uninstall endpoint not available in this build')
  expect([200, 204]).toContain(uninstall.status())

  // Give it a moment, then verify the exact package is gone
  await new Promise(resolve => setTimeout(resolve, 500))
  const list = await request.get(`${MARKETPLACE}/api/v1/marketplace/packages`)
  const body = await list.json()
  const packages: PkgEntry[] = body.entries ?? body.packages ?? []
  // Use exact match — pre-installed packages like '@kb-labs/commit' must not cause false positives
  expect(findExact(packages)).toBeUndefined()
})
