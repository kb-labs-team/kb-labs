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
| S-321.1 | Publish the fixture as a public package through the authenticated Gateway, then anonymously resolve it and download its scoped tarball through the HTTPS Registry source | Publish returns a trusted signature. The anonymous resolve identifies the published version, and the tarball bytes match its integrity and verify with the configured Ed25519 public key. |
| S-321.2 | Hard-stop and recreate the Registry and State containers while retaining their named data volumes, then install the fixture through the configured Marketplace source | Registry and State become ready without manual lock cleanup or republishing. Marketplace install succeeds from the HTTPS source; the installed version, tarball integrity, and signature match the published fixture. |
