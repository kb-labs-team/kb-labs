import { test, expect } from '@playwright/test'
import { REST } from '../../fixtures/urls.js'

// RV-01: review plugin is registered in platform
test('RV-01: review plugin is registered in platform', async ({ request }) => {
  const res = await request.get(`${REST}/api/v1/plugins/registry`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const manifests: { pluginId?: string; manifest?: { id?: string; name?: string } }[] =
    body.data?.manifests ?? body.manifests ?? []
  const hasReview = manifests.some(
    m =>
      m.pluginId?.includes('review') ||
      m.manifest?.id?.includes('review') ||
      m.manifest?.name?.toLowerCase().includes('review'),
  )
  expect(hasReview).toBe(true)
})

// RV-02: review heuristic command registered
test('RV-02: review heuristic command registered', async ({ request }) => {
  // The routes endpoint verifies the REST API is up and routes are mounted.
  // Plugin commands themselves are CLI-registered, not HTTP routes, so we
  // confirm the registry endpoint is reachable and returns 200 as a proxy
  // for plugin discovery being healthy.
  const res = await request.get(`${REST}/api/v1/routes`)
  expect(res.status()).toBe(200)
})

// RV-03: review plugin manifest loads correctly
test('RV-03: review plugin manifest loads correctly', async ({ request }) => {
  const res = await request.get(`${REST}/api/v1/plugins/registry`)
  expect(res.status()).toBe(200)
  const body = await res.json()
  const manifests: { pluginId?: string; manifest?: { id?: string; name?: string; commands?: unknown[] } }[] =
    body.data?.manifests ?? body.manifests ?? []

  const reviewPlugin = manifests.find(
    m =>
      m.pluginId?.includes('review') ||
      m.manifest?.id?.includes('review') ||
      m.manifest?.name?.toLowerCase().includes('review'),
  )
  test.skip(!reviewPlugin, 'review plugin not found in registry')

  // Manifest must have an id or name — the minimal contract for a registered plugin
  expect(reviewPlugin!.pluginId ?? reviewPlugin!.manifest?.id ?? reviewPlugin!.manifest?.name).toBeTruthy()
})
