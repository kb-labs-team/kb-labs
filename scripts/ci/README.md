# Clean-machine CI checks

The Go suite command is the same entry point used by the `go-module-suite` kb-devkit check and local development. It discovers Go modules from categories whose devkit language is `go`, excluding categories declared with `releaseLane: internal-tool`; categories without a release lane remain gating. It runs non-E2E packages twice, with a fresh `HOME` and `TMPDIR` for each module and variant. Internal-tool Go tests run through their selected package tasks in the internal verification lane. Variant one is a direct short child of `/tmp`; variant two is one short child of the platform default temp directory. Before invoking Go, the suite probes the host's Unix socket pathname capacity and checks that each root can fit the TSX IPC socket path. An insufficient root fails with the named `GO_SUITE_TMPDIR_SOCKET_PATH_TOO_LONG` diagnostic. The suite clears `KB_PLATFORM_ROOT`, `KB_HOME`, `KB_NET_OFFSET`, and `GOFLAGS` for each run. It reuses the Go module and build caches outside the fresh `HOME` so clean-environment runs do not needlessly redownload dependencies or recompile every module.

Remote verification reads internal-tool membership from the optional `releaseLane: internal-tool` category field in `devkit.yaml`; categories without it keep their existing gating membership. Candidate package shards and the shared workspace build use all selected packages except internal tools. The candidate's full kb-devkit check keeps workspace checks, while its Go module suite covers gating Go categories only. Internal tools run in separate shards that build, test, and use `kb-devkit check --internal-tool-package <name>` for package-scoped checks; their stage result, stdout/stderr failure details, and GitHub `jobConclusion` appear under `internalToolResults` without changing candidate status. Stream verification keeps every affected package in its gating test shards, including internal tools. The workspace `release-boundary` check fails when a gating package declares a workspace dependency on an internal tool. `shardTimeoutMinutes` remains owned by `verification-profile.json` for both test lanes.

The remote resolver writes the changed paths produced by `remote-changed-files.mjs` as a JSON manifest and passes that manifest to `kb-devkit affected --changed-files-file`. kb-devkit still resolves package ownership and dependency closure from the real workspace configuration; the manifest avoids running the path producer as a nested workspace task.

The clikit, kb-runner, and kb-devkit test deadline helpers use `KB_TEST_DEADLINE_SCALE`. The registered suite sets it to `2` unless the caller supplies another positive multiplier. To run one module with a larger scale while retaining the suite's isolated HOME and cache setup, use `KB_TEST_DEADLINE_SCALE=3 node scripts/ci/go-module-suite.mjs --module tools/clikit`.

Run the full registered suite from the repository root:

```sh
node scripts/ci/go-module-suite.mjs
```

For a focused local run, select registered modules by their workspace paths:

```sh
node scripts/ci/go-module-suite.mjs --module tools/clikit --module tools/kb-devkit
```

Run the clean-machine check to verify the runner and workflow contracts, and run `kb-devkit check` to include the registered Go modules:

```sh
kb-devkit check --only ci-clean-machine-lanes,go-module-suite
```

The reusable installer workflow builds one candidate from the triggering revision. Container journeys run on Linux; a separate native `macos-latest` job installs that candidate and checks the installed CLI. The nightly workflow updates the status issue selected by `NIGHTLY_STATUS_ISSUE`, or finds/creates the single issue labeled `nightly-status` when the value is `0`.
