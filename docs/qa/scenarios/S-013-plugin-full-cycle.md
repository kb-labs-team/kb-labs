---
id: S-013
title: Plugin — Full authoring cycle
persona: plugin-author
priority: P0
automation: e2e-done
e2e: tools/kb-create/v2/e2e/release_smoke_test.go
---

## Goal
Developer scaffolds a plugin, builds it, runs it locally, iterates on it, and it works end-to-end.
Extends S-001 Phase 5 — isolated scenario for the plugin authoring loop.

## Prerequisites
- [ ] KB Labs installed with fresh platform (`--platform /tmp/qa-platform`)
- [ ] Valid credentials in `.env` (gateway registration succeeded, or not required for local commands)
- [ ] `pnpm` available

---

## Steps

### Phase 1 — Scaffold

| # | Action | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| 1 | `kb scaffold run plugin my-plugin --yes` | `.kb/plugins/my-plugin/` created with correct structure | | ⬜ |
| 2 | Structure has `packages/my-plugin-contracts/`, `my-plugin-engine/`, `my-plugin-entry/` | All three packages present | | ⬜ |
| 3 | `manifest.ts` has `definePlugin(...)` with correct name | Plugin definition correct | | ⬜ |
| 4 | Entry registered in `.kb/marketplace.lock` | Lock has `@kb-labs/my-plugin` entry | | ⬜ |

### Phase 2 — Build

| # | Action | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| 5 | `cd .kb/plugins/my-plugin && pnpm install` | No peer-dep errors for `@kb-labs/*` | | ⬜ |
| 6 | `pnpm build` | Succeeds, `dist/manifest.js` exists | | ⬜ |
| 7 | `dist/manifest.js` passes CLI validation | `kb diag --command "my-plugin <cmd>"` shows no MANIFEST_VALIDATION_FAILED | | ⬜ |

### Phase 3 — Run

| # | Action | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| 9 | `kb my-plugin hello --who=World` | `Hello, World from my-plugin` | | ⬜ |
| 10 | `kb my-plugin hello --json` | Valid JSON output | | ⬜ |
| 11 | `kb my-plugin ping` | Health ping response | | ⬜ |

### Phase 4 — Iterate

| # | Action | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| 12 | Edit handler, change response text, `pnpm build` | Rebuilds fast (incremental) | | ⬜ |

### Phase 5 — Type safety

| # | Action | Expected | Actual | Status |
|---|--------|----------|--------|--------|
| 14 | `pnpm type-check` in plugin dir | No TypeScript errors | | ⬜ |
| 15 | Introduce a type error, `pnpm build` | Build fails with clear TS error | | ⬜ |

---

## Result
## Bugs
## Notes
