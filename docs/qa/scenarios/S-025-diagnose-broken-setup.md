---
id: S-025
title: Platform — diagnose and safely repair a V2 setup
persona: solo-developer
area: platform-core
priority: P1
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

A broken composition is diagnosable from its receipt and installed manifests,
with one structured answer for both a person and an agent.

## Steps

| # | Action | Expected |
|---|---|---|
| S-025.1 | Remove a required non-secret config value in an isolated fixture and run `kb-create doctor --platform-root "$PLATFORM_ROOT" --json` | Doctor completes with exit 0; JSON has `ok: true`, `data.operation: "doctor"`, `data.status: "unhealthy"`, and structured `data.findings` plus `data.installation`. The matching finding names the requirement `component`, JSON-pointer `path`, `code`, and remediation `hint`. Human output shows the same finding and hint. |
| S-025.2 | Omit a required secret and run the same doctor command | Doctor completes with exit 0 and `data.status: "unhealthy"`; structured `data.findings` identifies the requirement path and says it is missing. Output, logs, and telemetry contain no secret value. Human output shows the same safe finding. |
| S-025.3 | In an isolated fixture, corrupt the active receipt's `plan.host` command and run `kb-create doctor --platform-root "$PLATFORM_ROOT" --json` | Doctor completes with exit 0; JSON has `ok: true`, `data.operation: "doctor"`, and `data.status: "unhealthy"`. `data.installation.checks` contains a failed `host-spec` check with code `KB_HOST_SPEC_INVALID` and the exact next command `kb-create apply --platform-root "$PLATFORM_ROOT"`. Doctor does not run the host or any service command. |
| S-025.4 | Run `kb-create doctor --fix --platform-root "$PLATFORM_ROOT" --json` when the fixture has a manifest-declared safe default | Exits 0; JSON has `ok: true`, `operation: "doctor-fix"`, non-empty `snapshot.id`, and `hostRestarted`; the generated value matches the manifest default. |
| S-025.5 | Run `kb-create doctor --fix --platform-root "$PLATFORM_ROOT" --json` when a safe projection repair is available and a required user or secret value is still missing | Exits 0 after the safe repair; shared clikit JSON has `ok: true`, and `data.findings` plus `data.repair.requiredInput` preserve the unresolved requirement. No value or provider is invented. If the host was running, it remains stopped until the required input is supplied, and `hostRestarted` is false. |
| S-025.6 | Cause an apply or recovery operation failure and inspect its JSON result | Exits non-zero; JSON has `ok: false`, `error.code`, `error.stage`, `error.message`, `error.hint`, and `error.details.logPath` plus `error.details.diagnosticPath`; the dossier omits secret values. |
| S-025.7 | With platform A running, run `kb-create doctor --fix --platform-root "$PLATFORM_ROOT_B" --json`, then check B with `kb-create status --platform-root "$PLATFORM_ROOT_B" --json`; check A with `kb-create status` using its install root, `current`, and the resolved physical active version path | The repair operates on B's receipt and configuration, reports `hostRestarted: false`, and reports B's host as `stopped`. Each status call for A reports it `running` with its original receipt; the operation on B never signals A's host. All three paths identify A as the same installation. |
| S-025.8 | While platform A is running from a root containing spaces, a single quote, `$`, backticks, and a newline, configure B with A's exact Gateway URL from A's active receipt, then run `kb-create start --platform-root "$PLATFORM_ROOT_B" --json` (or `kb-create apply` for B), then execute the suggested stop command. Separately replace A's recorded process identity with a missing or mismatched value while its PID and Gateway remain live; run `status`, check the recorded Gateway health URL with `curl`, inspect its listener with `lsof`, remove only the named stale record after verifying or stopping the process, then run `status` and `start` for roots requiring that port. Also model a live foreign process with A's recorded PID/start-time value at the process-identity seam. | The operation fails before changing B with `KB_HOST_ALREADY_RUNNING`. The message identifies A's platform root and host pid only after verifying the recorded process identity. The printed POSIX-shell-safe stop command preserves A's exact root when parsed by the shell and stops A when executed. A live PID with a missing, mismatched, or reused-PID identity returns `KB_HOST_PROCESS_IDENTITY_STALE`; it says the PID is running but cannot be verified as this installation's recorded host, may still be serving Gateway traffic, and that kb-create did not and will not signal it. It gives the recorded Gateway health URL, exact `curl` and `lsof` checks to identify the listener, and only then the exact shell-safe command to remove that record. After removal, a still-listening Gateway port makes both status and start fail with `KB_INSTALL_PORT_IN_USE` and its owning process; status never reports a clean stopped state or start launches a second host while that port is held. |
| S-025.9 | With live root A owning the shim and live root B installed, run `kb-create doctor --fix --platform-root "$PLATFORM_ROOT_B" --json`; then point the shim at an arbitrary existing file, a missing target, removed managed-layout path, and valid root B in turn; run doctor in both human and JSON modes for A for each target | Fixing B exits 0 and leaves A's shim unchanged. For each target that is not a validated installation, both outputs name the link and target, explain why it is foreign and untouched, then give the exact `rm -- <shim-path>` command followed by `kb-create doctor --fix --platform-root "$PLATFORM_ROOT_A"`; JSON includes the diagnosis in `KB_INSTALL_SHIM_DANGLING` with the link in `path`. For valid root B, both outputs name B's canonical installation root and say that KB Labs leaves its shim in place; switching to A requires inspecting and removing that link, then running doctor fix for A. Each diagnosis leaves the link bytes untouched. |
| S-025.10 | Replace `$XDG_DATA_HOME/kb-create/gateway-roots.json` (default `$HOME/.local/share/kb-create/gateway-roots.json`) with a schema-1, malformed, or unreadable index; run plan, apply, status, doctor, and uninstall without `--fix` for an installed root, then run the exact ordered recovery commands printed by the diagnostic | Each reader exits 1 with catalogued `KB_INSTALL_GATEWAY_INDEX_UNAVAILABLE`, names the index path and whether its schema is unsupported or its contents cannot be read, and gives the exact sequence to remove that derived index then run `kb-create doctor --fix --platform-root "$PLATFORM_ROOT"` to rebuild the affected row from its receipt. Read-only commands leave the index and installation unchanged. After running the printed commands, doctor fix succeeds and recreates a valid schema-2 index containing the root's canonical installation ID and Gateway address. |

## Pass criteria

Diagnosis compares effective configuration with the manifests of the artifacts
recorded in the active receipt. It does not rely on old marketplace lock files,
parsing terminal text, or raw stack traces.
