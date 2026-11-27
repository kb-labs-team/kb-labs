import type { APIRequestContext } from '@playwright/test'
import { MCP } from '@kb-labs/e2e-shared/urls.js'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: Record<string, unknown>
}

export interface McpTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpCallResult {
  content?: Array<{ type: string; text?: string }>
  isError?: boolean
}

// Project runtime MCP is mounted at the `/mcp` project route itself. The
// standalone daemon keeps its historical `/api/v1/mcp` endpoint.
const MCP_ENDPOINT = process.env.MCP_URL?.includes('/api/v1/projects/')
  ? MCP
  : `${MCP}/api/v1/mcp`

/**
 * POST a JSON-RPC request to the MCP endpoint. The Streamable HTTP transport
 * answers a single non-streaming request with an SSE-framed body (or JSON),
 * so we parse whichever the server returns and return the JSON-RPC `result`.
 */
export async function postMcp<T = unknown>(
  request: APIRequestContext,
  body: JsonRpcRequest,
  token?: string,
): Promise<{ status: number; result?: T; error?: unknown }> {
  const res = await request.post(MCP_ENDPOINT, {
    headers: {
      'Content-Type': 'application/json',
      // The SDK requires the client to accept both JSON and the SSE stream.
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    data: body,
  })

  const status = res.status()
  const text = await res.text()
  const payload = parseRpcBody(text)
  return { status, result: payload?.result as T, error: payload?.error }
}

/** Parse either a plain JSON-RPC body or an SSE-framed one (`data: {...}`). */
function parseRpcBody(text: string): { result?: unknown; error?: unknown } | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined

  // SSE framing: one or more `data:` lines; take the last data payload.
  if (trimmed.includes('data:')) {
    const dataLines = trimmed
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice('data:'.length).trim())
    const last = dataLines[dataLines.length - 1]
    return last ? (JSON.parse(last) as { result?: unknown }) : undefined
  }

  return JSON.parse(trimmed) as { result?: unknown }
}

export async function listTools(
  request: APIRequestContext,
  token?: string,
): Promise<McpTool[]> {
  const { result } = await postMcp<{ tools: McpTool[] }>(
    request,
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    token,
  )
  return result?.tools ?? []
}
