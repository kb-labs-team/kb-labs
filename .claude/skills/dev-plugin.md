---
name: dev-plugin
description: Plugin development conventions and patterns for KB Labs
globs:
  - "plugins/**"
---

# Plugin Development

## Duck Typing Rule

A package group is a **plugin** if it:
- Uses `@kb-labs/sdk`
- Registers CLI commands and/or Studio pages
- Has a plugin manifest

Whether it runs an HTTP daemon is an implementation detail, not a boundary.

## Standard Plugin Structure

### Minimal plugin (3 packages)

```
plugins/your-plugin/
├── entry/                  # @kb-labs/your-plugin-entry — thin wiring
│   ├── src/
│   │   ├── index.ts        # registerPlugin() + manifest export
│   │   ├── cli/            # CLI commands (folders, not a separate package)
│   │   │   └── my-command.ts
│   │   └── studio/         # Studio pages (folders, not a separate package)
│   │       └── my-page.tsx
│   ├── package.json
│   └── tsup.config.ts
├── contracts/              # @kb-labs/your-plugin-contracts — types only
│   ├── src/index.ts
│   └── package.json
├── core/                   # @kb-labs/your-plugin-core — business logic
│   ├── src/index.ts
│   └── package.json
└── docs/
    └── adr/
```

### Plugin with daemon (+ HTTP service)

```
plugins/workflow/
├── entry/                  # manifest + CLI + Studio wiring
├── contracts/              # types
├── core/                   # business logic
├── daemon/                 # @kb-labs/workflow-daemon — HTTP server (:7778)
│   ├── src/bootstrap.ts
│   └── package.json
└── ...                     # free-form: engine/, artifacts/, builtins/
```

### Complex plugin (free-form extras)

```
plugins/mind/
├── entry/                  # thin wiring
├── contracts/              # types
├── core/                   # base logic
├── engine/                 # @kb-labs/mind-engine (free-form)
├── embeddings/             # @kb-labs/mind-embeddings (free-form)
├── vector-store/           # @kb-labs/mind-vector-store (free-form)
└── docs/
```

## Package Roles

### entry/ — Plugin Entry Point

**One package, one import for the platform.**

```ts
// Platform does: import { plugin } from '@kb-labs/mind-entry'
export const plugin = definePlugin({
  manifest: { ... },
  commands: [ragQueryCommand, indexCommand],
  pages: [mindDashboardPage],
});
```

Entry is **thin** — no business logic. CLI commands inside `src/cli/` call core.
Studio pages inside `src/studio/` call core or contracts.

- Contains: manifest, registerPlugin(), CLI commands, Studio pages
- Depends on: contracts + core + sdk
- Does NOT contain: business logic, algorithms, heavy deps

### contracts/ — Types Only

- Pure type definitions, interfaces, schemas
- **Zero runtime dependencies**
- Every other package in the plugin depends on this
- Safe to import from anywhere (no side effects)

### core/ — Business Logic

- Implementation, algorithms, data processing
- Depends on: contracts + sdk
- Does NOT depend on: entry, cli, studio, daemon

### daemon/ — HTTP Service (optional)

- Long-running process with a port
- Depends on: core + contracts + gateway-auth + gateway-core
- Declares `"requires": ["gateway"]` in manifest
- Gateway handles auth/routing — daemon just registers routes

## Dependency Rules Within a Plugin

```
contracts/  ← zero deps (types only)
core/       ← contracts + sdk
entry/      ← contracts + core + sdk
daemon/     ← contracts + core + gateway
free-form/  ← contracts + core (as needed)
```

Never: core → entry, core → daemon, contracts → anything internal

## After Building

```bash
```

Always run this after building — CLI caches plugin discovery.

## Error Handling

Every entry package gets `src/utils/error.ts` with two helpers.

### `handleError(ctx, err, isJson?)` — API / internal errors

Wrap every API call in `try/catch` and call this in the catch block.

```ts
try {
  const result = await someApiCall();
  // ...
} catch (err) {
  handleError(ctx, err, input.flags.json);
  return { exitCode: 1, result: null };
}
```

In JSON mode outputs `{ ok: false, error: { code, message, hint?, status? } }`.
In CLI mode calls `ctx.ui?.error?.(message, { hint, cause })` — a rich formatted box.

Extend it for your plugin's API error class:

```ts
import { YourApiError } from '@kb-labs/your-plugin-core';

if (err instanceof YourApiError) {
  const hint = err.status === 401 ? 'Check API key' : err.status === 404 ? 'Resource not found' : 'API error';
  if (isJson) {
    ctx.ui?.json?.({ ok: false, error: { code: err.code, message: err.message, status: err.status, hint } });
  } else {
    ctx.ui?.error?.(err.message, { hint, cause: `API ${err.status} (${err.code})` });
  }
  return;
}
```

Env var errors are auto-detected by matching `YOUR_ENV_VAR` in the message.

### `validationError(ctx, message, hint?, isJson?)` — missing args/flags

Call **before** the try/catch, for synchronous validation.

```ts
if (!id) {
  validationError(ctx, 'id is required', 'Usage: kb plugin cmd <id>', input.flags.json);
  return { exitCode: 1, result: null };
}
```

Always add a `hint` — usage string or "Use `kb plugin X` to find IDs".

### JSON error shape

All errors in `--json` mode follow this shape so agents can check `ok` first:

```json
{ "ok": false, "error": { "code": "INVALID_ARGS",    "message": "...", "hint": "..." } }
{ "ok": false, "error": { "code": "ENV_MISSING",     "message": "...", "hint": "..." } }
{ "ok": false, "error": { "code": "API_CODE",        "message": "...", "status": 401, "hint": "..." } }
{ "ok": false, "error": { "code": "INTERNAL_ERROR",  "message": "..." } }
```

Delete operations also wrap success: `{ "ok": true, "deleted": true, "entityId": "..." }`.

## Migration Note

Existing plugins may still have a separate `cli/` package instead of `entry/`.
When refactoring, merge `cli/` into `entry/src/cli/` and delete the old package.
Do this one plugin at a time — don't batch.
