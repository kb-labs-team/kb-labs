---
name: testing
description: Test pyramid strategy, decision tree, and templates — CLI handler tests, SSE/WS integration tests, e2e journeys
globs:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "**/e2e/**"
  - "**/__tests__/**"
  - "**/vitest.*.config.ts"
  - "**/commands/**"
---
# Testing Strategy

---

## Decision tree — pick your test level

```
What are you testing?
│
├── CLI command logic (flags, output format, error messages, exit codes)
│   → Handler test (Vitest + vi.mock + createCapturedUI)
│   → File: plugins/*/src/__tests__/cli/<command>.cli.test.ts
│   → Run:  pnpm --filter <pkg> run test:cli
│   → No daemon required. Fast (<5s total).
│
├── SSE stream behaviour (ordering, cleanup, terminal close, reconnect)
│   → SSE integration test (Playwright + collectSseEvents / expectSseTerminates)
│   → File: e2e/workflows/specs/sse/<endpoint>.spec.ts
│   → Run:  cd e2e/workflows && pnpm e2e
│   → Requires live daemon (kb-dev start).
│
├── WebSocket channel (subscribe/unsubscribe, level filter, cleanup on disconnect)
│   → WS integration test (Playwright + withWs + expectWsMessage)
│   → File: e2e/workflows/specs/ws/<channel>.spec.ts
│   → Run:  cd e2e/workflows && pnpm e2e
│   → Requires live gateway + daemon.
│
├── HTTP API contract (status codes, payload shape, validation errors)
│   → Already covered in services/workflow/daemon/src/api/__tests__/api-contract.integration.test.ts
│   → Do NOT duplicate. Use Fastify inject pattern from that file.
│
└── Multi-step user scenario (run → watch → view → logs)
    → Journey e2e (Playwright, full stack)
    → File: e2e/workflows/specs/cli/cli-journey.spec.ts
    → Run:  cd e2e/workflows && pnpm e2e
```

---

## Handler test template

```typescript
// plugins/<name>/entry/src/__tests__/cli/<command>.cli.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockCLIInput, createCapturedUI, createMockContext } from '@kb-labs/shared-testing-e2e';

vi.mock('../../http-client.js', () => ({
  WorkflowDaemonClient: vi.fn(),
}));

import { WorkflowDaemonClient } from '../../http-client.js';
import myCommand from '../../commands/<command>.js';

const MockedClient = vi.mocked(WorkflowDaemonClient);

beforeEach(() => {
  MockedClient.mockReset();
});

describe('<command>', () => {
  it('--json returns { ok: true, data: ... }', async () => {
    MockedClient.mockImplementation(() => ({
      someMethod: async () => ({ id: 'x', status: 'ok' }),
    }) as never);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await myCommand.execute(ctx, mockCLIInput({ flags: { json: true } }));

    expect(result.ok).toBe(true);
    expect(captured.json[0]).toMatchObject({ ok: true });
  });

  it('daemon unavailable — prints error, ok: false', async () => {
    MockedClient.mockImplementation(() => ({
      someMethod: async () => { throw new Error('ECONNREFUSED'); },
    }) as never);

    const { ui, captured } = createCapturedUI();
    const ctx = createMockContext({ ui });
    const result = await myCommand.execute(ctx, mockCLIInput({ flags: {} }));

    expect(result.ok).toBe(false);
    expect(captured.errors.length).toBeGreaterThan(0);
  });
});
```

`command.execute()` returns the raw `CommandResult` — `{ ok: true, result?, meta? }` or `{ ok: false, error, result?, meta? }` (see `core/plugin-contracts/src/handlers.ts`). There is no `exitCode` on this value — that field is injected later by the runtime (invoke/workflow/REST) into `CommandResultWithMeta`, one layer above the handler. Assert `result.ok` and read payload data off `result.result` (e.g. `result.result.hosts`), not off `result` directly.

**Key helpers from `@kb-labs/shared-testing-e2e`:**

| Helper | What it does |
|---|---|
| `mockCLIInput<F>({ flags, argv })` | Builds typed `CLIInput<F>` |
| `createCapturedUI()` | Returns `{ ui, captured }` — records json/success/errors/writes/logs |
| `createMockContext({ ui })` | Minimal `PluginContextV3` with `host: 'cli'` |
| `mockObject(defaults, overrides)` | Partial override factory for any interface |

**`captured` fields:**

```typescript
captured.json       // arguments to ctx.ui.json()
captured.success    // { message, opts? } from ctx.ui.success()
captured.errors     // strings from ctx.ui.error()
captured.warnings   // { message, opts? } from ctx.ui.warn()
captured.logs       // UILogEntry[] from ctx.ui.log()
captured.writes     // raw strings from ctx.ui.write()
captured.table      // { rows, columns? } from ctx.ui.table()
```

