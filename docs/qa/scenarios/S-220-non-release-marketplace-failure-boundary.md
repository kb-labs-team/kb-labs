---
id: S-220
title: Marketplace — report install and internal failures through the API boundary
persona: platform-maintainer
area: platform-core
priority: P1
status: active
release: false
modes: [local]
surfaces: [api]
---

## Goal

Verify that Marketplace package identity, forward-only updates, install failures,
and unexpected errors keep typed outcomes through the API boundary.

## Steps

| # | Action | Expected |
|---|---|---|
| S-220.1 | With a local registry publishing a fresh adapter whose catalog version has no `dist.integrity`, run `kb marketplace install @kb-labs/test-adapter --scope platform --json` | pnpm keeps the direct package under `minimumReleaseAge`; the CLI returns the catalogued `KB_MARKETPLACE_PACKAGE_TOO_FRESH` error, a correlation ID, and a hint to retry after the release-age window. Raw pnpm output is absent, and the correlated Marketplace API log retains the package-manager cause. |
| S-220.2 | In the Marketplace API integration harness, make the package source throw an unexpected error during `POST /api/v1/marketplace/packages/install` | The API returns HTTP 500 with the canonical `KB_RUNTIME_UNEXPECTED` failure envelope and correlation ID. The Marketplace API emits an error log with the same correlation ID; the internal exception text is absent from the response. |
| S-220.3 | In the Marketplace API integration harness, submit an install request without the required `specs` field | The API returns HTTP 400 with the canonical `KB_RUNTIME_INPUT_INVALID` failure envelope and correlation ID, and emits an error log with the same correlation ID. |
| S-220.4 | In the Marketplace npm-source integration harness, make the local registry's tarball disagree with its catalog integrity for an exact version | Installation returns `KB_MARKETPLACE_INTEGRITY_MISMATCH`; the package is absent from `node_modules` and the marketplace lock is unchanged. The correlated Marketplace API log retains the mismatch cause. |
| S-220.5 | With a fresh local registry package at an exact version and matching integrity pin, give that package a fresh transitive dependency, then run the Marketplace install | pnpm refuses the unrelated transitive dependency with `KB_MARKETPLACE_PACKAGE_TOO_FRESH`; the failed install restores `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` to their exact pre-install contents, and no package is recorded as installed. |
| S-220.6 | Install `@kb-labs/test-adapter@1.0.0` from a local registry, then make that same version's registry integrity differ from the installed Marketplace lock and install it again | Marketplace returns HTTP 409 with catalogued `KB_MARKETPLACE_VERSION_IMMUTABLE`. The response identifies the already-pinned version as immutable and says to publish a higher version, then run `kb marketplace install @kb-labs/test-adapter@latest --scope platform`; the installed package and lock entry remain unchanged, and the correlated log retains the integrity cause. |
| S-220.7 | With `@kb-labs/test-plugin@1.4.0` installed, make registry latest resolve to `1.4.0`, then run `kb marketplace update @kb-labs/test-plugin --scope project --json` | Marketplace returns catalogued `KB_MARKETPLACE_VERSION_NOT_HIGHER`, names installed version `1.4.0`, says only a higher version can be installed, and leaves the installed package and lock unchanged. |
| S-220.8 | With `@kb-labs/test-plugin@2.0.0` installed, make registry latest resolve to `1.9.0`, then run `kb marketplace update @kb-labs/test-plugin --scope project --json` | Marketplace returns catalogued `KB_MARKETPLACE_VERSION_NOT_HIGHER`, names installed version `2.0.0`, says only a higher version can be installed, and leaves the installed package and lock unchanged. |
| S-220.9 | With `@kb-labs/test-plugin@1.4.0` installed, make registry latest resolve to `1.5.0`, then run `kb marketplace update @kb-labs/test-plugin --scope project --json` | Marketplace installs `1.5.0`, records its integrity as the new pin, and leaves the old immutable version intact in the registry. |
| S-220.10 | With an unrelated package installed in the scope, make a local registry install reach pnpm but fail Marketplace's post-install integrity verification | Marketplace returns a typed integrity refusal. `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` are byte-identical to their pre-install contents; the unrelated package still resolves, and the refused package is absent from `node_modules`. |
| S-220.11 | With a local registry publishing an adapter whose installed manifest fails Marketplace validation after pnpm installs it, run the Marketplace service install boundary | Marketplace returns catalogued `KB_ADAPTER_MANIFEST_LOAD` with a correlation ID and manifest repair hint. The service rolls back the package-manager files, lock, manifest cache, and installed package graph to their exact pre-install state. |
| S-220.12 | In the Marketplace npm-source integration harness, issue `POST /api/v1/marketplace/packages/install` for `@kb-labs/test-adapter` with scope `platform`; make pnpm add fail after a partial manifest change and make the following offline recovery fail, with a sentinel secret in both child-process errors | The API returns `KB_MARKETPLACE_INSTALL_FAILED` with a safe cause that identifies the typed install-failure code and recovery-failure code. The correlated Marketplace log records the same codes and request ID. The response and log omit the underlying error text, sentinel secret, and scope-root path. |
