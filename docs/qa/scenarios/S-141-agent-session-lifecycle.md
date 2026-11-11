---
id: S-141
title: Agent — Create and inspect a project session
persona: solo-developer
area: agents
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [agent, api]
---

## Goal

A user creates an agent session for a project, retrieves its turns and plan, and receives a clear error when requesting an unknown session.

## Prerequisites

- [ ] Agent plugin installed in the selected project and its REST routes enabled.
- [ ] Host running; in secured mode, an authenticated user has access to the selected project.
- [ ] An agent ID defined by the Agents plugin, such as `orchestrator`.

## Steps

| # | Action | Expected |
|---|---|---|
| S-141.1 | Send `POST /api/v1/projects/<project-id>/rest/plugins/agents/sessions` with JSON `{"agentId":"<agent-id>","task":"Summarize the project"}` | HTTP success response contains a session with a non-empty ID, the supplied agent ID and task, and an initial status. |
| S-141.2 | Send `GET /api/v1/projects/<project-id>/rest/plugins/agents/sessions` | Response contains the new session ID and a total count that includes it. |
| S-141.3 | Send `GET /api/v1/projects/<project-id>/rest/plugins/agents/sessions/<session-id>` , `GET /api/v1/projects/<project-id>/rest/plugins/agents/sessions/<session-id>/turns`, and `GET /api/v1/projects/<project-id>/rest/plugins/agents/sessions/<session-id>/plan` | Session detail and turn history identify the same session ID; an empty turn history is represented as an empty collection. |
| S-141.4 | Send `GET /api/v1/projects/<project-id>/rest/plugins/agents/sessions/session-does-not-exist` | HTTP 404 returns a typed `KB_RUNTIME_RESOURCE_NOT_FOUND` envelope whose `details.sessionId` is `session-does-not-exist`; no stack trace is returned. |
| S-141.5 | Send `POST /api/v1/projects/<project-id>/rest/plugins/agents/sessions` with JSON `{"agentId":"agent-does-not-exist","task":"Summarize the project"}` | HTTP 404 returns a typed `KB_AGENT_NOT_FOUND` envelope whose `details.agentId` is `agent-does-not-exist`; no session is created. |
| S-141.6 | Send `GET /api/v1/projects/<project-id>/rest/plugins/agents/unknown-route` while Agents is installed in the project | HTTP 404 returns `KB_RUNTIME_RESOURCE_NOT_FOUND`; the message names the Agents plugin and requested route, and the hint gives `kb marketplace plugins doctor --scope project` as the next command. |
| S-141.7 | Invoke a project Agents REST handler that throws an unexpected error, then query `kb logs query --correlation-id <response-correlationId> --json` | The HTTP error envelope contains `KB_RUNTIME_UNEXPECTED` and a correlation ID. The query returns the persisted structured handler cause and stack for that same ID. |
