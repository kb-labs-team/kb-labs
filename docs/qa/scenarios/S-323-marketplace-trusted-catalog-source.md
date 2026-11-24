---
id: S-323
title: Marketplace — trust the Registry catalog independently
persona: platform-owner
area: marketplace
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [studio, cli, api]
---

## User value

A platform owner can install packages selected from the trusted Marketplace Registry catalog while ordinary Marketplace installs keep using their existing configured package sources.

## Preconditions

- [ ] A fresh Release 1 install and an isolated Registry with a signed plugin and adapter fixture are available.
- [ ] The Registry catalog uses the production URL and public key published by the Registry deployment runbook; the fixture uses its own test key.
- [ ] The npm source fixture contains an npm-only package and records requests.

## Steps

| # | Action | Expected |
|---|---|---|
| S-323.1 | Create a fresh Release 1 platform without Marketplace source overrides; inspect `marketplace.sources` and `marketplace.catalogRegistry`, then request the Gateway Marketplace Registry catalog status | `marketplace.sources` remains the existing npm source configuration. `marketplace.catalogRegistry` independently contains the production Registry base URL and its pinned Ed25519 public key; the status reports `trustedInstallAvailable: true`. |
| S-323.2 | In Studio, open a Registry package detail and install the selected plugin or adapter using its canonical `meta.identity` and exact `meta.version`; inspect the Marketplace lock and fixture request log | The install resolves only through the separately configured Registry source, verifies the signature, records the exact version and Registry provenance, and does not issue an npm request for the selected package. |
| S-323.3 | Install the npm-only fixture package through the ordinary Marketplace install command and inspect the lock and request log | Generic Marketplace resolution uses the unchanged configured npm source; the catalog Registry source is not consulted and source order is not changed. |
| S-323.4 | Update a catalog-installed package after changing `marketplace.catalogRegistry.url` or its signing key; also configure an ordered Registry with the old URL; inspect the response, package files, lock, and request logs | The update fails with a typed configuration error identifying the recorded Registry URL and key fingerprint. It does not switch to the ordered source, even when that source has the same URL. No package files or lock entries change. |
| S-323.5 | Update a catalog-installed package when the Registry resolves its pinned identity to a different canonical identity; inspect the response, package files, lock, and request log | The update fails with an identity error before installation. It cannot install the replacement identity as a successful update, and package files and lock remain unchanged. |
| S-323.6 | Update one catalog-installed identity when another lock entry uses the same Registry package name at a higher version | The update compares versions against the selected lock identity only, then updates that identity if its own pin permits it. |

## Source

The Marketplace Registry catalog is a separate, explicitly trusted install path. It must not alter the platform's ordered package-resolution sources or silently move an installed package to another Registry origin during update.
