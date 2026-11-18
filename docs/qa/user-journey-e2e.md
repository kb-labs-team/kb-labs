# User-journey E2E contract

The normative scenarios are documented in
[`user-journey-scenarios.md`](./user-journey-scenarios.md). This document
describes their automation layers and release wiring.

KB Labs E2E has two layers:

1. **Technical suites** — endpoint, schema, adapter, and service tests. They
   answer whether one subsystem behaves correctly.
2. **User journeys** — release gates that answer whether a user can install
   KB Labs, configure it, start it, and reach a useful result.

Technical suites are useful diagnostics, but they are not a substitute for a
user journey. A user-journey test must fail when any step is unavailable,
silently skipped, or reports success without leaving the next required
artifact.

## Canonical first-value journey

The main source/CI E2E runs the deterministic V2 contract journey. The
post-publish V2 E2E consumes the sealed release-index and exact public
artifacts:

```text
kb-create apply + sealed release-index
  → fresh platform/project roots
  → generated receipt, config and project pointer
  → kb CLI and kb-dev
  → all services alive and reachable
  → human login + service-account registration
  → marketplace list/install through the CLI
  → scaffold a plugin
  → install/build/run the plugin
  → lint shipped workflow templates
  → submit workflow
  → observe terminal status and logs
  → update without losing plugins or credentials
```

The journey is intentionally outcome-oriented. Every arrow is a required
transition. A missing binary, a missing auth header, an invalid shipped
workflow, a non-discoverable command, or a run that never reaches a terminal
state is a failure.

The release suite is not limited to this first-value path. The full scenario
catalog also covers:

- safe platform update and confirmed platform removal without deleting project
  artifacts;
- installing, switching, exercising, and removing adapters;
- adding, editing, running, inspecting, and removing workflows;
- isolated platform/project directories and clean CI installation.

## Clean installer release gate

`e2e/journey/run.sh` builds a local candidate from the current tree, publishes
its packed packages to the existing local Verdaccio registry, seals a release
index, and serves the launcher binary, checksum file, and index from a local
HTTP origin. The runner sets `KB_CREATE_DOWNLOAD_BASE_URL` to that origin; the
installer uses the normal GitHub Releases URL whenever this variable is unset.

Each journey is a fresh Node.js Linux container with git and the workspace-pinned
pnpm 12.21.0. The container starts with an empty temporary
HOME. The matrix covers direct agent apply for every built-in scenario, the
human `install` path through a PTY (defaults and a non-default scenario), and
the Node, port, and relative-path failures. A fresh git project then checks the
installed `kb` command, first value, runtime isolation, status, doctor, and
uninstall. Results include durations, platform-root size, and the first failed
step; CI appends the same table to the job summary.

Run the complete candidate journey locally from the repository root:

```bash
e2e/journey/run.sh
```

The script installs the frozen workspace dependencies and builds packages in
dependency order, then runs journeys one at a time to fit Docker Desktop's
memory budget. It removes its Compose containers and volumes on exit. It works
on macOS with Docker Desktop because install and
runtime commands execute in isolated Linux containers; neither the host HOME
nor host KB Labs state is used. To reuse a candidate already prepared by the
build, run `e2e/journey/run.sh --no-build`. To prepare packages, the sealed
index, and release-shaped binary files without starting containers, run
`e2e/journey/run.sh --prepare-only`.

CI builds the candidate once, then fans out fresh-container journeys. The
reusable workflow is called on relevant pull requests and pushes to `master`,
and is a required dependency of the release-candidate build job. The affected
paths include the launcher, runtime, CLI, host services, adapters, plugins,
release-index preparation, and candidate packaging.

## Test layers and responsibilities

| Layer | Purpose | Example command |
|---|---|---|
| Unit/integration | Diagnose a subsystem quickly | `pnpm --filter ... test` |
| Domain E2E | Exercise a running service or plugin domain | `kb-devkit run e2e --packages @kb-labs/e2e-workflows` |
| Launcher journey | Exercise V2 request/apply/status/plugin/workflow flow | `go test ./v2/e2e/...` |
| Domain user journeys | Exercise services, marketplace, adapters and workflow examples | `kb-devkit run e2e --packages @kb-labs/e2e-workflows` |
| Post-publish smoke | Exercise published V2 artifacts and release-index | `make e2e-release-smoke` |

## No silent skips

Domain E2E may skip a suite when the domain is not part of that platform
fixture. The canonical user journey may not skip prerequisites. In particular:

- missing `kb-create`, `kb`, `kb-dev`, or install manifest is a failure;
- failed service startup or unreachable health endpoint is a failure;
- auth login succeeding while marketplace returns 401 is a failure;
- an incomplete install must have a non-zero exit code;
- workflow lint and workflow execution must be checked explicitly;
- a command is not considered available until it runs from the documented
  user project context.

## Release gate policy

The release journey must run against published artifacts, not only local
source builds. It is required after binary/npm delivery and on a scheduled
cadence. The job must upload its complete step log on failure and must fail the
workflow when the journey itself fails; a green health check or a green domain
suite cannot override a red user journey.
