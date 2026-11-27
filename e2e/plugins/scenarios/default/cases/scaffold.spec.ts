import { test, expect } from '@playwright/test'
import { REST, REST_API_PREFIX } from '@kb-labs/e2e-shared/urls.js'

// SC-01: scaffold lists available templates
test('SC-01: scaffold lists available templates', async ({ request }) => {
  const res = await request.get(`${REST}${REST_API_PREFIX}/scaffold/templates`)
  expect(res.status(), 'scaffold templates endpoint is missing from the required profile').toBe(200)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const templates: { id?: string; name?: string }[] =
    body.data?.templates ?? body.templates ?? (Array.isArray(body) ? body : [])
  expect(Array.isArray(templates)).toBe(true)
  expect(templates.length).toBeGreaterThanOrEqual(1)
  // At least one template must be plugin-related
  const hasPlugin = templates.some(
    t => t.id?.includes('plugin') || t.name?.includes('plugin'),
  )
  expect(hasPlugin).toBe(true)
})

// SC-02: scaffold plugin template has required fields
test('SC-02: scaffold plugin template has required structure', async ({ request }) => {
  const res = await request.get(`${REST}${REST_API_PREFIX}/scaffold/templates`)
  expect(res.status(), 'scaffold templates endpoint is missing from the required profile').toBe(200)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const templates: { id?: string; name?: string; description?: string; type?: string }[] =
    body.data?.templates ?? body.templates ?? (Array.isArray(body) ? body : [])

  const pluginTemplate = templates.find(
    t => t.id?.includes('plugin') || t.name?.includes('plugin'),
  )
  expect(pluginTemplate, 'plugin template is missing from the required scaffold catalog').toBeTruthy()

  // Template must have at least an identifier and a description or type
  expect(pluginTemplate!.id ?? pluginTemplate!.name).toBeTruthy()
  expect(pluginTemplate!.description ?? pluginTemplate!.type).toBeTruthy()
})

// SC-03: scaffold run creates plugin files (if scaffold/run endpoint exists)
test('SC-03: scaffold run creates plugin structure', async ({ request }) => {
  const res = await request.post(`${REST}${REST_API_PREFIX}/scaffold/run`, {
    data: {
      template: 'plugin',
      name: 'e2e-test-plugin',
      targetDir: '/tmp/e2e-scaffold-test',
    },
  })

  expect(res.status(), 'scaffold run endpoint is missing from the required profile').not.toBe(404)
  expect(res.status(), 'scaffold run endpoint is missing from the required profile').not.toBe(501)

  expect([200, 201]).toContain(res.status())
  const body = await res.json()
  const data = body.data ?? body
  // Response must contain either a files array or an outputDir
  const hasFiles = Array.isArray(data.files) && data.files.length > 0
  const hasOutputDir = typeof data.outputDir === 'string' && data.outputDir.length > 0
  expect(hasFiles || hasOutputDir).toBe(true)
})
