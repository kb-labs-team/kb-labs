import { createServer } from 'node:http'
import Fastify from 'fastify'
import { expect, test } from '@playwright/test'
import { registerProjectRoutes } from '@kb-labs/gateway-app'

test('Gateway sanitizes an unstructured project workflow failure @S-022.5', async ({ request }) => {
  const upstream = createServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'text/plain' })
    response.end('UPSTREAM_PRIVATE_FAILURE')
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolve)
  })

  const upstreamAddress = upstream.address()
  if (!upstreamAddress || typeof upstreamAddress === 'string') {
    throw new Error('The downstream fixture did not receive a TCP address')
  }
  const app = Fastify()

  try {
    await registerProjectRoutes(app, [
      { serviceId: 'workflow', rewritePrefix: '/api/v1', healthCheck: '/health' },
    ], {
      resolveProjectService: async () => ({
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
        pathPrefix: '',
        headers: {},
        release: () => undefined,
      }),
    })
    const gatewayUrl = await app.listen({ host: '127.0.0.1', port: 0 })
    const response = await request.post(
      `${gatewayUrl}/api/v1/projects/prj_fixture/workflow/workflows/greet/runs?access_token=PRIVATE_QUERY_VALUE`,
      { data: {} },
    )
    const body = await response.json()

    expect(response.status()).toBe(500)
    expect(body).toMatchObject({
      ok: false,
      error: {
        code: 'KB_RUNTIME_COMMAND_FAILED',
        details: {
          route: 'POST /api/v1/workflows/greet/runs',
          upstreamStatus: '500',
        },
        message: expect.any(String),
        hint: expect.any(String),
      },
    })
    expect(JSON.stringify(body)).not.toContain('UPSTREAM_PRIVATE_FAILURE')
    expect(JSON.stringify(body)).not.toContain('PRIVATE_QUERY_VALUE')
  } finally {
    await app.close()
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
