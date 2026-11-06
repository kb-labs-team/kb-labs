---
id: S-244
title: Plugin execution — container permission boundaries and isolation
persona: team-admin
area: plugin-execution
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [cli, api]
---

## Goal

Run a fixture plugin in paranoid container mode and verify that its manifest
permissions control access and resource limits at the isolated environment
boundary.

## Prerequisites

- [ ] `platform.execution.mode` is `container`; the image starts the plugin runtime with the shared subprocess framing over attached stdio.
- [ ] A fixture manifest declares selected permissions using `PermissionSpec`; a second fixture omits those permissions.
- [ ] The fixture can attempt filesystem, network, environment, platform service, shell, and plugin invocation operations, and report configured quotas.

## Steps

| # | Action | Expected |
|---|---|---|
| S-244.1 | Run the permission-declaring fixture with `fs.read`, `fs.write`, `env.read`, `platform.*`, `shell.allow`, and `invoke.allow` grants, including `fs.read: ["src/**/*.ts"]`; then destroy the running container through its owner | **OS layer:** only grant-covered static prefixes are mounted; `src/**/*.ts` mounts `src` read-only, and write grants mount their static prefixes read-write. **Runtime shim:** path patterns are enforced inside those mounts, so a nonmatching file under `src` is denied. The container receives only environment keys selected by `env.read`. Platform, shell, and invoke permissions follow the manifest; an omitted permission remains denied. Owner teardown ends the container and the Docker label query shows it absent within five seconds. If the container remains present at the teardown deadline, the owner returns `KB_RUNTIME_CONTAINER_TEARDOWN_FAILED` with the last daemon failure as its cause. |
| S-244.2 | Run fixtures with `quotas.timeoutMs`, `memoryMb`, `cpuMs`, `maxProcesses`, and `maxOutputBytes` set, then exceed each quota | Each limit is enforced for the execution. Container memory, CPU, and process limits are enforced by the operating system. The violation returns its catalogued error, not `KB_RUNTIME_UNEXPECTED`. |
| S-244.3 | Omit all network declarations and try a raw outbound TCP socket from the fixture | **OS layer:** Docker starts with `--network none`; the outbound socket cannot connect. |
| S-244.4 | Make the Docker daemon unreachable, request a missing image, and trigger another daemon start error using the configured image; run `kb fixture execution healthy --json`. Then run container mode with no environment provider and with a provider that lacks attached `reserve()`/`start()` support. | Each Docker provisioning failure returns catalogued `KB_RUNTIME_CONTAINER_UNAVAILABLE` with a cause-specific hint containing the actual configured image and a concrete fix. Missing or incompatible providers return that same catalogued code with a provider-specific reason and marketplace install command, never a Docker-daemon diagnosis. No local backend runs, and no environment reservation or workspace attachment remains. |
| S-244.5 | Complete one successful and one failed fixture execution, then abort one active execution | The container environment and materialized workspace are released after success, failure, or abort. Closing the attached host stream delivers stdin EOF to the runtime, which exits and allows Docker `--rm` to remove the container. |
| S-244.6 | Install an unsigned plugin from the internet without overriding the execution mode | The resolved mode defaults to container for this untrusted source. This is a planned trust-tier claim, not a release claim. |
| S-244.7 | Declare fetch, TCP, or WebSocket targets in the fixture manifest and run it in container mode | No brokered network API exists yet, so container mode refuses the plugin before provisioning with `KB_RUNTIME_CONTAINER_NETWORK_UNSUPPORTED`. Its hint says container mode supports network-free plugins and names subprocess mode or the network-broker roadmap item. No local fallback runs. |
| S-244.8 | Set only `platform.execution.mode` to `container`, then run a fixture that invokes a platform service | Execution and platform RPC use the subprocess framing over attached stdio; no container Gateway secret or URL is required, and the container has no Gateway network channel. |
| S-244.9 | Run the fixture through subprocess mode and invoke a platform service while emitting a console log | Subprocess and container execution use the same length-prefixed framed stream for control, platform RPC, and logs; console output is delivered as log frames and cannot corrupt the protocol stream. |
| S-244.10 | Start a long-running fixture in container mode, then terminate the host-side Docker client process while the fixture is running | The runtime observes stdin EOF and exits; Docker removes the `--rm` container. Within the bounded cleanup interval, the unique run ID assigned to the fixture has no matching container in `docker ps -a` output. |
| S-244.11 | Set `platform.execution.mode` in turn to `in-process`, `subprocess`, `worker-pool`, and `container`; restart after each change; run the same successful fixture request through CLI, REST, REST WebSocket, workflow, Gateway webhook, and MCP | All six planes return the same fixture result for each configured mode. A plane-local backend choice that changes the result fails this claim. |

## Decision notes

- D56: “container = the ‘paranoid’ mode.” It is “slow, expensive and maximally isolated.” It is the security mechanism for marketplace trust tiers: marketplace-signed KB Labs plugins, author-signed plugins, then unsigned internet plugins; it is intended to become the default for untrusted sources. This trust-tier behavior is a planned claim, not a release claim.
- D61: “container boundaries are derived from the plugin manifest `PermissionSpec`.” `DEFAULT_PERMISSIONS` denies by default. Network is available only when the manifest declares it: undeclared means denied, with no fallback or auto-grant. A denial is catalogued and its hint names the manifest field to declare.
- D68: Container control messages use the subprocess framing over attached stdio; the container has no Gateway network channel or `GATEWAY_WS_URL`.
- D69: Docker networking is always `none`. No host-brokered network API exists yet, so container mode refuses every plugin that declares network targets with `KB_RUNTIME_CONTAINER_NETWORK_UNSUPPORTED`; subprocess mode is the current alternative.
- D70: Filesystem grants use an OS mount of the static prefix (read-only unless write is granted) and the runtime filesystem shim enforces the full pattern within that mount.

## Source

The permission contract and deny-by-default values are in
`core/plugin-contracts/src/permissions.ts`. Container provisioning is in
`core/runtime/src/loader.ts`; Docker launch options are in
`adapters/environment-docker/src/index.ts`. Known missing Docker limits are
recorded in the report findings.
