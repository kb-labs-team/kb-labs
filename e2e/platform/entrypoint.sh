#!/bin/sh
# Platform entrypoint: installs KB Labs from local Verdaccio registry,
# scaffolds e2e workflows, starts services.
# Waits for /health (gateway process) then /ready (all upstreams including REST).
set -e

export PATH="$HOME/.local/bin:$PATH"

# ── Step 1: Install KB Labs ────────────────────────────────────────────────
echo "==> [1/3] Installing KB Labs..."
# E2E must be hermetic. The image is required to provide every bootstrap
# binary; falling back to kblabs.ru made results depend on public infrastructure.
if ! command -v kb-create > /dev/null 2>&1; then
  echo "ERROR: hermetic E2E image is missing kb-create"
  exit 1
fi
echo "    Using binaries baked into the E2E image"
echo "    kb-create $(kb-create --version 2>&1 | head -1)"

# ── Step 2: Bootstrap project ──────────────────────────────────────────────
echo "==> [2/3] Bootstrapping project..."
mkdir -p /workspace && cd /workspace

# The V2 launcher consumes a sealed release index. The registry manifest still
# controls the E2E composition, while the index carries the platform wiring.
PLATFORM_ROOT=/workspace/kb-e2e
# `kb-create apply` requires the selected project root to exist before it
# starts installing the platform into that directory.
mkdir -p "$PLATFORM_ROOT"

# The initial host starts during apply and needs the E2E admin credentials.
# Compose can supply different values for the auth suites.
GATEWAY_BOOTSTRAP_ADMIN_EMAIL="${GATEWAY_BOOTSTRAP_ADMIN_EMAIL:-admin@e2e.test}"
GATEWAY_BOOTSTRAP_ADMIN_PASSWORD="${GATEWAY_BOOTSTRAP_ADMIN_PASSWORD:-E2eBootstrapPass1!}"
GATEWAY_BOOTSTRAP_TENANT_ID="${GATEWAY_BOOTSTRAP_TENANT_ID:-kblabs-cloud}"
export GATEWAY_BOOTSTRAP_ADMIN_EMAIL GATEWAY_BOOTSTRAP_ADMIN_PASSWORD GATEWAY_BOOTSTRAP_TENANT_ID

# The secured scenario exposes Gateway to the runner and selects sqlite-stores
# for auth. Request the remaining catalog adapters without duplicating it.
SCENARIO_ANSWERS=$(jq -cn --arg email "$GATEWAY_BOOTSTRAP_ADMIN_EMAIL" --arg tenant "$GATEWAY_BOOTSTRAP_TENANT_ID" \
  '{"access.mode": "secured", "admin.email": $email, "admin.tenant": $tenant}')
ADAPTERS=$(jq -r '[.adapters[].id | select(. != "sqlite-stores")] | join(",")' /release-index.json)

# Apply installs and starts the supervised host. The host starts the
# per-project REST and workflow runtimes on demand.
kb-create apply \
  --index /release-index.json \
  --platform-root "$PLATFORM_ROOT" \
  --project-root "$PLATFORM_ROOT" \
  --platform-channel stable \
  --service-profile default \
  --scenario custom --scenario-answers "$SCENARIO_ANSWERS" \
  --secret-env gateway.bootstrap.password=GATEWAY_BOOTSTRAP_ADMIN_PASSWORD \
  --plugins "$(jq -r '[.plugins[] | select(.default == true) | .id] | join(",")' /e2e-registry-manifest.json)" \
  --adapters "$ADAPTERS" \
  --registry http://verdaccio:4873
cd "$PLATFORM_ROOT"

# ── OIDC redirect-provider config (OAuth E2E stack only) ───────────────────────
# Apply creates the active platform root. Restart the host after writing the
# override so Gateway loads it. The override refers to the secret by env name.
if [ "${OIDC_E2E_ENABLED:-false}" = "true" ]; then
  echo "    OIDC_E2E_ENABLED=true — writing gateway config override"
  OIDC_ISSUER="${OIDC_CORP_ISSUER:-https://idp-stub:9443}"
  OIDC_CLIENT_ID="${OIDC_CORP_CLIENT_ID:-kb-gateway}"
  cat > "$PLATFORM_ROOT/current/.kb/kb.config.override.json" << OIDC_OVERRIDE
{
  "gateway": {
    "auth": {
      "providers": {
        "email-password": { "type": "email-password" },
        "corp": {
          "type": "oidc",
          "issuer": "${OIDC_ISSUER}",
          "clientId": "${OIDC_CLIENT_ID}",
          "clientSecretEnv": "OIDC_CORP_CLIENT_SECRET",
          "scopes": ["openid", "email"],
          "pkce": true
        }
      }
    }
  }
}
OIDC_OVERRIDE
fi

