# KB Labs workspace — Claude notes

Read `AGENTS.md` first; it contains repository-wide rules. This file records only Claude-specific behavior.

## Local vs installed CLI

Use the workspace CLI for development:

```bash
pnpm -s kb <command>
```

`kb` from `~/.local/bin` targets the installed platform, not this checkout. Do not symlink or copy a development build there. `dev-kb` is an optional interactive-shell helper, so do not rely on it in non-interactive scripts.

For JSON or pipelines, call the built workspace binary directly when it exists:

```bash
node ./cli/bin/dist/bin.js <command> --json
```

## Configuration and services

- Development configuration lives in `.kb/kb.config.json`; production-runtime selection is controlled by `platform.dir`. Change modes only when the task calls for it.
- `kb-dev start`, `restart`, and `ensure` require both `--config <path>` and `--net-offset <N>` in this repository.
- The normal runtime configs are `.kb/devservices.yaml` and `.kb/devservices.dev.yaml`, but they are machine-local and can be absent in a fresh checkout. Inspect the available config or complete platform setup before starting services. Do not edit ports to work around a collision; choose an appropriate network offset instead.

## Release safety

- Treat releases as an explicit user-authorized operation.
- Use the `release-prepare` workflow with a named flow (`platform` or `sdk`) for an actual release. Do not run `pnpm publish`, manually create/push a tag, or bypass release checks.
- `release:*:prepare` is an emergency fallback only after explicit approval; it does not publish to npm.

## Available local context skills

These flat skills are auto-loaded by their `globs`; consult only the one matching the task:

- `dev-plugin.md`, `dev-core.md`, `dev-monorepo.md`
- `new-route.md`, `deps-hygiene.md`, `docker-build-hygiene.md`, `worktree-isolated-stack.md`
- `tool-kb-dev.md`, `tool-kb-devkit.md`, `tool-kb-deploy.md`, `tool-kb-monitor.md`, `tool-release.md`, `tool-generate.md`
- `commit.md`, `marketplace-rehash.md`, `aeza-proxy.md`, `kb-labs-site-voice.md`, `clickup.md`
- `docs-authoring.md` — auto-loaded for Markdown and MDX edits across the repository.

The `kb-labs-*` folders are managed by KB Labs and are intentionally not maintained here.

For documentation writing, follow `.claude/skills/docs-authoring.md` (mirrored for agents in `.agents/skills/docs-authoring/SKILL.md`). For source-backed examples and staleness mapping, also follow `.claude/skills/docs-source-sync.md` (mirrored in `.agents/skills/docs-source-sync/SKILL.md`).

## Logging

Platform-backed processes use `IContextLogger` from `@kb-labs/core-platform`. Create root context in the launcher, derive scopes with `forComponent`, `forOperation`, or `forPlugin`, and keep diagnostics structured and secret-free. See `docs/adr/0036-platform-log-context-contract.md` for the full contract.
