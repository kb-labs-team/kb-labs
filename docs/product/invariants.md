# Product invariants

These rules describe product properties that must remain true across commands,
services, plugins, and release workflows. `Enforcement` names the checks and
cases that currently provide evidence. `Gap` records the mechanical rail still
needed where enforcement is partial or in debt. The documentation check
validates this structure and that linked paths exist inside the repository; it
does not prove that cited checks catch the listed violations. Reviewers must
verify each enforcement claim against the check implementation and its tests.
Every partial or debt entry names its concrete owning package, module, or file
in `Owner`.

## INV-01 — Internal tools never ship

**Rule:** Internal tools never ship; the release manifest defines the release and the gate checks shipped closure.

**Why:** Internal tooling changes must not silently alter the user's installed platform, while every shipped artifact must still be built and gated.

**Enforcement:** `release-build-graph` verifies selected packages and build targets, while `release-boundary` prevents gating packages from depending on internal tools; neither rejects an internal-tool package selected directly for release. [check-release-build-graph.mjs](../../scripts/checks/check-release-build-graph.mjs#L31), [release-boundary.go](../../tools/kb-devkit/internal/checks/release_boundary.go#L16), case S-277.1–S-277.3.

**Gap:** The release selection can still contain an internal-tool package without this check rejecting it.

**Owner:** [tools/kb-devkit/internal/checks/release_boundary.go](../../tools/kb-devkit/internal/checks/release_boundary.go)

**Status:** partial

## INV-02 — Plugins and adapters use public platform boundaries

**Rule:** Plugins talk to the platform only through public `@kb-labs/sdk`; adapters talk to the platform only through the public adapter contract package; the platform depends on neither plugin nor adapter packages.

**Why:** Platform, plugin, and adapter releases remain independently installable, and extensions cannot couple to private platform implementation packages.

**Enforcement:** `plugin-boundaries` is a workspace devkit custom check for plugin package membership, plugin imports/dependencies on `@kb-labs/sdk`, and platform imports/dependencies on plugin packages; [check-plugin-boundaries.mjs](../../scripts/checks/check-plugin-boundaries.mjs#L17), [devkit.yaml](../../devkit.yaml#L1100), case S-264.4. The plugin ESLint preset restricts plugin imports from platform internals; [plugin.js](../../infra/devkit/eslint/plugin.js#L41). `check-adapter-manifest` validates adapter category membership and discovery, not import direction; [check-adapter-manifest.mjs](../../scripts/checks/check-adapter-manifest.mjs#L75). Workspace dependency direction is documented in [AGENTS.md](../../AGENTS.md#L6), while internal package dependencies use `workspace:*`. No current ESLint import rule or devkit check covers adapter-to-platform imports or platform-to-adapter package dependencies. Runtime loads configured adapters through its declared dynamic loading mechanism.

**Gap:** Extend a workspace devkit custom check to parse adapter and platform/core package manifests plus source imports: adapters may use only the public adapter contract surface, and platform/core packages may not declare or statically import adapter packages. Keep configured dynamic adapter loading as the declared runtime loading mechanism; validate manifests and parsed imports across workspace categories.

**Owner:** [scripts/checks/check-plugin-boundaries.mjs](../../scripts/checks/check-plugin-boundaries.mjs)

**Status:** partial

## INV-03 — Errors and empty execution are visible

**Rule:** Every error is a catalogued diagnostic with cause and next step; a run that executed nothing is an error, never a pass.

**Why:** Operators need a trustworthy failure and a concrete recovery action, and automation must not report success when no work ran.

**Enforcement:** `error-code-catalog`, `catalogued-error-detail-types`, `test-catalog`, `remote-verify-plan.test.mjs`; [check-error-code-catalog.mjs](../../scripts/checks/check-error-code-catalog.mjs#L17), [test-catalog.mjs](../../scripts/test-catalog.mjs#L3), [remote-verify-plan.test.mjs](../../scripts/ci/remote-verify-plan.test.mjs#L120), cases S-051.1–S-051.5 and S-262.7.

**Gap:** A workspace-wide runtime rail must reject every successful-looking command or run result with zero executed work and require a catalogued cause and next command.

**Owner:** [tools/kb-runner](../../tools/kb-runner)

**Status:** partial

## INV-04 — Every fact has one owner

**Rule:** Every fact has one owner (Node version, ports, color policy, error catalog, and similar policy); copies are generated and verified with `--check`.

**Why:** Independent copies drift and make the same behavior depend on which entry point a user invokes.

**Enforcement:** `node-engine-policy`, `check-ports`, `color-policy-generated`, `error-code-catalog`; [check-node-engine-policy.mjs](../../scripts/checks/check-node-engine-policy.mjs#L43), [check-ports.mjs](../../scripts/checks/check-ports.mjs#L1), [generate-color-policy.mjs](../../tools/clikit/ui/generate-color-policy.mjs#L5), [devkit.yaml](../../devkit.yaml#L887).

**Gap:** A devkit custom check should identify duplicated policy facts across the workspace and require consumers to read the owner or generated output protected by `--check`.

**Owner:** [scripts/checks/check-ports.mjs](../../scripts/checks/check-ports.mjs)

**Status:** partial

## INV-05 — Installation is contained by its root

**Rule:** An install lives inside its root: nothing is created or changed outside it without user initiative.

**Why:** The selected root is the user's explicit boundary for installation state and cleanup.

**Enforcement:** The installer-requested launcher data directory (`$XDG_DATA_HOME/kb-create`, default `~/.local/share/kb-create`) owns machine-wide allocation records; per-root state remains inside the install root. Case S-187.4, S-187.7–S-187.8, S-222.11–S-222.13; [S-187-install-project-workspace.md](../qa/scenarios/S-187-install-project-workspace.md#L31), [S-222-secured-bootstrap-contract-failure.md](../qa/scenarios/S-222-secured-bootstrap-contract-failure.md#L39).

**Gap:** Runtime validation and install-root integration tests should prove every install, update, rollback, and recovery write resolves under the selected root, unless a separately requested destination owns it.

**Owner:** [tools/kb-create/v2/marketplace/install.go](../../tools/kb-create/v2/marketplace/install.go)

**Status:** partial

## INV-06 — Published versions are immutable

**Rule:** A published version is immutable: bump, never replace.

**Why:** Version and integrity together identify artifact bytes; replacing bytes in place breaks reproducible installs and safe updates.

**Enforcement:** Marketplace rejects a changed registry integrity for an already pinned version with catalogued `KB_MARKETPLACE_VERSION_IMMUTABLE`; [server.ts](../../services/marketplace/api/src/server.ts#L192), [packages.spec.ts](../../services/marketplace/api/src/routes/packages.spec.ts#L372), cases S-026.5 and S-220.6–S-220.9. The registry publisher also rejects replacing an existing version; [registry-service.ts](../../services/marketplace-registry/core/src/registry-service.ts#L118), [registry-service.test.ts](../../services/marketplace-registry/core/src/__tests__/registry-service.test.ts#L112).

**Status:** enforced

## INV-07 — Secured mode denies by default

**Rule:** Secured mode is deny-by-default: the platform enforces authorization at CLI, Gateway, and MCP boundaries; plugins declare no auth of their own.

**Why:** Every entry plane must apply the same platform-owned identity and authorization policy, independent of plugin metadata.

**Enforcement:** cases S-041.2–S-041.3, S-041.7–S-041.9, S-045.5–S-045.6; [S-041-local-and-secured-auth.md](../qa/scenarios/S-041-local-and-secured-auth.md#L27), [S-045-project-mcp-tools.md](../qa/scenarios/S-045-project-mcp-tools.md#L31).

**Gap:** A devkit/runtime boundary check and shared authorization integration tests should derive all registered CLI, Gateway, and MCP entry points and prove they enforce the platform auth contract without plugin-owned auth declarations.

**Owner:** [core/platform/src](../../core/platform/src)

**Status:** partial

## INV-08 — Secrets never leave protected state

**Rule:** Secrets never reach logs, output, URLs, or reports.

**Why:** Credentials are usable only while private; disclosure through diagnostics, URLs, or retained logs can grant unintended access.

**Enforcement:** cases S-028.5, S-051.5, S-193.1, S-193.3, S-222.11–S-222.13, S-270.5; [S-028-workflow-real-work.md](../qa/scenarios/S-028-workflow-real-work.md#L32), [S-270-platform-plugin-workflow-logs.md](../qa/scenarios/S-270-platform-plugin-workflow-logs.md#L26).

**Gap:** Shared logger, CLI renderer, URL builder, and report serializers need one platform redaction boundary with tests that inject sentinel secrets and prove absence from persisted and emitted outputs.

**Owner:** [core/platform/src](../../core/platform/src)

**Status:** partial

## INV-09 — Cases define behavior first

**Rule:** Case first: behavior without a case does not exist; behavior change = case change, then test, then code.

**Why:** Product expectations need a reviewable source of truth before implementation details change.

**Enforcement:** `test-catalog`, `test-pyramid`, and the case-first process in [AGENTS.md](../../AGENTS.md#L5); [test-catalog.mjs](../../scripts/test-catalog.mjs#L1), [check-test-pyramid.mjs](../../scripts/checks/check-test-pyramid.mjs#L4), case catalog in [docs/qa/scenarios](../qa/scenarios).

**Gap:** A devkit custom check should connect changed user-facing package paths to changed or explicitly claimed product cases and tests, without inferring behavior from source text.

**Owner:** [scripts/checks/check-test-pyramid.mjs](../../scripts/checks/check-test-pyramid.mjs)

**Status:** partial

## INV-10 — Green results cannot be weakened

**Rule:** Nothing is weakened to get green: no exceptions, skip lists, `--passWithNoTests`, loosened assertions; every fix removes the root cause.

**Why:** A green result is useful only when it preserves the full contract and represents executed evidence.

**Enforcement:** `devkit.yaml` has named check gates and `check-test-pyramid`; [devkit.yaml](../../devkit.yaml#L813), [check-test-pyramid.mjs](../../scripts/checks/check-test-pyramid.mjs#L41). Current package task templates still include `--passWithNoTests` at `devkit.yaml:704,732`.

**Gap:** Devkit package-task validation should reject `--passWithNoTests`, skipped or weakened assertions, and exceptions that replace derived rules; the package task template entries in [devkit.yaml](../../devkit.yaml#L704) still include `--passWithNoTests`.

**Owner:** [devkit.yaml](../../devkit.yaml)

**Status:** debt

## INV-11 — One execution mode applies across every plane

**Rule:** One declared execution mode is honored by every plane: CLI, REST, WebSocket, workflow, webhooks, and MCP.

**Why:** A command must not acquire different isolation, lifecycle, or failure behavior depending on how it was invoked.

**Enforcement:** cases S-240.2–S-240.4 and S-247.1–S-247.3; [S-240-plugin-execution-mode-matrix.md](../qa/scenarios/S-240-plugin-execution-mode-matrix.md#L29), [S-247-plugin-permission-parity-across-modes.md](../qa/scenarios/S-247-plugin-permission-parity-across-modes.md#L30).

**Gap:** Runtime integration tests should invoke a registry-derived fixture through each supported plane and prove that all report and use the same resolved execution mode.

**Owner:** [core/plugin-execution-factory](../../core/plugin-execution-factory)

**Status:** partial

## INV-12 — Mechanically check mechanical rules

**Rule:** Every rule that can be checked mechanically is checked mechanically (lint, tsc, kb-devkit, generators, external tools, release gate); a rule kept only by review is debt.

**Why:** Review is valuable for judgment, but repeatable properties should fail close to the change that violates them.

**Enforcement:** The `product-invariants-document` check validates this document's fields and linked repository paths; it does not execute the cited rails or prove that they reject violating inputs. [check-product-invariants.mjs](../../scripts/checks/check-product-invariants.mjs), [check-product-invariants.test.mjs](../../scripts/checks/check-product-invariants.test.mjs). The workspace also has `kb-devkit check` custom checks; [devkit.yaml](../../devkit.yaml#L813), and a shared Node ESLint template; [eslint.config.js](../../infra/devkit/eslint.config.js#L14).

**Gap:** No behavioral test currently runs each mechanically checkable rule's owning rail against a violating input and observes rejection. Add a behavioral absence test harness in the product-invariants check test suite that exercises the real owning checks with their real input formats; until that exists, INV-12 has no behavioral enforcement.

**Owner:** [scripts/checks/check-product-invariants.test.mjs](../../scripts/checks/check-product-invariants.test.mjs)

**Status:** debt

## INV-13 — Workflow orchestrates; plugins own their domain

**Rule:** A plugin owns its domain completely, including any internal orchestration. Workflow owns the course of the overall work and the policy between plugins. A plugin returns a typed final outcome (success, partial, cancelled, or typed failure); the project workflow plan deterministically decides what runs next, including retries, waits, and approvals. Workflow engine, runtime, contracts, and builtins stay generic and do not name plugins, vendors, or case details. Plugins do not steer the overall flow; cross-plugin composition belongs in project workflow YAML. Narrow sidecar calls through `ctx.invoke`, `ctx.workflows`, and `shell.exec` are allowed only through manifest-declared permissions, default off and visible. Plugin-specific internal domain logic must not be moved into workflow YAML.

**Why:** Plugins and workflow can evolve independently: plugins retain their domain logic while workflow provides reusable orchestration and explicit, reviewable composition policy.

**Enforcement:** `plugin-boundaries` mechanically checks plugin-to-platform dependencies/imports and platform-to-plugin dependencies/imports; [check-plugin-boundaries.mjs](../../scripts/checks/check-plugin-boundaries.mjs), [devkit.yaml](../../devkit.yaml#L1102). The product-invariants check recognizes IDs through INV-13; [check-product-invariants.mjs](../../scripts/checks/check-product-invariants.mjs#L8) and its regression test [check-product-invariants.test.mjs](../../scripts/checks/check-product-invariants.test.mjs#L37). Permissions are declared on the plugin manifest via [manifest.ts](../../core/plugin-contracts/src/manifest.ts#L699). `invoke.allow` and `shell.allow` default to empty, and `platform.workflows` defaults to `false`; the defaults are owned by [permissions.ts](../../core/plugin-contracts/src/permissions.ts#L359). Runtime denies undeclared invoke and shell use in [invoke.ts](../../core/plugin-runtime/src/api/invoke.ts#L78) and [shell.ts](../../core/plugin-runtime/src/api/shell.ts#L30). [plugin-api.test.ts](../../core/plugin-runtime/src/__tests__/plugin-api.test.ts#L566) asserts the invoke permission code and that the target is not called; [plugin-api.test.ts](../../core/plugin-runtime/src/__tests__/plugin-api.test.ts#L399) asserts the shell permission code and that no process is executed. [workflows-api.test.ts](../../core/plugin-runtime/src/__tests__/workflows-api.test.ts#L390) verifies omitted workflow permission is denied. [plugin-outcome-gate.integration.test.ts](../../services/workflow/daemon/tests/plugin-outcome-gate.integration.test.ts#L24) runs real workflow-engine runs through the daemon worker and plugin execution backend: a plugin handler returns a typed `status` of `partial` or `success`, and the workflow's `builtin:gate` routes to only the corresponding branch.

**Gap:** No structural check was found that rejects plugin IDs or case-specific references in workflow engine, runtime, contracts, or steps code. That separation remains review-enforced under definition-of-done item 10. S-295.4 (rejecting an engine reference to a plugin ID) is excluded because no mechanical rail currently exists.

**Owner:** [services/workflow](../../services/workflow), [core/plugin-contracts](../../core/plugin-contracts), and [core/plugin-runtime](../../core/plugin-runtime)

**Status:** partial
