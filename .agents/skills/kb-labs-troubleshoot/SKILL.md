---
name: kb-labs-troubleshoot
description: Use when the user reports a KB Labs problem — service stuck, build failing, command not found, port conflict, plugin not discovered, kb-dev reports failed, pnpm install errors, or asks "what is wrong with kb-labs".
user-invocable: true
---

# KB Labs Troubleshooter

Diagnose and fix common KB Labs platform issues. Work systematically from
environment → services → plugins → build.

## Step 0: Always start with doctor

```bash
kb-create doctor
```

This checks: node version, pnpm version, platform directory, installed manifest,
git status of key files. Most problems surface here.

## Step 1: "Command not found" or "Unknown command"

Most common cause: **stale plugin registry cache after building a plugin**.

```bash
pnpm kb marketplace plugins refresh
```

If that does not help, deep clear:

```bash
pnpm kb marketplace plugins refresh
```

Then retry the command. If it is still missing:

```bash
pnpm kb --help                    # is the group even present?
pnpm kb <group> --help            # is the command in the group?
pnpm kb plugins list              # is the plugin installed?
```

## Step 2: "Plugin not found" or wrong plugins in the available list

Symptom: `Plugin not found: @kb-labs/qa` or the available list shows only
test/workspace plugins.

Cause: zombie host-agent daemon processes connected to Gateway are intercepting
plugin execution with a stale local resolver.

Fix:

```bash
pkill -9 -f "host-agent-app/dist/index.js"
ps aux | grep host-agent | grep -v grep   # must be empty
pnpm kb marketplace plugins refresh
```

Then retry the command.

## Step 3: Service stuck in `failed` / `starting` / "port in use"

```bash
pnpm kb-dev status
pnpm kb-dev logs <service>
pnpm kb-dev doctor
```

Common fixes:

```bash
pnpm kb-dev start <service> --force        # kill port conflicts then start
pnpm kb-dev restart <service>              # restart + cascade dependents
pnpm kb-dev stop <service> --cascade       # stop service + dependents
```

Rules:
- Never start services with raw `node` or `pnpm *:dev` — always use `kb-dev`.
- If the service crashes repeatedly, run with `pnpm kb-dev start --watch` and
  inspect the crash logs.

## Step 4: Dirty submodule / "worktree has modifications"

Cause: runtime files inside `.kb/` that are accidentally tracked or cross-repo
link: paths that are stale.

```bash
git status
pnpm kb devlink status
pnpm kb devlink mode set --mode=local --install
```

If the user is on a worktree, `pnpm done` style scripts intentionally skip
certain QA stages — this is expected and not a bug.

## Step 5: Build failures — "Cannot find module @kb-labs/..."

Cause: wrong build order. Dependencies are not built before dependents.

```bash
npx kb-devkit-build-order --package=<your-package>
npx kb-devkit-build-order --package=<your-package> --script | bash
```

Never run `pnpm -r build` for cross-repo build order — it does not understand
dts dependency chains. Always use the devkit build-order tool.

## Step 6: Type errors after a core change

```bash
npx kb-devkit-types-audit --package=<your-package>
npx kb-devkit-types-order --package=<your-package>
```

Rebuild in types order.

## Step 7: Cannot find `.kb/kb.config.json`

This file is the platform's main configuration. **Do not try to recreate it.**

- If the user accidentally deleted it → ask them to restore from backup or git.
- If it was never created → run `kb-create` from the project root again.
- Do not fabricate its contents.

## Step 8: pnpm install errors with "workspace:" protocol

Usually means the project's workspace yaml is missing cross-repo paths.

```bash
pnpm kb devlink mode set --mode=local --install
```

## Step 9: Still stuck

Collect diagnostics and suggest the user open an issue:

```bash
kb-create doctor --json > /tmp/kb-doctor.json
pnpm kb-dev status --json > /tmp/kb-dev-status.json
pnpm kb-dev logs <service> | tail -100 > /tmp/kb-service.log
```

## Important rules

- **Never delete `.kb/kb.config.json`** under any circumstance.
- **Never delete `.kb/mind/` or `.kb/cache/`** without asking — they may hold
  expensive precomputed state.
- **Never edit files inside `.kb/` by hand** — it is platform runtime state.
- Prefer `kb-dev` commands over raw shell kills for service management.
- Prefer `kb devlink` over manually editing package.json workspace entries.
