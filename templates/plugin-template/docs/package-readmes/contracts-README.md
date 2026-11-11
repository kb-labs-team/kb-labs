# @kb-labs/plugin-template/contracts

Public contracts subpath for the plugin: it describes guaranteed artifacts, commands, workflows, API payloads, and the version of these promises.

## Why this package exists

Every KB Labs plugin is expected to publish a clear, lightweight “promise” to the rest of the ecosystem. This package is that promise: it contains only types, manifests, and validation helpers, so other teams (CLI, Workflow Engine, Studio, REST, marketplace tooling) can rely on a single source of truth without dragging in plugin runtime code.

## Quick start checklist

1. Use the contracts source under `src/contracts` in the same plugin package.
2. Update `pluginContractsManifest` with your plugin ID and initial artifacts/commands.
3. Adjust Zod schemas in `src/schema.ts` (or add new ones) to match your payloads.
4. Bump `contractsVersion` whenever the public promise changes (SemVer rules below).
5. Run `pnpm test` and `pnpm type-check` to ensure the manifest validates.
6. Import the manifest in your CLI/REST/workflow code to avoid hard-coded IDs.

### Renaming this package

When you turn the template into your own plugin:
- Change the root package name and manifest ID to the plugin ID.
- Update `pluginContractsManifest.pluginId` in `src/contract.ts`.
- Keep imports relative within the plugin, or expose the public API through a subpath of the root package.
- Replace sample artifact IDs (`template.hello.*`) with your own naming scheme.

## What's inside

- `pluginContractsManifest` — the single source of truth for the plugin's public capabilities
- TypeScript types (`src/types`) and Zod schemas (`src/schema`) for artifacts, commands, workflows, and API payloads
- `parsePluginContracts` utility for runtime validation of the manifest and third-party contracts

## Versioning rules

- `contractsVersion` follows SemVer and is **independent** from the plugin's npm version.
- **MAJOR** — breaking changes (removing/renaming artifacts, changing payload formats).
- **MINOR** — backwards-compatible extensions (new artifacts, commands, fields).
- **PATCH** — documentation/metadata updates without altering payload formats.

## Minimal manifest example

```ts
import type { PluginContracts } from './types.js';

export const pluginContractsManifest: PluginContracts = {
  schema: 'kb.plugin.contracts/1',
  pluginId: '@kb-labs/my-plugin',
  contractsVersion: '1.0.0',
  artifacts: {
    'my-plugin.result': {
      id: 'my-plugin.result',
      kind: 'json',
      description: 'Primary output of the CLI command.'
    }
  }
  // commands/workflows/api can be added later when needed
};
```

## Optional sections

All additional sections are **optional** — include only what your plugin actually supports:

- `commands` — define CLI or workflow commands that produce/consume artifacts.
- `workflows` — describe composed workflows and their steps.
- `api` — document REST (or future surfaces) when the plugin exposes them.

If your plugin only ships a CLI command, keep `commands` + `artifacts` and omit `workflows`/`api`. The Zod schema accepts missing sections.

## Usage in plugin code

```ts
import { pluginContractsManifest } from '../src/contracts/index.js';

const helloArtifactId = pluginContractsManifest.artifacts['template.hello.greeting'].id;
```

Use the manifest to avoid magic strings, assert that required artifacts exist, or log which promises were fulfilled.

## Who relies on the contract

- **Workflow Engine** — verifies allowed steps, required artifacts, and matches produced results with the contract.
- **Studio** — builds UI and hints based on declared artifacts and commands.
- **CLI / REST / other plugins** — reuse types and schemas as the source of truth, validate inputs/outputs.
- **Marketplace & QA tooling** — checks plugin compatibility and correctness before publishing.

## Looking ahead

- Generate JSON Schema / OpenAPI from the `api` contract surface.
- Add automatic inspectors in Studio and validators for the marketplace.

