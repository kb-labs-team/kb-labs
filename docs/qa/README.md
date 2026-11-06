# KB Labs — QA case catalog

`docs/qa/scenarios/*.md` is the source of truth for user-facing product cases. A case describes an observable user outcome, its prerequisites, and stable step IDs. Coverage is derived from test claims and actual run results; case files do not declare their own automation or coverage.

## Case-first workflow

1. **Catalog:** add or update the user case in `scenarios/` first. Keep `id` stable and assign each step a stable ID such as `S-010.4`. Expected outcomes must be visible and checkable.
2. **Claims:** tests declare the exact steps they verify next to the test: journey step metadata uses `cases=["S-010.4"]`; Playwright titles include `@S-020.3`; Go and Vitest tests use `// case: S-023.2` immediately above the test.
3. **Run:** execute the relevant journey or test suite and retain its result JSON. A claim alone does not prove a step passed.
4. **Coverage:** use `kb qa cases` to compare the catalog, claims, and run results. Steps report PASS, FAIL, NOT RUN, or NOT COVERED; a case passes only when every step passes. Unknown case or step IDs are errors.

A test claim records its kind (`journey`, `e2e`, or `unit`). A unit claim cannot satisfy a user-flow step in a release case. Release readiness applies to cases with `status: active` and `release: true` for each listed mode. `historical` cases are retained as design records and are not release-gated.

The decisions that bound the catalog (release scope, roles, adapter defaults, scheduling) are logged in [`docs/product/decisions.md`](../product/decisions.md). The step-by-step procedure for agents is the `intent-flow` skill.

## Frontmatter

Each case uses `id`, `title`, `persona`, `area`, `priority` (`P0`/`P1`/`P2`), `status` (`active`/`planned`/`draft`/`historical`), `release` (`true`/`false`), `modes` (`local`/`secured`), and `surfaces` (`cli`/`studio`/`api`/`agent`). Draft cases are product proposals and must set `release: false`; they remain out of coverage gates until accepted. Do not add `automation` or `e2e` fields. Historical duplicate records may include `superseded_by: S-023` to point to the active case that now owns that capability. Keep the superseding case ID valid and stable; `superseded_by` does not change the historical status.

## Cases

