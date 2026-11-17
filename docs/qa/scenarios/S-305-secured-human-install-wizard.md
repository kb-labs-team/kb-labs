---
id: S-305
title: Human — install a secured platform through the interactive wizard
persona: solo-developer
area: platform-core
priority: P1
status: planned
release: false
modes: [secured]
surfaces: [cli, api]
---

## Goal

A developer installs a secured platform from a terminal wizard, then signs in
to the new Gateway and verifies the administrator session.

## Prerequisites

- [ ] A sealed release index and isolated platform, Gateway, and CLI homes.

## Steps

| # | Action | Expected |
|---|---|---|
| S-305.1 | In a TTY, run `kb-create install` and choose the `explore` scenario, the `default` service profile, and secured Studio access; enter the administrator email, tenant, and password at the prompts | The wizard asks for each value in order without echoing the password, shows a plan for the selected platform and artifact count, applies it, and reports that the platform is installed and ready. The fresh platform is secured and reachable. |
| S-305.2 | Request `GET /auth/me` without a token, then log in as the administrator through the Gateway API and request `GET /auth/users` with that access token; separately run `kb auth login` and `kb auth status --json` in the installed CLI | The anonymous request returns HTTP 401 without a user profile. The authenticated API request returns HTTP 200 with the users collection. CLI login succeeds without echoing the password, and auth status reports the administrator session as authenticated. |
| S-305.3 | Run `kb-create status --platform-root "$PLATFORM_ROOT" --json` after the wizard completes | The command exits 0 and reports the newly installed secured platform as installed, running, and reachable. |
