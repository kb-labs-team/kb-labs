# @kb-labs/core-project-registry

Machine-level registry of KB Labs projects (`<KB_HOME>/projects.json`, default `~/.kb`), deterministic `projectId`
derivation and per-project runtime state paths. Design: [ADR-0044](../../docs/adr/0044-project-registry-and-project-id.md).

```ts
import { createProjectRegistry } from '@kb-labs/core-project-registry';

const registry = createProjectRegistry(); // honors KB_HOME
const { project } = await registry.add('/work/app');
await registry.list();
await registry.remove(project.id); // unregisters only; files are never deleted
```

Failures are `ProjectRegistryError` with a stable `KB_PROJECT_*` catalog code and secret-free `details`.
Types live in `@kb-labs/core-contracts`.