---

## SSE test template

```typescript
// e2e/<domain>/specs/sse/<endpoint>.spec.ts
import { test, expect } from '@playwright/test';
import {
  collectSseEvents,
  waitForSseEvent,
  expectSseTerminates,
  assertSseOrder,
  assertNoSseDuplicates,
} from '@kb-labs/shared-testing-e2e';

test('SE-01: snapshot arrives first, stream closes on terminal', async ({ request }) => {
  const runId = await startRun(request);
  const events = await collectSseEvents(`${WORKFLOW}/api/v1/runs/${runId}/events`, {
    untilEvent: 'run.finished',
    timeoutMs: 30_000,
  });

  expect(events[0].event).toBe('run.snapshot');
  assertSseOrder(events, ['run.snapshot', 'run.finished']);
  assertNoSseDuplicates(events);
});

test('SE-02: already-terminal run closes stream immediately', async ({ request }) => {
  // Start run, wait for completion, then reconnect
  const runId = await startRun(request);
  await waitForSseEvent(`${WORKFLOW}/api/v1/runs/${runId}/events`, 'run.finished', { timeoutMs: 30_000 });
  await expectSseTerminates(`${WORKFLOW}/api/v1/runs/${runId}/events`, { timeoutMs: 3_000 });
});
```

---

## WS test template

```typescript
// e2e/<domain>/specs/ws/<channel>.spec.ts
import { test, expect } from '@playwright/test';
import { withWs, expectWsMessage, expectWsClose } from '@kb-labs/shared-testing-e2e';
import { projectWorkflowRoute } from '@kb-labs/workflow-contracts/routes';

test('WS-L01: subscribe → receive log stream', async () => {
  await withWs(`${GATEWAY_WS}${projectWorkflowRoute(projectId, `ws/logs/${jobId}`)}`, async (ws) => {
    ws.send({ type: 'subscribe', jobId, level: 'info' });

    const msg = await expectWsMessage<{ type: string; level: string; message: string }>(
      ws,
      (m) => m.type === 'log',
      { timeoutMs: 10_000 },
    );

    expect(msg.level).toBe('info');
    expect(msg.message).toBeTruthy();
  });
});
```

---

## Adding a new command — checklist

When you add `src/commands/<name>.ts` to a plugin-entry package:

1. **Create the test file**: `src/__tests__/cli/<name>.cli.test.ts`
2. **Use the handler test template** above — mock the HTTP client, not the full daemon
3. **Run**: `pnpm --filter <pkg> run test:cli`
4. **Verify coverage**: `cd plugins/<name>/entry && cat package.json | node scripts/checks/check-test-pyramid.mjs`

The devkit `check-test-pyramid` custom check runs per-command diff:
- `src/commands/foo.ts` without `src/__tests__/cli/foo.cli.test.ts` → **warning**
- No `__tests__/cli/` directory at all → **error**
- Missing `test:cli` script in `package.json` → **error**

---

## When NOT to write a test

- **HTTP contract already covered** — `api-contract.integration.test.ts` in the daemon. Don't duplicate.
- **Pure function, no side effects** — unit test in the main vitest suite (not `cli/`).
- **Partial/TODO implementation** — use `test.skip('WS-P01: ...', ...)` with a comment, never an empty test.
- **Manual-only scenario** — document in the ADR, not in a flaky test.

---

## Running tests

```bash
# Handler tests — fast, no daemon needed
pnpm --filter @kb-labs/workflow-entry run test:cli

# All plugin handler tests across the monorepo
kb-devkit run test:cli

# SSE + WS tests (need live daemon)
kb-dev start --config .kb/devservices.yaml --net-offset 0
cd e2e/workflows && pnpm e2e

# Full e2e suite
kb-devkit run e2e
```

---

## Known fragile patterns to avoid in SSE/WS

1. **Only checking `writableEnded`, not `!destroyed`** — causes write-after-close crash.
   Check: `!res.raw.writableEnded && !res.raw.destroyed` before writing.

2. **No cleanup on client disconnect** — subscribe count leaks.
   Always call `engine.unsubscribe(subId)` in the `close` handler.

3. **Missing keep-alive** — connection drops silently after 60s idle.
   Heartbeat every ~30s with `event: keep-alive\ndata: {}\n\n`.

4. **WebSocket `send` without `readyState` check** — crashes on closed socket.
   Always guard: `if (ws.readyState === ws.OPEN) ws.send(...)`.
