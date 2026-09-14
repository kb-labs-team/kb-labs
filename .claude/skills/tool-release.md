---
name: tool-release
description: KB Labs release workflow — release-prepare, checks, safe handoff to CI. Edge cases in tool-release-reference.md.
globs:
  - "plugins/release/**"
  - ".kb/kb.config.json"
  - ".kb/release/**"
---

# Release workflow

Releasing changes package versions, tags, Git history, and may trigger npm publication. Proceed only with explicit user approval.

## Critical rules

1. **A normal release only ever runs the `release-prepare` workflow.** It handles validation, checks, build, release review artifacts, approval, changelog, version bump, commit, tag, and push end to end. Never replace that chain with direct CLI calls: no `pnpm publish`, `npm publish`, `pnpm -r publish`, bare stable `pnpm kb release run`, or manual `git tag`/`git push` to simulate a release.
2. **Always pass `--flow`.** `pnpm kb release run` without `--flow` grabs all packages at once and collides `platform`'s and `sdk`'s independent release cycles. Every invocation needs `--flow platform` or `--flow sdk`, no exceptions.
3. **Changesets are gone.** `.changeset/`, `pnpm changeset`, `pnpm release` no longer exist. `plugins/release/*` is the only source of truth for versions/changelog/publish now.
4. **Never call bare `pnpm kb release run --channel ...` directly.** Stable publishing is CI's job after a tag push (`stage` → `deliver-candidate` → `launcher-smoke`, then a separate manual `promote-npm-release.yml`). Canary's only agent-safe path is `release-prepare` with `{"channel":"canary"}` (below) — its approval gate makes the publish auditable. A bare `release run --channel canary --yes` is an unapproved direct npm-publish and is prohibited the same as the stable bypass.

## Normal agent path

Always through the `release-prepare` workflow. It requires input `flow` (optional `channel`, see below), confirms the run is from `master`, then runs `Preview → Checks → Build → Release Review → Approval → Prepare → Git`. Nothing bumps or changes git refs before approval. Needs the workflow daemon running (`kb-dev start`):

```bash
pnpm kb workflow run --workflow-id release-prepare --input '{"flow":"platform"}'
pnpm kb workflow runs status --run-id <runId>
```

Valid `flow` values come from `release.flows` in `.kb/kb.config.json` (normally `platform` and `sdk`) — never omit it, never invent a value. `platform` and `sdk` are separate workflow runs.

**`skipChecks` input** (optional boolean, default `false`) skips only the `Checks` phase (`dist-exports`/`pack-install`/`typecheck`/`lint`/`tests`) — everything else, including the approval gate, still runs. Use only when Checks itself is broken and blocking an unrelated release; run `pnpm kb release checks --flow <flow>` manually afterward and don't call the release verified until that's green.

**`channel` input** (`"stable"` default, or `"canary"`) is the only agent-safe way to build canary — it keeps the approval gate; canary skips all git mutations (no bump, no commit, no tag). Approving dispatches `release-build-candidate.yml` and downloads the resulting bundle — **it does not by itself publish to npm** (verified live 2026-09-02: build succeeded, bundle downloaded to `.kb/release/candidates/<candidateId>/`, npm untouched). Actual delivery is a separate, not-auto-chained `gh workflow run release-deliver-candidate.yml` dispatch (`candidate_run_id`, `candidate_id`, `flow`, `version`, `target=canary`) — that dispatch is the real publish step and needs its own explicit human authorization in chat, same as any other npm-publish action. Needs `NPM_TOKEN`/`NODE_AUTH_TOKEN` in the daemon's environment for when delivery does run.

```bash
pnpm kb workflow run --workflow-id release-prepare --input '{"flow":"platform","channel":"canary"}'
```

The workflow pauses at `waiting_approval` with the release review, plan, changelog, and diff link ready to inspect. Approve only after the user explicitly authorizes that exact action in chat — it's a real tag + push, irreversible in git history even though it doesn't itself touch npm for stable:

```bash
pnpm kb workflow runs approve --run-id <runId>
```

After a stable approve, the workflow finishes `prepare` itself (bump, changelog, commit, tag `<flow>-v<version>`, push) — but that push does **not** by itself trigger a candidate build or publish (the `publish-npm-on-tag.yml` workflow this section used to point to was deleted in the release control-plane cutover; a tag push today has no CI listener at all). Dispatch the candidate build explicitly, same as canary, then check it:

```bash
gh workflow run release-build-candidate.yml --ref master \
  -f candidate_id=<flow>-<version>-stable-<short_sha> \
  -f commit_sha=<full tagged commit sha> -f flow=<flow> -f version=<version> -f channel=stable
gh run list --workflow=release-build-candidate.yml --limit 3
```

Once that candidate build succeeds, publishing to npm still needs its own explicit dispatch and its own human authorization in chat — same as canary delivery, just with `target=stable` this time:

```bash
gh workflow run release-deliver-candidate.yml --ref master \
  -f candidate_run_id=<the build run id above> -f candidate_id=<same candidate_id> \
  -f flow=<flow> -f version=<version> -f target=stable
```

If checks/build/approval fail before the tag is pushed, just fix and rerun the workflow — nothing is committed yet. If the tag is already pushed and the candidate build/deliver are red, don't touch git by hand (no deleting/forcing the tag) — read `gh run view <run-id> --log-failed`, fix the root cause, and redispatch `release-build-candidate.yml` against the same already-tagged commit (no need to redo `release-prepare` — the commit and tag are already correct).

## Release order

Always release `platform` first, then `sdk` — SDK may re-export platform symbols, and downstream users expect platform to be at least as new. `sdk`'s `peerDependencies` use `>=2.0.0` ranges, so releasing out of order only produces noisy peer warnings, not breakage.

## Prohibited shortcuts

- No `pnpm publish`, `npm publish`, `pnpm -r publish`, manual `git tag`, or manual `git push` to simulate a release.
- No direct `release run --skip-checks` path.
- No removing release checks except the documented one-release break-glass procedure, explicitly approved by a human — see the reference doc, and restore the check immediately after.

## Safe inspection

```bash
pnpm kb release plan --flow platform
pnpm kb release checks --flow platform
pnpm kb release run --flow platform --dry-run
pnpm kb release status --flow platform   # drift: git tag vs. real npm vs. recent CI — see reference doc
```

## Special cases — only with explicit human approval

Everything below is a deliberate exception to the workflow-first path above, not a faster way to do a normal release. Don't reach for any of it unless the user has explicitly asked for that specific case; read `.claude/skills/tool-release-reference.md` first for the full procedure:

- **Break-glass**: bypassing one release check to escape a bootstrap deadlock (e.g. a package already published broken).
- **Local Verdaccio → promote path**: a human-only, laptop-driven release path an agent can't complete (needs an interactive npm OTP).
- **`release:*:prepare` fallback**: only when the workflow daemon can't be restored — no workflow approval gate exists on this path, so it needs its own explicit sign-off.
- **Go binaries release** (kb-create, kb-dev, kb-devkit, kb-deploy, kb-monitor): a separate `-binaries` tag flow via goreleaser, unrelated to npm packages.
- Full `release` config schema, changelog/version-bump internals, and the source package map for `plugins/release/*`.
