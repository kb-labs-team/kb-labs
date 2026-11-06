---
id: S-140
title: MCP — Call project tools safely across projects
persona: solo-developer
area: agents
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [agent, api]
---

## Goal

An agent can invoke an authorized mutating project tool, receives structured errors for invalid calls, and cannot read or mutate another project's tools or data.

## Prerequisites

- [ ] Host running with projects A and B registered and their project-scoped MCP runtimes enabled.
- [ ] Project A has the `@kb-labs/commit` plugin installed at project scope and a prepared commit plan for a staged change in a disposable repository; project B is a separate project with a different repository and no project-scoped commit plugin.
- [ ] In secured mode, a valid bearer token is available; an invalid token can be supplied for the negative path.

## Steps

| # | Action | Expected |
|---|---|---|
| S-140.1 | On project A's MCP endpoint, call `tools/list` using `Content-Type: application/json` and `Accept: application/json, text/event-stream` | The catalog includes only tools available in project A; `kb-labs-commit__commit_plan_apply` schema reflects its manifest-declared flags and whether each is required or optional. |
| S-140.2 | Call `kb-labs-commit__commit_plan_apply` with `{}` | MCP result has `isError: false`, readable text containing the new commit SHA, and `structuredContent` with the same structured UI output model the CLI renders, including the success message, its sections, and the SHA; project A's Git history contains that commit and no remote push occurs. |
| S-140.3 | Call `tools/call` for `tool-that-does-not-exist` with `{}` | MCP returns a tool result with `isError: true`, `structuredContent` containing the full ADR-0049 error envelope, and a text line formatted `<code>: <message> — <hint>`; the hint names `tools/list` as the next discovery action. |
| S-140.4 | Call `kb-labs-commit__commit_plan_apply` with an argument whose type violates its listed `inputSchema` | MCP returns the same typed error result shape with a validation error naming the argument and expected type; no command runs and repository state is unchanged. |
| S-140.5 | Call `tools/list` and `tools/call` against project B's endpoint from the same MCP client, with project B registered and its ID supplied to the host | Project B's runtime is healthy for project B's registered ID and canonical root, does not list project A's project-scoped commit tool, and attempting that tool through B returns the typed unknown-tool result; project A's staged change is not visible through B. |
| S-140.6 | In secured mode, call project A's `tools/list` with a missing token, then with an invalid bearer token | Each request returns HTTP 401 with `{ok:false,error}` containing the ADR-0049 `KB_AUTH_REQUIRED` envelope, a correlation ID, and login hint; neither returns a project tool catalog. |
| S-140.7 | In secured mode, call project A's `tools/list` with a valid user access token obtained from the secured API | HTTP 200 returns project A's catalog; secured MCP accepts the same user token as secured REST routes. |
