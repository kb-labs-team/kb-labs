# ADR-0048: Extension Model: Shared Version Store, Per-Project Pin, SDK Contract Version

**Date:** 2026-09-26
**Status:** Proposed
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-09-26
**Tags:** architecture, plugin-system, marketplace, platform

> **Risk note:** this is the riskiest area of the target architecture. It
> touches discovery, marketplace and module resolution (ADR-0012, ADR-0030).
> The decision below is the recommendation from the notes, not a validated design.

## Context

Plugins and adapters are installed either globally or in a project, and the
platform can end up as a transitive dependency of a plugin (a bug the
guardrails are meant to prevent). Three variants were considered for where
extensions live. State is of three kinds: global (`~/.kb/`), project
declaration (`<repo>/.kb/`, in git) and project runtime state
(`~/.kb/state/<projectId>/`). The visibility split of adapters into
"plugin-visible" and "platform-only" already exists (ADR-0021).

Source: `docs/architecture/target/03-domain-model.md` (variant C) and
`07-migration.md` stage 7.

## Decision

**Variant C (hybrid):** a shared per-machine version store (one copy of each
version) plus a per-project **pin** in the lock that selects the version and
enables it. Different versions of one plugin coexist across projects without
duplication (comparable to the pnpm store or VS Code extensions).

Conditions:

- A plugin declares compatibility with an **SDK contract version**; the installer checks it **before** installation and the host checks it on load.
- The platform is a **peerDependency** of a plugin, not a dependency; at runtime there is exactly one copy (lint from stage 0 plus a load-time check).
- A plugin talks to the platform only through the SDK (`IPluginAdapters`); direct `core-*` imports are forbidden by lint.
- Namespace ownership follows ADR-0046: owner by scope, shadowing is an install-time error.

The peer-dependency and no-`core-*` lints apply **only to plugins in the
author's sense**: packages with a `kb.plugin/3` manifest (cli/rest/studio
surfaces) and the plugin template. Cores, daemons, engines and registries under
`plugins/` are part of the platform and are not covered.

## Consequences

### Positive

- No version conflicts between projects and no duplicated installs.
- Incompatible plugins are rejected at install time with a clear error (`KB_PLUGIN_SDK_INCOMPATIBLE`, ADR-0049).

### Negative

- Largest change in the migration: discovery, marketplace and module resolution all change.
- A shared store needs garbage collection and integrity rules.
- SDK contract versioning becomes a public compatibility obligation.

### Alternatives Considered

- **A. Global extensions, enabled per project:** one version per machine; simple, but version conflicts between projects.
- **B. Local-only per project:** any versions, but disk duplication and "install everywhere".

## Implementation

Migration stage 7, a separate slice that does not block stages 1-6 and is done
after the project runtime (stage 3). Completion criterion: two projects on
different versions of one plugin work simultaneously; an incompatible plugin is
rejected at install. Stage 0 already covers the lints; boundary lints are PR
#480 and the reserved-namespace checks are PR #476.

### Open questions

- Format and location of the shared store and of the lock/pin file (project lock vs `.kb/lock.json`).
- Definition and numbering of the "SDK contract version" and its relation to the platform version and `kb.plugin/3`.
- Multi-tenancy inside one daemon: what is isolated between projects (caches, state, LLM keys) is listed as an open question in the notes.
- How the scope precedence of ADR-0012 combines with pins when project and platform pin different versions.
- Whether adapters use the same store and pin mechanism as plugins.

## References

- [ADR-0012](./0012-platform-project-scope.md), [ADR-0021](./0021-plugin-services-platform-boundary.md), [ADR-0030](./0030-manifest-cache-and-safe-artifact-resolution.md), [ADR-0046](./0046-command-naming-reserved-namespaces-and-shadowing.md), [ADR-0049](./0049-unified-error-envelope-and-catalog.md)
- PR #479, #480, #476

---

**Last Updated:** 2026-09-26
