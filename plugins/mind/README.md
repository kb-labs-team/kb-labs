# @kb-labs/mind

Plugin entry point for KB Labs **Mind** (RAG) — the manifest that wires the
engine (`@kb-labs/mind/core`) to the platform: CLI commands, REST routes, and
permissions. Imports only `@kb-labs/sdk`.

## CLI

```bash
kb mind index update   [--index <id>] [--scope <glob>] [--root <path>] [--full]
kb mind search  --text "<query>" [--index <id>] [--snippet none|line|full] [--format json]
kb mind ask     --text "<question>" [--index <id>] [--mode instant|auto|thinking] [--agent]
kb mind map show --task "<task>" [--index <id>]        # task-orientation file map
kb mind sync add|update|delete <paths…> [--index <id>]
kb mind status [--index <id>]
```

Agent contract: `… --format json | grep "^{"` emits a single-line JSON response
(pointers + provenance/freshness, not payloads).

## REST

Mounted under `MIND_BASE_PATH` (`/api/v1/plugins/mind`): `POST /index`,
`/search`, `/query`, `/explore`, `/reindex`, `/sync/*`; `GET /status`, `/health`.

## Tests

- Unit/integration — `pnpm --filter @kb-labs/mind test`
- CLI handler (CLI↔REST parity) — `pnpm --filter @kb-labs/mind test:cli`
