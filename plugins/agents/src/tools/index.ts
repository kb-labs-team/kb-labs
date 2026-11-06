/**
 * @kb-labs/agents/tools
 *
 * Tool implementations for agents (filesystem, shell, search, etc.)
 */

export * from './types.js';
export * from './registry.js';
export * from './gateway.js';
export * from './tools/index.js';
export * from './config.js';
export * from './utils.js';
export * from './workspace-provider.js';
export { RemoteWorkspaceProvider, type DispatchFn } from './remote-workspace-provider.js';

// Main export for easy setup
export { createToolRegistry } from './tools/index.js';
