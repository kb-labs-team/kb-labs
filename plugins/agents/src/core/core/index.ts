/**
 * @kb-labs/agents/core — clean SDK-native agent implementation.
 *
 * Public API:
 *   bootstrapAgentSDK()   — register RunnerFactory once at startup
 *   SDKAgentRunner        — the runner class (if you need to instantiate directly)
 *   LoopContextImpl       — for custom ExecutionLoop implementations
 *   ToolExecutor          — for custom guard/processor pipelines
 *   createRunContext()    — for testing
 *   ContextMetaImpl       — for testing
 */

export { bootstrapAgentSDK } from './bootstrap.js';
export { SDKAgentRunner } from './runner.js';
export { LoopContextImpl } from './loop-context.js';
export { ToolExecutor } from './tool-executor.js';
export { createRunContext, ContextMetaImpl } from './run-context.js';
export { createSessionMemoryBridge } from './session-memory-bridge.js';
