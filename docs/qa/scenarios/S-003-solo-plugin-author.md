---
id: S-003
title: Solo — Create & Run Plugin
persona: plugin-author
priority: P1
automation: e2e-done
e2e: tools/kb-create/v2/e2e/release_smoke_test.go
---

## Goal

Developer scaffolds a new plugin, builds it, and runs its command in their project —
the full local plugin authoring loop without publishing.

## Prerequisites

- [ ] KB Labs installed and project bootstrapped
- [ ] Valid credentials in `.env` (gateway registration succeeded)
- [ ] `pnpm` available

---

## Steps

### Phase 1 — Scaffold

| # | Action | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| 1 | `kb scaffold run plugin demo --yes` | Directory created at `.kb/plugins/demo/`, contains `package.json`, `src/`, `packages/` | | ⬜ |
| 2 | Inspect scaffold output structure | Has `packages/demo-contracts/`, `packages/demo-engine/`, `packages/demo-entry/` (or similar) | | ⬜ |
| 3 | `cat .kb/plugins/demo/packages/demo-entry/src/manifest.ts` | Contains `definePlugin(...)` with correct name and commands | | ⬜ |

### Phase 2 — Build

| # | Action | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| 4 | `cd .kb/plugins/demo && pnpm install` | Dependencies installed, no `@kb-labs/*` peer-dep errors | | ⬜ |
| 5 | `pnpm build` | Build succeeds, `packages/demo-entry/dist/manifest.js` exists | | ⬜ |
| 6 | `node -e "import('.kb/plugins/demo/packages/demo-entry/dist/manifest.js').then(m => console.log(m.default?.name ?? m.name))"` | Prints plugin name | | ⬜ |

### Phase 3 — Run in project

| # | Action | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| 8 | `kb --help` | `demo` group appears in command list | | ⬜ |
| 9 | `kb demo hello --who=World` | Prints `Hello, World from demo` | | ⬜ |

### Phase 4 — Iterate (edit → rebuild → re-run)

| # | Action | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| 10 | Edit a command handler in `src/`, change response text | | | ⬜ |
| 11 | `pnpm build` from plugin dir | Rebuilds fast (incremental) | | ⬜ |

---

## Result

<!-- PASS / FAIL / PARTIAL -->

## Bugs

## Notes
