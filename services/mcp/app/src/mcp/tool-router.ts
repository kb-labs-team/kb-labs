/**
 * Tool router — executes a resolved McpTool by routing through the same V3
 * command pipeline the CLI uses (executeCommandV3). Plugin output is captured
 * via the platform's uiProvider mechanism:
 *
 *   bootstrap.ts wires an AsyncLocalStorage-backed uiProvider to the execution
 *   backend. callTool() activates the per-call context via callOutput.run();
 *   the backend calls uiProvider() → createBufferedUI(push) where push appends
 *   to the call-local buffer. Concurrent calls are fully isolated.
 *
 * Multi-tenancy seam: callTool never touches a global platform directly. It
 * resolves the PlatformContainer through `resolvePlatform(tenantId)`. Today that
 * returns the single global container; when the platform gains per-tenant
 * isolation, only the resolver changes — this module stays untouched.
 */

import path from 'node:path';
import { executeCommandV3 } from '@kb-labs/cli-runtime';
import { noopUI } from '@kb-labs/plugin-contracts';
import type { PlatformContainer } from '@kb-labs/core-runtime';
import type { PlatformServices } from '@kb-labs/plugin-contracts';
import { callOutput } from './output-capture.js';
import type { McpTool } from './tool-builder.js';

export interface ToolCallResult {
  success: boolean;
  output: string;
  exitCode: number;
}

/** Tenant → platform container. Default returns the global container; platform overrides for isolation. */
export type PlatformResolver = (tenantId: string) => PlatformContainer;

/**
 * Resolve a manifest handler reference (e.g. "dist/commands/x.js" or
 * "commands/x.js#handler") to an absolute path under the plugin's dist/.
 * Mirrors the CLI plugin-executor so MCP and CLI execution stay identical.
 */
function resolveHandlerPath(pluginRoot: string, handler: string): string {
  const relative = handler.split('#')[0] ?? handler;
  return relative.startsWith('dist/')
    ? path.resolve(pluginRoot, relative)
    : path.resolve(pluginRoot, 'dist', relative);
}

/** Project a PlatformContainer onto the PlatformServices surface executeCommandV3 consumes. */
function createPlatformServices(container: PlatformContainer): PlatformServices {
  return {
    logger: container.logger,
    llm: container.llm,
    embeddings: container.embeddings,
    vectorStore: container.vectorStore,
    cache: container.cache,
    config: container.config,
    storage: container.storage,
    analytics: container.analytics,
    eventBus: container.eventBus,
    invoke: container.invoke,
    documentDatabase: container.documentDatabase,
    kvStore: container.kvStore,
    logs: container.logs,
  };
}

/**
 * Execute an MCP tool. tenantId is propagated end-to-end (no loss); the platform
 * container is resolved through the seam so isolation is the platform's concern.
 *
 * Output capture: activates the AsyncLocalStorage context so the execution
 * backend's uiProvider can write into the call-local `lines` buffer. The `ui`
 * param passed to executeCommandV3 is unused by V3 (the backend uses uiProvider),
 * but noopUI is passed explicitly to make the intent clear.
 */
export async function callTool(
  tool: McpTool,
  args: Record<string, unknown>,
  tenantId: string,
  resolvePlatform: PlatformResolver,
): Promise<ToolCallResult> {
  const lines: string[] = [];
  const container = resolvePlatform(tenantId);

  const exitCode = await callOutput.run(lines, () =>
    executeCommandV3({
      pluginId: tool.pluginId,
      pluginVersion: tool.version,
      pluginRoot: tool.pluginRoot,
      handlerPath: resolveHandlerPath(tool.pluginRoot, tool.handlerPath),
      argv: [],
      flags: args,
      tenantId,
      // ui is ignored by executeCommandV3 V3 (backend uses uiProvider).
      // noopUI is passed explicitly to document this intent.
      ui: noopUI,
      platform: createPlatformServices(container),
      platformContainer: container,
      socketPath: container.getSocketPath(),
      permissions: tool.permissions,
      quotas: tool.permissions?.quotas,
      onLog: (entry) => lines.push(entry.message),
      onLoggerLog: (entry) => lines.push(`[${entry.level}] ${entry.message}`),
    }),
  );

  return { success: exitCode === 0, output: lines.join('\n'), exitCode };
}
