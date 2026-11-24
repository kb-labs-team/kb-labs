---
id: S-321
title: Marketplace Registry packages remain verifiable after service restart
persona: solo-developer
area: marketplace
priority: P1
status: planned
release: false
modes: [secured]
surfaces: [api]
---

## Goal

As a package author or installer, I can publish and install a public Registry package that remains available and verifiable after the Registry services are recreated.

## Prerequisites

- [ ] A secured single-node Registry deployment with persistent filesystem storage and a persistent State journal.
- [ ] A trusted author identity, a public Ed25519 verification key, and a disposable public plugin fixture.

## Steps

| # | Action | Expected |
|---|---|---|
| S-321.1 | Start the dedicated secured Gateway in platform scope with only the Registry upstreams and no registered user project; check `/ready`, publish the fixture through authenticated Gateway, then anonymously resolve and download its scoped tarball through the HTTPS Registry source | The Gateway starts without a fabricated project registration and reports ready when its configured Registry upstreams are ready. This platform readiness policy is explicit; standalone project-scoped Gateway keeps its existing REST readiness requirement. The Gateway host port is reachable only on loopback through a separate edge bridge, while Registry and State have no host-published ports and remain attached only to the private internal network. Publish returns a trusted signature. The anonymous resolve identifies the published version, and the tarball bytes match its integrity and verify with the configured Ed25519 public key. |
| S-321.2 | Hard-stop and recreate the Registry and State containers while retaining their named data volumes, then install the fixture through the configured Marketplace source | Registry and State become ready without manual lock cleanup or republishing. Marketplace install succeeds from the HTTPS source; the installed version, tarball integrity, and signature match the published fixture. |
| S-321.3 | Submit a publish request with a path-traversal package name and attempt a filesystem storage write to an absolute sibling path sharing the configured storage-root prefix | The Registry rejects the invalid package address before writing. The filesystem adapter rejects the sibling path, and no file appears outside the configured storage root. |
| S-321.4 | Interrupt an atomic filesystem replacement before it is committed, then read the existing Registry metadata | Registry readers see the previous complete metadata or the new complete metadata; no partial value is published as canonical metadata. |
| S-321.5 | Hard-stop and recreate the Gateway while retaining its persistent database volume, log in again with the bootstrap administrator, and request the author's package list | The same administrator identity and namespace remain available after restart, and the published package remains listed for that author. |
| S-321.6 | Request the public Registry catalog, resolve, metadata, and scoped tarball over HTTPS; then try a write method, account route, and project route, and inspect access logs for a request containing a query token | HTTPS verifies the API hostname and certificate chain. Public GET/HEAD reads reach the secured Gateway, while write, account, and project routes are not proxied. The edge returns 429 when its per-client request or connection limit is exceeded, clears caller-supplied forwarded identity headers, and omits query strings from access logs. |
