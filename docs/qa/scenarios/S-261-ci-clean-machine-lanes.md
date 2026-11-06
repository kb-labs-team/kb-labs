---
id: S-261
title: Local build tooling and GitHub CI prove clean-machine behavior
persona: platform-developer
area: platform-core
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

As a KB Labs maintainer, I can rely on local build tooling and CI to catch regressions in Go modules, cached build outputs, affected package selection, and the local installer on macOS.

## Steps

| # | Action | Expected |
|---|---|---|
| S-261.1 | Run `kb-devkit check` in the workspace | The local suite check reads the devkit `go-binary` registry and runs every registered module's non-e2e Go tests with a fresh `HOME`, cleared `KB_PLATFORM_ROOT`, `KB_HOME`, `KB_NET_OFFSET` and `GOFLAGS`, and two real-world temporary-directory variants: a short child of `/tmp` and one short child of the platform default temp directory. Before testing, it derives the host's Unix socket pathname capacity and refuses a variant that cannot fit the TSX IPC socket path, with a named diagnostic and an exact rerun command that sets `TMPDIR=/tmp` and preserves the registered check name or direct entry arguments. Empty registry discovery or a discovery error also fails the gate. A failing check's JSON output retains its issue detail and the exact `kb-devkit check --only <name>` rerun command. |
| S-261.2 | Open a pull request or push to `master` that triggers the installer journey workflow and inspect its native macOS smoke | The reusable workflow builds one candidate from that change and the native `macos-latest` job downloads it, runs `kb-create install` into a temporary platform root under a fresh `HOME`, then passes `kb --version`, `kb doctor --json`, `kb project add <worktree> --json`, and `kb qa cases list --json`. The Docker container matrix remains Linux-only. |
| S-261.3 | Inspect a completed nightly user journey run | Its computed scoreboard is published to the single configured GitHub issue, which is updated on later runs; the run summary and artifact retain the same scoreboard. Blocking roots are grouped by the structured error envelope captured for their failing invocations (`code` + `area`, with `stage` when present); each group lists its member root step IDs and is ordered by total unblocked claims. A failing step whose invocation has no structured envelope (including assertion failures on a successful response and timeouts) appears in a visible “no envelope” group with its step ID. An invocation row that cannot be parsed is reported by line number; JSONL records are framed only by LF, so U+0085, U+2028, and U+001C–U+001E inside a JSON string remain part of one valid row. A step that cannot run because a prerequisite failed is recorded as BLOCKED with that prerequisite's step ID, and the pyramid groups it under its failed producer. |
| S-261.4 | Run `kb-devkit run build` after one package has cached outputs | Restored regular files retain their original file mode, including read permission for other users, and restored executable outputs retain their executable bit. |
| S-261.5 | In a temporary Git workspace, build packages, commit a declared build-input change on a branch, merge it with `--no-ff`, then run `kb-devkit run build --affected`; checkout the merged branch and its merged feature branch without changing file content; then change a tracked file outside declared build inputs | The changed package and all of its workspace dependents are scheduled after the merge, and after storing that result, an unchanged-content checkout leaves input-hash selection empty. A later tracked file change outside declared task globs selects its owning package and all dependents by both Git diff and input hashes; unrelated packages remain unselected. |
| S-261.6 | Run the clikit, kb-create, and kb-devkit Go test suites with a fresh `HOME` and external network access disabled; exercise a tool that never exits and a fixture that exits before readiness | Tests invoke the exact workspace-pinned pnpm executable from the outer Corepack cache without registry access. If it is absent, the test fails immediately with catalogued `KB_TOOLCHAIN_PNPM_UNAVAILABLE` and the next command `corepack install`. A non-terminating external tool returns catalogued `KB_TOOLCHAIN_EXTERNAL_TIMEOUT` with the tool, argument summary, elapsed time, stderr tail, and exact invocation to retry; no Go-tool test waits indefinitely. The stall test arms the tool's execution budget only after the fixture signals that it wrote its stderr, so a delayed fixture start under host load is not reported as the stall itself. Readiness waiting ends with the child's exit or an independent readiness watchdog. The child package owns only its process group: after teardown, completion is confirmed by PID/start-time identity and live membership in that owned process group under the caller's context plus one teardown grace; zombies and reused group IDs are excluded. A descendant that calls `setsid`/`setpgid` leaves this ownership boundary; kb-runner's S-237 process-tree supervisor owns full-tree supervision across group changes. Successful completion means no live member of the owned process group remains; if live members remain, the wait returns a typed error naming the group and survivor PIDs within that bound. Root-identity and member observations are bounded by that same context-plus-grace limit; a blocked observation returns a typed error naming the process PID and observation. If root identity is unavailable, no member-ownership claim is made. An empty member snapshot or a reused leader identity latches the group as gone, and no later process-group snapshot can reclassify it as live. `Started.Wait` is a single-call operation like `exec.Cmd.Wait`; every concurrent or later call returns a typed error naming the root PID immediately, without waiting on the first caller's context. |
| S-261.7 | Run the kb-create Go suite with a fresh `HOME`, including a test that fails after starting an installed supervisor and a test that classifies install-root targets while another test runs concurrently | Every test that starts a host, supervisor, fakehost, or helper process registers process-tree teardown before it can fail; after the suite, the process audit reports no remaining test-owned child. Install tests resolve their service ports from test-scoped Gateway allocations rather than the default service graph ports, so concurrent lanes do not collide on default ports. |
| S-261.8 | In a fresh checkout after dependencies are installed and before any build, run `node core/plugin-runtime/src/platform-resolve/node-engine.mjs --required-major package.json` | The selector exits 0 and prints the Node major required by the root manifest; it does not require any package `dist` output. The kb-devkit Node policy check rejects selector import graphs that resolve to build output or outside-workspace dependencies. |
| S-261.9 | Run the clikit, kb-runner, and kb-devkit Go tests under host load with `KB_TEST_DEADLINE_SCALE` set | Suite results do not depend on host load. A test deadline failure reports its configured budget, elapsed time, and observed host load. |

