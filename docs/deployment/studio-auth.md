# Studio Auth — Deployment Guide (ADR-0020)

This document covers environment variables, bootstrap admin setup, wildcard SSL, nginx
configuration, and the production readiness checklist for Studio auth.

---

## Configuration

Auth is read by the Gateway process (`services/gateway/app`). Secrets and bootstrap
identity come from **environment variables**; everything else is a **config key** under
`gateway.auth` in `.kb/kb.config.json` (schema: `services/gateway/contracts/src/config.ts`).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `GATEWAY_JWT_SECRET` | yes (prod) | HMAC secret for access and refresh tokens (`openssl rand -hex 64`). With `NODE_ENV=production` the gateway refuses to start without it; otherwise it falls back to a **public dev secret** and logs a warning — never expose such a gateway |
| `GATEWAY_BOOTSTRAP_ADMIN_EMAIL` | first start | Email of the first admin (or `gateway.auth.bootstrap.adminEmail`) |
| `GATEWAY_BOOTSTRAP_ADMIN_PASSWORD` | first start | Password of the first admin (bcrypt-hashed on write). Env only, never a config key |
| `GATEWAY_BOOTSTRAP_TENANT_ID` | no | Tenant of the admin (or `gateway.auth.bootstrap.tenantId`), default `kblabs-cloud` |
| `AUTH_COOKIE_SECURE` | no | Overrides `gateway.auth.cookieSecure`. Disable only for local HTTP dev |
| `AUTH_ACCESS_TTL_SEC` / `AUTH_REFRESH_TTL_SEC` | no | Override token lifetimes in seconds (E2E fast-expiry tests) |
| `AUTH_INVITE_TTL_MS` | no | Override invite lifetime in ms (E2E) |
| `AUTH_LOGIN_RATE_LIMIT_PER_IP` / `AUTH_LOGIN_RATE_LIMIT_PER_EMAIL` | no | Override login rate limits |

### Config keys (`gateway.auth.*`)

| Key | Default | Description |
|---|---|---|
| `access.mode` | — | High-level "Studio access" choice, written by `kb-create`: `secured` (login required) or `local` (no login, binds `127.0.0.1` unless `host` is set). Absent = `secured` |
| `enabled` | derived | Not defaulted. Explicit `true`/`false` wins over `access.mode`; when omitted it follows `access.mode` (login required unless `local`). `false` = every request runs as a local admin; the gateway refuses to start this way on a non-loopback bind |
| `sessionAccessTtlSec` | `900` | Access token lifetime |
| `sessionRefreshTtlSec` | `2592000` (30d) | Refresh token lifetime |
| `refreshGraceWindowSec` | `5` | Grace window for parallel refresh (CD-5) |
| `bcryptCost` | `12` | bcrypt cost factor |
| `passwordPolicy.{minLength,maxLength,hibpEnabled}` | `8` / `256` / `true` | Password policy; `hibpEnabled` needs outbound HTTPS to `api.pwnedpasswords.com` |
| `rateLimit` | see schema | Login / activation rate limits |
| `inviteTtlMs` | 7 days | Invite lifetime |
| `bootstrap.{tenantId,adminEmail,provisionCliCredentials}` | — | Bootstrap admin and CLI credential seeding |
| `providers` | built-in `email-password` | Identity providers (`oidc`, third-party) |

Tenant routing lives in `gateway.tenants.pattern` (default `{tenant}.kblabs.ru`).

---

## Bootstrap Admin

The bootstrap admin is created on the **first gateway start** when the email and password
are present. It is **idempotent and deliberately conservative**: if a user with that email
already exists in the tenant, bootstrap does nothing — it never re-activates the account,
re-sets the password or repairs a missing credential. Restarting the gateway therefore
**cannot** fix a broken admin.

```bash
# Gateway startup log lines from the bootstrap step
kb logs query --plugin-id gateway --limit 50 | grep bootstrap-admin
# → "bootstrap-admin: provisioned tenant-admin"
# → "bootstrap-admin: admin already exists and is active, skipping"
# → "bootstrap-admin: a user with the bootstrap email already exists in a non-active state; not touching it"
```

A failed bootstrap is logged as a warning (`Bootstrap admin seed failed (non-fatal)`) and the
gateway still starts — without an admin.

### Installing with `kb-create`

`kb-create` asks for "Studio access" and writes `gateway.access.mode`; the gateway declares
what it needs in `kb-create.requirements.json` (see `tools/kb-create/v2/README.md`). For
`secured` the wizard also asks for the first admin's email and password (hidden input,
confirmed) and generates the session signing secret (`GATEWAY_JWT_SECRET`) when you press Enter.
Non-interactive installs pass the secrets with `--secret-env`. Secrets land only in the private
`.kb/v2/secrets.env`, never in generated config. If the admin password is skipped, no admin exists
after install: `kb-dev doctor` reports `no_active_admin`, and `kb auth reset-admin` creates one
using the email the installer already wrote.

