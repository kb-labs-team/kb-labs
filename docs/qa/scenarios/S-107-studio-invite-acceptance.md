---
id: S-107
title: Studio — accept an invitation and activate an account
persona: team-member
area: studio
priority: P1
status: active
release: false
modes: [secured]
surfaces: [studio]
---

## Goal

An invited user sets a password from the activation link, enters Studio signed in, and receives a clear message when the link is unusable.

## Prerequisites

- [ ] Secured gateway and a pending member invite with a valid activation link.

## Steps

| # | Action | Expected |
|---|---|---|
| S-107.1 | Open the invite's `/activate/<token>` URL | Studio displays the invite activation screen with password and confirmation inputs. |
| S-107.2 | Enter matching passwords and submit | Studio calls `POST /api/auth/activate`, creates the account, establishes a session, and opens the signed-in Studio dashboard. |
| S-107.3 | Open the same activation URL after it has been consumed or revoked | Studio explains “This invite link is invalid or expired” and does not establish a session. |
| S-107.4 | Enter a password rejected by the server password policy and submit, then correct it and submit again | The activation API returns a catalogued `KB_RUNTIME_INPUT_INVALID` failure with the server policy reason in `message` and an actionable `hint`; Studio displays the reason, the rejected attempt does not consume the invite, and the corrected password activates the account. |
