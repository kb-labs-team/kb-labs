# @kb-labs/host-app (`kb-host`)

The machine-level host: **one process, one platform launch, one external port**.
It runs the gateway, the marketplace service and the state daemon as modules of
`runHost` (`@kb-labs/shared-daemon`). Design: ADR-0043, `docs/architecture/target/04-topology.md`.

Role / not responsible for: the host serves the platform APIs. It does not
install, update or supervise itself (the launcher, `kb-create`, does). Project
services (rest, workflow) run in one **project runtime** process per active
project (`@kb-labs/project-runtime-app`), supervised by the host; mcp is not
composable yet and still runs standalone.

## What it does

- **One external port.** The gateway listens on `gateway.port + KB_NET_OFFSET`
  (default 4000). Marketplace and state bind ephemeral `127.0.0.1` ports chosen
  by the host before the platform launches.
- **Generated topology (B8).** The host builds the `serviceTransport` services
  map for the modules it runs and installs it in-process during platform
  assembly, and adds the gateway routes `/api/v1/marketplace` and
  `/api/v1/state`. Nothing has to be written in `kb.config`. Explicit
  `adapterOptions.serviceTransport.services` entries stay authoritative for the
  ids they name (an explicit entry for a host-run module also decides where it
  binds; TCP only), and `gateway.upstreams` entries win by name.
- **Health.** `GET /health` on the gateway reports each running module as an
  upstream (`upstreams.marketplace`, `upstreams.state`) and adds
  `projectRuntimes` (limit, active, per-project state; no addresses or causes).
  `/ready` requires the machine-level upstreams only; a project runtime is ready
  when it has been started lazily, so none running is a ready host.
- **Logs.** One stream; modules log under their own component
  (`gateway`, `marketplace`, `state`). One signal owner (`runHost`): SIGTERM or
  SIGINT tears modules down in reverse start order (gateway first), then the
  platform, then exits.

## Configuration

Top-level `host` section of the KB config (all optional):

```jsonc
{
  "host": {
    "modules": ["gateway", "marketplace", "state"], // default: all three
    "auth": "off", // "off" (default) | "on"
    "maxActiveProjects": 4,        // project runtimes running at once
    "projectIdleTimeoutSec": 900,  // stop a runtime idle this long; 0 = never
    "projectStartTimeoutSec": 60   // how long a runtime may take to become healthy
  }
}
```

- `modules` selects what runs. Modules not listed do not start (the gateway
  port is not opened without `gateway`).
- `auth: "off"`: no login. The gateway binds loopback only; an unset
  `gateway.host` becomes `127.0.0.1`, and a non-loopback `gateway.host` makes the
  host refuse to start with `KB_HOST_EXPOSURE_REFUSED` (unified error envelope,
  printed as JSON on stderr by `kb-host`). The check runs before any module binds.
- `auth: "on"`: the gateway runs in its secured mode (login required) and may
  bind a non-loopback address.
- A contradicting `gateway.auth.enabled` is an error, not overridden.

## Project runtimes (model B)

`GET|POST|... /api/v1/projects/{projectId}/<module>/<path>` is answered by the
runtime of that project (`<module>` is `rest` or `workflow`; the rest of the
path reaches the module unchanged). The gateway authenticates first, then asks
the host's `ProjectRuntimeManager`, which:

- checks the id against the project registry (exact `prj_...` id only; unknown
  -> `404 KB_PROJECT_UNKNOWN`),
- starts the runtime lazily on a loopback ephemeral port with a fresh secret
  (no fixed ports, no `--net-offset`); a failed start -> `502
  KB_PROJECT_RUNTIME_START_FAILED`,
- reuses it, health-checks it, restarts it with backoff after a crash,
- stops it after the idle timeout, evicts the least recently used idle runtime
  when `maxActiveProjects` is reached, and answers `503
  KB_PROJECT_RUNTIME_LIMIT` when all are busy,
- stops all runtimes (process groups) on host shutdown. A runtime also exits by
  itself when the host pid disappears.

A runtime only serves requests carrying the host's secret header. WebSocket
upgrades to project runtimes are not proxied yet.

`KB_SOCKET_PATH` must be unset: it would make every module bind the same socket.

## Running

`kb-host` is not started by `kb-dev` in user mode. The launcher starts it as one
supervised process. Illustrative launcher spec (the field names belong to the
launcher's process contract, not to this package):

```jsonc
{
  "id": "kb-host",
  "command": "<platform>/bin/kb-host",   // or: node <platform>/node_modules/@kb-labs/host-app/dist/bin.js
  "cwd": "<platform root or project root>",
  "env": { "KB_NET_OFFSET": "0" },
  "health": { "url": "http://127.0.0.1:4000/health", "timeoutMs": 30000 },
  "stop": { "signal": "SIGTERM", "graceMs": 15000 }
}
```

Exit code 1 with a JSON error envelope on stderr means startup was refused;
exit code 0 follows a clean signal shutdown.
