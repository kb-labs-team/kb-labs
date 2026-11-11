# ADR-0016: Test Pyramid for Plugin Commands, SSE, and WebSocket

**Status:** Accepted  
**Date:** 2026-05-15

## Context

CLI commands across all plugins had zero test coverage. SSE and WebSocket streaming
produced recurring runtime bugs (write-after-close, missing cleanup on disconnect,
duplicate events) that were only caught in production. There was no convention for
where tests should live or how to run them.

## Decision

Adopt a three-level test pyramid enforced by devkit:

### Level 1 — Handler tests (fast, no daemon)

- **Location:** `plugins/*/src/__tests__/cli/*.cli.test.ts`
- **Tool:** Vitest + `vi.mock` for the HTTP client
- **Helpers:** `@kb-labs/shared-testing-e2e` — `mockCLIInput`, `createCapturedUI`, `createMockContext`, `mockObject`
- **Run:** `pnpm run test:cli` (per plugin) or `kb-devkit run test:cli` (all)
- **Speed:** < 5s per package, no external services required

### Level 2 — SSE/WS integration tests (real daemon)

- **Location:** `e2e/<domain>/specs/sse/` and `e2e/<domain>/specs/ws/`
- **Tool:** Playwright test runner
- **Helpers:** `@kb-labs/shared-testing-e2e` — `collectSseEvents`, `expectSseTerminates`, `withWs`, `expectWsMessage`
- **Run:** `cd e2e/<domain> && pnpm e2e`
- **Purpose:** Catches streaming bugs that mocks cannot surface (backpressure, cleanup, ordering)

### Level 3 — Journey e2e (full stack)

- **Location:** `e2e/<domain>/specs/cli/`
- **Tool:** Playwright
- **Purpose:** Multi-command user scenarios; slow, run in CI only

## Enforcement

- `devkit.yaml` `plugin-entry` preset requires `test:cli` script in `package.json`
- `devkit.yaml` `custom_checks: test-pyramid` warns when `src/__tests__/cli/` is empty
- `kb-devkit run test:cli` aggregates handler tests across all plugin-entry packages

## What is NOT tested here

- HTTP API contracts — covered by `api-contract.integration.test.ts` in the daemon package
- Pure utility functions — covered by the main vitest suite (`test` task)

## Consequences

- Plugin owners must add a `test:cli` script (3-line config, inherits from `@kb-labs/devkit/vitest/cli`)
- First real tests live in `services/workflow/entry` as the canonical example
- `@kb-labs/shared-testing-e2e` gains CLI-specific helpers (`captured-ui`, `mock-context`, `mock-cli-input`)

## References

- `.claude/skills/testing.md` — decision tree and templates
- `services/workflow/entry/src/__tests__/cli/` — canonical examples
- `e2e/workflows/specs/sse/` — SSE integration tests
- `e2e/workflows/specs/ws/` — WS integration tests
