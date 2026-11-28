import { test, expect } from '@playwright/test'
import { decodeUxSuccessResult } from '@kb-labs/core-platform/ux-result'
import { projectRest } from '@kb-labs/e2e-shared/project-rest.js'

const BASE = '/plugins/quality'

test('QL-01: GET /health returns score and grade', async ({ request }) => {
  const res = await (await projectRest(request)).get(`${BASE}/health`)
  expect(res.status()).toBe(200)
  const d = decodeUxSuccessResult<{ score: number; grade: string }>(await res.json())
  expect(typeof d.score).toBe('number')
  expect(d.score).toBeGreaterThanOrEqual(0)
  expect(d.score).toBeLessThanOrEqual(100)
  expect(typeof d.grade).toBe('string')
})

test('QL-02: GET /stats returns package count and LOC', async ({ request }) => {
  const res = await (await projectRest(request)).get(`${BASE}/stats`)
  expect(res.status()).toBe(200)
  const d = decodeUxSuccessResult<{ packages: number; loc: number; size: string }>(await res.json())
  expect(typeof d.packages).toBe('number')
  expect(d.packages).toBeGreaterThanOrEqual(0)
  expect(typeof d.loc).toBe('number')
  expect(typeof d.size).toBe('string')
})

test('QL-03: GET /dependencies returns duplicate/unused/missing arrays with totalIssues', async ({ request }) => {
  const res = await (await projectRest(request)).get(`${BASE}/dependencies`)
  expect(res.status()).toBe(200)
  const d = decodeUxSuccessResult<{ duplicates: unknown[]; unused: unknown[]; missing: unknown[]; totalIssues: number }>(await res.json())
  expect(Array.isArray(d.duplicates)).toBe(true)
  expect(Array.isArray(d.unused)).toBe(true)
  expect(Array.isArray(d.missing)).toBe(true)
  expect(typeof d.totalIssues).toBe('number')
  expect(d.totalIssues).toBe(
    d.duplicates.length + d.unused.length + d.missing.length
  )
})

test('QL-04: GET /build-order returns sorted list and layer info', async ({ request }) => {
  const res = await (await projectRest(request)).get(`${BASE}/build-order`)
  expect(res.status()).toBe(200)
  const d = decodeUxSuccessResult<{ sorted: unknown[]; packageCount: number; hasCircular: boolean }>(await res.json())
  expect(Array.isArray(d.sorted)).toBe(true)
  expect(typeof d.packageCount).toBe('number')
  expect(typeof d.hasCircular).toBe('boolean')
})

test('QL-05: GET /cycles returns cycles array with count and hasCircular', async ({ request }) => {
  const res = await (await projectRest(request)).get(`${BASE}/cycles`)
  expect(res.status()).toBe(200)
  const d = decodeUxSuccessResult<{ cycles: unknown[]; cycleCount: number; hasCircular: boolean; affectedPackages: unknown[] }>(await res.json())
  expect(Array.isArray(d.cycles)).toBe(true)
  expect(typeof d.cycleCount).toBe('number')
  expect(typeof d.hasCircular).toBe('boolean')
  expect(Array.isArray(d.affectedPackages)).toBe(true)
  expect(d.cycleCount).toBe(d.cycles.length)
})

test('QL-06: GET /layers returns violations with totalViolations', async ({ request }) => {
  const res = await (await projectRest(request)).get(`${BASE}/layers`)
  expect(res.status()).toBe(200)
  const d = decodeUxSuccessResult<{ violations: unknown[]; totalViolations: number; affectedPackages: unknown[]; layerMap: object }>(await res.json())
  expect(Array.isArray(d.violations)).toBe(true)
  expect(typeof d.totalViolations).toBe('number')
  expect(Array.isArray(d.affectedPackages)).toBe(true)
  expect(typeof d.layerMap).toBe('object')
})

test('QL-07: GET /coupling returns packages with instability metrics', async ({ request }) => {
  const res = await (await projectRest(request)).get(`${BASE}/coupling`)
  expect(res.status()).toBe(200)
  const d = decodeUxSuccessResult<{ packages: { name: string; instability: number }[]; avgInstability: number }>(await res.json())
  expect(Array.isArray(d.packages)).toBe(true)
  expect(typeof d.avgInstability).toBe('number')
  for (const pkg of d.packages.slice(0, 5)) {
    expect(typeof pkg.name).toBe('string')
    expect(pkg.instability).toBeGreaterThanOrEqual(0)
    expect(pkg.instability).toBeLessThanOrEqual(1)
  }
})
