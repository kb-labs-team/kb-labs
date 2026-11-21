---
id: S-005
title: S-005 — Team member connects to a secured platform
persona: team-member
area: security
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

A team member installs the client, signs into a secured gateway, and runs an authorized project operation using the team platform.

## Prerequisites

- [ ] Secured host, registered project, member account, and assigned project access.

## Steps

| # | Action | Expected |
|---|---|---|
| S-005.1 | Run `kb-create apply --index <sealed-index.json> --platform-root <client-root> --service-profile client --json` | Stdout is exactly one parseable JSON document with `ok: true`, the requested client root, `profile: client`, no services, and the shim owner reported under the rules in i03. `data.receipt.plan.artifacts` includes `@kb-labs/cli-bin` with the sealed source revision, tarball integrity, content scope, and dist digest. The client root has no host runtime configuration and no host is started. |
| S-005.2 | Run `<client-root>/.kb/v2/bin/kb auth login --gateway-url <url> --email <member>` and enter the password at the TTY prompt, or use `--password-stdin` for automation | The installed client CLI logs in and stores a session for the secured gateway. |
| S-005.3 | Run `<client-root>/.kb/v2/bin/kb auth status` | The installed client CLI shows the signed-in member and gateway. |
| S-005.4 | Send `GET <gateway-url>/auth/permissions` with the member session | HTTP 200 JSON `permissions` contains `projects:read` and excludes `users:read`. |
| S-005.5 | Send `GET <gateway-url>/auth/users` with the member session | HTTP 403 JSON has `error.code: "KB_AUTH_FORBIDDEN"`, `error.message: "Permission denied: users:read"`, and a non-empty `error.hint`. |
| S-005.6 | Run `kb-create status --platform-root <client-root> --json` and `kb-create doctor --platform-root <client-root> --json` | Both report `profile: client` as healthy; neither expects a host. |
| S-005.7 | While a host is running on the machine, run `kb-create apply --index <sealed-index.json> --platform-root <client-root> --service-profile client --json` | Apply succeeds and installs the client without starting or changing the running host. |