## Evidence

Registry and environment tests cover S-261.1 through the local `go-module-suite` workspace check, which reads the `go-binary` registry; the native workflow contract test covers S-261.2; the journey scoreboard test uses the minimal x104-j86 fixture to cover structured root grouping for S-261.3, and nightly issue-sync tests cover publication. Focused Go engine tests cover S-261.4 and S-261.5. Clikit toolchain and devkit Go tests cover S-261.6. The kb-create process audit and concurrent install-port regression tests cover S-261.7. The no-dist selector fixture and resolved-import policy check cover S-261.8. Deadline helper tests and the suite environment contract cover S-261.9; the load-flake tests remain local test evidence because they depend on host load and process-table access. The external GitHub macOS smoke and nightly issue update are release evidence the orchestrator must observe on the backup repository PR and nightly run. This case remains non-release until those external outcomes are recorded.

## Round 2

The owner moved the Go module suite to local gates and specified a native macOS install from the reusable workflow's candidate artifact. The macOS container journey row was removed because GitHub macOS runners do not provide Docker.

## Round 3

The native macOS job delegates its setup to repository scripts shared with the container journey. A failing kb-devkit external check keeps the issue detail and rerun command in its JSON output.

## Round 5

The two TMPDIR variants use short roots at their real system locations. The suite checks that each root can fit a TSX Unix socket path before starting any Go package tests and reports `GO_SUITE_TMPDIR_SOCKET_PATH_TOO_LONG` when it cannot.

## Round 6

When a TMPDIR variant cannot fit the measured TSX socket path, its diagnostic includes a copyable command that reruns the same registered check or direct suite invocation with `TMPDIR=/tmp`.

## Round 7

The `child` package owns its process group, not descendants that leave it with `setsid` or `setpgid`; cancellation, identity-observation failure, and group confirmation all return within the caller's context plus one teardown grace.
