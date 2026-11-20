---
id: S-031
title: Session expired — clear prompt to re-login
persona: solo-developer
area: security
priority: P1
status: active
release: false
modes: [secured]
surfaces: [cli]
---

## Goal

An expired or revoked CLI session is reported clearly and the user can sign in again.

## Prerequisites

- [ ] Secured gateway and disposable CLI profile with a saved human session.

## Steps

| # | Action | Expected |
|---|---|---|
| S-031.1 | With a saved session whose access token is expired or has at most 60 seconds remaining before automatic refresh, run `kb auth status --json` | JSON reports `session.authenticated: true`, `session.tokenExpired: true`, and the saved `session.gatewayUrl`; `session.path` identifies the canonical `~/.kb/session.json` file. |
| S-031.2 | Run `kb auth tokens` while the access token is expired and its refresh token is valid | The CLI refreshes the session and the command returns the token list without asking the user to sign in again. |
| S-031.3 | Revoke the saved session on the gateway, then run `kb auth tokens` | The command exits unsuccessfully and prints a sign-in hint containing `kb auth login`; it does not print a stack trace or silently continue as authenticated. |
| S-031.4 | Remove the saved session and run `kb auth tokens` | The command exits unsuccessfully and says to sign in with `kb auth login --gateway-url <url> --email <email>`; the password is entered at a TTY prompt or piped with `--password-stdin`. |
