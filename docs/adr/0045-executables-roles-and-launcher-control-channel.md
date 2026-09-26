# ADR-0045: Executables, Roles and the Launcher Control Channel

**Date:** 2026-09-26
**Status:** Proposed
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-09-26
**Tags:** architecture, cli, installer, security, platform

## Context

KB Labs ships seven binaries (`kb`, `kb-create`, `kb-dev`, `kb-devkit`,
`kb-deploy`, `kb-monitor`, `kb-env`). Their roles overlap: `kb-dev` serves both
platform developers and users (the runtime renders `devservices.yaml`), and
system commands such as `auth-reset-admin` live in the TS CLI although they are
lifecycle operations. Studio must be able to request a platform update but
cannot update the platform it runs in (see ADR-0028 for the shared
human/agent frontend engine and ADR-0035 for the installer contract).

Source: `docs/architecture/target/05-executables.md`.

## Decision

**Two user-facing executables; everything else is author or ops tooling.**

| Role | Executable | Owns | Does not own |
|---|---|---|---|
| Launcher / supervisor | `kb-create` | install, update, rollback, uninstall, doctor; start/stop of the host, autostart; local control channel | business or management operations |
| Platform client | `kb` | all management and plugin commands; thin client of the host API | install, update, uninstall of the platform |
| Host | platform process (not a CLI) | management API (`config`, `project`, plugins, logs, auth), Studio, routing | lifecycle of the platform itself |
| Author tools | `kb-dev`, `kb-devkit`, `kb-env` | developing and testing the platform | user path |
| Ops | `kb-deploy`, `kb-monitor` | cloud deploy and observation | local user path |

Decisions on individual tools: `kb-env` is for e2e and test environments only;
`kb-monitor` is for deploy/ops only; `kb-create` is **not renamed now** (the
role is fixed by documentation and rules; revisit only if the confusion persists).
In user mode the host is a single process, so no six-service supervisor is
needed; the launcher starts and keeps the host. `kb-dev` remains for platform
development.

**Control channel.** The launcher exposes a narrow, versioned JSON channel on
loopback with a token, identical on macOS, Linux and Windows. Sockets and named
pipes are not introduced.

**Rules (checkable):**

1. Studio and the host never spawn platform binaries (`kb-create`, `kb-dev`, `kb`, ...) as subprocesses.
2. The only bridge from management to lifecycle is the launcher control channel: Studio -> host API (`/api/v1/platform/update-request`) -> control channel -> launcher performs the operation and restarts the host. The host does not know the launcher is written in Go; the launcher does not know Studio.
3. `kb` contains no install logic. `kb start/stop/status`-style commands are either an alias that runs the launcher as the user (a deliberate entry) or absent.
4. No shared code between Go and TS. Only versioned contracts are shared: release index, receipt, package technical manifests (ADR-0029), the launcher control protocol, the host HTTP API.
5. Author and ops tools are not part of the user install and are not called from the user path.
6. One writer per file: the installer writes only generated config, `config patch` only user config (see ADR-0047).

**Verification:** a `kb-devkit` lint forbids `child_process`/`exec` of platform
binaries in `services/*`, `plugins/*/daemon`, `studio/*`; a contract test uses
one set of JSON fixtures for the control protocol shared by Go and TS; each
binary README gets a "Role / Not responsible for" section.

## Consequences

### Positive

- Explicit ownership; Studio never needs to reach into Go tooling.
- Lifecycle operations survive host restarts because they live outside the host.
- Rules 1-5 are mechanically enforceable.

### Negative

- `kb-create` name stays misleading for a launcher/supervisor.
- A second (control) protocol to version and test on both sides.
- `reset-admin` moves out of the TS system commands into launcher recovery mode.

### Alternatives Considered

- **Rename `kb-create` to `kb-launcher`:** rejected for now, churn without gain.
- **Unix sockets / named pipes for the control channel:** rejected; loopback + token is uniform across OSes.
- **Host spawns the launcher or `kb` update logic in-process:** rejected (rules 1-3); the platform cannot update itself.

## Implementation

Migration stage 4 (launcher supervisor) in `07-migration.md`: `kb-create`
gains `start | stop | status`, autostart and the control channel; `update` and
`rollback` stop and restart the host; `kb-dev` is no longer used in user mode;
`reset-admin` moves to `doctor --recover`. The boundary lints (rule 1, rule 4
imports) are stage 0 work, PR #480. Release-side changes are tracked by #478
and are not part of this ADR.

### Open questions

- Exact `reset-admin` placement (`kb-create doctor --recover` is marked tentative in the notes).
- Whether `kb-dev` keeps rendering `devservices.yaml` for users during the transition.
- Control protocol schema and versioning policy (to be defined with stage 4).

## References

- [ADR-0020](./0020-single-external-port.md), [ADR-0028](./0028-human-and-agent-frontends-share-the-engine.md), [ADR-0029](./0029-package-manifests-are-the-technical-source-of-truth.md), [ADR-0035](./0035-breaking-cutover-for-the-new-installer-contract.md), [ADR-0041](./0041-v2-release-index-is-published-release-output.md)
- PR #479 (target architecture notes), #480 (boundary lints), #478

---

**Last Updated:** 2026-09-26
