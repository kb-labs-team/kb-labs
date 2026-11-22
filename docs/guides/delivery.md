# Delivery — declarative rollouts with `kb-deploy apply`

> **Historical design — not a supported V2 launcher workflow.** The described
> `kb-create install-service`, `swap` and `releases` commands were removed in
> the breaking launcher cutover. Do not use this walkthrough for a current
> release; use [the V2 release process](../RELEASE-PROCESS.md) and its sealed
> platform index instead.

A 15-minute walkthrough covering the declarative delivery plane introduced in
[ADR-0014](../adr/0014-declarative-delivery-and-fleet-distribution.md).

## TL;DR

- `.kb/deploy/deploy.yaml` is the single source of truth for *what runs where*.
- `kb-deploy plan` is read-only and safe; it produces a diff between the
  manifest and observed state on each host.
- `kb-deploy apply` rolls out the plan in waves with a health gate and
  auto-rollback.
- `deploy.lock.json` is committed to git. Its history is your audit trail.

## 1. Repo layout

Deploy artifacts live beside the code they deploy. For a typical product repo:

```
<workspace>/
├── src/
├── .kb/
│   ├── kb.config.jsonc
│   ├── profiles/
│   └── deploy/
│       ├── deploy.yaml             ← the manifest
│       ├── deploy.lock.json        ← resolved state (committed)
│       └── configs/
│           └── gateway.jsonc
└── .env                            ← secrets for local runs (gitignored)
```

Teams that want to separate concerns may move `.kb/deploy/` to its own repo —
the `deploy.yaml` schema is identical in either location.

## 2. Write `deploy.yaml`

Start from [`templates/deploy/deploy.yaml`](../../templates/deploy/deploy.yaml):

```bash
cp templates/deploy/deploy.yaml .kb/deploy/deploy.yaml
```

Fill in:
- `platform.version` — the pinned KB Labs platform.
- `services.<name>` — one per service you deploy. Adapters are admin choices;
  the service manifest declares only roles.
- `hosts.<name>` — ssh target. Use `key_path_env` to point at a key file
  (preferred) or `key_env` for a raw PEM.
- `rollout.autoRollback: true` if you want wave-level safety.

## 3. First plan

```bash
export DEPLOY_SSH_KEY=$HOME/.ssh/kb-deploy.key
kb-deploy plan --config .kb/deploy/deploy.yaml
```

Possible outcomes (exit codes):

| code | meaning |
|------|---------|
| 0 | nothing to do |
| 2 | changes present (`apply` to roll them out) |
| 4 | **drift** — a host is out of sync with the lock. See §5. |
| 1 | error (validation, SSH, config) |

Add `--json` for CI / agents; the same exit codes apply.

## 4. First apply

```bash
kb-deploy apply --config .kb/deploy/deploy.yaml --yes
```

What happens:

1. Load + validate `deploy.yaml` (schema, host references, lock mode).
2. Resolve `${secrets.X}` / `${env.X}` and fail fast on missing secrets.
3. Dial every host over SSH; probe `~/kb-platform/releases.json` via
   `kb-create releases --json`.
4. Compute the plan per service (install / swap / restart / skip).
5. Execute wave by wave:
   - On each host: `kb-create install-service` → `kb-create swap` → `kb-dev
     restart` → `kb-dev ready` (health gate).
6. On success — write and commit `deploy.lock.json`.
7. On failure in any wave — if `rollout.autoRollback: true`, swap completed
   hosts back to their previous release.

Exit codes: `0` (no changes), `1` (applied), `2` (error), `3` (rollback fired).

## 5. Drift

"Drift" means the observed state on a host doesn't match the lock. Common
causes: an admin ran `kb-create swap` directly, or the host was reinstalled.

```
Drift detected:
  prod-1/gateway: lock=gateway-1.2.3-aaa target=gateway-1.2.2-bbb
Options: 'kb-deploy apply' to reconcile to lock, or 'kb-deploy adopt' to
         update lock from target state.
```

- `kb-deploy apply` forces `prod-1` back to the lock version.
- `kb-deploy adopt` *(follow-up)* rewrites the lock to match the target.

## 6. Rollback

### One-click rollback on the target

