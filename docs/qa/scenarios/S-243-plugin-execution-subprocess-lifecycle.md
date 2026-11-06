---
id: S-243
title: Plugin execution — subprocess lifecycle and cancellation
persona: solo-developer
area: plugin-execution
priority: P1
status: planned
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

Run a plugin command in a child process, stop it on cancellation or timeout,
and receive a stable exit result.

## Prerequisites

- [ ] `platform.execution.mode` is `subprocess`.
- [ ] A fixture command returns a known value, fails with a catalogued error, throws a plain `Error`, returns a malformed error envelope, runs long enough to cancel, and can spawn a child process.

## Steps

| # | Action | Expected |
|---|---|---|
| S-243.1 | Run `kb fixture execution healthy --json` | The CLI prints its JSON success result and exits with code `0`; the child and its IPC server close. |
| S-243.2 | Run `kb fixture execution typed-failure --json` | The CLI prints the catalogued error envelope and exits with code `1`. |
| S-243.3 | Run `kb fixture execution hold --json` and press Ctrl+C | The CLI reports the catalogued cancellation code, exits nonzero, and the child process and descendants exit. |
| S-243.4 | Start workflow `plugin-execution-cancel` and run `kb workflow runs cancel RUN_ID --json` | The step is cancelled with the same catalogued cancellation code as CLI cancellation; the subprocess and descendants exit. |
| S-243.5 | Run the fixture command past its configured timeout | The caller receives catalogued `KB_RUNTIME_TIMEOUT` with its generic catalogue-owned hint, not worker-pool capacity guidance; the subprocess, descendants, and per-execution IPC server close. |
| S-243.6 | In each real plugin execution backend, run a fixture handler that returns an error object without a valid hint | The shared boundary returns `KB_PLUGIN_CONTRACT_VIOLATION`; flat string details preserve the source code when present, source error class, bounded message, and `failureMode: "returned"`. Exactly one structured log entry with the same correlation ID contains those source details plus plugin ID/version and command. The response contains no stack. |
| S-243.7 | In each real plugin execution backend, run a fixture handler that throws a plain `Error` without a hint | The shared boundary returns catalogued `KB_PLUGIN_COMMAND_FAILED`; flat string details preserve the source error class, bounded message, and `failureMode: "thrown"`. Exactly one structured log entry with the same correlation ID contains those source details plus plugin ID/version and command. The response contains no stack. |
| S-243.8 | Pass a serialized module-resolution failure from handler import through the shared plugin failure normalizer | The boundary returns catalogued `KB_PLUGIN_LOAD_FAILED` with structured `plugin`, `command`, and missing `specifier` details, and uses the catalogue-owned next-step hint for plugin diagnosis. It does not classify the module-load exception as `KB_PLUGIN_CONTRACT_VIOLATION`. |

## Decision notes

- D45: “`QUEUE_FULL`, `ACQUIRE_TIMEOUT`, `WORKER_CRASHED` and container-unavailable are catalogued codes with hints. A known execution state never surfaces as `KB_RUNTIME_UNEXPECTED`.” The same rule applies to subprocess cancellation and timeout outcomes.

## Source

`core/plugin-execution-factory/src/backends/subprocess.ts` owns per-call IPC,
timeout, signal forwarding, and cleanup. `cli/runtime/src/v3/execute-command.ts`
returns exit code `1` for failed execution. Workflow cancellation passes a
signal through `services/workflow/runtime/src/runners/sandbox-runner.ts`.
