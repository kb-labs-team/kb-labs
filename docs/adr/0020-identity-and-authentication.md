# ADR-0020: Identity & authentication for Studio cloud

**Date:** 2026-05-26
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-05-26
**Reviewers:** —
**Tags:** architecture, security, auth, identity

## Context

Studio is moving to cloud (`{tenant}.kblabs.ru`) and is currently open to
the world — the existing login form is a mock that writes a role string to
`localStorage` with no route guards. Gateway already issues HS256 JWTs and
hosts `/auth/register|token|refresh|me`, but only for **machine clients**
through a **publicly exposed** `/auth/register`.

We need to close Studio for the cloud move and at the same time lay down
the **single right seam** for future identity providers (Google, Okta,
LDAP, SAML) without sprinkling abstractions across the auth stack.

Authorization (RBAC + ReBAC) is intentionally a separate epic
([ClickUp 869def338](https://app.clickup.com/t/869def338)). This ADR
covers identity and authentication only.

### Alternatives considered

1. **Bake roles into JWT (`role: 'admin'`).** Simple but couples token
   format to authorization model. Every authz change becomes a breaking
   token change. Rejected.
2. **One adapter per concern (UserStore, TokenIssuer, Membership, PDP).**
   Speculative — only one implementation of each on day 1. Rejected, see
   "minimum viable adapter surface" below.
3. **External IdP as source of truth (no local user record).** Removes
   our admin UI surface and forces a coupling to IdP-specific lifecycle.
   Doesn't fit "self-hosted on-prem" customers. Rejected.
4. **Cross-subdomain cookies (`studio.X.kblabs.ru` + `api.X.kblabs.ru`).**
   Forces `SameSite=Lax` with `Domain=.kblabs.ru`, enabling cookie leakage
   between tenants. Rejected in favour of same-origin per tenant.
5. **Account lockout after N failed logins.** NIST 800-63B explicitly
   discourages this — lockout itself becomes a DoS vector. Rejected, see
   `## Implementation → out of scope`.

## Decision

### Architectural principles (binding)

1. **External IdP is a door, not the source of truth.** An identity
   provider only confirms "this is `alice@acme.com`". We always keep our
   own `User` record, mint our own session JWT, and own revocation,
   rotation, and agent-token issuance.

2. **One public seam: `IIdentityProvider`.** UserStore, TokenIssuer,
   Membership, PDP — internal to the gateway. Anything else is a fork, not
   an adapter.

3. **Tokens carry identity, not permissions.** Access JWT payload:
   `{ sub, tenantId, type: 'user' | 'machine', iat, exp, jti, fam }`.
   No `role`, `scopes`, or `capabilities` ever land in a token.

4. **PDP interface exists from day one** as a stub. Handlers call
   `policy.check(...)` immediately; real RBAC + ReBAC ([ClickUp
   869def338](https://app.clickup.com/t/869def338)) replaces the
   implementation, not the contract. ABAC is explicitly deferred.

5. **Subject ≠ identity in the token.** `Subject = { user, memberships,
   attributes }` is resolved on every request (cached). Changing a user's
   group takes effect immediately, not on token expiry.

6. **Admins manage access, not accounts.** Invite + Membership +
   role/disable. Passwords are the single exception, and only for the
   built-in `email-password` provider.

7. **Agent tokens are a platform concern.** Minted from a live user
   session, independent of any external IdP. Constrained delegation is
   reserved as a contract field but not implemented this iteration.

8. **`tenantId` is derived from the `Host` header, never from the body.**
   The login form has no "workspace" field — the user already arrived on
   the right subdomain.

9. **Multi-device sessions via "session families".** Each device gets its
   own family; logout from one device does not evict others. A family is
   the unit of revocation.

10. **Refresh rotation with reuse detection (OAuth2 best practice).**
    Each refresh token is one-shot. Reusing a previously-consumed refresh
    invalidates the **entire family** — we treat it as cookie theft.

### Critical contract decisions (CD-1..CD-10)

These are concrete consequences of the principles, called out separately
because they constrain implementation details.

- **CD-1 — Middleware checks `User.status` on every request.** PDP doesn't
  know about disabled users. The middleware does `usersStore.getById`
  (LRU-cached with ≤30s TTL, invalidated on disable) and rejects when
  `status !== 'active'`. Without this, a disabled user remains effective
  for up to 15 minutes until access expires.

- **CD-2 — `fam` is mandatory in access JWT, not just refresh.**
  `changePassword` needs to know which family is "current" so it can
  revoke the others. The access cookie is the only one available on
  `/auth/password/change`.

- **CD-3 — PDP exposes `enumeratePermissions(identity)`.** Studio's
  `useCan('users:write')` needs the set of permissions to render
  permission-aware UI. The stub implementation returns the list derived
  from `PERMISSIONS` enum, filtered through `check`.

- **CD-4 — Email canonicalization on input to every store.**
  `.toLowerCase().trim()` applied before any store write or lookup.
  `users-store`, `invites-store`, and the `email-password` provider all
  share one canonicalization function.

- **CD-5 — Refresh rotation has a 5-second grace window.** A refresh
  rotated less than 5 seconds ago, presented with the original `jti`,
  returns the same `replacedBy` without killing the family. This survives
  flaky-network retries and multi-tab races. Beyond 5 seconds, reuse
  detection fires and the family dies.

- **CD-6 — `credentials` is a separate collection, not a field on `User`.**
  Schema: `{ userId, providerId, hash, updatedAt }`. Adding Google/Okta
  later means a new row, not a migration. The built-in `email-password`
  provider writes here with `providerId: 'email-password'`.

- **CD-7 — Permissions are a `core/contracts` enum.** Both Studio and
  gateway import `PERMISSIONS` from the same module. Typos become compile
  errors, not silent denies.

- **CD-8 — Constant-time auth response.** `/auth/login` returns the same
  JSON shape and matching latency for every failure mode (unknown user,
  wrong password, disabled). A dummy bcrypt compare runs when the user
  isn't found. Defends against email enumeration and timing attacks.

- **CD-9 — Explicit `expiresAt > now` check next to every TTL-indexed
  read.** TTL sweeps are best-effort; the gap between expiry and physical
  deletion is a security window. `rotateRefresh` and `findByToken` both
  check explicitly.

- **CD-10 — Gateway runs behind nginx with `trustProxy: true`.** Without
  this every session shows the nginx IP, not the real client. We also
  rely on `X-Forwarded-For` parsing in the rate-limit per-IP path.

### Deployment topology

- `{tenant}.kblabs.ru/` — Studio SPA (same-origin).
- `{tenant}.kblabs.ru/api/*` — gateway (same-origin).
- `api.kblabs.ru/*` — machine-only endpoint (MCP agents, CI, webhooks).
  `tenantId` for machine clients comes from JWT, not subdomain.
- Wildcard DNS `*.kblabs.ru` + wildcard TLS via Let's Encrypt DNS-01.

Same-origin per tenant means cookies are `SameSite=Strict` with no
`Domain` attribute. Cross-tenant cookie leakage is structurally
impossible. CORS isn't needed for Studio↔gateway.

### Cookies

| Cookie | Flags | Path | TTL |
|---|---|---|---|
| `kb_access` | HttpOnly; Secure; SameSite=Strict | `/` | 15 min |
| `kb_refresh` | HttpOnly; Secure; SameSite=Strict | `/api/auth/refresh` | 30 days |
| `kb_csrf` | Secure; SameSite=Strict | `/` | 30 days (matches refresh) |

`kb_csrf` is non-HttpOnly so Studio JS can read it and submit it via the
`X-CSRF-Token` header (double-submit pattern).

## Consequences

### Positive

- Studio in cloud is closed with a clean separation between identity
  (today) and authorization (next epic).
- The `IIdentityProvider` seam is honest: the built-in `email-password`
  is one implementation among future-equals. Adding Google/Okta later is
  additive, not refactoring.
- Reuse detection + grace window gives strong protection against cookie
  theft without inflicting spurious logouts on flaky networks or
  multi-tab users.
- Same-origin cookies remove an entire category of cross-subdomain CSRF
  and cookie-leakage concerns.
- Backward compatible for existing machine tokens — the only break is
  closing publicly accessible `/auth/register` behind a permission.

### Negative

- Operational dependency on wildcard TLS issuance (Let's Encrypt DNS-01)
  and the DNS provider's API. If the DNS provider lacks a certbot plugin,
  this becomes a manual renewal every 60 days.
- Multi-tab refresh coordination via `BroadcastChannel` is non-trivial to
  test and has no fallback for unsupported browsers (acceptable: modern
  evergreen browsers only).
- Stub PDP returning hardcoded `tenant-admin`/`tenant-member` group
  permissions is a stopgap. Real RBAC must arrive before any third party
  uses the platform.
- LRU cache on `User.status` (CD-1) introduces a ≤30s window between
  "admin disables user" and "all that user's requests start failing". For
  this iteration, acceptable.

### Out of scope (explicit non-decisions)

- Account lockout. NIST 800-63B treats it as a DoS vector. Defence is
  rate-limit per-IP + per-email + audit-log alerting on bursts.
- 2FA / MFA, password reset via email (self-service), magic-link, email
  verification, SSO. Each lands later as either a new
  `IIdentityProvider` implementation or a separate adapter.
- Real email delivery for invites. Activation URL is returned to the
  admin in the API response and copied to clipboard.
- Audit log as a feature. Security events (`failed-login`,
  `refresh-reuse-detected`, `refresh-grace-retry`, `session-revoked`,
  `user-disabled`, `csrf-failed`) are written to logs as `warn` with
  structured fields, but no dedicated audit sink.
- Constrained delegation for machine tokens / MCP onboarding consent
  screen.
- Tenant provisioning UI. Only `bootstrap` from env on first start.
- ABAC. RBAC + ReBAC ([ClickUp 869def338](https://app.clickup.com/t/869def338))
  covers the foreseeable need; ABAC arrives only when a concrete
  enterprise customer requires attribute-based conditions.

## Implementation

Detailed step-by-step plan with TDD ordering, file paths, test
scenarios, and acceptance criteria lives in
`/Users/kirillbaranov/.claude/plans/wiggly-dreaming-truffle.md`
(session-scoped) and will be turned into ClickUp tasks before code lands.

High-level phases:

1. **Phase 0** — this ADR + contracts in `core/contracts`
   (`IIdentityProvider`, `IPolicyDecisionPoint`, `PERMISSIONS`).
2. **Phase 1** — backend stores + auth-core under `plugins/gateway/auth/`,
   wired through the platform's `IDocumentDatabase` / `IKVStore`
   (no direct SQLite, follow the `host-store.ts` pattern from commit
   `079d3a23`).
3. **Phase 2** — Studio: auth-provider, route guards, login + activate +
   account + admin pages, HTTP-client with single-flight refresh and
   `BroadcastChannel` multi-tab coordination.
4. **Phase 3** — `kb-labs-infra`: wildcard DNS + TLS + nginx.
5. **Phase 4** — 33 end-to-end Playwright scenarios (mandatory, see
   plan); no shortcuts.

This decision will be revisited when (a) a real customer needs an
external IdP, (b) we add machine-token constrained delegation, or (c)
ABAC becomes concrete.

## Addendum: operator recovery of the admin (2026-09)

Bootstrap (`ensureBootstrapAdmin`) never modifies an existing user, so it cannot repair an
admin whose credential was lost, whose status was set to `disabled`, or whose membership
disappeared. Since there is no email reset, the sanctioned recovery path is the offline CLI
command `kb auth reset-admin` (`resetAdmin` in `services/gateway/auth`): it upserts the
`email-password` credential, sets `status=active`, restores the `tenant-admin` membership and
revokes all of the admin's sessions. It validates the password against the normal policy, runs
as a dry run unless `--yes` is given, takes the password only from stdin or generates one, and
refuses to run while a gateway is listening (concurrent sqlite writer). Manually deleting the
credentials row is **not** a recovery: bootstrap will not recreate it. See
`docs/deployment/studio-auth.md`.

Because every login failure is deliberately identical (CD-8), a locked-out install cannot be
diagnosed from the login response. The gateway therefore evaluates auth readiness from its own
stores (`evaluateAuthReadiness`): it logs the result at startup and serves it at
`GET /health/auth`, restricted to local, non-proxied requests (the body says whether an admin
exists and whether the dev JWT secret is in use). `kb-dev doctor` surfaces it. State knowledge
stays in the gateway; the Go tools duplicate no document-database format.

## References

- ClickUp epic — Platform Authorization Layer (PDP + RBAC + ReBAC):
  <https://app.clickup.com/t/869def338>
- Companion plan file (session-scoped):
  `~/.claude/plans/wiggly-dreaming-truffle.md`
- Master commit that established `IDocumentDatabase` + `IKVStore`:
  `079d3a23`
- NIST SP 800-63B (digital identity guidelines):
  <https://pages.nist.gov/800-63-3/sp800-63b.html>
- OAuth 2.0 refresh-token rotation guidance (RFC 6819 §5.2.2.3).

---

**Last Updated:** 2026-05-26
