# Autonomous development workflows

Reference workflow definitions for the **"intention → conditional release"**
autonomous development loop, driven by the KB Labs workflow engine + the
`claude` CLI + plugins (clickup, review, commit, kb-devkit).

These are **versioned source of truth**. The engine loads workflows from
`.kb/workflows/` (gitignored, per-developer runtime), so to use them:

```bash
cp services/workflow/examples/autonomous-dev/03-dev-cycle.yml .kb/workflows/
cp services/workflow/examples/autonomous-dev/05-tech-lead.yml  .kb/workflows/
kb workflow run --workflow-id 05-tech-lead --input '{"intention":"...","list_id":"<clickup-list>"}'
```

## Layers

| File | Layer | What it does |
|------|-------|--------------|
| `05-tech-lead.yml` | **L1** | intention → grounded `claude -p` decomposition → **human gate** → ClickUp tickets (acceptance-as-test) |
| `gen-epic-orchestrator.py` | **L2** | decomposition → `epic-orchestrator.yml`: one job per ticket, fans out child runs in dependency (`needs:`) order, each in its own isolated worktree |
| `03-dev-cycle.yml` | **L3** | one ticket → branch + draft PR → `claude -p` plan → **human gate** → agent writes code → quality (kb-devkit `--affected`) → AI review → commit + push → CI gate → **human merge gate** |

## Two human gates (the founder touches these)

1. **plan-review** — approve/reject the agent's implementation plan before code.
2. **Approve and Merge** — conditional release to `main`.

Everything between runs autonomously.

## Self-healing loop (engine feature)

The quality and review gates route a failure back to `agent-execute`
(`restartFrom: agent-execute`), merging the failure context into
`trigger.payload`. The agent reads `${{ trigger.payload.type_errors }}` /
`test_failures` / `ai_feedback` and fixes its own mistakes, up to
`maxIterations`. On exhaustion the gate **fails honestly** — it never degrades
into a silent false green. (Cross-job restart + the honest-fail guard live in
`services/workflow/steps/src/gate.ts` + `daemon/src/worker.ts`.)

## Notes / requirements

- The run executes in an isolated git worktree (`/private/tmp/kb-worktrees/wt_*`).
  The `Provision environment` step links `kb-devkit` onto `PATH`; the
  `Checkout Feature Branch` step forces the worktree onto the feature branch
  (and frees the branch from any stale worktree) so commits land and push.
- Quality uses `kb-devkit run <task> --affected` to scope checks to the changed
  package(s) instead of building the whole monorepo.
- Requires: `claude` CLI, `gh` CLI authenticated, `kb` with clickup/review/commit
  plugins, and a running KB Labs host.
