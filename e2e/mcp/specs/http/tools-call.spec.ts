import { test, expect } from '@playwright/test'
import { getAccessToken } from '@kb-labs/e2e-shared/auth.js'
import { listTools, postMcp, type McpCallResult } from './_helpers.js'

// MCP tools/call — routes a tool invocation through executeCommandV3 and returns
// its captured output as MCP content.

test('M-10: calling a known tool returns text content', async ({ request }) => {
  const token = await getAccessToken(request)
  const tools = await listTools(request, token)
  expect(tools.length, 'MCP tools/list returned an empty catalog; project plugin discovery is unavailable').toBeGreaterThan(0)

  const tool = tools[0]
  const { result } = await postMcp<McpCallResult>(
    request,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool.name, arguments: {} } },
    token,
  )

  expect(result?.content).toBeTruthy()
  expect(Array.isArray(result?.content)).toBe(true)
  expect(result?.content?.[0]?.type).toBe('text')
})

test('M-11: calling an unknown tool reports isError', async ({ request }) => {
  const token = await getAccessToken(request)
  const { result } = await postMcp<McpCallResult>(
    request,
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'does-not-exist__nope', arguments: {} },
    },
    token,
  )

  expect(result?.isError).toBe(true)
  expect(result?.content?.[0]?.text ?? '').toContain('KB_RUNTIME_MCP_UNKNOWN_TOOL')
})
