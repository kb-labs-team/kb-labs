# @kb-labs/shared-testing-e2e

E2E test harness for the KB Labs platform. Wraps `kb-dev` so tests can boot real services in `beforeAll`, assert against real HTTP/WS/SSE, and clean up in `afterAll`.

## Quickstart

```ts
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { KbDevController, httpClient } from '@kb-labs/shared-testing-e2e';

const controller = new KbDevController();
let client: ReturnType<typeof httpClient>;

beforeAll(async () => {
  await controller.ensureServices(['state-daemon', 'gateway']);
  client = httpClient(controller.getServiceUrl('gateway'));
}, 120_000);

afterAll(async () => {
  await controller.dispose();
}, 60_000);

describe('gateway health', () => {
  it('responds to /health', async () => {
    const res = await client.get('/health');
    expect(res.ok).toBe(true);
  });
});
```

## What's in the box

- **`KbDevController`** — drives `kb-dev ensure|status|stop --json` as a subprocess. One instance per test file.
- **`httpClient(baseUrl)`** — thin `fetch` wrapper with JSON parsing and timeouts.
- **`connectWs(url, opts)`** — WebSocket client with message tracking + `closeAllTrackedSockets()` for `afterEach`.
- **`readSse(url)`** — async iterator over Server-Sent Events.
- **`registerAgent(client, { namespaceId })` / `registerHost(...)`** — gateway auth helpers (JWT via `/auth/register` → `/auth/token`).
- **`createIsolatedProjectRoot()`** — temp dir with its own `.kb/devservices.yaml` for tests that mutate marketplace lock / plugins.
- **`makeTestNamespace(import.meta.url)`** — unique-per-test resource namespace for isolation across shared services.

## Lifecycle rules

1. **One `KbDevController` per test file.** Per-test boot is 3–10s and will ruin your day.
2. **Always `dispose()` in `afterAll`** — otherwise services leak across test runs.
3. **Prefer namespaced IDs** for every resource a test creates; use `afterEach` to clean them up explicitly even when services are shared.
4. **Use `createIsolatedProjectRoot()`** for any test that mutates `.kb/marketplace.lock`, `.kb/plugins.json`, or similar project-scoped state. Never touch the real workspace.

## Testing the harness itself

```bash
pnpm --filter @kb-labs/shared-testing-e2e build
pnpm --filter @kb-labs/shared-testing-e2e test
```

The default test suite is hermetic (no kb-dev spawn, no docker). Full boot-cycle tests are gated behind `KB_E2E_BOOT=1` because `state-daemon` depends on `redis` which requires Docker.

## Deep Agents scenarios

Slower end-to-end user scenarios for Agents (real REST/WS flow, long sessions,
mode and escalation behavior) share one opt-in flag: `KB_AGENTS_E2E_DEEP=1` in
the workspace `.env`, or the same process environment variable. A process env
value takes precedence over `.env`. Tests should use
`isDeepAgentE2EEnabled()` from this package with Vitest's `describe.skipIf` or
`it.skipIf`; keep deterministic, fast regression tests ungated.
