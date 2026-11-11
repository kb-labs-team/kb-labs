import type { ILogger, IServiceTransport } from '@kb-labs/core-platform';
import { unexpectedMcpResult, mcpToolSuccess } from './request-handler.js';
import type { McpServiceTool } from './tool-builder.js';

/** Invoke an enabled service command through the platform's topology-aware transport. */
export async function callServiceTool(
  tool: McpServiceTool,
  args: Record<string, unknown>,
  transport: IServiceTransport,
  logger: ILogger,
) {
  try {
    const pathParameters = new Set([...tool.route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!));
    const route = tool.route.path.replace(/\{([^}]+)\}/g, (_match, key: string) => encodeURIComponent(String(args[key])));
    const basePath = `${tool.route.mount === 'project-api' ? '/api/v1' : ''}${route}`;
    const inputNames = new Set(Object.keys(tool.inputSchema.properties));
    const query = new URLSearchParams();
    const payload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (pathParameters.has(key) || !inputNames.has(key) || value === undefined) {continue;}
      if (tool.route.body === true) {
        payload[key] = value;
      } else if (Array.isArray(value)) {
        for (const item of value) {query.append(key, String(item));}
      } else {
        query.append(key, String(value));
      }
    }
    const path = query.size > 0 ? `${basePath}?${query}` : basePath;
    const hasBody = tool.route.body === true;
    const response = await transport.call(tool.serviceId, {
      path,
      metadata: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        'http-method': tool.route.method,
      },
      ...(hasBody ? { payload } : {}),
    });
    if (!response.ok) {
      return unexpectedMcpResult(new Error(`Service ${tool.serviceId} returned HTTP ${response.statusCode}.`), logger);
    }
    return mcpToolSuccess(JSON.stringify(response.payload ?? null));
  } catch (error) {
    return unexpectedMcpResult(error, logger);
  }
}
