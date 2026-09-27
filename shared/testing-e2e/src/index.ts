/**
 * @kb-labs/shared-testing-e2e
 *
 * E2E test harness for the KB Labs platform. Playwright-safe — no vitest imports.
 *
 * For CLI handler tests (vitest context) import from @kb-labs/shared-testing-e2e/cli:
 *   - `mockCLIInput`, `mockObject`, `createCapturedUI`, `createMockContext`
 *
 * SSE helpers:
 *   - `collectSseEvents` — drain SSE stream into array
 *   - `waitForSseEvent` — wait for specific event type
 *   - `expectSseTerminates` — assert stream closes on its own
 *   - `assertSseOrder` / `assertNoSseDuplicates` — assertion helpers
 *
 * WebSocket helpers:
 *   - `withWs` — auto-close wrapper
 *   - `expectWsMessage` — wait for message matching predicate
 *   - `expectWsClose` — assert clean close
 *
 * Infrastructure:
 *   - `KbDevController` — boots/queries/stops real services via `kb-dev --json`.
 *   - `HttpClient` / `connectWs` / `readSse` — tiny HTTP/WS/SSE helpers for assertions.
 *   - `registerAgent` / `registerHost` — gateway auth helpers.
 *   - `createIsolatedProjectRoot` — temp dir with its own `.kb/` for mutating tests.
 *   - `makeTestNamespace` — unique-per-test resource namespace for isolation.
 *
 * Lifecycle contract: **one controller per test file**. Boot in `beforeAll`,
 * dispose in `afterAll`. Services are shared across `describe`/`it` blocks
 * inside the same file. Per-test boot is prohibitively slow.
 */

export { KbDevController } from './kb-dev-controller.js';

export { DiagCollector } from './diag-collector.js';
export { registerDiagSnapshotHook } from './diag-snapshot-hook.js';
export type {
  DiagSnapshot,
  KbLogEvent,
  AdapterStageTrace,
  PluginGovernanceTrace,
  GovernanceMiddlewareInfo,
  ConfigLayersDiag,
  PluginDiscoveryDiag,
  DiscoveredPluginInfo,
  SkippedPluginInfo,
  ServiceDiag,
} from './diag-types.js';
export type {
  ServiceId,
  ServiceState,
  ServiceStatus,
  ServiceHealth,
  StatusSnapshot,
  StatusSummary,
  KbDevAction,
  KbDevResult,
  KbDevControllerOptions,
  EnsureOptions,
} from './types.js';

export { HttpClient, httpClient } from './http-client.js';
export type { HttpClientOptions, HttpResponse } from './http-client.js';

export { connectWs, closeAllTrackedSockets } from './ws-client.js';
export type { WsOptions, WsHandle } from './ws-client.js';

export { readSse } from './sse-reader.js';
export type { SseEvent, SseOptions } from './sse-reader.js';

export { registerAgent, registerHost } from './jwt-helpers.js';
export type { AgentCredentials, HostCredentials } from './jwt-helpers.js';

export { createIsolatedProjectRoot } from './isolated-project-root.js';
export type { IsolatedProjectRoot, IsolatedProjectRootOptions } from './isolated-project-root.js';

export { makeTestNamespace } from './namespace.js';

export { findWorkspaceRoot, resolveWorkspaceRoot } from './workspace-root.js';
export { isDeepAgentE2EEnabled } from './deep-e2e.js';

// --- SSE helpers ---
export { collectSseEvents, waitForSseEvent, expectSseTerminates } from './sse/collect.js';
export type { CollectSseOptions } from './sse/collect.js';

export { assertSseOrder, assertNoSseDuplicates } from './sse/assert.js';

// --- WebSocket helpers ---
export { withWs } from './ws/lifecycle.js';
export { expectWsMessage, expectWsClose } from './ws/assert.js';
