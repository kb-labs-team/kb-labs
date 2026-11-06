# ADR-0011: Single Version Policy for External Dependencies

**Date:** 2026-04-14
**Status:** Accepted
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-04-14
**Reviewers:** Kirill Baranov
**Tags:** [tooling, process, architecture]

> **Note:** Tags are mandatory. Minimum 1 tag, maximum 5 tags. See approved tags list in [DOCUMENTATION.md](../DOCUMENTATION.md#adr-tags).

## Context

The monorepo contains ~170 workspace packages (core, sdk, cli, shared, plugins, adapters, studio, sites, templates). Before this decision, each package declared its own versions of external dependencies independently, and versions drifted over time:

- `zod` existed as `^3.23.8`, `^3.24.1`, `^3.25.76`, `^4.0.0`, `^4.1.5`, and `latest` — across 39 packages.
- `vitest` as `^1.0.0`, `^3`, and `^3.2.4` — across 172 usages.
- `react` / `react-dom` as `^18.3.1` and `^19.0.0` — producing duplicate runtime instances in the dependency graph.
- `@types/node` spread across four major versions.
- Smaller splits: `execa` 8/9, `jsdom` 24/25/27, `next-mdx-remote` 5/6, `@vitest/coverage-istanbul` 3/4.

**Concrete failures observed:**

1. **Type mismatch across package boundaries** — `zod@3` schemas are not structurally assignable to `zod@4` consumers, breaking generic inference at package seams.
2. **Singleton runtime bugs** — two copies of `react` in the dep graph produce `Invalid hook call`; two copies of `pino` split logger state.
3. **Bundle duplication** — Module Federation and client bundlers ship multiple copies of the same library.
4. **Peer dependency warnings** — pnpm emits dozens of `unmet peer` lines at install time, drowning real signals.
5. **Lockfile churn** — independent drift produces noisy `pnpm-lock.yaml` diffs on unrelated PRs.

**Constraints:**

- Solo maintenance — no Google-scale tooling or dedicated infra team.
- Must work with pnpm workspaces; a migration to Bazel or Rush is not on the table.
- Must not block day-to-day development or require manual audits.

Alternatives considered: relying on code review only; per-package Renovate/Dependabot; writing a custom KB-Labs dependency plugin; using `pnpm.overrides` alone; splitting the monorepo by domain. All rejected — see [Alternatives Considered](#alternatives-considered).

## Decision

**Adopt a Single Version Policy (SVP):** every external dependency exists in **exactly one version** across the entire monorepo. Enforced mechanically by [syncpack](https://jamiemason.github.io/syncpack/); CI fails on any drift.

Three reinforcing layers:

1. **Declaration layer — [syncpack](https://jamiemason.github.io/syncpack/).**
   Config: [`.syncpackrc.json`](../../.syncpackrc.json). A `versionGroups` rule with `policy: sameRange` requires every external dependency to have one range across the monorepo. A `semverGroups` rule forces all internal `@kb-labs/*` dependencies to `workspace:*` (pnpm replaces with `^version` on publish).

2. **CI layer — GitHub Actions.**
   A `deps` job in [`ci.yml`](../../.github/workflows/ci.yml) and [`ci-pr.yml`](../../.github/workflows/ci-pr.yml) runs `pnpm deps:lint` on every push and PR. Any mismatch fails the build.

3. **Runtime layer — `pnpm.overrides`.**
   Critical singletons (`react`, `react-dom`, `@types/react`, `@types/react-dom`, `zod`) are pinned in the root `package.json` via `pnpm.overrides`. This forces transitive consumers — including npm-published packages outside our control — to resolve to the chosen version, preventing duplicate copies in `node_modules`.

**Developer interface:**

- `pnpm deps:check` — list mismatches (exit 1 if any)
- `pnpm deps:fix` — auto-fix where possible + format
- `pnpm deps:lint` — full check (versions + formatting) — used in CI
- `pnpm deps:list` — full dependency listing
- `pnpm deps:format` — format `package.json` fields

Agent guidance: [`.claude/skills/deps-hygiene.md`](../../.claude/skills/deps-hygiene.md).

**Workflow rules:**

- New dependency: check `pnpm deps:list` first, reuse the version already in the monorepo.
- Bumping a dependency: atomic — update everywhere in one PR, fix breakages, or don't bump at all.
- Major-version split: handled as a dedicated migration PR (`syncpack` cannot auto-resolve across majors).

## Consequences

### Positive

- **Type safety across package boundaries.** No more "works in isolation, fails at import seam" bugs from mismatched generic types (e.g. zod schemas flowing between packages).
- **No singleton duplication.** One `react`, one `zod`, one `pino` per build — runtime bugs from double-instances become structurally impossible.
- **Smaller bundles.** Module Federation and client-side bundles no longer ship duplicate libraries.
- **Cleaner lockfile.** Fewer independent resolutions → smaller `pnpm-lock.yaml` diffs → easier review.
- **CI enforcement.** Drift cannot sneak in via an unrelated PR; every PR is validated before merge.
- **Low-cost upgrades.** `syncpack` surfaces every consumer of a dependency in one command — bumping is find-and-replace plus a test run, not a codebase archaeology exercise.

### Negative

- **Major-version upgrades become workspace-wide events.** Bumping `zod` 3→4 or `react` 18→19 requires fixing every consumer in one PR. For a solo maintainer this is heavy — mitigated by treating such bumps as dedicated migration PRs (with their own ADRs if architecturally significant).
- **Cannot experiment with a new version in one package.** "Let me try `vitest@4` in this plugin only" is not possible. This is by design — partial upgrades are the exact drift SVP exists to prevent.
- **Peer warnings from npm-published packages still appear at install.** Packages fetched from npm (transitive) may declare peer ranges that don't match our pinned version (e.g. `@module-federation/enhanced` lists React 19 as a peer). These are warnings, not real installs — `pnpm.overrides` ensures the actual installed graph is consistent. The noise must be tolerated.
- **`NODE_ENV` interaction.** With `NODE_ENV=production` in the shell, pnpm skips devDependencies and `syncpack` isn't installed locally. CI is unaffected (NODE_ENV is unset there). Documented in the skill.
- **One-time migration cost.** Consolidating the existing 431 mismatches required a coordinated cleanup pass across ~40 packages (completed 2026-04-14).

### Alternatives Considered

- **Do nothing / rely on code review.** Already the status quo. Drift is invisible in isolated PR diffs; reviewers cannot hold a mental model of 170 packages. Rejected — the observed failures above are exactly what this alternative produces.
- **Per-package Renovate / Dependabot.** Keeps each package individually up-to-date but increases drift (each bot PR touches only one package). Exactly the opposite of what is needed.
- **Custom KB-Labs dependency plugin (extend DevLink).** Considered. Rejected — `syncpack` solves the version-mismatch detection problem at production quality; writing and maintaining our own detector would consume effort better spent on product. Can be revisited later as a thin wrapper on `syncpack` if KB-Labs-specific rules become valuable (layer boundaries, duck-typing plugin checks).
- **`pnpm.overrides` only, no declaration enforcement.** `overrides` forces resolution at install time but doesn't prevent source `package.json` files from drifting. Future authors reading a package think the declared version is authoritative when it isn't. Rejected — declaration must match reality.
- **Monorepo split (e.g. extract `sites/` or `studio/`).** Trades a dependency problem for a coordination problem (how do sites consume SDK changes across repos?). Rejected — the dependency problem is tractable; coordination overhead isn't, especially for a solo team.

## Implementation

**Already completed (2026-04-14 consolidation):**

- [`.syncpackrc.json`](../../.syncpackrc.json) authored with `sameRange` policy and `workspace:*` enforcement for internal deps.
- `deps:{check,fix,format,lint,list}` scripts added to root `package.json`.
- `deps` CI job added to [`ci.yml`](../../.github/workflows/ci.yml) and [`ci-pr.yml`](../../.github/workflows/ci-pr.yml).
- All 431 existing mismatches resolved to 0. Locked versions recorded in memory: `memory/project_deps_svp.md`.
- `pnpm.overrides` added to root `package.json` for the React ecosystem and `zod`.
- Pre-existing `"*"` and `workspace:^` internal dependencies fixed to `workspace:*` in `sdk/sdk`, `services/workflow/studio`, `core/plugin-execution-factory` (these bypassed the policy by resolving to npm-latest).
- Scaffolded test plugins in `.kb/plugins/` removed (they pulled npm-published `@kb-labs/*` artifacts with conflicting React 19 peer requirements).
- `next` downgraded to `^14.2.15` so it coexists with the React 18 studio host. React 19 / Next 15 upgrade deferred to a future migration ADR.
- Agent skill authored: [`.claude/skills/deps-hygiene.md`](../../.claude/skills/deps-hygiene.md).

**Ongoing:**

- Every PR runs `pnpm deps:lint` in CI — drift cannot land.
- New external dependencies are added at the version already in the monorepo, or — if a new version is intentional — the bump is applied to all consumers in the same PR.
- Major-version bumps are handled as dedicated migration PRs with explicit ADRs when the change is architecturally significant (e.g. React 18→19 will require studio-host and all plugin-studio pages updated together).

**Revision triggers:**

- A genuine cross-cutting upgrade becomes compelling (e.g. zod v4 stabilises, React 19 ecosystem matures) — open a dedicated migration ADR.
- `syncpack` becomes unmaintained — re-evaluate options (`manypkg`, Rush, or an internal tool layered on its parser).
- Transitive peer warnings become a meaningful signal rather than noise — consider an allowlist or a custom lint rule on top of `pnpm install` output.

## References

- Config: [`.syncpackrc.json`](../../.syncpackrc.json)
- CI jobs: [`ci.yml`](../../.github/workflows/ci.yml), [`ci-pr.yml`](../../.github/workflows/ci-pr.yml)
- Agent skill: [`.claude/skills/deps-hygiene.md`](../../.claude/skills/deps-hygiene.md)
- [ADR-0004 Versioning and Release Policy](./0004-versioning-and-release-policy.md) — internal package versioning, publish flow
- [ADR-0003 Package and Module Boundaries](./0003-package-and-module-boundaries.md) — layering rules that SVP complements
- [syncpack documentation](https://jamiemason.github.io/syncpack/)
- [pnpm overrides documentation](https://pnpm.io/package_json#pnpmoverrides)

---

**Last Updated:** 2026-04-14
**Next Review:** 2026-10-14 (6 months — check if peer-warning noise justifies additional tooling; re-evaluate deferred majors)
