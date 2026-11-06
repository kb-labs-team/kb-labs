---
id: S-100
title: Secured install — bootstrap and recover the first administrator
persona: team-admin
area: security
priority: P0
status: active
release: false
modes: [secured]
surfaces: [cli]
---

## Goal

A secured installation has a usable first administrator, and an administrator can recover access after losing the password.

## Prerequisites

- [ ] Fresh secured V2 installation with bootstrap email and tenant configured.
- [ ] Platform root is isolated for this run.

## Steps

| # | Action | Expected |
|---|---|---|
| S-100.1 | Capture the email and generated password from a successful fresh secured install result, verify it is absent from install-owned files, sign in to the gateway with it, then run `kb auth status --json`; after the secured update and rollback, verify install-owned files again. Separately run the supplied-password apply in S-181.3, then repeat install/apply and inspect status, doctor, update, rollback, and recovery output | The successful generated-password result contains the first-administrator email and password. The password is absent from every file under the install root and from installer-declared outside-root files, including the secret store, plans, receipts, logs, version roots, snapshots, and temporary or backup files. The same remains true after update and rollback. Login succeeds, and JSON is an ADR-0049 success envelope whose `data.session.authenticated` is `true` and whose session reports the expected gateway URL and admin email. After that result is written, one atomic secret-store update records disclosure and removes both stored password entries. If output succeeds but the process stops before the atomic write, a retry may show the generated password again. For S-181.3's operator-supplied password, `firstAdmin.state` is `supplied` and the email remains available, but no result contains a password value. The supplied value and its environment-variable name are absent from stdout, stderr, plans, requests, receipts, rendered config, registry, logs, and files under the install root or `$KB_HOME`; repeat install/apply, status, doctor, update, rollback, and recovery output never prints either one. Recovery may show only its newly generated replacement once. |
| S-100.2 | Stop the host, then run `kb-create doctor --platform-root <platform-root> --recover --email admin@example.test --tenant <tenant-id> --password-stdin --yes` and pipe a new password to stdin, with no registered project for the platform root | Recovery exits with status 0 and does not echo the password; it uses the explicit platform root without resolving a project. |
| S-100.3 | Start the host and sign in with the recovered password | Login succeeds and `GET /auth/me` returns the bootstrap admin's email and tenant ID. |
| S-100.4 | Run the same recovery command while the host is running | Command exits unsuccessfully with a typed `KB_*` error and actionable hint that recovery requires a stopped host and instructs `kb-create stop`, recovery, then `kb-create start`. |
| S-100.5 | After a fresh secured install, inspect `kb-create status --platform-root <platform-root> --json`, sign in with the disclosed first-administrator credential, and inspect `/health/auth` | Status reports `bootstrapCompleted: true`; login succeeds; `/health/auth` reports `ok: true` and `activeAdmins >= 1`. |

## Bootstrap credential lifecycle

The bootstrap password is kept only until successful handoff. For a generated
password, the first successful result discloses it; for a supplied password,
the result reports its origin without disclosing the value. Requirement values
and typed bootstrap facts live in one private state record. A single atomic
replacement updates the password and its origin together, or records handoff
and erases both password names together. Operator requirement IDs address only
the values map, never the typed bootstrap facts. Version updates and rollback
share this record and cannot restore an older password copy.

For a supplied password, `firstAdmin.state` is `supplied` and the email remains
available, but the result has no password field. The supplied value and its
environment-variable name are absent from output and persisted artifacts. The
origin marker survives erasure, so retries and later commands continue to
report the supplied state without reading or printing a password.

| Bootstrap completed | Credential disclosed | Password present in store | First `install` / `apply` | Repeat `install` / `apply` | `update` | `rollback` | `start` | `doctor` | `doctor --recover --generate` |
|---|---|---|---|---|---|---|---|---|---|
| No | No | Yes | Creates the first admin and may use the credential for project registration; a successful result discloses it, then atomically records disclosure and erases it. | Not applicable before an installation exists. | Not available before an installation exists. | Not available before a snapshot exists. | May pass it only during unfinished bootstrap. | Reads lifecycle state for diagnosis; does not show the password. | Generates and shows a replacement once; it does not store it. |
| Yes | No | Yes | A successful result discloses the stored credential and atomically records disclosure plus erasure. A completed install never logs in; if receipt identity is absent, it returns the project-owner registration commands. | Never logs in. It discloses the stored credential in its successful result, then atomically records disclosure and erases it. | Keeps the shared secret state; does not log in or disclose the password. | Keeps the shared secret state; does not log in or disclose the password. | Must not pass it after completion. | Reads lifecycle state for diagnosis; does not show the password. | Generates and shows a replacement once; it does not store it. |
| Yes | Yes | No | Repeats never log in with the bootstrap password. A receipt-backed registered project remains registered; when registration identity is absent, the successful result gives `kb auth login --gateway-url <url> --email <email>`, `kb project add <path>`, and `kb project show <path>`. | Never logs in. A recorded project stays registered; absent receipt identity returns the successful registration notice and commands for the user. | Keeps the shared secret state and never restores or reads a versioned password copy. | Keeps the shared secret state and never restores or reads a snapshot password copy. | Must not pass it. | May read marker state, never the password value. | Generates and shows a replacement once; it does not store it. |

The only interrupted handoff states are: (1) completion is recorded before
disclosure, so the stored password remains the only copy and a retry shows it;
(2) the disclosure result was written but the atomic state replacement did not
commit, so retry may show it again; or (3) that replacement committed, so the
disclosure marker exists and both password entries are absent. A value and its
origin can never be committed separately. Concurrent launcher mutations of one
installation serialize against the same operation lock: a writer that read
before disclosure must either apply its unrelated change to the current record
or return a catalogued refusal; it can never restore the disclosed password.
Existing flat or sidecar stores from earlier builds are preserved and diagnosed
as unsupported; this build does not read or migrate them.

Bootstrap password replacement follows the readiness boundary in S-222.8:

| Current origin | Requested origin | Bootstrap completed | Outcome |
|---|---|---:|---|
| Generated | Supplied | No | Accept one atomic replacement; the current value is supplied and can never be disclosed. A successful result reports `firstAdmin.state="supplied"` and erases both password names. |
| Supplied | Generated | No | Accept one atomic replacement; the new generated value may be disclosed once because it is the value the installer generated. |
| Generated | Generated | No | Accept one atomic rotation; only the replacement value may be disclosed once. |
| Supplied | Supplied | No | Accept one atomic replacement; the current value remains non-disclosable. |
| Any origin | Any different value or origin | Yes | Refuse with `KB_INSTALL_BOOTSTRAP_CREDENTIAL_LOCKED`; preserve the current value and facts. Use the documented stopped-host recovery flow to change the active credential. |

If an atomic replacement fails before rename, a fresh read observes the entire
old record; if rename commits but directory sync reports an error, a fresh read
observes the entire new record. Neither outcome can pair a value with another
value's origin.
