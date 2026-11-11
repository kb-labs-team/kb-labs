# ADR-0051: UX Coherence Contract

**Date:** 2026-10-01  
**Status:** Accepted  
**Deciders:** KB Labs Team  
**Tags:** architecture, cli, api, mcp, studio, ux

## Context

The platform has a shared `ErrorEnvelope` type and catalog, but its command-line
interfaces, HTTP handlers, MCP boundary, and Studio render failures and
successes differently. That makes automation surface-specific and lets raw
errors or stacks escape. S-203 defines one observable contract across every
registered surface; registry-driven coverage means newly registered commands,
routes, and tools cannot silently avoid the contract.

## Decision

### Machine result envelope

All CLI `--json` output and HTTP/MCP machine results use exactly one top-level
envelope:

```json
{ "ok": true, "data": { "id": "example" }, "meta": { "requestId": "r1" } }
```

```json
{ "ok": false, "error": { "code": "KB_RUNTIME_UNEXPECTED", "message": "The operation failed.", "hint": "Copy diagnostics and contact support.", "correlationId": "c1" } }
```

`data` contains the complete operation payload, including domain objects such
as doctor and status. `meta` is optional and surface metadata belongs there.
Failures contain the existing `ErrorEnvelope` from
`core/platform/src/error-envelope`; do not introduce parallel Go launcher
errors, `ERR_*` codes, or plugin-specific error contracts. Every surface maps
its errors into the platform `KB_*` catalog. The shared JSON Schema and valid
and invalid examples live in `core/platform/contracts/ux-result/` and are read by TS and Go
contract tests.

For HTTP, the envelope is the response body and the status code keeps its
existing protocol meaning. For MCP, failures retain MCP-native error signaling
and put the envelope in structured content, with a readable message and hint
in text content. Protocol-level JSON-RPC errors remain protocol errors. CLI
machine mode writes exactly one envelope to stdout; diagnostics never go to
stdout.

### Success and exit codes

An operation is reported successful when its boundary completes normally:
the CLI dispatcher wraps a normal handler return, including `void` or
`undefined`, as `{ "ok": true, "data": null }` when no value was returned.
The handler's return means that the command call completed; it does not certify
an external postcondition. A command's product case owns any postcondition and
must verify it separately. A typed failure or thrown error is a failed
operation, never a success-shaped payload.

All CLIs use the same exit table:

| Exit | Meaning |
|---:|---|
| 0 | The command call completed successfully. |
| 1 | Any operation failure other than invalid usage or input. |
| 2 | Invalid usage or input. |

There are no additional exit-code classes for auth, not found, or unavailable;
those are expressed by the stable error code and envelope. HTTP uses status
codes, and MCP uses protocol error signaling, while both retain the same
machine error envelope.

### Unexpected errors and human rendering

Unknown thrown values map to `KB_RUNTIME_UNEXPECTED` and receive a
`correlationId`. The stack is written only to the structured log with that
correlation ID. No stack or raw internal error is displayed in terminals,
HTTP/MCP response content, Studio UI, Studio developer details, or browser
console. User-facing output exposes the correlation ID and a copy-diagnostics
action wherever the surface supports actions.

Human CLI errors use one renderer with four parts: code, plain-language
message, why (when known), and the exact next step. The renderer accepts an
`ErrorEnvelope`; commands and plugins must not format their own machine errors.

### Enforcement boundaries

| Surface | Enforcement point |
|---|---|
| TypeScript CLI, platform and plugin commands | CLI dispatcher normalizes all outcomes before rendering and maps exit status. Plugin stdout bypass is forbidden in machine mode; plugin output must pass through the host-owned renderer/stream contract. |
| Go CLIs (`kb-create`, `kb-dev`, `kb-devkit`) | Shared Go `clikit` result renderer and exit mapper serialize the same schema and map errors to the `KB_*` catalog. `kb-create` uses the same adapter rather than a `LauncherError` protocol. |
| Gateway | Global Gateway handler normalizes failures at the server boundary; deliberate HTTP errors retain their status and become `ErrorEnvelope` failures. |
| REST | REST global error handler is the final response boundary. Route-local failures use the same envelope and cannot expose causes or stacks. |
| MCP | MCP request boundary normalizes transport/dispatch exceptions; tool results keep MCP signaling and carry the shared envelope as structured content. |
| Studio | API client and application, widget, and federated-plugin boundaries decode and render the shared envelope; no boundary renders a stack or raw error. |

Registries are the source for exhaustive contract checks. Tests enumerate
registered commands, HTTP routes, MCP tools, and Studio error boundaries; a
hand-maintained inventory is not sufficient. A new registration without a
contract outcome must fail coverage.

## Consequences

### Positive

- Automation consumes the same success and error shape regardless of CLI
  implementation language or service boundary.
- Domain payloads are unambiguously data, and failure diagnostics have one
  stable code, message, hint, and correlation path.
- New registrations inherit a mandatory contract check.

### Negative

- Each surface must adapt existing command and protocol behavior at its
  boundary, and Go must map its current diagnostics to the platform catalog.
- Registry-wide valid and failure fixtures require maintained test fixtures
  that can safely exercise every registered operation.

## References

- [S-203 — Consistent actionable outcomes across KB Labs](../qa/scenarios/S-203-ux-coherence-contract.md)
- [ADR-0049 — Unified Error Envelope and Error Catalog](./0049-unified-error-envelope-and-catalog.md)
- `core/platform/contracts/ux-result/`

