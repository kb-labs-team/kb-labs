---
id: S-269
title: Marketplace — complete plugin tasks with less guesswork than npm
persona: solo-developer
area: marketplace
priority: P1
status: draft
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

A developer completes common discovery, installation, update, recovery, and publishing tasks through the KB Marketplace with compatibility, trust, scope, and recovery details visible at the decision point, and with fewer manual steps or a measured time advantage over the equivalent npm workflow.

## Steps

| # | Action | Expected |
|---|---|---|
| S-269.1 | Search the Marketplace for a plugin, inspect the result, then find and assess the same plugin through npm | Before install, Marketplace shows description, author, verified signature, and compatibility with this platform version; the equivalent npm path does not provide this platform-specific decision information in its package result. |
| S-269.2 | Install the same compatible plugin once through `kb marketplace install <identity>` and once through the equivalent npm workflow | Marketplace installs by short identity, checks SDK/platform compatibility before download, and either completes atomically or restores the prior state; the npm workflow requires the measured equivalent manual steps and does not provide the same KB compatibility gate. |
| S-269.3 | Review the proposed plugin's declared capabilities and permissions before install in Marketplace and through npm | Marketplace shows declared capabilities and permissions before mutation; the npm workflow requires separate package inspection before the same decision can be made. |
| S-269.4 | Install the same sealed fixture through Marketplace and npm with cold caches, then repeat with warm caches | Record both elapsed times and compare them on the same fixture and machine. **budget: OPEN until measured.** No speed advantage is claimed until the measurements establish a budget. |
| S-269.5 | Preview and apply an update to the same pinned plugin through Marketplace and npm, then restore the prior plugin version where supported | Marketplace preview shows changelog, compatibility, and breaking status; versions remain immutable and pinned; one-command rollback is available for the plugin update model. The equivalent npm workflow requires separate version/change review and recovery steps. |
| S-269.6 | Trigger a source, signature, or integrity failure through Marketplace, then trigger the equivalent failure through npm | Marketplace reports a typed error with the exact next command, source provenance, and trust status in output, lock, and doctor; the npm workflow's raw error does not identify the KB-specific recovery action. |
| S-269.7 | Install the same plugin for the current project and for the platform through Marketplace, then reproduce the scopes through npm | Marketplace selects project or platform scope without manual package paths and records each scope independently; the npm workflow requires the user to choose and maintain package paths manually. |
| S-269.8 | Install the same plugin through the Registry primary URL and through a configured mirror, then repeat with network unavailable and caches populated | Marketplace uses the same identity and verification policy through a mirror. Offline installation is claimed only if the cached plugin can be resolved and verified without network; npm equivalence and any advantage are recorded by the run. |
| S-269.9 | Publish a plugin through `kb hub publish`, then inspect it as a consumer and compare with publishing the equivalent package through npm | Marketplace validates the KB manifest and signs the Registry artifact automatically; consumers see yank/deprecation state. The equivalent npm workflow requires separate KB validation, signing, and consumer communication steps. |
