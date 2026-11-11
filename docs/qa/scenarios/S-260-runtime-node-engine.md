---
id: S-260
title: Platform runtime refuses an unsupported Node.js engine
persona: solo-developer
area: platform-core
priority: P1
status: active
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

KB Labs supports one Node.js major, declared by the root `package.json` as
`MAJOR.x`. Workspace packages repeat that value for npm metadata, and a check
keeps those declarations and the generated Go policy aligned. Installer
preflight and runtime entry points use one catalogued diagnostic for any Node.js
major outside the policy.

## Prerequisites

- [ ] An isolated installed platform whose runtime package includes its
  `package.json` with `engines.node`.
- [ ] A Node.js runtime on a major other than the declared policy major.

## Steps

| # | Action | Expected |
|---|---|---|
| S-260.1 | Run the built runtime entry point with a Node.js major below the policy. | It exits non-zero with catalogued `KB_NODE_VERSION_UNSUPPORTED`; `requiredMajor` and `actualVersion` identify the policy and running version, and the catalogue hint provides the exact next command. No raw `TypeError` appears. Claimed by `node-engine.integration.test.ts` (`reports the catalogued engine refusal under a real older Node binary`). |
| S-260.2 | Run `kb-devkit check --only node-engine-policy --json` against the workspace. | The root declaration has the single `MAJOR.x` form, every workspace package declaration equals it, and the check passes. Claimed by `check-node-engine-policy.test.mjs` (`the shipped Node policy passes the workspace check`). |
| S-260.3 | Run the Go policy generator check through `kb-devkit check --only node-engine-policy --json`. | The generated Go supported-major value matches the root policy. A root policy edit without regeneration fails the check. Claimed by `check-node-engine-policy.test.mjs` (`generated Go Node policy matches the owner and rejects root-owner drift`). |
| S-260.4 | Submit older and newer Node major versions to installer preflight and the runtime engine boundary. | Both boundaries return `KB_NODE_VERSION_UNSUPPORTED` and render message and hint from the same catalogue entry with `requiredMajor` and `actualVersion`. Claimed by `node-engine.test.ts` (`runtime rejects older and newer majors with catalogue fields`), `toolchain_test.go` (`TestNodePolicyRejectsOlderAndNewerMajorsWithCatalogDiagnostic` and `TestNodeRemediationRendersTheCatalogHint`), and `preflight_test.go` (`TestInstallerPreflightMatchesRuntimeCatalogForOlderAndNewerMajors`). |
| S-260.5 | Run the workspace Node engine policy check and inspect the delivery Compose config through its invoker. | Every tracked `FROM node:<tag>` stage uses the root policy major. The delivery Dockerfile has no default for its Node major, refuses an empty build argument, and derives the NodeSource URL from it. Compose config refuses an unset `KB_NODE_MAJOR` with a message naming root `package.json` `engines.node`; the documented invoker renders the root major into both target build args and resolves Compose through the shared owner, which supports `docker compose` and `docker-compose` and reports its catalogued missing-tool message instead of silently skipping. Unsupported image tags and unresolved image ARGs still fail with `file:line`. Claimed by `check-node-engine-policy.test.mjs` (`tracked Node image with the matching policy tag passes`; `tracked Node image with a mismatched tag fails with file and line`; `tracked Node image with an unresolved ARG fails with file and line`; `tracked Node image resolves a declared global ARG default`) and `e2e/delivery/scripts/delivery-invoker.test.mjs` (`delivery compose config rejects an unset Node policy argument`; `delivery invoker renders the root Node major to both targets through v2 and standalone Compose`; `delivery invoker reports the shared missing Compose message`). |
| S-260.6 | Build `@kb-labs/plugin-contracts`, then run the Node policy checker, documentation source sync, and Go policy generator. | Each consumer loads the parser through the package's declared `@kb-labs/plugin-contracts/node-engine-policy` export and uses the shared policy implementation; no consumer depends on the contract package's private source path. |

## Pass criteria

Every entry point that installs the platform resolve hook shares the same
engine check. The policy comes from the root package declaration copied into
the installed runtime package manifest; the actual version comes from the
running Node.js process. Go callers and agent launchers derive the major from
the same root declaration.

## Non-goals

This case does not move the Node policy to another major. Every tracked
Dockerfile using the official `node` base image follows the same policy,
including website build images. Their base-image tags are checked like
platform service and e2e container images. The policy does not constrain
Dockerfiles based on other base images.
