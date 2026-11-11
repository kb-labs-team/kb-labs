# ADR-0015: CLI Path-Based Routing (Full Trie Overhaul)

**Date:** 2026-05-15
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-05-15
**Tags:** [cli, routing, plugin-system, dx]

## Context

The current CLI routing system uses a flat `id / group / subgroup` triple to identify commands. This model has three critical defects that caused `kb clickup <subgroup> <cmd>` to silently return "Unknown command":

1. **`canonicalKey` collision** (`register.ts:388`): the collision key was computed as `${group}:${id}`, omitting `subgroup`. Commands `clickup/task/create`, `clickup/space/create`, `clickup/folder/create`, `clickup/list/create` all produced the key `clickup:create`, causing every command after the first to be silently dropped.

2. **`checkNamespaceCollision` false-positive hard error**: the function threw on `group + id` equality, not on full path equality, so even non-colliding commands with the same `id` in different subgroups were rejected.

3. **`resolveCommand` backtracking hack** (`bootstrap.ts`): command resolution tried `group:subgroup:id`, then `group:id`, then bare `id` in a loop — a fragile, non-scalable heuristic with no support for positional arguments or "did you mean?" suggestions.

Additional quality gaps:
- No fuzzy "did you mean?" on unknown command — bare "Unknown command" shown.
- No shell tab completion.
- `legacy-types.ts` defined `Command`/`CommandGroup`/`CommandRegistry` that diverged from actual usage.

**Breaking change is acceptable:** all internal plugins are migrated simultaneously; this is a pre-release refactor.

## Decision

### 1. Manifest format: single `path` field

Replace `id / group / subgroup` in `CliCommandDecl` with a single `path: string` that encodes the full command path as space-separated tokens:

```ts
interface CliCommandDecl {
  path: string       // e.g. 'clickup task search'
  describe: string
  longDescription?: string
  flags?: CliFlagDecl[]
  examples?: string[]
  handler: string    // './commands/task-search.js#default'
  permissions?: PermissionSpec
  category?: string
  aliases?: string[]
}

interface CliGroupMeta {
  path: string       // e.g. 'clickup' or 'clickup task'
  describe: string
}
```

Helper `getCommandSegments(decl): string[]` returns `decl.path.split(' ')`.

### 2. `CommandManifest` gets `segments: readonly string[]`

```ts
interface CommandManifest {
  segments: readonly string[]  // ['clickup', 'task', 'search'] — canonical key
  id: string      // last segment (derived)
  group: string   // first segment (derived)
  subgroup?: string  // second segment if depth >= 3 (derived)
  // ... rest unchanged
}
```

Canonical collision key becomes `segments.join(':')` — globally unique by construction.

### 3. `TrieRouter` replaces flat maps

A trie where each node is a path segment. Two separate tries: one for system commands (always checked first, unkillable), one for plugin commands.

```
root
 ├── [systemTrie]  auth → {login, logout}, info → {health, version}
 └── [pluginTrie]
      ├── clickup
      │    ├── workspace  ← RegisteredCommand
      │    ├── task
      │    │    ├── search  ← RegisteredCommand
      │    │    └── create  ← RegisteredCommand   ← no collision!
      │    └── space
      │         └── create  ← RegisteredCommand   ← different node!
      └── marketplace
           └── plugins → list, enable, disable
```

`resolve(tokens: string[]): RouteResult` walks the trie, consuming tokens:

```ts
type RouteResult =
  | { type: 'system-cmd';   cmd: SystemCommand;       rest: string[] }
  | { type: 'system-group'; group: SystemGroup;        rest: string[] }
  | { type: 'command';      command: RegisteredCommand; rest: string[] }
  | { type: 'group';        segments: string[];         describe?: string; childKeys: string[] }
  | { type: 'ambiguous';    input: string[];             candidates: string[] }
  | { type: 'not-found';    input: string[];             suggestions: string[] }
```

When a token is not found, the router:
1. Runs Levenshtein fuzzy match (threshold ≤ 2) against sibling keys.
2. Falls back to `findDeep()` — DFS for commands whose path *ends with* the remaining tokens (shorthand detection).

### 4. `TrieBackedRegistry` replaces `InMemoryRegistry`

New public API (full legacy removal):

```ts
class TrieBackedRegistry {
  register(cmd: SystemCommand): void
  registerGroup(group: SystemGroup): void
  registerManifest(cmd: RegisteredCommand): void
  resolve(tokens: string[]): RouteResult
  complete(tokens: string[]): string[]   // tab completion
  listCommands(): RegisteredCommand[]
  listCommandsUnder(segments: string[]): RegisteredCommand[]
  getCommandAt(segments: string[]): RegisteredCommand | null
  markPartial(v: boolean): void
  isPartial(): boolean
  getDiagnostics(): RegistryDiagnostics
}
```

