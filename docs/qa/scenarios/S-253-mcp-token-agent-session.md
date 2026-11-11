---
id: S-253
title: MCP — connect an agent with a personal token
persona: team-member
area: agents
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [cli, agent, api]
---

## Goal

Give an external agent access to one project's MCP tools with a personal API token, observe its tool call, and cut off access by revoking or expiring the token.

## Prerequisites

- [ ] A running platform with project A registered and a mutating plugin command installed in that project.
- [ ] In secured mode, a signed-in user with a personal token and credentials for the external MCP client. The current MCP policy is permit-all; this case does not imply granular per-tool authorization.
- [ ] In local mode, the local project MCP endpoint is reachable on loopback.

## Steps

| # | Action | Expected |
|---|---|---|
| S-253.1 | In secured mode, run `kb auth tokens --name "project agent" --expires-in-days 1 --json` | JSON contains the one-time token and token metadata with name `project agent` and an expiry within one day. |
| S-253.2 | Configure the external MCP client to connect to project A's URL from `kb mcp config --json` and, in secured mode, send the token as a Bearer credential | The client establishes an MCP session to project A; in local mode the endpoint accepts the request without a token. |
| S-253.3 | Call `tools/list`, then call the listed mutating tool with valid arguments; inspect the durable audit record and analytics event separately | `tools/list` returns the project A tool catalog; the mutating call returns its successful MCP result and performs the operation in project A. A durable record in the platform audit collection contains the authenticated `userId` and API `tokenId`, project, tool, `success` outcome, correlation ID, and timestamp. It contains no tool arguments or secrets, and the analytics event remains separate. A catalogued tool-call failure also produces one audit record with its error code as the outcome. |
| S-253.4 | In secured mode, revoke the token with `kb auth tokens --revoke <TOKEN_ID> --json`, then call `tools/list` and `tools/call` again over the existing client connection | Revocation succeeds; both subsequent requests return HTTP 401 and do not return tools or execute the command. |
| S-253.5 | In secured mode, create a second one-day token, wait until its recorded expiry, then call `tools/list` over the existing client connection | The request returns HTTP 401 and no tool catalog is returned. |

## Authorization behavior

**D49:** MCP permissions remain a stub; the current default policy is permit-all. This case checks token authentication and audit identity only. It does not define or promise a permission model or per-tool token scopes.

## Source

Token commands are in `cli/commands/src/commands/system/auth/auth-tokens.ts`; the MCP URL command is `cli/commands/src/commands/system/mcp/config.ts`. Secured MCP authentication and tool execution are implemented in `services/mcp/app/src/server.ts`; analytics are emitted in `services/mcp/app/src/mcp/request-handler.ts` and are separate from the required audit record. The current permit-all policy is in `services/mcp/app/src/mcp/authz.ts`. Existing project isolation expectations are in S-045 and S-140.
