# Plugin E2E matrix

Per-plugin end-to-end suites, selected by affected packages locally and by E2E zones in CI.

## Test categories

`devkit.yaml` splits the e2e domains into two categories (same `e2e-suite` preset,
same `pnpm run e2e` task, same `--affected` tracking):

| Category | Subject | Domains |
|---|---|---|
| `plugin-e2e-suite` | a specific **plugin** | `mind`, `workflows`, `marketplace`, `plugins` |
| `e2e-suite` | platform / infra layer | `services`, `platform`, `gateway`, `marketplace-registry`, `studio`, `rest-api`, `mcp` |

Each `e2e/<suite>` package `devDepends` on the plugin's `workspace:*` packages, so
kb-devkit's affected engine links them: edit `plugins/mind/**` → `@kb-labs/mind-*`
is affected → `e2e-mind` is affected → only its suite runs. Change a shared dep
(`sdk`, `core/*`) → every dependent plugin suite is affected (transitive).

## Local

```bash
# Run ONLY the suites whose plugin changed (vs the git base):
KB_DEV_BIN="$PWD/tools/kb-dev/kb-dev" ./tools/kb-devkit/kb-devkit run e2e --affected

# One suite explicitly:
KB_DEV_BIN="$PWD/tools/kb-dev/kb-dev" ./tools/kb-devkit/kb-devkit run e2e --packages @kb-labs/e2e-mind
```

The runner (`kb-labs-e2e-runner`) applies each scenario via `kb-dev ensure
--scenario …` (overlay + restart) and runs Playwright. `KB_DEV_BIN` points it at
the repo's `kb-dev` binary; without it the runner looks for `kb-dev` on `PATH`.

Suites with real-service / opt-in tests (e.g. `mind`'s real-embedder bench) **skip**
unless their env flag is set — for mind: `MIND_BENCH_REAL=1` plus live OpenAI + Qdrant.

## CI

The E2E test plan in [CI (PR)](../.github/workflows/ci-pr.yml) matches the full PR
diff against [E2E zones](./CI-ZONES.md). [Affected E2E](../.github/workflows/e2e-affected.yml)
runs the selected suites against the same merge commit as the plan. Each selected
plugin suite starts its own Docker stack.

## Adding a new plugin suite

1. Create `e2e/<plugin>/` (mirror an existing domain; `package.json` `devDepends`
   on the plugin's `@kb-labs/<plugin>-*` packages — this is the affected link).
2. Add `e2e/<plugin>` to the `plugin-e2e-suite` category in `devkit.yaml`.
3. Add `e2e/<plugin>/ci.zone.json` with the source paths the suite exercises and
   its `e2e-<plugin>` suite ID. See [E2E zones](./CI-ZONES.md) for a manifest example.
