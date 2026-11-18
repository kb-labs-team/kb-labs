---
id: S-187
title: Install — select and register a local project
persona: solo-developer
area: platform-core
priority: P0
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

Install the local platform, register a selected project without writing KB Labs
files into its repository, and verify the platform and project from the install
flow.

## Prerequisites

- [ ] A sealed release index and isolated platform and project roots.
- [ ] The project directory exists and is not registered yet.

## Steps

| # | Action | Expected |
|---|---|---|
| S-187.1 | Run `kb-create install --index release-index.json --platform-root "$PLATFORM_ROOT"` and enter `"$PROJECT_ROOT"` when asked for the project directory | The wizard displays the canonical project path and the install plan identifies both the platform root and project path. |
| S-187.2 | Complete the installation | The platform config exists under `$PLATFORM_ROOT/.kb/`; the project is in the platform project registry with its canonical path and derived project ID; no KB Labs files or directories are created in `$PROJECT_ROOT`. |
| S-187.3 | Inspect the `Verification` result printed by `kb-create install`, then run the two `Next` commands | The verification result reports the installed platform and registered project ID and canonical path; `kb-create status` and `kb project show` confirm those values. |
| S-187.4 | Run `kb-create install --index release-index.json --platform-root "$PLATFORM_ROOT" --project-root "$PROJECT_ROOT"` | Non-interactive install selects and registers the canonical project path without creating KB Labs files in its repository. |
| S-187.5 | Run `kb-create install --index release-index.json --platform-root "$PLATFORM_ROOT"` without selecting a project and inspect the success text | The platform installs without registering a project, and the next step gives the exact command `kb project add <path>`. |
| S-187.6 | Run `kb-create install --json --index release-index.json --platform-root "$PLATFORM_ROOT" --service-profile default --scenario custom --scenario-answers '{"access.mode":"local"}' --project-root "$PROJECT_ROOT"`, then run `kb project show "$PROJECT_ROOT" --json` | JSON install registers the canonical project path; project show exits 0 and returns that path and its derived project ID. |
| S-187.7 | Run `kb-create install --json --index release-index.json --platform-root "$PLATFORM_ROOT" --project-root "$MISSING_PROJECT_ROOT"`, where the project path does not exist | The command exits non-zero with catalogued `KB_INSTALL_INPUT_REQUIRED`, explains that the selected project directory must exist, and gives a copyable `mkdir -p` command for that path or tells the user to pass an existing project directory. No platform root, receipt, launcher shim, or project registry entry is created. |
| S-187.8 | Run `kb-create plan --json --index release-index.json --platform-root "$PLAN_ROOT" --project-root "$MISSING_PROJECT_ROOT"` and `kb-create apply --json --index release-index.json --platform-root "$APPLY_ROOT" --project-root "$MISSING_PROJECT_ROOT"`, with the selected project path absent | Both commands exit non-zero with catalogued `KB_INSTALL_INPUT_REQUIRED` and the project-root correction hint; neither creates its platform root. Request validation rejects the missing project before plan resolution or apply. |
| S-187.9 | Install and register a project, remove or move that project directory, then run `kb-create update --index release-index.json --input "$RECEIPT_REQUEST" --platform-root "$PLATFORM_ROOT"`, where `RECEIPT_REQUEST` is the request recorded in the installed receipt | Update succeeds using the recorded request without requiring the project directory to exist, because update does not register or write to the project. |
| S-187.10 | On a fresh secured install, select an existing project through a symlink alias and complete `kb-create install`; then sign in with the disclosed administrator credential and run the printed project verification command | Install sends the absolute lexical alias to the secured Gateway's authenticated project API. The receipt records that selected spelling plus the registry project ID and canonical path; the install result, success output, and `kb project show` command use the registry ID and canonical path. After explicit login, the printed command verifies that identity, and install leaves no CLI session or credentials in HOME. |
| S-187.11 | On an existing local or secured installation, run both `kb-create install` and `kb-create apply` with a non-empty `--project-root` whose absolute lexical spelling differs from both project paths recorded in the active receipt (including a symlink alias to the same directory), then inspect install state | Both commands exit non-zero with catalogued `KB_INSTALL_PROJECT_SELECTION_CHANGED` before applying anything; the message says the selection spelling differs from the recorded selection without claiming it is a different project. Each hint gives the mode-specific `kb auth login` (secured only), `kb project add`, and `kb project show` sequence so the registry can settle identity; the active receipt and installation remain unchanged. |
| S-187.12 | On an existing local or secured installation with the scenario's Marketplace package recorded, stop the host through `kb-create stop`; run `kb-create install` with the recorded selected spelling, then with its recorded canonical spelling, then with no `--project-root` | Each invocation starts the host through the supervised lifecycle when it was stopped, then reconciles the exact platform Marketplace spec, identity, version, source, enabled state, and stored integrity through the install's host-control channel. A matching installation succeeds and leaves the host running and reachable (PC-001.2). No user, CLI-session, or bootstrap credential is read; only the existing machine-owned launcher token authorizes the local host-control request. No Gateway request or project registration occurs. The receipt's selected path, project ID, canonical path, and Marketplace install record remain unchanged, and `$KB_HOME/projects.json` remains byte-identical. A non-empty project selection matches only when its absolute lexical spelling is string-equal to the receipt's selected path or canonical path; omitting the project leaves its registry entry unchanged. |
| S-187.13 | On an existing secured installation after bootstrap disclosure, remove the scenario package from the platform Marketplace inventory or change its installed identity, version, source, enabled state, or integrity metadata, then run `kb-create install` with the recorded request | The install fails closed with catalogued `KB_MARKETPLACE_STATE_DRIFT`, identifies the missing or mismatched package without exposing Marketplace store paths, and gives `kb auth login --gateway-url <gateway-url>` followed by `kb marketplace install <spec> --scope platform` as the authorized recovery. The install does not claim the receipt proves the package is present, silently reinstall the package, or alter the prior install receipt or project registry. If the supervised host-control reconciliation channel is unavailable after the standard host start path, it fails with `KB_MARKETPLACE_STATE_UNAVAILABLE` and does not fall back to receipt-only success. |

## Pass criteria

The installer owns project selection, registration, and project-aware
verification. Project registration stores identity and runtime state under the
platform's machine state; it never creates project configuration or other KB
Labs files inside the selected repository. Omitting a project leaves the
platform usable and prints the exact command needed to register one later.
S-039/S-040 cover request apply and platform install health; S-043 covers
project registry operations; S-181 covers install-time release-channel and
request sealing.
