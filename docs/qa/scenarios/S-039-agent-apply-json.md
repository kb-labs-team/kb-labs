---
id: S-039
title: Agent — Apply a V2 request as JSON
persona: solo-developer
area: platform-core
priority: P0
status: active
release: false
modes: [local, secured]
surfaces: [agent, cli]
---

## Goal

An automation agent installs the exact platform and project selection from a request without interactive prompts, and receives actionable machine-readable failures for invalid requests.

## Prerequisites

- [ ] Sealed release index and isolated platform/project roots.
- [ ] Valid request JSON for the success path; a separate copy can be edited for negative paths.

## Steps

| # | Action | Expected |
|---|---|---|
| S-039.1 | Run `kb-create apply --json --index release-index.json --platform-root "$PLATFORM_ROOT" --service-profile default --scenario commit --scenario-answers '{"cache":"state-broker"}'` | Exits 0; JSON has `ok: true`, `operation: "apply"`, the isolated platform root and cache provider in the request, and non-empty logPath. Marketplace receives spec `@kb-labs/commit` through the rendered source order (Registry before npm fallback); the receipt records resolved identity `@kb-labs/commit`, source and version. The plugin is absent from release-index artifacts. |
| S-039.2 | Run `kb-create status --platform-root "$PLATFORM_ROOT" --json` | Exits 0; JSON has `ok: true`, `installed: true`, `host.state: "running"`, and `installation.receiptId` equal to the receipt ID in `$PLATFORM_ROOT/current/.kb/v2/receipt.json`. |
| S-039.3 | Run `kb-create doctor --platform-root "$PLATFORM_ROOT" --json` | A healthy install exits 0 with `ok: true`; if an installed manifest requirement is missing, it exits 1 and the corresponding finding includes its `owner`, `path`, and `hint`. |
| S-039.4 | Copy `request.json`, set its required `platformRoot` field to an empty string, then run `kb-create apply --index release-index.json --input invalid-request.json --json` | Process exits non-zero and emits a JSON error envelope with stable `code`, `message`, and a hint naming `platformRoot`, telling the operator to correct `invalid-request.json`, and giving the retry command with the actual paths: `kb-create apply --index 'release-index.json' --input 'invalid-request.json' --json`; the installed platform state is unchanged. |
