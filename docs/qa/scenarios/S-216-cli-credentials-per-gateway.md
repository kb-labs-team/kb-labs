---
id: S-216
title: Authentication — keep separate CLI sessions for several Gateways
persona: plugin-author
area: security
priority: P1
status: planned
release: false
modes: [secured]
surfaces: [cli]
---

## Goal

A user who works with their own platform and with the official KB Labs marketplace stays signed in to both. Each saved credential is used only at the Gateway that issued it, and signing in to one never signs the user out of another.

## Prerequisites

- [ ] Two secured Gateways with different origins: the user's platform (A) and a marketplace Gateway (B).
- [ ] A user account on each Gateway.

## Steps

| # | Action | Expected |
|---|---|---|
| S-216.1 | From a user platform root connected to Gateway A, run `kb auth login --gateway-url <A> --email <email> --password-stdin`, then sign in to Hub Gateway B with the same command and B's URL | Both logins exit 0. Signing in to B adds a session and leaves A's session and identity unchanged; the credential store holds one entry per normalized Gateway origin. |
| S-216.2 | Run `kb auth status --json` | The ADR-0049 success envelope lists every saved session with its Gateway origin, email, and expiry; no token value appears. |
| S-216.3 | Run a protected command from the user platform root against A, then explicitly target B with `--gateway-url <B>` | Each request carries only the credential issued by its own Gateway origin; no request to B carries A's token, and refresh requests go only to the origin that issued the refresh token. The platform root's user identity is not replaced by Hub identity. |
| S-216.4 | Run `kb auth logout --gateway-url <B>`, then repeat the protected command against A | Logout removes only B's session; the command against A still succeeds. A command against B returns `KB_AUTH_REQUIRED` with a login hint for B's URL. |
| S-216.5 | With no session for B, explicitly target B with a protected command | The command exits non-zero with `KB_AUTH_REQUIRED` and a hint naming B's URL; it does not fall back to A's session or to a machine credential issued by another origin. |

Gateway A may be the local user platform Gateway, while B may be a separate Hub or marketplace Gateway. Each command's selected target controls credential lookup; ambient platform identity never substitutes for a different target's session. The origin-bound rule in S-203.23 already holds for one saved session; this case covers several saved sessions.