`kb-create rollback @kb-labs/gateway` atomically swaps `current` back to the
previous release. Use this for fast manual recovery.

### Deeper rollback via git

`deploy.lock.json` is the full history. Check out an older lock, then run
`kb-deploy apply` — the fleet will reconcile to that state.

### Rollback window

`kb-create` retains up to `keep-releases` (default 3) plus the current and
previous releases (always protected). Deeper rollback requires restoring from
git history of the lock; the older release will be reinstalled from registry.

## 7. Secrets (D15)

- `deploy.yaml` contains only references: `${secrets.OPENAI_KEY}`.
- Values come from the control machine's process env (populated by CI secrets,
  a `.env` file in the deploy repo root, or a vault).
- Resolved values are never written to `deploy.lock.json`, configs on disk, or
  git history.
- On target, MVP uses kb-dev's existing `.env` wiring; full tmpfs delivery
  (per-release `/dev/shm/kb-platform/secrets/<service>.env`) is follow-up.

### Required secrets for production

| Secret | Service | Required in prod | How to generate |
|--------|---------|-----------------|-----------------|
| `GATEWAY_JWT_SECRET` | gateway | **Yes — gateway refuses to start without it** | `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"` |
| `GATEWAY_INTERNAL_SECRET` | gateway, REST API, Marketplace API, marketplace-registry | **Yes — all modes** | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` for team deployments; kb-create generates and preserves it automatically |
| `OPENAI_API_KEY` | llm-openai adapter | Only if using OpenAI | From platform.openai.com |

> **`GATEWAY_JWT_SECRET`**: gateway bootstrap throws a fatal error if this is not set when `NODE_ENV=production`.
> In dev mode it falls back to an insecure default — never deploy that configuration to any shared environment.

## 8. CI — GitHub Actions

The reusable workflow
[`kb-deploy-apply.yml`](../../.github/workflows/kb-deploy-apply.yml) wires up
`plan` on every push (uploading `plan.json` as an artifact) and `apply` behind
a GitHub Environment approval.

Usage from your product repo:

```yaml
name: Deploy to staging
on:
  push:
    branches: [main]
    paths: ['.kb/deploy/**']

jobs:
  call:
    uses: kb-labs-team/kb-labs/.github/workflows/kb-deploy-apply.yml@main
    with:
      manifest: .kb/deploy/deploy.yaml
      environment: staging
    secrets:
      DEPLOY_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
      OPENAI_KEY: ${{ secrets.OPENAI_KEY }}
```

## 9. Lock modes

`rollout.lockMode` controls how the updated lock returns to git:

- **`artifact`** *(default, recommended for CI)* — `kb-deploy apply` writes
  `deploy.lock.json` to disk; CI commits it via a standard git step. Conflicts
  surface as git merge conflicts at PR time.
- **`autoCommit`** — `kb-deploy apply` commits and pushes the lock directly.
  Requires branch protection on the deploy repo (otherwise a compromised CI
  token can push malicious versions). `kb-deploy plan` emits a warning when
  `autoCommit` is set so you don't forget.

## 10. Anti-patterns

- **Don't `kb-create install-service` directly on a production host**. It
  works — but `kb-deploy apply` will then treat the host as drift at the next
  run. Only reach for the low-level tools to diagnose.
- **Don't put adapter requirements in `ServiceManifest`**. The service code
  already expresses them; `deploy.yaml` is the single contract for admins
  (see ADR-0014 §D1).
- **Don't share one `deploy.yaml` across environments**. Keep separate files
  per environment (staging, prod), or use separate branches — you want the
  git history scoped to one blast radius.

## References

- ADR: [docs/adr/0014-declarative-delivery-and-fleet-distribution.md](../adr/0014-declarative-delivery-and-fleet-distribution.md)
- Implementation plan: [docs/plans/0014-declarative-delivery-and-fleet-distribution.md](../plans/0014-declarative-delivery-and-fleet-distribution.md)
- Starter template: [templates/deploy/deploy.yaml](../../templates/deploy/deploy.yaml)
- Reusable CI workflow: [.github/workflows/kb-deploy-apply.yml](../../.github/workflows/kb-deploy-apply.yml)
