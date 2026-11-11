---
id: S-045
title: MCP — Connect to a project tool catalog
persona: solo-developer
area: agents
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [agent, api]
---

## Goal

An agent client connects to the selected project's MCP endpoint, discovers that project's available command tools, and reads project diagnostics over Streamable HTTP.

## Prerequisites

- [ ] Host running and project registered; the project MCP runtime is enabled.
- [ ] The selected project has the `commit` plugin installed and at least one plugin command manifest.
- [ ] In secured mode, a valid gateway bearer token is available to the agent client.

## Steps

| # | Action | Expected |
|---|---|---|
| S-045.1 | Send JSON-RPC `initialize` to `POST /api/v1/projects/$PROJECT_ID/mcp` with protocol version `2025-03-26`, empty capabilities, and client info | When the project runtime is reachable, HTTP 200 returns the JSON-RPC result (as JSON or a Streamable HTTP event stream) with `result.protocolVersion: "2025-03-26"`. If the project runtime cannot be reached, HTTP 502 returns the shared `{ok:false,error}` envelope with `KB_PROJECT_RUNTIME_START_FAILED`, a correlation ID, and its catalogue-provided hint. |
| S-045.2 | Send JSON-RPC `tools/list` to the registered project endpoint in the installed runtime's default enabled service configuration (`DEFAULT_PROJECT_MODULES` in `@kb-labs/project-runtime-app`) | The result includes plugin tools declared by the selected project's plugin manifests, service tools declared by each service in the default enabled set, and `kb-labs__mcp_diagnostics`; every listed tool has an object `inputSchema`. The workflow tool `workflow__workflow_run` is present in this default enabled configuration. The catalog contains exactly the service tools generated from `DEFAULT_PROJECT_MODULES`. Calling an enabled GET service tool puts path arguments in the route and remaining arguments in the query, without a request body; a request body is sent only when the declared route has a body schema. Plugin tool names use the sanitized manifest plugin id, followed by `__` and the command path with spaces replaced by underscores. |
| S-045.3 | Call `kb-labs__mcp_diagnostics` with empty arguments | The JSON-RPC result is not marked `isError` and its text content includes `loaded cleanly`. |
| S-045.4 | In local mode, repeat initialize and `tools/list` without `Authorization` | Requests succeed through the loopback host and return the selected project's catalog from the enabled service capability set and plugin manifests. |
| S-045.5 | In secured mode, call `tools/list` first without a bearer token and then with an invalid bearer token | Both requests return HTTP 401 with `{ok:false,error}` containing the ADR-0049 `KB_AUTH_REQUIRED` envelope, a correlation ID, and login hint; neither returns a tool catalog. |
| S-045.6 | In secured mode, call `tools/list` at the registered project endpoint with a valid user access token obtained from the secured API | HTTP 200 returns the project's tool catalog; the same token accepted by secured REST routes authenticates project MCP. |
| S-045.7 | Call project MCP with a previously valid user token after its account is disabled, then after its session family is revoked | The disabled account returns HTTP 401 with `KB_AUTH_USER_INACTIVE`; the revoked session returns HTTP 401 with `KB_AUTH_SESSION_REVOKED`. The gateway does not forward stale user identity to the project runtime. |
| S-045.8 | In secured mode, call `tools/list` at the registered project endpoint with a valid machine access token obtained from the gateway | HTTP 200 returns the project's tool catalog using the machine identity resolved by the gateway. |
| S-045.10 | In secured mode, send the opaque host-registry credential issued by `/hosts/register` to the registered project MCP endpoint | HTTP 401 returns the catalogued `KB_AUTH_MCP_CREDENTIAL_REQUIRED` envelope and a correlation ID. Its catalogue hint identifies the user or machine access credential MCP accepts and explains that a host-registration credential is for host connections. |
| S-045.11 | Start the real project runtime with the workflow service manifest omitted from its enabled module set, then send JSON-RPC `tools/list` to its MCP endpoint | The served service-tool names exactly equal the generated MCP service tools for the runtime's loaded manifests, and contain no `workflow__*` tool. |