Deleted: `get()`, `has()`, `getManifestCommand()`, `getWithType()`, `listGroups()`, `listProductGroups()`, `getGroupsByPrefix()`, `getCommandsByGroup()`, `list()`, `listManifests()`, `findCommand()`, `findCommandWithType()`.

### 5. Bootstrap dispatches on `RouteResult`

```ts
const result = registry.resolve(tokens)
switch (result.type) {
  case 'system-cmd':   return executeSystem(result.cmd, result.rest)
  case 'system-group': renderSystemGroupHelp(result.group); return 0
  case 'command':      return executePlugin(result.command, result.rest)
  case 'group':        renderGroupHelp(result); return 0
  case 'ambiguous':    presenter.error(`Did you mean:\n${...}`); return 1
  case 'not-found':    presenter.error(`Unknown command...`); return 1
}
```

Deleted: `resolveCommand()`, `handleEarlyExits()`, `resolveGroupDisplay()`, `renderGroupsHelp()`, `handleCommandNotFound()`.

### 6. Shell tab completion

`TrieRouter.complete(tokens)` does prefix-match on children at the resolved trie node.  
Hidden command `kb __complete <tokens...>` prints completions line-by-line.  
`kb completion bash|zsh|fish` generates shell integration scripts.

## Consequences

### Positive

- **Correctness**: same-id commands in different subgroups are structurally distinct — collision by definition impossible.
- **Scalability**: adding a 4th or 5th level requires zero routing changes.
- **DX**: "did you mean?" on every typo; tab completion out of the box.
- **Simplicity**: `resolve()` returns a typed result; bootstrap is a clean `switch` with no heuristics.
- **Full legacy removal**: no dead code, no diverged type definitions.

### Negative

- **Breaking change**: all plugins must migrate `CliCommandDecl` from `{id, group, subgroup}` to `{path}`. Scope is bounded — all plugins are in this monorepo and migrated simultaneously.
- **`getHandlerPath` / `getHandlerPermissions`** in `plugin-executor.ts` must be updated to match by `path` rather than by `id`.

### Alternatives Considered

- **Patch canonicalKey only** (`segments.join(':')`): fixes collision but leaves backtracking resolver, no did-you-mean, no tab completion. Rejected — insufficient for the scope of the release.
- **Adopt a framework (yargs, oclif)**: heavy migration, changes CLI output format, breaks existing plugin API surface. Rejected.
- **Keep `id/group/subgroup` in manifest, only fix registry**: still requires discover.ts to compute a canonical key, still a two-source-of-truth problem. Rejected.

## Implementation

Files changed (in implementation order):

| # | File | Action |
|---|------|--------|
| 1 | `docs/adr/0015-cli-path-routing.md` | NEW (this file) |
| 2 | `core/plugin-contracts/src/manifest.ts` | `path` in `CliCommandDecl`/`CliGroupMeta` |
| 3 | `cli/commands/src/registry/trie-router.ts` | NEW — `TrieRouter`, `RouteResult` |
| 4 | `cli/commands/src/registry/types.ts` | add `segments` |
| 5 | `cli/commands/src/registry/discover.ts` | derive `segments` from `cmd.path` |
| 6 | `cli/commands/src/registry/schema.ts` | validate `path` |
| 7 | `cli/commands/src/registry/service.ts` | rewrite → `TrieBackedRegistry` |
| 8 | `cli/commands/src/registry/register.ts` | fix `canonicalKey`, remove `checkNamespaceCollision` |
| 9 | `cli/commands/src/registry/legacy-types.ts` | **DELETE** |
| 10 | `cli/commands/src/registry/index.ts` | update exports |
| 11–12 | `cli/commands/src/presentation/` | update help renderers |
| 13 | `cli/commands/src/presentation/product-help.ts` | **DELETE** |
| 14–16 | `cli/commands/src/commands/system/` | update to `listCommands()` |
| 17 | `cli/commands/src/commands/system/completion.ts` | NEW — `kb completion` |
| 18 | `cli/bin/src/runtime/bootstrap.ts` | rewrite dispatch |
| 19 | `cli/bin/src/runtime/plugin-executor.ts` | lookup by `path` |
| 20 | `cli/bin/src/runtime/limits.ts` | `listCommandsUnder()` |
| 21 | `plugins/commit/src/manifest.ts` | migrate 20 commands |
| 22 | `cli/commands/src/commands/system/marketplace/index.ts` | migrate 11 commands |
| 23–25 | `cli/commands/src/registry/__tests__/` | rewrite tests |

## References

- Root cause identified in `register.ts:388` (canonicalKey omits subgroup)
- `checkNamespaceCollision` false-positive in `register.ts:178`
- `resolveCommand` backtracking in `bootstrap.ts`
- Related: ADR-0002 (plugins and extensibility), ADR-0003 (package boundaries)

---

**Last Updated:** 2026-05-15
**Next Review:** —
