# ADR-0037: Containers Are the Canonical Cloud Delivery Path

**Date:** 2026-07-31
**Status:** Proposed
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-07-31
**Tags:** deployment, delivery, architecture, distribution, marketplace

> **Supersedes:** [ADR-0014 — Declarative Delivery and Fleet Distribution](./0014-declarative-delivery-and-fleet-distribution.md)
> **References:** [ADR-0001 — Config Overlays](../../core/config/docs/adr/0001-config-overlays.md), [ADR-0012 — Platform / Project Scope](./0012-platform-project-scope.md), [ADR-0013 — Installer Config Placement](./0013-installer-config-placement.md)

---

## Context

Deploying the platform to a VPS or Kubernetes is currently impossible for an external user and
painful for the team. This surfaced while reviewing [PR #328](https://github.com/kb-labs-team/kb-labs/pull/328),
which patches a deploy failure by syncing `package.json` from `kb.config.prod.json` in CI — a
symptom fix. The underlying cause: **composition (adapters, plugins) is baked into container
images at build time**, so changing it requires rebuilding, which requires the monorepo. No
external user can do that.

An audit of the delivery surface found three parallel systems, none finished, and no user-facing
self-hosting path in any of them:

| Path | Config | Used by |
| --- | --- | --- |
| `kb-deploy run` | `.kb/deploy.yaml` (imperative `targets:`) | production — gateway, marketplace-registry |
| `kb-deploy apply` | `.kb/deploy/deploy.yaml` (declarative `services:`/`hosts:`) | dogfood VM, platform 2.94.0, Verdaccio |
| `kb-deploy apply` | `infra/preview/deploy.yaml.tmpl` (imperative `targets:`) | PR previews (`.github/workflows/preview.yml`) |

`kb-deploy apply` accepts both schemas; nothing in the codebase documents which is canonical.

Six of the eight deployable backend units (`.kb/devservices.yaml`) have no container image at
all — including `state-daemon`, which `marketplace-registry` depends on at runtime.

There is also a confirmed, live data-loss bug: images create `.kb/storage`, but
`infra/docker-compose.backend.yml` mounts a volume only on `/app/.kb/database`; writes to
`.kb/storage` (used by `@kb-labs/data-store`) are lost on container recreate. Tracked and fixed
independently of this ADR.

### Relationship to ADR-0014

[ADR-0014](./0014-declarative-delivery-and-fleet-distribution.md) (Proposed, 2026-04-22) addressed
overlapping ground and chose the opposite mechanism: npm-package releases with atomic symlink
swaps on target hosts, orchestrated over SSH via `kb-deploy apply`, explicitly rejecting
Docker-first as the primary delivery mechanism.

Its machinery is built and in active use — this ADR does not describe dead code. The dogfood VM
runs on it today (`.kb/deploy/deploy.yaml`), and PR preview environments drive `kb-deploy apply`
against an imperative schema layered on top of the same command.

ADR-0014's first objection to containers — *"containers still need configured adapters inside"* —
was correct against **baked-config** images, which describes every image that exists today
(`services/gateway/app/Dockerfile`, `services/marketplace-registry/app/Dockerfile`). This ADR
dissolves that objection by taking configuration out of the image (see Decision 1). Its second
objection — *"forces container infrastructure on users who do not need it"* — remains correct,
which is why `kb-create` stays a first-class, non-container installation path; nothing here
retires it.

What tips the balance toward containers now: **only the container path has a story for
Kubernetes.** ADR-0014's atomic symlink swap over SSH has no meaning inside a pod, where the
orchestrator — not `kb-deploy` — owns process lifecycle, restarts, and scheduling. Maintaining two
fully-built delivery systems long-term, one of which cannot reach the target the team most needs
(k8s), is not sustainable at this team size.

### Alternatives considered

1. **Keep ADR-0014 as the primary path, add a thin Docker wrapper around `kb-create install-service`.**
   Rejected: this still requires SSH access to every target host and does not produce anything a
   user can `helm install`. It optimizes the wrong axis — it does not remove the monorepo
   dependency for external users.
2. **Runtime plugin installation as the default packaging** (marketplace fetch inside the running
   container, Grafana `GF_INSTALL_PLUGINS`-style). Rejected as the *default*: with `replicas: N`,
   install work reruns on every pod start — autoscaling, eviction, OOM-restart — turning registry
   availability into a runtime dependency exactly when scaling under load. Retained as an opt-in
   path for eval/dev (see Decision 2).
3. **Run both systems indefinitely, let users pick.** Rejected: doubles the delivery surface the
   team maintains, and `kb-deploy apply` already silently accepts two incompatible config schemas
   today — evidence this ambiguity is already a cost, not a hypothetical one.

## Decision

### 1. Composition is injected at runtime, not baked in at build time

Container images ship code only. `kb.config.json` and `marketplace.lock` are delivered via a
mounted file / ConfigMap, not `COPY`-ed from a source-tree default at build time.

This is cheaper than it sounds, because two pieces already exist and needed no new code:

- **Config resolution already favors an override.** `core/config/src/api/read-kb-config.ts`
  finds `.kb/kb.config.json` by walking the filesystem from `cwd`. An image's `WORKDIR` is
  exactly that resolution root, so a file bind-mounted or ConfigMap-mounted at
  `.kb/kb.config.json` is picked up with zero code change.
- **`${VAR}` interpolation already exists and is recursive** —
  `core/runtime/src/config-interpolation.ts`. A single shipped config can carry
  `${REDIS_URL}` / `${OPENAI_API_KEY}` filled from env or a Kubernetes Secret. No Helm
  templating of config internals is required.

What changed as part of this ADR: images now bake their prior source-tree config as a
`*.default.json` / `*.default.lock` fallback, applied by a `docker-entrypoint.sh` **only if
nothing was already mounted at the live path**, so an operator-supplied file always wins cleanly
and unambiguously. See `services/gateway/app/docker-entrypoint.sh` and the equivalent in
`services/marketplace-registry/app/`.

Interpolation strictness now depends on environment: `core/runtime/src/config-loader.ts` passes
`required=true` to `interpolateConfig` when `NODE_ENV=production`, so a missing secret crashes the
process at boot instead of leaving a literal `${VAR}` in a config that boots "successfully." Outside
production, missing variables still degrade lazily as before — this preserves the dev/CLI ergonomics
`interpolateConfig`'s non-strict mode was originally built for.

### 2. Bake plugins by default; runtime install is an opt-in escape hatch

The deliverable service set is known and static (CLI / REST-API / Workflow / Studio / MCP /
Gateway / Marketplace / Marketplace-Registry / State-daemon), so most users need a working
standard composition, not arbitrary runtime assembly.

| Packaging | Audience | Mechanism |
| --- | --- | --- |
| Flavor images | ~90%, standard plugin set | `docker pull`; nothing installed at pod start |
| Runtime install | eval / dev / custom at small scale | opt-in initContainer, documented as not-for-scale |
| Bake your own | custom plugins in production | published base image + one install command |

All three are driven by the same `marketplace.lock` and its SHA256 integrity hashes
(`core/discovery/src/marketplace-lock.ts`) — one format, one install code path, three packagings.
Reproducibility rests on the lock's integrity, not on image immutability.

### 3. ADR-0014 is superseded, migrated off before deletion

The declarative SSH/symlink path is retired, but not deleted out from under anything running on
it. Sequencing (full detail in the companion implementation plan):

1. Build out the container path fully — every backend unit gets an image, plus a published
   Helm chart and compose artifact.
2. Migrate PR previews onto it (previews are already container-based; only the driver changes).
3. Migrate the dogfood VM onto the published compose artifact; retire its Verdaccio dependency.
4. Only then remove `kb-deploy apply`/`plan`/`flow` and the `orchestrator`/`remote`/`secrets`/
   `lock`/`releaseid` internals (~2,700 lines). `kb-deploy run`/`status` and the
   `config`/`state`/`affected`/`infra`/`docker`/`ssh`/`jsonc` internals they depend on are
   unaffected and remain the production path for gateway/marketplace-registry until Phase 2
   images replace them too.

**Known regression, accepted deliberately:** ADR-0014 gave canary rollout waves, health-gated
promotion, and atomic swap-to-`previous` rollback. Kubernetes provides equivalents natively
(rolling updates, readiness gates, `kubectl rollout undo`), so nothing is lost on the k8s path.
On plain compose-over-SSH, canary rollout genuinely disappears; basic rollback survives via the
existing pre-deploy image capture in `.github/workflows/deploy.yml`.

## Consequences

### Positive

- A user without monorepo access can deploy from published images + a values file.
- One delivery mechanism has a Kubernetes story; the team stops maintaining two.
- Composition changes (swap an adapter, add a plugin) no longer require a rebuild, **once a
  flavor image already bakes the adapter package the mounted config selects.**

Correction from an earlier draft of this ADR: config injection alone does **not** retire
`scripts/sync-adapter-deps.mjs` (PR #328). Mounting a config that names a different adapter only
works if that adapter's npm package is already present in the image's `node_modules` — the
package still has to be a real build-time dependency. The sync script's job (keep `package.json`
matching the adapters an image's baked default config references) remains necessary until Phase 3
flavor images make "which adapters are present" an explicit, chosen build input rather than
something inferred from one default config. Retiring the script is scoped to Phase 3+, not this
decision.

### Negative

- Canary rollout waves and health-gated promotion are lost on the compose-over-SSH path (not on
  k8s). Documented above as a deliberate, scoped trade-off.
- `workflow` cannot run more than one replica until worker/scheduler splitting is implemented
  separately (`services/workflow/docs/adr/0014-worker-deployment-architecture.md`, not yet built) —
  every replica would run its own in-process `CronScheduler` and double-fire scheduled jobs.
- Runtime plugin installation, where used, makes container boot dependent on registry
  availability — mitigated by keeping it opt-in rather than default.

### Alternatives Considered

See "Alternatives considered" in Context above.

## Implementation

Tracked in the companion delivery plan (`docs/plans/2026-07-31-cloud-deployment-overhaul.md`).
Summary of what changes:

- `services/gateway/app/Dockerfile`, `services/marketplace-registry/app/Dockerfile` — config/lock
  moved to `*.default.*`, applied via `docker-entrypoint.sh` (done).
- `core/runtime/src/config-loader.ts` — strict interpolation gated on `NODE_ENV=production` (done).
- Dockerfiles for `state-daemon`, `marketplace` (5070), `rest-api`, `workflow`, `mcp`, `studio`
  (done — see `docs/plans/2026-07-31-cloud-deployment-overhaul.md` Phase 2).
- Published Helm chart and versioned `docker-compose.yml` release artifacts.
- `kb-create validate` — pre-deploy composition validation against `ADAPTER_REGISTRY_KEYS` and
  plugin↔SDK peer ranges.
- Migration of PR previews and the dogfood VM off `kb-deploy apply`, then removal of the
  declarative command surface.

**Verified, no change needed:** the "silent NoOp fallback at boot" gap this ADR originally assumed
does not exist for core adapters. `fillAdapterFallbacksAndRecord`
(`core/runtime/src/loader.ts:200-220`) already fails fast — a configured-but-unloaded adapter
throws before any fallback is installed; NoOp/InMemory is only installed for slots that were never
configured, which is correct, intended behavior (and what every minimal default composition in
Phase 2 relies on). The one silent-skip that does exist —
`DiscoveryManager.checkIntegrity` (`core/discovery/src/discovery-manager.ts:233-241`) logging and
continuing on a lock integrity mismatch — is scoped to *plugin* discovery (registry completeness),
not adapter wiring, and is explicitly skipped for `source: "local"` entries
(`discovery-manager.ts:165`), which is what every lock file in this repo uses. It does not affect
the container path.

This ADR will be revisited once the migration in step 3 above completes, to record actual
Kubernetes rollout behavior against what was assumed here.
