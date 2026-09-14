# Release workflow — reference for special cases

Not auto-loaded. Read this only after `.claude/skills/tool-release.md` points here for a specific special case, and only with the human approval that skill requires for that case.

## Break-glass: bypassing exactly one check for one release

Bootstrap deadlock: if a package is already published broken (e.g. `workspace:*` leaked into `dependencies`/`devDependencies`), the `pack-install` gate pulls real peer deps from npm and fails on *every* subsequent release, including the one meant to fix it. Circular: fixing it needs a publish, the publish is blocked by checks, the checks are blocked by the thing not yet fixed.

This is a rare, one-off case — not a general checks-bypass mechanism. It does not authorize the bare-CLI `--skip-checks` path (still fully prohibited by critical rule #1 in the main skill, and blocked by the agent runtime's environment classifier). It's also distinct from the workflow's own `skipChecks` input (see main skill) — that one is legitimate, goes through the approval gate, and never touches `.kb/kb.config.json`.

Narrow, auditable procedure for exactly this case:

1. Only after an explicit "ok, approve" from the human in chat for this specific step — not pre-authorized, not default.
2. Identify which check actually hits the bootstrap deadlock (usually `pack-install`) — don't disable more than one check at a time.
3. Temporarily remove exactly that check from `.kb/kb.config.json` — from both the global `release.checks` and `release.flows.<flow>.checks` (the global copy still lands in the merged list for that flow otherwise — see `mergeConfigWithFlow` in `manager-core/planner.ts`). Leave every other check (`dist-exports`, etc.) active.
4. Run the release only through the `release-prepare` workflow (not `--skip-checks`, not bare CLI) — that's the only certified agent path, and the bypass stays blocked even here.
5. Immediately after, in the same pass with no intervening commits, restore the check and commit that separately ("revert emergency check bypass for `<flow>` release"). `git diff` on the config before/after should be empty.
6. Both commits (bypass + revert) reference the incident: which package was published broken and which release fixes it.

Never leave a check disabled longer than one release run, and never disable more than one at a time — needing more than one is a signal to stop and find the root cause instead of widening the bypass.

## Local Release Path — Verdaccio pre-flight, then promote (human only)

Not a path an agent can complete — the promote step needs an interactive npm OTP. For a human shipping from their own laptop: build once → publish to Verdaccio (a local registry, never touches real npm) → verify → promote the same already-committed versions to npm.

Compared to the agent's `stage`/`deliver` CI path: this re-packs from source at publish time instead of shipping one pre-verified tarball, and doesn't verify post-publish against real npm — fine for a one-off local release or registry sanity-check, but `stage`+`deliver` is the more rigorous path for anything that matters.

**Constraint:** `config.registry` (the `release` key in `.kb/kb.config.json`) is config-only — no `--registry` CLI override for `release run`. It controls where a `channel: stable` run publishes (normally Verdaccio here). `kb release promote` *does* accept a `--registry` override (defaults to `config.publish.npmRegistry`) since it's a separate, later step.

### Verdaccio setup (one-time)

Separate from the checked-in `verdaccio` kb-dev service (`.kb/devservices.dev.yaml` + `.kb/verdaccio/config.yaml`) that `release-prepare.yml`'s "Stage internal deps to Verdaccio" step brings up automatically for the `pack-install` Checks gate — that one is zero-config and ephemeral (planned versions only, for the duration of one Checks run). The manual setup below is for this section's separate use case: an actual local `channel: stable` release publish. You can reuse the same checked-in config/container for this too (`./tools/kb-dev/kb-dev ensure verdaccio --config .kb/devservices.dev.yaml --net-offset 0`) instead of steps 1-2 below — it already allows anonymous publish — but you still need step 3 (npmrc auth token) since this path shells out to `pnpm`/`npm publish` directly rather than through `release stage plan`'s own token handling.

```bash
# 1. Start Verdaccio
npx verdaccio -l 4873

# 2. Allow anonymous publish — edit ~/.config/verdaccio/config.yaml:
#    packages:
#      '@*/*':
#        access: $all
#        publish: $all       ← change from $authenticated
#      '**':
#        access: $all
#        publish: $all       ← change from $authenticated
#
#    max_body_size: 200mb    ← required for studio-app (~50MB tarball)
#
# 3. Add npmrc auth token so npm client doesn't block scoped packages:
#    echo '//localhost:4873/:_authToken=verdaccio-local' >> ~/.npmrc
#
# 4. Restart Verdaccio after config changes.
```

### Step 1 — Release to Verdaccio

```bash
# 1. Ensure Verdaccio is running on :4873 (see setup above)
# 2. Set "release": { "registry": "http://localhost:4873", ... } in .kb/kb.config.json

# 3. Full pipeline: build + bump + git commit/tag + publish to Verdaccio +
#    mandatory registry verification
NPM_REGISTRY=http://localhost:4873 NPM_TOKEN=verdaccio-local pnpm release:platform
# or:
NPM_REGISTRY=http://localhost:4873 NPM_TOKEN=verdaccio-local pnpm release:sdk
```

After this: `package.json` versions are bumped, git commit + tag exist, packages are published to and verified against `http://localhost:4873`.

> **Version drift warning:** if publish fails before the commit/tag step, `package.json` is already bumped but no tag exists. Each retry bumps again. Reset with:
> `git diff --name-only | grep "package.json" | xargs git checkout --`

### Validate from Verdaccio (optional)

```bash
curl http://localhost:4873/@kb-labs/core-platform
npm install @kb-labs/core-platform --registry http://localhost:4873
```

### Step 2 — Promote to npm

```bash
# 1. Remove "registry" from .kb/kb.config.json, or leave it — promote ignores
#    config.registry entirely, always targets config.publish.npmRegistry / real npm.

# 2. Make sure NPM_TOKEN/NODE_AUTH_TOKEN are NOT set — a stored bypass-2FA
#    token is what npm now rejects on real npm. Unset both to fall back to
#    an interactive OTP prompt (npm's normal 2FA, still works):
unset NPM_TOKEN NODE_AUTH_TOKEN

# 3. Promote exactly what step 1 committed — no re-bump, no rebuild, no re-plan.
pnpm kb release promote --scope @kb-labs/sdk

# --tag/--registry override config.publish.stableTag/npmRegistry for
# one-off or emergency promotes:
pnpm kb release promote --scope @kb-labs/sdk --tag next
```

Promote is idempotent — safe to rerun after a partial failure (already-published versions count as success).

## Canary — CLI shape (agent path is in the main skill)

The agent-safe canary path is `release-prepare` with `{"channel":"canary"}`, documented in the main skill. This is the underlying CLI shape it runs after approval, for reference:

```bash
pnpm kb release run --flow platform --channel canary --yes
pnpm kb release plan --flow sdk --channel canary   # preview only
```

Canary publishes straight to real npm under a prerelease dist-tag — no Verdaccio, no git commit, no git tag. Version is computed in-memory as `<base-version>-canary.<shortsha>`; `package.json` and git history stay untouched. Users install with `npm install @kb-labs/sdk@canary`. Deterministic per commit, so retrying a failed canary from the same commit is naturally idempotent.

## `kb release status` — drift check (git tag vs. real npm vs. recent CI)

```bash
pnpm kb release status --flow platform
pnpm kb release status --flow sdk --json
pnpm kb release status --flow platform --ci=false   # skip the gh CI lookup
```

Read-only, no side effects. Answers "what is actually stable vs. candidate right now" without hand-comparing `npm view`, `git tag`, and Actions logs:

- Finds the latest stable git tag for the flow (by semver, from `buildReleaseTag`'s pattern).
- Queries real npm (`config.publish.npmRegistry`, never Verdaccio) for a sample of the flow's packages under both the `stable` and `canary` dist-tags, and flags it if packages in the same flow disagree with each other (partial/non-atomic publish).
- Flags it if the git tag's version doesn't match what `latest` actually resolves to on npm.
- Flags it if `canary` is semver-ahead of `latest` — that's an unverified candidate, not a release, until it has a green delivery+smoke run and has been explicitly promoted.
- Best-effort pulls the last few `release-build-candidate.yml`/`release-deliver-candidate.yml` CI runs via `gh` (skipped/noted, not fatal, if `gh` isn't available).

**Already wired into `release-prepare`'s review** — the "Prepare release review" step calls this automatically and injects a "Current release status" section into the review artifact shown at `waiting_approval`, before the package table. A warning there is about the *existing* baseline, not the candidate being reviewed — it means "what you're releasing on top of isn't fully clean," not "this candidate is broken." A status-check failure (network, `gh` not authed) never blocks the review from rendering.

Source: `plugins/release/manager-core/src/status.ts` (`computeFlowReleaseStatus`), `plugins/release/manager-cli/src/cli/commands/status.ts`, wired into `.kb/workflows/scripts/release-review-artifacts.mjs`.

## `release:*:prepare` fallback scripts

Only when the workflow daemon can't be restored, and only after explicit human approval — this path has no workflow approval gate of its own.

```bash
# Dry-run (safe, no publish, no git)
pnpm release:platform:dry
pnpm release:sdk:dry

# Prepare fallback: checks, build, version bump, changelog, git commit/tag/push.
# Never touches npm. No workflow approval step — that's why it needs its own sign-off.
pnpm release:platform:prepare
pnpm release:sdk:prepare

# Manual path only (needs local NPM_TOKEN) — publishes to config.registry
pnpm release:platform
pnpm release:sdk
```

Each script: `release-preflight.mjs` (token/registry check) → `kb-devkit run build` (full topological build — must happen before the CLI process starts, since the release CLI is itself a plugin and an in-pipeline `build --affected` can invalidate its own plugin cache mid-run) → `pnpm kb release run --flow <flow> --skip-build --yes`.

## Full pipeline stages

`plan → snapshot → checks → build → verify → version bump → changelog → publish → registry verify → git tag`

- **stable**: bump persists to `package.json`, changelog written, publish targets `config.registry`, registry verification mandatory, git commit/tag/push runs. Tag is `<flow>-v<version>` — see `resolveFlowFromTag`/`buildReleaseTag` in `manager-core/src/tag.ts`.
- **canary**: bump/changelog/git are all skipped — only plan → checks → build → verify → publish, targeting `config.publish.npmRegistry` under `config.publish.canaryTag`.
- **`--skip-publish`** (what `release:*:prepare` uses): runs through changelog + git commit/tag/push, but publish/checkpoint-write/registry-verify are skipped — no npm contact needed.

```bash
--skip-checks    # skip pre-release gates
--skip-build     # skip build stage (if already built)
--skip-verify    # skip pack+install verification
--skip-publish   # prepare-only — version/changelog/git tag, never touches npm
--dry-run        # simulate everything, no publish/git
--yes            # skip confirmation prompt
--channel        # 'stable' (default) or 'canary'
```

## Pre-release checks

Configured in `release.checks` in `.kb/kb.config.json`:
- `build` — `pnpm run build` per scope
- `dist-exports` — `scripts/gates/check-dist-exports.sh` per package
- `pack-install` — `scripts/gates/check-pack-install.sh` per package
- `typecheck`, `lint`, `tests` — optional, per scope

## Version bump logic

- `auto` (default): reads conventional commits since last tag — `feat:` → minor, `BREAKING CHANGE`/`!:` → major, else patch.
- `platform` flow: lockstep — max bump across all packages → single version for all.
- `sdk` flow: independent — bumped on its own commits only.

## Changelog

- Template `corporate-ai` (LLM-enhanced via the configured LLM adapter), falls back to a simple bullet list if the LLM is unavailable.
- Groups configured in `release.changelog.groups` (Core & SDK, Gateway & API, Adapters, Plugins, Studio) — most commits land in "Other" without a conventional scope.
- Output: `.kb/release/CHANGELOG.md` (prepends new version block, deduplicates same-version).

## Config location

`release` key inside `profiles[0].products` in `.kb/kb.config.json`:

```json
"release": {
  "versioningStrategy": "lockstep",
  "channel": "stable",
  "packages": { "exclude": ["templates/*", "{{.Name}}", "@product-name/*"] },
  "flows": {
    "sdk":      { "versioningStrategy": "independent", "packages": { "include": ["@kb-labs/sdk"] } },
    "platform": { "versioningStrategy": "lockstep",    "packages": { "exclude": ["@kb-labs/sdk", "templates/*", "{{.Name}}", "@product-name/*"] } }
  },
  "publish": {
    "access": "public",
    "canaryTag": "canary",
    "stableTag": "latest",
    "npmRegistry": "https://registry.npmjs.org",
    "verifyRegistryTimeoutMs": 30000
  },
  "changelog": { "locale": "en", "groups": [ ... ] },
  "checks": [ ... ]
}
```

`channel` and `publish.*` are all optional — defaults match current stable behavior.

### Adding a new flow

```json
"my-flow": {
  "versioningStrategy": "independent",
  "packages": { "include": ["@kb-labs/my-package"] },
  "checks": []
}
```
No code changes needed — flows are config-only.

## Releasing Go binaries (kb-create, kb-dev, kb-devkit, kb-deploy, kb-monitor)

There is no independent binary release workflow or separate binary promotion path — the standalone `-binaries` tag + goreleaser flow, and the `promote-binaries.yml` / `promote-npm-release.yml` pointer-release dance described in older versions of this doc, were deleted in the release control-plane cutover. None of `release-binaries.yml`, `promote-binaries.yml`, or `promote-npm-release.yml` exist in `.github/workflows/` anymore.

Go binaries are built and sealed as part of the **`platform`** flow's own candidate: `release-build-candidate.yml`'s `if: inputs.flow == 'platform'` steps ("Build exact Go binary assets", "Generate binary manifest from checksums", "Seal unified release index") run goreleaser (`.goreleaser.yaml` still exists and is still used, just invoked from here, not from a standalone workflow) as one stage of the same candidate build/deliver pipeline described in `tool-release.md` — there's no separate binaries release to trigger. Preparing a `platform` release through `release-prepare` (canary or stable) is what produces new binaries; see `tool-release.md`'s normal agent path and stable-delivery steps for the actual commands.

## Source packages

| Package | Role |
|---------|------|
| `@kb-labs/release-manager-core` | `planRelease()`, `runReleasePipeline()`, `mergeConfigWithFlow()`, versioning strategies, `resolvePublishTag`/`resolvePublishRegistry` (`channel.ts`), `verifyAgainstRegistry` with retry (`verdaccio-verify.ts`), `buildReleaseTag`/`resolveFlowFromTag` (`tag.ts`) |
| `@kb-labs/release-manager-changelog` | Commit parsing, template rendering (`corporate-ai`) |
| `@kb-labs/release-manager-cli` | CLI commands (`plan`, `run`, `changelog`, `publish`, `promote`, `stage`, `deliver`), REST handlers. `stage`/`deliver` are the CI-thin pack-once/ship pair used by the agent path. `pack` (verification-only, `npm pack` + static checks) is a different, older command — don't confuse it with `stage` |
| `@kb-labs/release-manager-contracts` | Zod schemas, TypeScript types for REST API (`ReleaseChannelSchema`, etc.) |

## Build after changes

```bash
pnpm --filter @kb-labs/release-manager-contracts build
pnpm --filter @kb-labs/release-manager-core build
pnpm --filter @kb-labs/release-manager-cli build
```
Order matters: contracts → core → cli.