| ID | Title | Persona | Priority | Status | Release | Modes | Surfaces | Superseded by |
|---|---|---|---|---|---|---|---|---|
| [PC-001](PC-001-clean-install.md) | Clean V2 install from released artifacts | solo-developer | P0 | active | true | [local, secured] | [cli] | — |
| [PC-002](PC-002-first-start.md) | PC-002 — Start the V2 host and confirm services | solo-developer | P0 | active | true | [local, secured] | [cli] | — |
| [PC-003](PC-003-health-diagnostics.md) | PC-003 — Diagnose platform health | solo-developer | P0 | active | false | [local, secured] | [cli] | — |
| [PC-004](PC-004-service-restart.md) | PC-004 — Restart and recover host services | solo-developer | P1 | active | false | [local, secured] | [cli] | — |
| [PC-005](PC-005-platform-update.md) | PC-005 — Platform update superseded by S-023 | solo-developer | P0 | historical | false | [local, secured] | [cli] | S-023 |
| [PC-006](PC-006-platform-rollback.md) | PC-006 — Platform rollback superseded by S-024 | solo-developer | P1 | historical | false | [local, secured] | [cli] | S-024 |
| [PC-007](PC-007-broken-setup.md) | PC-007 — Broken setup repair superseded by S-025 | solo-developer | P1 | historical | false | [local, secured] | [cli] | S-025 |
| [S-001](S-001-solo-install-first-run.md) | Solo — install and first verified run | solo-developer | P0 | active | true | [local, secured] | [cli] | — |
| [S-002](S-002-solo-first-workflow.md) | Solo — First AI Workflow | solo-developer | P0 | active | true | [local, secured] | [cli] | — |
| [S-003](S-003-solo-plugin-author.md) | S-003 — Scaffold and link a plugin author’s local loop | plugin-author | P1 | active | true | [local, secured] | [cli] | — |
| [S-004](S-004-team-admin-cloud-deploy.md) | S-004 — Deploy a platform to a remote host | team-admin | P0 | active | false | [local, secured] | [cli] | — |
| [S-005](S-005-team-member-connect.md) | S-005 — Team member connects to a secured platform | team-member | P1 | active | false | [local, secured] | [cli] | — |
| [S-006](S-006-workflow-create-yaml.md) | S-006 — Define a workflow from YAML | solo-developer | P0 | active | false | [local, secured] | [cli] | — |
| [S-007](S-007-workflow-run-with-inputs.md) | S-007 — Run a workflow with inputs | solo-developer | P0 | active | true | [local, secured] | [cli] | — |
| [S-008](S-008-workflow-cancel.md) | S-008 — Cancel a running workflow | solo-developer | P1 | active | false | [local, secured] | [cli] | — |
| [S-009](S-009-workflow-history-logs.md) | S-009 — Inspect workflow history and logs | solo-developer | P1 | active | true | [local, secured] | [cli] | — |
| [S-010](S-010-marketplace-install-plugin.md) | Marketplace — Install plugin | solo-developer | P0 | active | true | [local, secured] | [cli] | — |
| [S-011](S-011-marketplace-enable-disable.md) | Marketplace — Enable / disable plugin | solo-developer | P1 | active | false | [local, secured] | [cli] | — |
| [S-012](S-012-marketplace-update-plugin.md) | S-012 — Update a pinned marketplace plugin | solo-developer | P1 | active | false | [local, secured] | [cli] | — |
| [S-013](S-013-plugin-full-cycle.md) | S-013 — Full plugin authoring cycle superseded by S-003 | plugin-author | P0 | historical | false | [local, secured] | [cli] | S-003 |
| [S-014](S-014-ai-commit-with-llm.md) | S-014 — Generate and apply an AI commit with a real LLM | solo-developer | P0 | active | false | [local, secured] | [cli] | — |
| [S-015](S-015-ai-code-review.md) | AI Code Review | solo-developer | P0 | active | false | [local, secured] | [cli] | — |
| [S-016](S-016-mind-rag-search.md) | Mind — RAG search | solo-developer | P1 | active | false | [local, secured] | [cli] | — |
| [S-017](S-017-gateway-own-key.md) | Configure the platform LLM adapter with the user's own key | solo-developer | P1 | active | false | [local, secured] | [cli] | — |
| [S-018](S-018-gateway-switch-provider.md) | S-018 — Switch the configured LLM provider | solo-developer | P1 | active | false | [local, secured] | [cli, studio] | — |
| [S-020](S-020-studio-first-login.md) | Studio — First login | solo-developer | P0 | active | true | [secured] | [studio] | — |
| [S-021](S-021-studio-workflow-runs.md) | S-021 — View workflow runs in Studio | solo-developer | P1 | active | true | [local, secured] | [studio] | — |
| [S-022](S-022-studio-trigger-workflow.md) | S-022 — Trigger a workflow from Studio | solo-developer | P1 | active | true | [local, secured] | [studio] | — |
| [S-023](S-023-platform-update.md) | Platform — update from a new sealed index | solo-developer | P0 | active | true | [local, secured] | [cli] | — |
| [S-024](S-024-platform-rollback.md) | Platform — rollback to a V2 snapshot | solo-developer | P1 | active | true | [local, secured] | [cli] | — |
| [S-025](S-025-diagnose-broken-setup.md) | Platform — diagnose and safely repair a V2 setup | solo-developer | P1 | active | true | [local, secured] | [cli] | — |
| [S-026](S-026-plugin-publish.md) | S-026 — Publish a plugin to the marketplace registry | plugin-author | P1 | active | false | [local, secured] | [cli] | — |
| [S-027](S-027-workflow-live-progress.md) | S-027 — Follow live workflow progress | solo-developer | P0 | active | false | [local, secured] | [cli] | — |
| [S-028](S-028-workflow-real-work.md) | S-028 — Workflow performs real work | solo-developer | P0 | active | false | [local, secured] | [cli] | — |
| [S-029](S-029-workflow-failure-visibility.md) | S-029 — Workflow failure is visible and actionable | solo-developer | P0 | active | true | [local, secured] | [cli] | — |
| [S-030](S-030-long-running-command.md) | Plugin command — Long-running, progress visible, cancellable | solo-developer | P1 | active | false | [local, secured] | [cli] | — |
| [S-031](S-031-session-expired.md) | Session expired — clear prompt to re-login | solo-developer | P1 | active | false | [local, secured] | [cli] | — |
| [S-032](S-032-workflow-webhook.md) | S-032 — Workflow sends an outbound webhook on completion (not shipped) | solo-developer | P1 | historical | false | [local, secured] | [cli] | — |
| [S-033](S-033-platform-team-composition-validated-before-ship.md) | S-033 — Validate a platform composition before shipping | platform-team | P0 | active | false | [local, secured] | [cli] | — |
| [S-034](S-034-platform-team-full-image-matrix-published.md) | Platform Team — Full Image Matrix Published on Release | platform-team | P0 | planned | false | [local, secured] | [cli] | — |
| [S-035](S-035-team-admin-try-container-five-minutes.md) | Team Admin — Try KB Labs in a Container Without a Rebuild | team-admin | P0 | planned | false | [local, secured] | [cli] | — |
| [S-036](S-036-team-admin-override-composition-without-rebuild.md) | Team Admin — Override Composition Without Rebuilding | team-admin | P0 | planned | false | [local, secured] | [cli] | — |
| [S-037](S-037-team-admin-catch-broken-composition-before-deploy.md) | S-037 — Admin composition check superseded by S-033 | team-admin | P0 | historical | false | [local, secured] | [cli] | S-033 |
| [S-038](S-038-team-admin-missing-secret-fails-fast.md) | Team Admin — Missing Secret Fails Fast Instead of Booting Broken | team-admin | P0 | planned | false | [local, secured] | [cli] | — |
| [S-039](S-039-agent-apply-json.md) | Agent — apply a V2 request as JSON | solo-developer | P0 | active | true | [local, secured] | [agent, cli] | — |
| [S-040](S-040-human-install-wizard.md) | Human — complete the V2 install wizard | solo-developer | P0 | active | true | [local, secured] | [cli] | — |
| [S-041](S-041-local-and-secured-auth.md) | Authentication — local access and secured login | team-member | P0 | active | true | [local, secured] | [cli, studio, api] | — |
| [S-042](S-042-admin-invite-reset-link.md) | Team Admin — invite a member and issue a reset link | team-admin | P1 | active | true | [secured] | [cli, api] | — |
| [S-043](S-043-project-registry-and-isolation.md) | Projects — register and isolate project extensions | solo-developer | P0 | active | true | [local, secured] | [cli, studio] | — |
| [S-044](S-044-workflow-run-history-logs-cron.md) | S-044 — Configure and inspect a workflow cron schedule | solo-developer | P1 | active | true | [local, secured] | [cli, studio, api] | — |
| [S-045](S-045-project-mcp-tools.md) | MCP — call project-scoped tools | solo-developer | P1 | active | true | [local, secured] | [agent, api] | — |
| [S-046](S-046-studio-projects-extensions-workflows.md) | Studio — Switch project context and inspect its extensions | solo-developer | P1 | active | true | [local, secured] | [studio] | — |
| [S-047](S-047-marketplace-install-pin-uninstall.md) | S-047 — Uninstall a marketplace plugin | solo-developer | P0 | active | true | [local, secured] | [cli] | — |
| [S-048](S-048-project-adapter-binding.md) | Adapters — configure platform bindings and reject project overrides | solo-developer | P1 | active | true | [local, secured] | [cli] | — |
| [S-049](S-049-plugin-author-scaffold-link-loop.md) | S-049 — Plugin author loop superseded by S-003 | plugin-author | P1 | historical | false | [local] | [cli] | S-003 |
| [S-050](S-050-platform-uninstall.md) | Platform — uninstall a V2 installation safely | solo-developer | P1 | active | true | [local, secured] | [cli, agent] | — |
| [S-051](S-051-unified-error-envelope.md) | Errors — show the unified actionable error envelope | solo-developer | P1 | active | true | [local, secured] | [cli, api, agent] | — |
| [S-100](scenarios/S-100-first-admin-bootstrap-and-recovery.md) | Secured install — bootstrap and recover the first administrator | team-admin | P0 | active | true | [secured] | [cli] | — |
| [S-101](scenarios/S-101-change-own-password.md) | Account — change your own password | team-member | P1 | active | true | [secured] | [studio, api] | — |
| [S-102](scenarios/S-102-manage-sessions-and-logout.md) | Account — inspect and revoke sessions, then log out | team-member | P1 | active | true | [secured] | [cli, studio, api] | — |
| [S-103](scenarios/S-103-api-tokens-for-agents-and-ci.md) | Authentication — create, use, and revoke a personal API token | team-member | P1 | active | true | [secured] | [cli, studio, api, agent] | — |
| [S-104](scenarios/S-104-roles-and-admin-authorization.md) | Security — admins manage tenant access and members cannot manage users | team-admin | P0 | active | true | [secured] | [api, cli] | — |
| [S-105](scenarios/S-105-revoke-or-expire-an-invite.md) | Team Admin — revoke or allow an invite to expire | team-admin | P1 | active | true | [secured] | [api] | — |
| [S-106](scenarios/S-106-studio-user-administration.md) | Studio — administer users and invites | team-admin | P0 | planned | true | [secured] | [studio] | — |
| [S-107](scenarios/S-107-studio-invite-acceptance.md) | Studio — accept an invitation and activate an account | team-member | P1 | planned | true | [secured] | [studio] | — |
| [S-108](scenarios/S-108-members-cannot-open-user-administration.md) | Studio — members cannot open user administration | team-member | P1 | planned | true | [secured] | [studio] | — |
| [S-109](scenarios/S-109-configured-oauth-login.md) | Authentication — sign in through a configured identity provider | team-member | P2 | active | false | [secured] | [studio, api] | — |
| [S-194](scenarios/S-194-platform-service-lifecycle.md) | Platform — Select and manage services across install, update, and rollback | solo-developer | P1 | planned | true | [local, secured] | [cli] | — |
| [S-195](scenarios/S-195-journey-registry-package-integrity.md) | Journey publisher — Detect stale registry tarballs | developer | P1 | planned | false | [local] | [cli] | — |
| [S-196](scenarios/S-196-multiple-projects-current-context.md) | Projects — Register repositories and select the current project | solo-developer | P0 | planned | false | [local, secured] | [cli, studio] | — |
| [S-197](scenarios/S-197-commit-and-review-across-projects.md) | Projects — Commit in one repository and review another | solo-developer | P1 | planned | false | [local, secured] | [cli] | — |
| [S-198](scenarios/S-198-workflows-and-crons-across-projects.md) | Projects — Keep workflow and cron runs within their project | solo-developer | P1 | planned | false | [local, secured] | [cli, studio, api] | — |
| [S-199](scenarios/S-199-mind-mcp-and-plugins-across-projects.md) | Projects — Isolate Mind, MCP tools, and plugin installs | solo-developer | P1 | planned | false | [local, secured] | [cli, api, agent] | — |
| [S-200](scenarios/S-200-project-adapter-and-llm-settings.md) | Projects — adapter settings are platform-owned | solo-developer | P1 | historical | false | [local, secured] | [cli, studio] | S-048 |
| [S-201](scenarios/S-201-project-analytics-and-dashboard-isolation.md) | Projects — Filter analytics, logs, and dashboard by project | solo-developer | P1 | planned | false | [local, secured] | [cli, studio, api] | — |
| [S-202](scenarios/S-202-project-unregister-and-member-access.md) | Projects — Unregister one project and preserve tenant access boundaries | team-member | P1 | planned | false | [secured] | [cli, studio, api] | — |
| [S-204](scenarios/S-204-project-plugin-settings.md) | Projects — Configure plugin settings independently | solo-developer | P1 | planned | false | [local, secured] | [cli, studio] | — |
| [S-205](scenarios/S-205-architecture-viewer.md) | Studio — browse and share an architecture package | solo-developer | P1 | planned | false | [local, secured] | [studio, api] | — |
| [S-278](scenarios/S-278-cli-terminal-color-policy.md) | CLI — terminal color follows terminal capability and overrides | developer | P2 | planned | false | [local] | [cli] | — |
| [S-279](scenarios/S-279-host-shutdown-waits-for-runtime-descendants.md) | Host shutdown waits for project runtime descendants | solo-developer | P1 | planned | false | [local] | [cli] | — |
| [S-280](scenarios/S-280-statebroker-durability.md) | StateBroker cache survives daemon and host restarts | solo-developer | P1 | planned | false | [local] | [cli] | — |
| [S-281](scenarios/S-281-sqlite-vector-input-contract.md) | SQLite vector storage rejects invalid dimensions and values | plugin-author | P1 | planned | false | [local] | [api] | — |
| [S-284](scenarios/S-284-local-candidate-registry-delivery.md) | Deliver and install immutable candidates from a local registry | platform-team | P0 | planned | false | [local] | [cli] | — |
## Manual run records

Manual observations can be recorded in `runs/YYYY-MM-DD.md` with the release/index identity, mode, case and step IDs, observed results, and linked defects. Run records are evidence; they do not replace claims or the catalog.
