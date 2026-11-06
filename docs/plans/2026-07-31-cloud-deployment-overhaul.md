# Cloud Deployment Overhaul — Plan

**Date:** 2026-07-31
**Status:** Draft
**Related ADR:** ADR-0037 (to be written, see Phase 1) — supersedes [ADR-0014](../adr/0014-declarative-delivery-and-fleet-distribution.md)
**Supersedes in part:** `docs/architecture/cloud-deployment.md` (describes KB Labs' own Oracle Cloud infra, not a self-hosting path)

## Relationship to ADR-0014

[ADR-0014 — Declarative Delivery and Fleet Distribution](../adr/0014-declarative-delivery-and-fleet-distribution.md)
(Proposed, 2026-04-22) addressed the same problem and chose the opposite answer: npm-package
releases with atomic symlink swaps on hosts, orchestrated over SSH, explicitly **rejecting
Docker-first** as the primary mechanism.

Its machinery is built **and in use** — this is not dead code:

| Path | Config | Used by |
| --- | --- | --- |
| `kb-deploy run` | `.kb/deploy.yaml` (imperative `targets:`) | production — gateway, marketplace-registry |
| `kb-deploy apply` | `.kb/deploy/deploy.yaml` (ADR-0014 `services:`/`hosts:`) | dogfood VM, platform 2.94.0, Verdaccio |
| `kb-deploy apply` | `infra/preview/deploy.yaml.tmpl` (imperative `targets:`) | PR preview envs (`.github/workflows/preview.yml`) |

Note `apply` accepts **both** schemas, and nothing documents which is canonical.

**Decision: consolidate on the container path and decommission the declarative one** (Phase 6).
Three delivery systems is too much surface for the team size, and only the container path has a
Kubernetes story — ADR-0014's SSH symlink swap has no meaning inside a pod, where the
orchestrator owns lifecycle.

ADR-0014's first objection to containers — *"containers still need configured adapters inside"* —
was valid against **baked-config** images, which is exactly today's broken gateway image. Phase 1
dissolves it. Its second objection — *"forces container infrastructure on users who do not need
it"* — remains valid and is why `kb-create` stays a first-class, non-container path.

**What is knowingly given up:** canary waves, health-gated rollout, and atomic swap with a
`previous` release. Kubernetes provides all three natively (rolling updates, readiness gates,
`kubectl rollout undo`), so nothing is lost on the k8s path. On compose-over-SSH, canary rollout
genuinely goes away; basic rollback survives (`deploy.yml` already captures pre-deploy images).

## Goal

Make deploying the platform to a VPS or Kubernetes as easy as the local installer
(`kb-create`, ~5 minutes). Today this is impossible for an external user and painful
for the team.

Success criteria:

- A user with no access to the monorepo can deploy the platform from published artifacts.
- Composition (services, adapters, plugins) is declared in **one file**, not baked into images.
- A bad composition fails **before** deploy, or crashes the pod loudly — never boots degraded.
- Upgrades are version-pinned and reversible.

## Current state — why it does not work today

| Area | Finding |
| --- | --- |
| Images | Only `kb-gateway` and `kb-marketplace-registry` exist. No images for `rest-api`, `mcp`, `workflow` daemon, `studio`. |
| Registry service | `kb-marketplace-registry` is a KB Labs SaaS component (defaults to `api.kblabs.ru`), not something a user self-hosts. Effectively only gateway ships. |
| Config | `kb.config.prod.json` and `marketplace.prod.lock` are `COPY`-ed into the image at build time. Changing adapters requires rebuilding, which requires the monorepo. |
| Plugins | No install path inside a container. The lock is baked. |
| Build model | `Dockerfile`s have no builder stage; they copy artifacts produced on the CI runner by `pnpm deploy --prod`, with the whole monorepo as build context. Not reproducible outside CI. |
| Sources of truth | Three files must agree: `package.json` deps, `kb.config.prod.json` adapters, `marketplace.prod.lock`. `scripts/sync-adapter-deps.mjs` (PR #328) syncs the first two; nothing syncs the third. |
| Kubernetes | No chart, no manifests, nothing. |
| Distribution | `infra/docker-compose.backend.yml` lives in the monorepo and is hand-placed on the VPS as `~/kb-labs/docker-compose.backend.yml`. No CI step publishes it. |
| Versioning | `IMAGE_TAG:-latest` — a restart can silently pull a new version. |
| Data safety | **Confirmed data loss:** the image creates `.kb/database`, `.kb/storage`, `.kb/analytics`, but compose mounts a volume only on `/app/.kb/database`. With `storage: "@kb-labs/data-store"`, writes to `.kb/storage` land in the ephemeral container layer. |
| Runtime | `node:22-slim` (gateway) vs `node:20-slim` (marketplace-registry), while CI builds `node_modules` on Node 22. ABI risk for native addons. |
| Docs | No self-hosting guide. |

### What already works and should be reused

- **Config env interpolation exists and is good** — `core/runtime/src/config-interpolation.ts`
  resolves `${VAR}` recursively across the whole config. This means a single shipped
  config can carry `${REDIS_URL}` / `${OPENAI_API_KEY}` and be filled from env or a
  Kubernetes Secret. **No Helm templating of config internals is needed.**
- **Config is found by filesystem walk** — `core/config/src/api/read-kb-config.ts` looks for
  `.kb/kb.config.json` upward from cwd. The image already places its config at exactly that
  path, so **mounting a file over it overrides composition today, with zero code change**.
- **`marketplace.lock` already records exact versions + SHA256 integrity** —
  `core/discovery/src/marketplace-lock.ts`. Reproducibility can rest on the lock rather than
  on image immutability.

## Target user journey

This is the guide we want to be able to write:

```
1. Provision a VPS or a cluster.

2. Choose a mode:
   Evaluate:    docker run ghcr.io/kb-labs/platform:1.4      # all-in-one, sqlite, no external deps
   Production:  helm install kb-labs/platform -f values.yaml

3. Declare composition in ONE file:
     services: [rest-api, workflow, studio, mcp]
     adapters: { llm: openai, cache: redis, storage: s3 }
     plugins:  [mind, review, commit]
     secrets:  injected via env / secretRef, referenced as ${VAR} in config

4. kb-create validate values.yaml        # incompatibility caught BEFORE deploy

5. helm install  /  docker compose up

6. Open https://<host>/studio — health page green per service.
```

## Plan

### Phase 0 — Stop the bleeding (days)

Independent of the architecture work; ship immediately.

1. **Fix the storage data loss.** Mount a volume over `/app/.kb/storage` (and decide on
   `.kb/analytics`) in `infra/docker-compose.backend.yml`, or point `data-store` at a path
   under the already-persisted `.kb/database`. Confirmed live issue.
2. **Unify Node versions.** `services/marketplace-registry/app/Dockerfile` → `node:22-slim`,
   matching gateway and the CI `setup-node`.
3. **Pin image tags.** Replace `${IMAGE_TAG:-latest}` with an explicit release version;
   make `latest` an alias, never the deployed default.

### Phase 1 — Take config and lock out of the image *(the unlock)*

Nothing downstream is possible while composition is baked in. Cheaper than expected —
mostly packaging and documentation, not refactoring.

1. **Write ADR-0037** — "Containers are the canonical cloud delivery path". Records: images ship
   code only; `kb.config.json` + `marketplace.lock` arrive via mount/ConfigMap; reproducibility
   rests on the lock's integrity hashes, not on image immutability; `kb-create` remains the
   non-container path. Must state explicitly why ADR-0014 is superseded and what is given up
   (see "Relationship to ADR-0014" above). Reference `core/config/docs/adr/0001-config-overlays.md`
   for the existing overlay/interpolation pipeline.
2. **Stop `COPY`-ing config into images.** Ship a default config as a *fallback* at a
   different path, so a mounted `.kb/kb.config.json` cleanly wins.
3. **Make interpolation strict in production.** `config-loader.ts:485` currently passes
   `required = false`, so a missing `${GATEWAY_JWT_SECRET}` leaves a literal placeholder and
   degrades silently. Gate on `NODE_ENV=production` → strict. Per the repo bug-fix rule, add a
   test that fails before and passes after.
4. **Document the override contract** — which paths are mount points, which env vars are
   required, what happens when one is missing.

### Phase 2 — Complete the image matrix

Deliverable set is known and static: CLI / REST-API / Workflow / Studio / MCP.

1. Add `Dockerfile`s for `services/rest-api`, `services/mcp`, `services/workflow/daemon`,
   `studio/app`, following the gateway pattern.
2. Replace the two hardcoded `pnpm deploy` steps in `.github/workflows/deploy.yml` with a
   build matrix over the known service list.
3. Trigger image publication from the **release** event (when `manager-core` publishes packages),
   so image version == release version by construction.

### Phase 3 — Tiered packaging (Local / Team / Prod), deferred build-out

**Decision (2026-07-31):** "all-in-one" is not one image. Packaging splits into three tiers by
audience, not by mechanism — all three still use the per-service images from Phase 2, just
composed differently:

| Tier | Audience | Composition |
| --- | --- | --- |
| **Local / eval** | "try it in 5 minutes" | sqlite + InMemory/NoOp fallbacks (already built into `ADAPTER_DEFAULTS` — an eval compose can simply *not* configure `cache`/`eventBus` and get InMemory for free), no Redis/MinIO/Qdrant containers |
| **Team** | small self-hosted teams | Redis + sqlite/local storage, single-host compose — close to today's `infra/docker-compose.backend.yml` |
| **Prod** | production deployments | full adapter set (Redis, S3/MinIO or real object storage, Qdrant if `mind` is used), Helm-deployed |

Build-out deferred — not started this session. When resumed:
1. **Local/eval compose overlay** — new `docker-compose.eval.yml` reusing the *existing* Phase 2
   images with sqlite/InMemory-defaulting configs, no new Dockerfiles needed. Cheapest of the
   three to build first.
2. **Team tier** — largely already exists as `infra/docker-compose.backend.yml`; needs the
   dependency/volume fixes from Phase 0 and the full 8-service set from Phase 2 folded in.
3. **Prod tier / flavor images** — standard plugin set baked at build time (Helm-deployed, Phase 4).
4. **Publish a base image** — substrate for "bake your own" without the monorepo, needed by all
   three tiers' CI.

Deliberately not resumed this session: two Docker build rounds already hit real infra fragility
(missing `.dockerignore`, a corrupted Colima daemon from a prior disk-full event — see
`docs/deployment/docker-build-hygiene.md`). Building more images back-to-back right after
recovering from that is exactly the risk the hygiene policy exists to avoid.

### Phase 4 — Distribution artifacts

1. **Helm chart — done.** `deploy/helm/kb-labs-platform/`. `values.yaml` carries composition
   (`config` → ConfigMap, `secretRefs` → existing Secrets, `${VAR}` interpolated at boot by the
   running process, not by Helm). Guardrails enforced at render time and verified via
   `helm lint`/`helm template` (`deploy/helm/kb-labs-platform/test.sh`, 10/10 checks): required
   `image.tag` (never `latest`), `workflow.replicas` capped at 1, `marketplace-registry`'s
   `wait-for-state-daemon` initContainer. Caught and fixed a real correctness bug before shipping:
   Kubernetes ConfigMap mounts are unconditional (unlike `docker run -v`), so the composition
   ConfigMap only renders/mounts when `config`/`marketplaceLock` are actually set — otherwise
   every image's own baked default would never apply. Not yet run as a real `helm install` against
   a live cluster (no `kind`/`k3d` available) — see the chart README.
2. **Publishable `docker-compose.yml`** — a release artifact, not a file hand-copied from `infra/`.
   Not done — requires touching release/publish CI, same risk category as the blocked
   `.kb/deploy.yaml` wiring (Task #12); deliberately not attempted without a check-in.
   `infra/docker-compose.backend.yml` (extended in Phase 2) is the publish source once that
   CI step exists.
3. Both versioned and published alongside images on release.

### Phase 5 — Fail loudly, validate early

1. **`kb-create validate <file>`** — check the composition (adapter slots against
   `ADAPTER_REGISTRY_KEYS`, plugin↔SDK peer ranges) *before* anything is deployed.
   Note `ADAPTER_REGISTRY_KEYS` is exported today but consumed nowhere.
2. **No silent degradation at boot.** `initPlatform` currently skips stale/missing lock entries
   and falls back to NoOp/Mock. In production that must crash the process instead — a green pod
   running without half its adapters is worse than a failed deploy.
3. Retire `scripts/sync-adapter-deps.mjs` — with composition injected, `package.json` no longer
   needs to mirror the config, and the root cause it patches disappears.

### Phase 6 — Migrate off the declarative path, then decommission it

Strictly after Phases 2–4: there is nothing to migrate onto until images exist for every service
and a compose/Helm artifact is published. **Nothing is deleted before its replacement runs.**

1. **Migrate PR previews.** The smaller move — previews are already container-based (build, push
   GHCR, ssh, `docker compose up`); only the driver changes from `kb-deploy apply` to the
   canonical container path. Update `infra/preview/*.tmpl`, `.github/workflows/preview.yml`,
   `preview-teardown.yml`.
2. **Migrate the dogfood VM.** `.kb/deploy/deploy.yaml` runs four core daemons on one host from a
   local Verdaccio — a natural fit for the published compose artifact from Phase 4. Retire the
   Verdaccio dependency along with it.
3. **Decommission.** Once both are green, remove `cmd/apply.go`, `cmd/plan.go`, `cmd/flow.go`
   (+ tests) and `internal/{orchestrator,remote,secrets,lock,releaseid}` — roughly 2,700 lines.
   Verify `internal/{config,state,affected,infra,docker,ssh,jsonc}` stay, since `kb-deploy run`
   and `status` depend on them.
4. **Collapse the config files.** `.kb/deploy.yaml` and `.kb/deploy/deploy.yaml` are two files with
   near-identical names and different schemas; end on one, and drop the now-unused declarative
   schema from `internal/config`.
5. **ADR-0037 supersedes ADR-0014.** Do not rewrite ADR-0014's text — set
   `Status: Superseded by ADR-0037` and record the reasoning in 0037. The record of why the
   GitOps/SSH approach looked right in April is the point of keeping it; without it, someone
   re-proposes it in a year.

### Phase 7 — Docs

1. **New:** `docs/guides/self-hosting.md` — the target journey, written only after Phases 1–4
   land, so it does not document aspirations.
2. **Rewrite/scope:** `docs/architecture/cloud-deployment.md` — currently describes KB Labs'
   own Oracle Cloud box and a "local CLI + remote backends" model. Either relabel it as internal
   infra or fold it into the new guide.
3. **Review:** `sites/web/docs/deploy-runbook.md`, `tools/kb-deploy/README.md`, and the
   deployment section of `CLAUDE.md`.
4. **Update `.claude/skills/tool-kb-deploy.md`** — it documents `apply`/`plan` as available
   commands; they will not exist after Phase 6.

## Decision: how plugins get into a deployment

**Bake by default; runtime install is an opt-in escape hatch.**

The deliverable set is known and static (CLI / REST-API / Workflow / Studio / MCP), so most
users need a working standard set, not arbitrary composition. Designing the primary path around
flexibility that a minority needs would penalise everyone else.

Runtime install is rejected as the *default* for a specific reason: with `replicas=N` the install
runs on **every pod start** — autoscaling, eviction, restart-after-OOM. That turns registry
availability into a **runtime** dependency rather than a build-time one: if the registry is down,
pods fail to start, precisely when scaling under load.

Three packagings, one mechanism:

| Path | Audience | Mechanism |
| --- | --- | --- |
| Flavor images | ~90%, standard set | `docker pull`; nothing installed at boot |
| Runtime install | eval / dev / custom at small scale | opt-in initContainer, documented as not-for-scale |
| Bake your own | custom plugins in production | published base image + one command |

All three are driven by the **same `marketplace.lock`** and its integrity hashes — one format,
one install code path, three packagings. This is what keeps it from becoming three mechanisms.

## Open questions

- Does `kb-marketplace-registry` stay KB Labs-hosted only, or is a self-hosted registry a
  supported topology? This decides whether an air-gapped install is possible.
- Do CLI and MCP belong in the cloud matrix at all, or are they client-side only?

## Sequencing note

Phase 1 is the unlock — every later phase depends on composition being injectable. Phase 0 is
independent and should not wait for it. Phase 6 is strictly last among the build phases: the
declarative path stays fully functional until previews and the dogfood host run on its
replacement.
