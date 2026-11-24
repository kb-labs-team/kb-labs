---
id: S-322
title: Studio Marketplace — browse and install Registry packages
persona: solo-developer
area: marketplace
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [studio, api]
---

## Goal

Find a published plugin or adapter in the public Marketplace Registry and
install the selected package using its canonical Registry identity.

## Prerequisites

- [ ] Studio can reach a Marketplace Registry containing public `@kb-labs/commit` and `@kb-labs/adapters-vibeproxy` packages.
- [ ] Project A is registered and selected for plugin installation.

## Steps

| # | Action | Expected |
|---|---|---|
| S-322.1 | Open **Marketplace**, choose **Open marketplace**, and search the public catalog | Registry packages appear with their name, version, and kind; the catalog includes both plugins and adapters. The page does not list runtime manifests as published packages. |
| S-322.2 | Open a package and inspect its details | The package detail shows the canonical identity returned as `meta.identity` and its version. The display name `fullName` is not used as an install identity. |
| S-322.3 | Install a plugin package for the selected project | Studio submits the Registry identity with the selected version to the project plugin install API and reports success. |
| S-322.4 | Install an adapter package | Studio submits the Registry identity with the selected version to the adapter install API and reports success. |

## Pass criteria

Marketplace search reads public Registry summaries and package details from
the Marketplace Registry API. It presents both package kinds and uses the
canonical identity from Registry metadata for installation. This case remains
planned until Studio browser coverage exercises the Registry catalog and both
install paths.