# Scaffold test workflows used by E2E suite
mkdir -p .kb/workflows

cat > .kb/workflows/e2e-hello.yml << 'EOF'
name: e2e-hello
version: 1.0.0
description: E2E smoke workflow — runs echo and exits cleanly
on:
  manual: true
jobs:
  greet:
    runsOn: local
    steps:
      - name: Say hello
        uses: builtin:shell
        with:
          command: echo "hello from e2e"
EOF

cat > .kb/workflows/e2e-fail.yml << 'EOF'
name: e2e-fail
version: 1.0.0
description: E2E failure workflow — intentionally exits non-zero
on:
  manual: true
jobs:
  fail:
    runsOn: local
    steps:
      - name: Fail intentionally
        uses: builtin:shell
        with:
          command: exit 1
EOF

cat > .kb/workflows/e2e-slow.yml << 'EOF'
name: e2e-slow
version: 1.0.0
description: E2E slow workflow — sleeps 10s so reconnect tests can observe in-progress runs
on:
  manual: true
jobs:
  wait:
    runsOn: local
    steps:
      - name: Sleep
        uses: builtin:shell
        with:
          command: sleep 10
EOF

cat > .kb/workflows/e2e-approval.yml << 'EOF'
name: e2e-approval
version: 1.0.0
description: E2E approval workflow — pauses for human approval then continues
on:
  manual: true
jobs:
  gate:
    runsOn: local
    steps:
      - name: Before gate
        uses: builtin:shell
        with:
          command: echo "before approval"
      - name: Human gate
        uses: builtin:approval
        with:
          title: E2E approval check
          instructions: Approve to continue, reject to stop
      - name: After gate
        uses: builtin:shell
        with:
          command: echo "after approval"
EOF

# ── Step 3: Register the project ────────────────────────────────────────────
# `kb-create apply` started the supervised host. Register the installed
# platform root through its supported CLI entrypoint so the host can route
# /api/v1/projects/{id}/... to its runtime.
echo "==> [3/3] Registering the project..."
# Secured Gateway registration requires an authenticated CLI session. Feed the
# bootstrap password over stdin so it never appears in the process arguments.
printf '%s\n' "$GATEWAY_BOOTSTRAP_ADMIN_PASSWORD" | kb auth login --gateway-url http://127.0.0.1:4000 --email "$GATEWAY_BOOTSTRAP_ADMIN_EMAIL" --password-stdin
kb project add "$PLATFORM_ROOT"
if [ "${OIDC_E2E_ENABLED:-false}" = "true" ]; then
  kb-create restart --platform-root "$PLATFORM_ROOT"
fi

echo "==> Waiting for gateway process to start (/health)..."
ATTEMPTS=0
until curl -sf http://localhost:4000/health > /dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 300 ]; then
    echo "ERROR: Gateway did not start after 600s"
    kb-create status --platform-root "$PLATFORM_ROOT" || true
    exit 1
  fi
  sleep 2
done
echo "    Gateway process up after ${ATTEMPTS}x2s"

# Wait for all upstreams to be wired (/ready returns 200 only when REST API,
# workflow daemon, marketplace etc. are all responding).
# Docker Compose healthcheck also polls /ready — we must be ready before tail.
echo "==> Waiting for the host to be ready (/ready)..."
ATTEMPTS=0
until curl -sf http://localhost:4000/ready > /dev/null 2>&1; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 60 ]; then
    echo "ERROR: Platform /ready did not pass after 120s — upstreams still down"
    kb-create status --platform-root "$PLATFORM_ROOT" || true
    curl -s http://localhost:4000/ready || true
    exit 1
  fi
  sleep 2
done

echo "==> Platform fully ready after ${ATTEMPTS}x2s"

kb-create status --platform-root "$PLATFORM_ROOT"

# Keep container alive while tests run
exec tail -f /dev/null