### Diagnosing "I can't log in"

Every login failure returns the same `401 invalid_credentials` (CD-8), so the response never
says *why*. Ask the gateway instead — it knows whether an admin exists:

```bash
kb-dev doctor          # auth ● enabled, 1 active admin(s)   — or the exact problem and fix
```

`kb-dev doctor` reads `GET /health/auth` from the local gateway and reports:

| Code | Severity | Meaning | Fix |
|---|---|---|---|
| `no_active_admin` | error | Auth is enabled but the tenant has no active `tenant-admin` — **nobody can log in**. This is the state of a fresh secured install where no bootstrap admin was seeded | `kb auth reset-admin` |
| `bootstrap_failed` | error | Seeding the bootstrap admin failed at startup (see the gateway log) | fix the cause, or `kb auth reset-admin` |
| `bootstrap_user_inactive` | warning | The bootstrap admin exists but is not active; bootstrap never re-activates users | `kb auth reset-admin` |
| `jwt_secret_default` | error on a reachable bind, warning on loopback | `GATEWAY_JWT_SECRET` is unset, tokens are signed with a public dev secret | set `GATEWAY_JWT_SECRET`, restart |

The same findings are logged once at gateway startup as `auth-readiness: …` (error level for
errors, with a `hint` field), so they also appear in `kb logs`.

`/health/auth` is **not public**: it answers only a request that comes from this machine, was
not proxied (no `X-Forwarded-*`/`X-Real-IP`/`Forwarded` header) and carries a loopback `Host`;
everything else gets a plain `404`. So it is invisible behind the nginx setup above, and you
query it on the host: `curl http://localhost:4000/health/auth`.

### Recovering the admin (forgotten password, disabled, credential lost)

Use `kb auth reset-admin`. It works **offline** against the platform database, so it is the
way back in when nobody can log in. Stop the gateway first (the command refuses to run
while one listens on `gateway.port`, to avoid concurrent sqlite writes; `--force` overrides).

```bash
kb-dev stop gateway

# 1. Dry run — shows the state of the admin and what would be repaired, changes nothing
kb auth reset-admin --email admin@example.com --tenant kb-cloud

# 2. Apply with a generated password (printed once) ...
kb auth reset-admin --email admin@example.com --tenant kb-cloud --generate --yes

# ... or with a password from stdin (never pass passwords as arguments)
printf %s "$NEW_PASSWORD" | kb auth reset-admin --email admin@example.com --tenant kb-cloud --password-stdin --yes
```

Then start the gateway again the way you normally do.

`--email` and `--tenant` default to `GATEWAY_BOOTSTRAP_ADMIN_EMAIL` / `GATEWAY_BOOTSTRAP_TENANT_ID`
(or `gateway.auth.bootstrap.*`). The command:

- creates the admin if it does not exist, or repairs the existing one:
  sets `status=active`, writes the new `email-password` credential, restores the
  `tenant-admin` membership;
- validates the password against the same policy as activation (a rejected password
  changes nothing);
- **revokes all sessions** of the admin — treat every reset as a possible compromise.

> ⚠️ Do **not** "delete the `credentials` row and restart": bootstrap skips an existing
> active user, so the admin would be left with no credential and could never log in.

---

## Wildcard SSL

Auth cookies require `Secure` attribute, which requires HTTPS. Set up wildcard SSL for `*.kblabs.ru`:

```bash
# DNS-01 challenge (works with Cloudflare — see Phase 3 infra docs)
certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/cloudflare/credentials.ini \
  -d "*.kblabs.ru" \
  -d "kblabs.ru"

# Verify
openssl s_client -connect kb-cloud.kblabs.ru:443 -servername kb-cloud.kblabs.ru \
  | openssl x509 -noout -subject -issuer
```

Auto-renewal:
```bash
# /etc/cron.d/certbot-renew
0 3 * * * root certbot renew --quiet --post-hook "nginx -s reload"
```

---

## nginx Configuration

nginx is the single entry point for each tenant subdomain. It serves Studio SPA and proxies
`/api/` to the Gateway process.

```nginx
# /etc/nginx/sites-enabled/tenant-wildcard.conf
server {
    listen 443 ssl http2;
    server_name ~^(?<tenant>[a-z0-9-]{2,40})\.kblabs\.ru$;

    ssl_certificate     /etc/letsencrypt/live/kblabs.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/kblabs.ru/privkey.pem;

    # Security headers
    add_header Referrer-Policy  "no-referrer"   always;
    add_header X-Frame-Options  "DENY"          always;
    add_header X-Content-Type-Options "nosniff" always;

    # Studio SPA (client-side routing → index.html fallback)
    location / {
        root  /var/www/studio/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # Gateway API — trust-proxy headers passed through (CD-10)
    location /api/ {
        proxy_pass         http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_pass_header  Set-Cookie;
    }
}

# HTTP → HTTPS redirect
server {
    listen 80;
    server_name ~^[a-z0-9-]{2,40}\.kblabs\.ru$;
    return 301 https://$host$request_uri;
}
```

