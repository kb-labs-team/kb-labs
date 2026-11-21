# @kb-labs/project-runtime-app (`kb-project-runtime`)

One process for one project (ADR-0043, model B). It launches the platform once,
rooted at the project, and runs the project-scoped services (`rest-api`,
`workflow`, and MCP) as `runHost` modules. MCP is reachable at
`/api/v1/projects/<project-id>/mcp` through the host. Started and supervised by `kb-host`
(`ProjectRuntimeManager`); not meant to be run by hand.

```
kb-project-runtime --project-root <abs> --project-id <prj_...> --listen 127.0.0.1:PORT [--parent-pid PID]
# `kb-host` supplies the runtime guard credential on inherited FD 3. The executable is supervised; running it directly without that pipe fails closed.
```

- `--project-id` must be the id derived from the root (ADR-0044).
- Modules bind their own ephemeral loopback ports (generated transport); a
  project's hand-written `rest`/`workflow`/`mcp` transport entries are ignored.
- The `--listen` address is a guard: it requires the secret in
  `x-kb-runtime-token`, answers `GET /__runtime/health`, and forwards
  `/<module>/<path>` to the module with `/<module>` stripped.
- `--parent-pid`: the runtime exits when that process is gone.
- Not included yet: mcp, WebSocket proxying.
