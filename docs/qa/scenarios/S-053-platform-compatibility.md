---
id: S-053
title: Platform — refuse incompatible release selections before mutation
persona: solo-developer
area: platform-core
priority: P1
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

Resolve platform, SDK, plugin, adapter and binary compatibility before an
installation or update can change the active receipt or installed files.

## Prerequisites

- [ ] Sealed release entries for the stable platform, canary prerelease, an incompatible SDK, and a platform without the runner's OS/architecture binary.
- [ ] An installed plugin fixture whose declared platform range accepts version N and excludes N+1.
- [ ] The installer runs on a supported Linux or macOS host.

## Steps

| # | Action | Expected |
|---|---|---|
| S-053.1 | Plan with `--policy strict` for a platform/SDK pair present as an exact relation in the sealed matrix | The exact selected pair resolves and appears in the immutable plan. |
| S-053.2 | Plan the same platform against an indexed SDK admitted by the matrix range but without an exact relation, once with `--policy strict` and once with `--policy compatible` | Strict returns `KB_INSTALL_INCOMPATIBLE_COMPONENTS` with `details.kind=sdk`, `details.id=sdk`, `details.selectedVersion`, `details.requiredRange`, and `details.policy=strict`; the hint is `Use an exact platform/SDK pair from the release matrix or choose --policy compatible.` Compatible resolves only if the matrix range admits that exact SDK version. |
| S-053.3 | Install plugin `fixture-compat@N`, then run `kb-create update --platform-version N+1 --policy compatible --json` where the installed manifest range excludes N+1 | Update exits 1 as an operation failure before mutation with `KB_UPDATE_INCOMPATIBLE`; details contain `kind=plugin`, `id=fixture-compat`, `selectedVersion=N+1`, and the declared `requiredRange`; the hint matches the `KB_UPDATE_INCOMPATIBLE` catalogue template rendered with those component details. The active receipt and host remain unchanged. |
| S-053.4 | Request an adapter whose declared platform or SDK range excludes the selected release | Planning fails with `KB_INSTALL_INCOMPATIBLE_COMPONENTS`; details contain `kind=adapter`, the adapter `id`, rejected `selectedVersion`, and declared `requiredRange`; the hint is `Choose compatible versions or pass an explicit supported provider.` No installation files change. |
| S-053.5 | Request an SDK outside the platform SDK range or a platform without a binary for the runner OS/architecture | Planning fails with `KB_INSTALL_INCOMPATIBLE_COMPONENTS`; an SDK rejection identifies `kind=sdk`, `id=sdk`, `selectedVersion`, and `requiredRange`, while a missing binary identifies `details.kind=binary`, `details.id=kb-create`, and `details.target=<os>/<arch>`. The error includes a hint and leaves the active receipt unchanged. |
| S-053.6 | Attempt an update that violates an installed plugin or adapter range | `KB_UPDATE_INCOMPATIBLE` exits 1 as an operation failure and identifies the installed component, kind, target version and range, and says to update or remove that component first. The receipt and running host are preserved. |
| S-053.7 | On the Linux or macOS runner, plan from a sealed release fixture that omits the runner OS/architecture binary | Planning returns `KB_INSTALL_INCOMPATIBLE_COMPONENTS` with `details.kind=binary`, `details.id=kb-create`, and `details.target=<os>/<arch>`; the isolated install root is unchanged. |
| S-053.8 | Request `fixture-sdk-incompat@1.0.0` once with `--platform-version 3.2.0` and once with `--platform-channel stable`, omitting an explicit SDK selection in both requests | In both plans, the selected platform's companion SDK from the release matrix is `3.0.0`. Planning fails with `KB_INSTALL_INCOMPATIBLE_COMPONENTS`; details contain `kind=plugin`, `id=fixture-sdk-incompat`, `selectedVersion=3.0.0`, and `requiredRange=<3.0.0`; the hint is `Choose compatible versions or pass an explicit supported provider.` Neither isolated install root changes. |

## Pass criteria

Strict compatibility means an exact relationship in the sealed matrix;
compatible compatibility may use a valid semantic-version range declared by
that matrix. Update evaluates every plugin and adapter in the active receipt,
even when the new update request omits them. Incompatible updates fail before
the snapshot or any package/config/receipt mutation.