Reserved subdomains (`api`, `www`, `docs`, `mail`, `admin`, `static`, `cdn`) need their own
server blocks **before** the wildcard block so they take precedence.

### Deploy Studio

```bash
# Build
pnpm --filter @kb-labs/studio-app build

# Deploy (adjust path as needed)
rsync -av --delete studio/app/dist/ vps:/var/www/studio/dist/
nginx -t && nginx -s reload
```

---

## Trust-Proxy (CD-10)

The Gateway is started with `trustProxy: true` (Fastify). nginx must send the real client IP:

```nginx
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Real-IP         $remote_addr;
```

Verify in gateway logs: each request should show the real client IP, not `127.0.0.1`.

---

## Cookie Attributes (verified by AUTH-02, AUTH-29)

| Cookie | HttpOnly | Secure | SameSite | Path | TTL |
|---|---|---|---|---|---|
| `kb_access` | ✅ | ✅ | Strict | `/` | 15m |
| `kb_refresh` | ✅ | ✅ | Strict | `/api/auth/refresh` | 30d |
| `kb_csrf` | ❌ (JS-readable) | ✅ | Strict | `/` | 30d |

No `Domain` attribute — cookies are origin-scoped to `{tenant}.kblabs.ru` automatically.

---

## Production Readiness Checklist

### Before first deploy

- [ ] `GATEWAY_JWT_SECRET` is set (not the built-in dev default), 32+ chars, stored in secrets manager
- [ ] `GATEWAY_BOOTSTRAP_ADMIN_PASSWORD` is strong and changed after first login (or rotated with `kb auth reset-admin`)
- [ ] Wildcard SSL certificate is valid: `openssl s_client -connect kb-cloud.kblabs.ru:443`
- [ ] nginx wildcard config applied, reserved subdomains have own server blocks
- [ ] `AUTH_COOKIE_SECURE=true` (default) — never disable in production
- [ ] `gateway.auth.passwordPolicy.hibpEnabled=true` (default) — outbound HTTPS to `api.pwnedpasswords.com` allowed

### After first deploy (manual smoke test)

- [ ] `curl -i https://kb-cloud.kblabs.ru/api/auth/providers` → 200 with wildcard cert
- [ ] Login via browser → cookies present with HttpOnly/Secure/SameSite=Strict
- [ ] No `role` field in `/api/auth/me` response (CD-3)
- [ ] Cross-tenant guard: `curl -H "Host: other-tenant.kblabs.ru" https://kb-cloud.kblabs.ru/api/auth/me` with tenant-A cookies → 401
- [ ] `password123` on invite activation → 400 with "pwned" reason (HIBP working)
- [ ] Gateway logs show real client IPs (not `127.0.0.1`)
- [ ] Security events (`failed-login`, `refresh-reuse-detected`, `csrf-failed`) appear in gateway logs with structured fields

### Ongoing

- [ ] Certbot auto-renewal cron is active: `crontab -l | grep certbot`
- [ ] Gateway memory usage is stable after 1h (LRU cache for user status checks, CD-1)
- [ ] Bootstrap admin runs idempotent on every restart (no duplicate users in DB)

---

## Invite Flow (no email, admin-only)

1. Admin opens `/admin/invites`
2. Fills the email, clicks **Send invite**
3. Activation URL is shown in the UI (copied to clipboard via `navigator.clipboard`)
4. Admin shares the URL with the invited user out-of-band (Slack, email, etc.)
5. User opens the URL, sets a password → auto-logged in as `tenant-member`

The URL contains a one-time token. After activation the token is consumed and the URL
becomes invalid (AUTH-15). Invites expire after `AUTH_INVITE_TTL` (default 7 days, AUTH-14).

---

## Tenant Provisioning

Currently tenants are bootstrapped from env vars only. There is no tenant provisioning UI.

To add a new tenant:
1. Set `GATEWAY_BOOTSTRAP_TENANT_ID=new-tenant` + `GATEWAY_BOOTSTRAP_ADMIN_EMAIL/PASSWORD`
2. Restart the gateway — the admin user for the new tenant is created
3. Add a DNS A record for `new-tenant.kblabs.ru` → the VPS IP
4. The wildcard nginx config picks it up automatically

---

## What is NOT implemented in this iteration

See `docs/adr/0020-identity-and-authentication.md` § "What we are NOT doing" for the
complete list. Key items:

- No password reset via email (users are re-invited; the admin is recovered with `kb auth reset-admin`)
- No 2FA / MFA
- No SSO / OAuth2 / OIDC
- No account lockout (would be a DoS vector)
- No real-time audit log (security events are in gateway logs only)
- No tenant provisioning UI
