---
id: S-199
title: Projects — Isolate Mind, MCP tools, and plugin installs
persona: solo-developer
area: plugins
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [cli, api, agent]
---

## Goal

Use project-specific plugin installations, Mind indexes, and MCP catalogs for
several repositories on one platform.

## Prerequisites

- [ ] Projects A and B are registered and contain distinct source fixtures.
- [ ] Mind and a vector store are configured for Project A; different plugins are installed in A and B.
- [ ] Project MCP endpoints are reachable; a secured-mode user has a valid token.

## Steps

| # | Action | Expected |
|---|---|---|
| S-199.1 | Install `@kb-labs/mind` and a project-only plugin in Project A; install a different plugin in Project B; inspect each `.kb/marketplace.lock` and Studio Plugins page | A lists its installed plugins and not B's plugin; B lists its plugin and not the A-only plugins. Platform-installed plugins remain available according to the platform scope. |
| S-199.2 | From Project A, run `kb mind index update`, then `kb mind search --text "project alpha marker" --json`; run the same search from Project B | A's results cite only A paths and include its marker; B does not return A's marker or A paths. Mind index status and stored index belong to A. |
| S-199.3 | Call `tools/list` at `/api/v1/projects/<A_ID>/mcp` and `/api/v1/projects/<B_ID>/mcp` | Each project endpoint lists tools for that project's installed plugins; an A-only tool is absent from B's catalog. |
| S-199.4 | Call an A-only MCP tool through A, then call the same tool through B | A executes against A's repository and returns its result; B returns the typed unknown-tool result, and neither call reads or changes the other repository. |
| S-199.5 | Repeat the two `tools/list` calls in secured mode without a token and with a valid member token | Missing credentials return HTTP 401 without a catalog; a valid member token returns only the requested project's catalog, subject to the platform's project-access policy. |
| S-199.6 | From Project A and Project B, run `kb mcp config codex --json` | Each result contains the corresponding registered project ID and project MCP endpoint. The command requires a project because the URL and config are project-specific. |

## Dependencies

- S-016 covers Mind index and search.
- S-043 covers plugin installation isolation.
- S-045 and S-140 cover project MCP discovery, calls, and errors.
