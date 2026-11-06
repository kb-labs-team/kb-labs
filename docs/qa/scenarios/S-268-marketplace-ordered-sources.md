---
id: S-268
title: Marketplace — resolve identities through ordered trusted sources
persona: solo-developer
area: marketplace
priority: P0
status: active
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

A developer installs a Marketplace entity by the install spec they would type at the Marketplace command. Marketplace resolves it from the KB Registry first, reports the manifest-owned identity and source that served it, and uses npm only as an explicit fallback when the Registry does not own the spec.

## Prerequisites

- [ ] A platform install configured with the Registry URL, its Ed25519 public key and optional auth token through environment references, plus an optional npm fallback URL.
- [ ] A published Commit plugin, a Registry-owned identity, an npm-only fixture identity, and a deliberately tampered Registry mirror response.
- [ ] The installed journey Registry service, its State dependency, and Verdaccio are reachable through their configured service addresses.

## Steps

| # | Action | Expected |
|---|---|---|
| S-268.1 | Run `kb marketplace install @kb-labs/commit --json`, then inspect its lock entry, install output, and `kb marketplace plugins doctor --json` | Registry receives install spec `@kb-labs/commit`, resolves canonical manifest identity `@kb-labs/commit`; installation reports both values, source `registry` and signature `verified`; the lock records Registry source, tarball integrity, and verified signature status; doctor reports the same provenance. The Registry signature is verified with the configured Ed25519 public key before extraction. |
| S-268.2 | Run `kb marketplace install journey-npm-only-fixture --json` when Registry reports `not-found-unowned` and npm fallback contains the identity | Installation succeeds from npm only after that structured Registry result; output, lock, and doctor identify source `npm` and signature `unsigned`. |
| S-268.3 | Attempt the same fallback identity while the Registry returns an authentication or transport failure | The install fails with the catalogued source error code and its exact next command; npm is not queried and no package or lock entry is created. |
| S-268.4 | Attempt installation when Registry signature verification fails or tarball bytes differ from the Registry integrity | The install fails with the catalogued signature or integrity error code and exact next command; npm is not queried, no package is extracted, and the lock remains unchanged. |
| S-268.5 | Attempt an npm fallback for an identity whose namespace or handle is reserved by the Registry | Registry returns `not-found-owned`; installation fails with the catalogued ownership error code and exact next command. npm is not queried and no package or lock entry is created. |
| S-268.6 | Install using the Marketplace source URL, key reference, token reference, and optional npm URL supplied to `kb-create install`; update the platform; inspect `kb-create status` and `kb-create doctor` | The resolved ordered source configuration persists across update. Both status reports show effective source kinds and URLs with credentials redacted; the referenced signing key and token values are absent from config, status, and doctor output. |
| S-268.7 | Install through a Registry mirror whose metadata is valid but whose tarball has been altered | The mirror uses the same signature and integrity policy as the primary Registry; installation fails with the catalogued integrity error code and exact next command, does not fall through to npm, and leaves package files and lock unchanged. |
| S-268.8 | Run `kb marketplace plugins doctor --json` with a Marketplace lock entry that has no source provenance | Doctor fails with the catalogue-owned provenance error and the exact `kb marketplace install <identity>` command needed to record provenance; it does not infer or fill missing source fields. |
| S-268.9 | Install with `kb-create install --scenario commit` and no Marketplace source flags, then inspect the rendered config, Marketplace health, and install receipt | The install spec is `@kb-labs/commit`; Marketplace resolves canonical identity `@kb-labs/commit` from the installed manifest. The receipt records requested spec, resolved identity, source and version. With Registry configured, the same spec is sent to Registry before the configured npm fallback. |
| S-268.13 | Install with `kb-create install --scenario commit` while the configured Marketplace sources cannot install `@kb-labs/commit`, then inspect the diagnostic, receipt, and host status | Marketplace records each source and its not-found result and returns `KB_PLUGIN_NOT_FOUND`; kb-create reports `KB_MARKETPLACE_INSTALL_FAILED` with the original Marketplace error code/message and source outcomes as cause. Its catalogue-owned retry uses the exact install spec `@kb-labs/commit`. The platform receipt remains installed and the host remains healthy. |
| S-268.14 | On a fresh Release 1 local root, run `kb-create install --json --platform-root "$PLATFORM_ROOT" --gateway-url http://127.0.0.1:4500 --marketplace-npm-url http://verdaccio:4873 --scenario commit`; inspect the receipt, Marketplace lock, plugin list, and status | The real npm-only Marketplace source installs Commit without Registry or fake Marketplace responses. The receipt preserves requested install spec `@kb-labs/commit` separately from manifest-resolved identity `@kb-labs/commit`, source `npm`, and version. The lock records package and identity `@kb-labs/commit`, plugin list reports `@kb-labs/commit`, and the platform host is healthy. |
| S-268.10 | Put an installed Marketplace plugin entry in a project lock whose `resolvedPath` uses parent segments to reach a plugin outside the project, including normalized and backslash traversal forms, then run discovery; separately add a user-created local link whose absolute `link` points to a developer plugin outside the scope and run discovery | The installed entry is rejected with structured reason `invalid-lock`; discovery does not load or register it. The local link remains the recorded user-owned pointer and discovery loads the external developer plugin from that exact path. |
| S-268.11 | Generate the container image default configuration, then resolve it as Marketplace runtime configuration | The generated `marketplace.sources` list matches the release-declared list used by local installs, and Marketplace configuration resolution completes without the missing-sources startup error. |
| S-268.12 | Install a fresh Release 1 platform with only `--marketplace-npm-url http://verdaccio:4873`; inspect the rendered config and `kb-create status` | The install accepts the npm URL without Registry flags and renders `[ { "kind": "npm", "url": "http://verdaccio:4873" } ]` as the Marketplace source list. Status reports that effective source URL. |
