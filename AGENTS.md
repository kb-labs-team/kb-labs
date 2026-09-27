# KB Labs workspace

## Non-negotiable rules

- Keep dependency direction: `core` → `sdk`/`shared`/`core/plugin-*` → `cli`/`adapters` → `plugins` → `studio`.
- Internal dependencies use `workspace:*` only; never use `link:` or pinned internal versions.
- Treat every directory in `plugins/` as a plugin. Plugin pages use only `@kb-labs/sdk` and contracts, not Studio internals.
- Use `ILogger`/`ICache` from `@kb-labs/core-platform`; use `platform.logger` for a no-op logger. Do not use `as any`, `@ts-ignore`, duplicate types, or stub files to hide a problem.
- Do not alter `devservices.yaml` port assignments, `devkit.yaml` categories/presets, or `pnpm-workspace.yaml` globs without a task-specific reason.
- Do not push or amend commits unless the user explicitly asks.

## Work safely

- Search before changing unfamiliar code. Prefer `rg`; use `pnpm kb mind ask --text "…" --agent` when semantic discovery is useful, but do not make it a mandatory gate for a small, well-scoped edit.
- Build in dependency order: `kb-devkit run build` (or `pnpm build`). For incremental verification use `kb-devkit run build --affected`. Never use `pnpm -r run build`.
- Start local services through `kb-dev`; do not invoke service entry points with `node`. The repository hook requires `--config <path>` and `--net-offset <N>` for `start`, `restart`, and `ensure`. Runtime config under `.kb/` is machine-local and may be absent in a fresh checkout.
- A bug fix needs a focused regression test when a practical test boundary exists. Do not add a test merely to satisfy a rule when the change is configuration or documentation only.

## Useful locations

- Cross-cutting ADRs: `docs/adr/`; module ADRs: `<module>/docs/adr/`.
- Managed KB Labs skills: `.claude/skills/kb-labs-*/` — do not edit manually.
- Task-specific Claude guidance: `.claude/skills/*.md` is versioned with the repository; keep per-user Claude state outside this directory.
- Documentation writing: follow `.agents/skills/docs-authoring/SKILL.md` for Markdown/MDX edits; use `.agents/skills/docs-source-sync/SKILL.md` for source maps and generated examples.

## Common commands

```bash
pnpm build
pnpm check
kb-devkit run build --affected
pnpm --filter <package> test
kb-dev status
```
