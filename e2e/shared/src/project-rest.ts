import type { APIRequestContext, APIResponse } from '@playwright/test'
import { loginAdmin } from './auth.js'
import { GATEWAY } from './urls.js'

/** Resolve the installed fixture through the host registry, then use its project REST route. */
export async function projectRest(request: APIRequestContext, projectPath = '/workspace/kb-e2e') {
  await loginAdmin(request)
  const response = await request.get(`${GATEWAY}/api/v1/projects`)
  if (!response.ok()) throw new Error(`project list failed: ${response.status()}`)
  const body: unknown = await response.json()
  if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true || !('data' in body) || !Array.isArray(body.data)) {
    throw new Error('project list returned an invalid envelope')
  }
  const matches = body.data.filter((item: unknown) => item && typeof item === 'object' && 'path' in item && item.path === projectPath)
  if (matches.length !== 1 || typeof matches[0].id !== 'string' || !matches[0].id) {
    throw new Error(`expected exactly one registered project for ${projectPath}`)
  }
  const base = `${GATEWAY}/api/v1/projects/${encodeURIComponent(matches[0].id)}/rest`
  return {
    get(path: string): Promise<APIResponse> {
      if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/api/v1/')) {
        throw new Error('project REST path must be service-relative, without /api/v1')
      }
      return request.get(`${base}${path}`)
    },
  }
}
