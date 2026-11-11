---
id: S-041
title: Authentication — local access and secured login
persona: team-member
area: security
priority: P0
status: active
release: true
modes: [local, secured]
surfaces: [cli, studio, api]
---

## Goal

Local projects work without login; secured gateways require a valid session.

## Prerequisites

- [ ] Local host with no saved human session, secured host, and test member account on secured host.
- [ ] A linked plugin command and a declared, provisioned webhook with a test payload and signature.

## Steps

| # | Action | Expected |
|---|---|---|
| S-041.1 | In local mode, request `GET /auth/me` without an Authorization header | HTTP 200 JSON identifies `userId: "local-admin"` (or `handle: "local-admin"`); no saved CLI session is needed. |
| S-041.2 | In secured mode, request `GET /auth/me` without an Authorization header | HTTP 401; the route does not return a user profile. |
| S-041.3 | In secured mode, log in as the configured administrator and request `GET /auth/users` with the returned access token | HTTP 200 JSON contains the users collection; the token is accepted for the protected admin operation. |
| S-041.4 | In secured mode, log in through `POST /auth/login/cli`, update the platform, restart the host, run a protected CLI command with the saved session, roll back, and run another protected CLI command with the same session | When the token contract is unchanged, the saved user session remains valid through update, rollback, and host restart, and both protected CLI commands succeed. If the host rejects a saved user token, the protected command exits unsuccessfully with `KB_AUTH_REQUIRED` and the catalogued login hint rendered with the currently configured Gateway URL resolved by the same service-address rule as plugin Gateway calls. The saved session's login URL does not override the currently configured address. The journey covers the unchanged-contract path; rejection is covered by the auth-gate unit test. Each host start authenticates its machine connection again from stored machine registration credentials, independently of the user session. |
| S-041.5 | In local mode, run `kb auth status --json` | JSON is an ADR-0049 success envelope whose `data.session.authenticated` is `false`; local access does not require a human session. |
| S-041.6 | Run `kb auth login --gateway-url <url> --email <member>` without a TTY or password input; repeat with `--password-stdin` and a password piped to stdin; then run the login in a TTY and enter the password at its prompt; finally run `kb auth status --json` and `kb auth tokens --json` | Without a TTY or password input, login exits 2 immediately with `KB_RUNTIME_INPUT_INVALID` and cause `The password prompt requires an interactive terminal.`; its hint is the runnable command `cat password.txt | kb auth login --gateway-url '<actual-url>' --email '<actual-member>' --password-stdin`, ending with `--password-stdin`. With `--password-stdin`, login stores the human session at `data.session.path` (`~/.kb/session.json`) without echoing the password. With a TTY, the password prompt accepts input without echo and login succeeds. Status is an ADR-0049 success envelope whose `data.session.authenticated` is `true` and whose session contains the member email; token listing returns an ADR-0049 success envelope. |
| S-041.7 | In secured mode, use a fresh user HOME with no CLI session, then run `kb config show --json`, `kb workflow defs list --json`, `kb marketplace plugins list --json`, `kb marketplace plugins list --scope platform --json`, and a command from a freshly linked plugin with no auth declaration | Every command that requires a user session exits non-zero before config-dependent handler setup, gateway transport resolution, its handler, or an upstream runs, and returns exactly one ADR-0049 JSON envelope with code `KB_AUTH_REQUIRED`, message `Authentication is required.`, and the catalogued login hint rendered with the configured Gateway URL. The configured URL follows the same service-address rule as plugin Gateway calls: use `KB_GATEWAY_URL` when supplied; otherwise resolve the Gateway listener from its transport address or `GATEWAY_PORT`, module default port, and network offset. This is the same URL rule used by S-041.4; no saved session URL overrides it. Invalid `GATEWAY_PORT` returns `KB_CONFIG_INVALID` instead of an auth hint. No URL placeholder appears. The platform-owned command and plugin dispatch use the same gate. Plugin metadata cannot opt out of it. |
| S-041.8 | With a fresh user HOME and no CLI session, run `kb auth login --help`, `kb auth status --json`, `kb version`, and `kb health` | Help and version output normally; auth status returns an ADR-0049 success envelope with `data.session.authenticated: false`; health returns its diagnostic result. The platform allowlist is owned by the CLI, not plugin metadata. |
| S-041.9 | In secured mode, log in as a member and run `kb auth reset-link --user-id <user-id> --json` | The request reaches the permission check only after authentication and returns `KB_AUTH_FORBIDDEN` with the checked permission `users:write`; it does not return `KB_AUTH_REQUIRED`. |
| S-041.10 | In local mode, run `kb workflow defs list --json`, `kb marketplace plugins list --json`, and a linked plugin command without a saved session | The platform gate is a no-op; commands proceed to their product checks. |
| S-041.12 | After logging in, run the platform-owned `kb config show --json`, workflow, marketplace, and linked-plugin commands from S-041.7 | Authentication passes and each command proceeds to its product checks; each returns its normal response or its own product-precondition error, never `KB_AUTH_REQUIRED`. |
| S-041.15 | In secured mode, request `GET /health/auth` first from a loopback peer using a loopback Host and no forwarding headers, then repeat with a remote peer, any forwarding header, or a non-loopback Host; compare each denied response with a request to an unknown Gateway path | A local unproxied operator request reaches the route's own guard and receives readiness output without a user session. Every other request receives the same HTTP 404 and `KB_RUNTIME_RESOURCE_NOT_FOUND` envelope as an unknown Gateway path (only `correlationId` may differ), before readiness is computed. The response contains no readiness details and is not 401/403. |
| S-041.17 | In secured mode, authenticate with `kb auth login`, register the real project with `kb project add`, confirm it with `kb project list`, and read `kb registry commands --json` to select one runnable command from each registered session-protection class. Run `kb auth logout`, then run `kb project add` anonymously and run each selected command from both the registered project and a real unregistered directory | Authenticated setup and registry selection succeed. After logout, anonymous `kb project add` and each representative command exit non-zero with exactly one ADR-0049 JSON envelope containing `KB_AUTH_REQUIRED`, its authentication-required message, and the catalogued login hint rendered with the configured Gateway URL; each representative has the same result from both directories and project registry resolution does not replace the auth response. With agent diagnostics enabled, each refusal writes one resolved-context record to stderr before the gates, and its correlation id matches the envelope's `correlationId`. The installed journey derives representatives from the CLI registry listing and fails if any registered session-protected class has no runnable command. |
| S-041.18 | In secured mode, place malformed JSON, a JSON object with missing or invalid required credential fields, and an unreadable file at `~/.kb/session.json` or `~/.kb/credentials.json`, then run a protected CLI command | Each corrupt or unreadable saved auth file exits unsuccessfully with one catalogued error envelope that identifies the file as invalid or unreadable and hints `kb auth login` to replace the saved authentication data. It never reports only `KB_AUTH_REQUIRED`, emits a raw parse/filesystem error, or prints a stack trace. A missing file remains the unauthenticated case. |

## Notes

- 2026-10-06 owner decision: a saved CLI session survives platform update, rollback, and host restart while the token contract is unchanged. A token rejected by the host yields `KB_AUTH_REQUIRED` with the login hint. The host machine connection authenticates again on each start. No legacy token compatibility path is retained.
