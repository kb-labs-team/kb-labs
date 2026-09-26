# ADR-0046: Command Naming, Reserved Namespaces and Shadowing Rules

**Date:** 2026-09-26
**Status:** Proposed
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-09-26
**Tags:** architecture, cli, plugin-system, conventions

## Context

A command path is `path: 'group subgroup cmd'` (ADR-0015); one manifest owns
one namespace (ADR-0018 CLI namespace ownership). The registry
(`cli/commands/src/registry/`) currently shadows commands silently in three
independent layers: system over plugin (`registerManifest`, logged as `warn`),
first-registered package owning a top-level segment (order of discovery is not
a rule), and priority between sources for the same path (`workspace` /
`linked` / `node_modules`, logged at `info`/`debug`). A command simply
"does not exist" and the reason is visible only in debug logs. New system
groups (`kb project`, `kb plugin`, `kb adapter`, `kb config`) would silently
hide commands of plugins that already own those names, and per-project plugins
(ADR-0012, project wins) add a fourth axis that discovery order cannot resolve.

Source: `docs/architecture/target/06-command-naming.md`.

## Decision

**Form.** `kb <namespace> [<noun>] <verb> [args] [flags]`, `kb-create <verb>`.
Everything lowercase, multi-word in `kebab-case`, no abbreviations. Nouns come
from the domain model and are **singular** (`plugin`, `project`, `adapter`);
the noun is omitted when the namespace is the entity (`kb project add`).

**Closed verb vocabulary:** `list`, `show`, `add`/`remove` (register/unregister
a reference), `create`/`delete` (make/destroy the object; delete is
destructive, ADR-0025), `install`/`uninstall` (package artifacts), `enable`/`disable`,
`get`/`set`, `update`, `run`, `status`, `doctor`, `start`/`stop`. `add` is
not `install`: `add` is for things the platform knows about (a project),
`install` for things that are installed (plugin, adapter). New verbs go through review.

**Common flags:** `--json` (one JSON envelope, ADR-0028), `--project <id|path>`,
`--scope platform|project` (ADR-0012, default `project`), `--yes`, `--dry-run`.
`operationType` is one of `read | mutate | analyze | execute`; `execute`
(running a product action) is allowed as a fourth type by author decision. A
`mutate` command must support `--dry-run` and `--json` (the registry adds
`--dry-run`, a lint checks `--json`); destructive commands follow ADR-0025.

**No legacy names, no aliases.** Old names are renamed and removed
(`marketplace plugins list` -> `kb plugin list`; add `kb project *` and
`kb config get/set`; `auth-reset-admin` leaves the TS commands). The only
allowed alias is `kb start/stop/status` delegating to the launcher (ADR-0045).

**Reserved namespaces.** One source of truth, a `reserved-namespaces` file in
`cli/contracts`, from which checks and the documentation table are generated:

| Tier | Who may take it | Starting list |
|---|---|---|
| S system | core CLI only | `help version completion diag health config auth logs webhook platform project plugin adapter` (`hello`, `groups` to verify against code) |
| V top-level verbs (future `kb <verb>`) | nobody for now | `init start stop restart status update upgrade install uninstall doctor login logout open sync run debug test build` |
| F first-party | only `@kb-labs/*` packages | `commit mind agent review qa quality release workflow marketplace state gateway inbox steward policy impact devlink scaffold github clickup` |
| R reserved for planned entities | nobody | `user team tenant token secret env skill template profile registry deploy dev devkit monitor support assistant` |

S, V, R are rejected by the manifest lint and on `plugin install/enable`; F is
rejected unless the package is in `@kb-labs/*`. Names starting with `_` are
platform-reserved. Generic technical words (`server`, `daemon`, `host`,
`cache`, `key`, `service`, `job`, `task`, `tool`) are not reserved. Tier R is
reviewed every release and names without plans are freed. The error offers a
replacement (`acme-user`). Third-party plugins are advised, not required, to use
a product or organisation name.

**Shadowing rules.**

1. Reserved namespaces live in one place in code and in the docs; a plugin manifest using one fails the `kb-devkit` lint and is rejected at install/enable.
2. Shadowing is an **install/enable-time error**, not a runtime warning. Runtime shadowing is allowed only as state drift and must be visible in `kb health` and `kb plugin doctor`.
3. The namespace owner is decided by rule, not discovery order: scope (project > platform, ADR-0012), then explicit priority; a tie is an error.
4. Adding a system namespace is a breaking change; the release gate checks it against plugin namespaces in `marketplace-registry`.
5. A plugin namespace equals its short name (`@kb-labs/commit` -> `commit`), enforced by lint.
6. Any shadowing is a visible line in `kb --help` / `kb plugin doctor` ("command X hidden: reason"), not a debug log.

**Verification:** manifest lint in `kb-devkit` (verb from vocabulary, lowercase/kebab
path, `mutate` has `--dry-run`/`--json`); a help contract test that every command in
`kb --help` matches the form.

## Consequences

### Positive

- Predictable names; new commands like `kb init`/`kb start` can be added later without colliding with existing plugins.
- Silent disappearance of commands is replaced by an explicit error or a visible diagnostic.

### Negative

- Breaking renames without aliases; the plugin authors bear the cost of reserved names (same as `git`, `gh`, `kubectl`).
- The reserved list needs periodic review and a registry check on every change.

### Alternatives Considered

- **Keep discovery-order ownership and warn at runtime:** rejected; the reason stays invisible and ordering is not specified.
- **Keep old names as aliases:** rejected by the author; rename and remove.
- **Reserve generic technical words too:** rejected; rule 4 protects against conflicts without a reservation.

## Implementation

Migration stage 0 (guardrails), stage 7 (owner-by-scope and install-time
shadowing errors need the per-project model of ADR-0048). The reserved-namespace
file, manifest lint and install/enable rejection are implemented in PR #476.
Command-form and help-contract lint belong to the same guardrail track (#480
covers the boundary lints, not naming).

### Open questions

- Are `kb plugin *` and `kb adapter *` system commands (host clients) or commands of the marketplace plugin? A system group wins, and `marketplace` is a plugin today, so its CLI would have to become system. Not decided in the notes.
- `hello` and `groups` in tier S, and the whole starting list, still need to be checked against the code.
- Whether `reset-admin` is reachable as `kb-create doctor --recover` (tentative).

## References

- [ADR-0012](./0012-platform-project-scope.md), [ADR-0015](./0015-cli-path-routing.md), [ADR-0018](./0018-cli-namespace-ownership.md), [ADR-0025](./0025-destructive-action-protocol.md), [ADR-0028](./0028-human-and-agent-frontends-share-the-engine.md), [ADR-0045](./0045-executables-roles-and-launcher-control-channel.md)
- PR #476 (reserved namespaces), PR #479 (target notes)

---

**Last Updated:** 2026-09-26
