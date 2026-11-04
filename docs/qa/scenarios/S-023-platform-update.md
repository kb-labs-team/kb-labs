---
id: S-023
title: Platform — update from a new sealed index
persona: solo-developer
area: platform-core
priority: P0
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

Update an existing verified V2 installation without resolving versions from
ambient state or losing a recoverable snapshot.

## Steps

| # | Action | Expected |
|---|---|---|
| S-023.1 | In local or secured mode, establish the existing user session when secured, then run `kb project list --json`; save the active V2 receipt, generated-config hashes, SHA-256 fingerprints of private installation-secret entries, and `kb-create status --json` | Establishes the installed N version and known-good host/config state without exposing secret values |
| S-023.2 | Build requests targeting N+1 patch, N+1 minor, and N+2 across two releases admitted by the release matrix; run `kb-create plan --index INDEX --input REQUEST --json` for each | Each plan resolves its target before mutation and lists every component as from -> to, estimated download size, added and removed packages, and the markdown `releaseNotes` field for every intervening platform release in the sealed index. |
| S-023.3 | Run `kb-create update --index INDEX --input REQUEST --json` against a running N host, using the same service ports in N and N+1 | Verifies the target offline beside N without starting another host or opening project state, then atomically switches the active version without stopping services. The result lists component versions, intervening release notes, snapshot, operation log, and `pendingRestart: { services: [{ id, runningVersion }], installedVersion, command }`. N remains intact and continues serving on its ports. |
| S-023.4 | Inspect the active receipt, generated config, `kb-create status --json`, and `kb-create doctor --json` after S-023.3; compare installation-secret fingerprints | The receipt, status, and doctor identify installed N+1. Status and doctor contain the same `pendingRestart` object as update, naming services still running N; it is absent after restart. Config and secrets remain byte-for-byte unchanged. Human output lists services and the restart command. |
| S-023.5 | Run `kb project list --json` from the existing project before restarting | The core project command exits successfully with `ok: true`; the saved CLI session still works while the old host serves requests. |
| S-023.6 | Run the same update request when the target is already installed | Succeeds with a clear “already up to date” result, does not restart services, and leaves the receipt bytes unchanged. |
| S-023.7 | Update to a sealed release whose artifacts were published minutes ago, while an unrelated dependency is subject to pnpm's configured minimum release age | The exact plan artifacts install successfully because their sealed, checksum-verified versions are trusted; pnpm's release-age policy remains in force for dependencies outside the plan |
| S-023.8 | Run `kb-create restart --platform-root ROOT --json` after S-023.3 while work is active, then retry with `--interrupt`; also exercise interactive restart | Non-interactive restart refuses with `KB_RESTART_WORK_IN_FLIGHT`; details list each `{ kind, id, owningService }`, and the hint offers to wait or rerun with `--interrupt`. Interactive restart asks whether to wait or proceed. `--interrupt` proceeds and the pending restart clears. |
| S-023.9 | Repeat a patch, minor, and N-to-N+2 update with the host stopped; then compare the REST health version, `kb --version`, `kb --version --json`, `kb --json --version`, `kb version --json`, and `kb-create status --json`; temporarily remove the active receipt, run `kb project list --json`, `kb --version`, and `kb version --json`, then restore the receipt | Update leaves services stopped; `kb-create start` starts the target. REST health `version.kbLabs`, platform, SDK, CLI `kb --version`, both global JSON flag orders (`kb --version --json` and `kb --json --version`), `kb version --json`, and the update-owned `kb-create` binary at `.kb/v2/bin/kb-create` report the unified target version. If the active receipt is unavailable, the unrelated `kb project list --json` command still succeeds, while both CLI version surfaces fail with catalogued `KB_CLI_PLATFORM_VERSION_UNAVAILABLE`; neither reports a package version. |
| S-023.10 | Update with compatible marketplace plugins, non-default adapters and secrets, optional services, two registered projects with per-project plugins/settings, SQLite analytics and workflow history, users/sessions, installation secrets, and generated config; write a database row and log entry after update but before restart | Compatible plugin commands, adapter bindings/config/secrets, enabled service states, project registrations/settings, database rows including the write made after update, users/sessions, every existing installation secret, and generated config remain available and unchanged after restart. After a secured install, update carries every installation secret still owned by the install state without any secret flags; it never asks to recreate or write those secrets. Mutable state is shared from the install root; update does not copy it between version roots. |
| S-023.11 | After restart, request Studio assets and list and invoke project MCP tools | Studio serves target-version assets without stale cached assets, and project MCP tools remain listed and runnable. |
| S-023.12 | Before switching, snapshot every entry under the install-root `state/` tree (including bytes, file mode, and modification time), record the old host's marketplace lock and config view, then inject download/install failure, checksum mismatch, and staged manifest/config/doctor verification failures one at a time; include a sealed update index that introduces a required configuration value absent from N; repeat once with a successful update before restarting | Each failed update exits with process status 1 and a typed error with actionable hint; the missing required configuration is reported with `KB_INSTALL_CONFIG_REQUIRED` before switching. The complete `state/` tree and the still-running N host's lock/config view remain byte-for-byte unchanged after every failed update and after successful activation. The staged tree is removed on failure. |
| S-023.13 | Terminate update during staging, then run `kb-create status --json`, `kb-create doctor --json`, and `kb-create update --json` | No half-installed version reports healthy. Each command detects the incomplete operation and recovers it or returns a typed diagnosis with the exact recovery command. |
| S-023.14 | Run update while a workflow run, long command, or service job is active | Update does not interrupt work or restart services. Platform-owned in-flight query returns workflow runs, jobs, and long-command registrations with `{ kind, id, owningService }`. |
| S-023.15 | With N running, update N→N+1→N+2 without restarting, inspect retained roots and measure disk use; then test both an unhealthy and healthy N+2 restart | Before restart, retain active N+2 and last-healthy/running N; prune never-started N+1. If N+2 fails health, restore and start N. If N+2 passes health, prune N at that successful health check. Keep at most two recovery snapshots, pruned after a healthy restart. `doctor` reports retained root paths and disk use for retained versions and snapshots; no byte cap applies. |
| S-023.16 | On a fresh install, inspect the install container, `current`, its `versions/` directory, and `kb-create doctor --json`; then make a directory copy of an unversioned install and run update against it | Fresh install uses a real install-root container and the relative `current` link to a version root; doctor reports the container, active platform root, `versions/`, shared state, and installer state. Update refuses the unversioned copy with catalogued `KB_INSTALL_LAYOUT_UNSUPPORTED` and an exact reinstall command, without changing its bytes. |
| S-023.17 | Create a fresh temporary parent and install root, install and update twice, restart, uninstall, and inspect the parent after each command | The user-chosen install root is a container with `versions/`, relative `current`, shared mutable state, and declared installer state. Install, both updates, restart, and uninstall create, modify, and remove no path outside that install root except a shim explicitly requested by the install request and documented per-user launcher state. Updates leave the shim path, link identity, and bytes unchanged; it continues through `current` to the active version's CLI. The parent contains only `install` before uninstall and is empty after uninstall. |
| S-023.18 | Run update with an environment mapping for a secret already stored at the identical value, then with a changed value; repeat with a newly required secret absent from the store | The identical value is a no-op. A new or changed value is refused before staging with a catalogued policy diagnostic whose next step is the working `stop` and `apply --secret-env` command. A newly required but unstored secret is refused during planning, before staging, with a catalogued diagnostic and an actionable next command. Update never writes installation secrets. |

## Pass criteria

Update is forward-only, stages sealed content inside the install root and verifies before switching, and never
restarts services. It uses the resolved V2 plan and receipt/snapshot recovery
model; preserves user data and installed contents; and reports changes,
progress, durations, and typed actionable errors in human and JSON formats.
Local and secured modes share these guarantees. The secured mode proves that
the saved administrator session remains usable across update and restart.

The post-update project check uses a core CLI command because Commit is an
optional marketplace plugin, not a platform member (see the platform-members
decision in `docs/product/decisions.md`).
