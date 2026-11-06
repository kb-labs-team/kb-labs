---
id: S-252
title: Marketplace — share a published plugin by link
persona: plugin-author
area: marketplace
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [cli, api]
---

## Goal

Give another user temporary access to a private plugin already published to the Marketplace, let them inspect and install it, and remove that access.

## Prerequisites

- [ ] The Marketplace Registry and Gateway are running. The publisher owns a private published plugin; use the Commit plugin or a deterministic published fixture.
- [ ] In secured mode, the publisher and recipient have authenticated Marketplace accounts. In local mode, the platform's local identity can publish and share.
- [ ] The recipient has a project scope selected for installation.

## Steps

| # | Action | Expected |
|---|---|---|
| S-252.1 | As the publisher, run `kb hub access add @<HANDLE>/<PLUGIN> --link --ttl 7 --json` in local mode, then repeat in secured mode with the publisher's credentials | Both modes return a share token for the published package and an expiry within seven days. A secured request without credentials returns HTTP 401 with `KB_AUTH_REQUIRED` and does not create a token. |
| S-252.2 | As the recipient, request `GET /api/v1/registry/packages/<HANDLE>/<PLUGIN>?token=<SHARE_TOKEN>` through the Gateway, then run `kb marketplace install @<HANDLE>/<PLUGIN> --token <SHARE_TOKEN> --json` in the selected project | The metadata response identifies the shared package and version; installation returns that package in `installed` and records it in the recipient's selected project. This works in local mode and in secured mode for the recipient's authenticated project. |
| S-252.3 | As the publisher, revoke the link token using the Marketplace Registry share-revocation action, then repeat S-252.2 | Revocation succeeds; the recipient can no longer view the private package or install it with the revoked token. **This is a failing claim today:** no Registry share-revocation command or route is registered. |
| S-252.4 | As a recipient who was not granted access, request `GET /api/v1/registry/packages/<HANDLE>/<PLUGIN>` and attempt `kb marketplace install @<HANDLE>/<PLUGIN> --json` without a token in local mode and in secured mode | Both attempts are denied and do not install the package. Metadata access returns HTTP 403 `Access denied`; the install reports that Registry access is denied. |

## Decision note

**D58:** “Share by link” means access to a plugin already published by another user, using Marketplace's existing share command. The release plugin is Commit; a deterministic published fixture may be used. Cover publisher share, recipient view and install, revocation, and denial without a share in local and secured modes. Current commands create allowlist access or a link token; the requested revoke outcome is a failing claim until Registry adds a revoke owner.

## Source

The publishing commands come from the installable `@kb-labs/marketplace-registry` plugin at `plugins/marketplace-registry/src/manifest.ts`; it calls the separately deployed Registry over HTTP. Metadata access, allowlisting, and token creation are in `services/marketplace-registry/api/src/routes/packages.ts`; share-token lifetime and access checks are in `services/marketplace-registry/core/src/registry-service.ts`. Recipient installation is `cli/commands/src/commands/system/marketplace/commands/install.ts`. `services/marketplace-registry/api/src/routes/packages.ts` currently has no token-revocation route.
