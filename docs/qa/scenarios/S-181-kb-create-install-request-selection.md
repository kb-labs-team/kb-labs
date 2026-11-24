---
id: S-181
title: Installer — choose a channel and seal an install request
persona: solo-developer
area: platform-core
priority: P0
status: active
release: true
modes: [local, secured]
surfaces: [cli]
---

## Goal

Choose the platform release channel and artifact source for a fresh install,
and verify that secret values do not enter the plan, request or receipt.

## Prerequisites

- [ ] Stable and canary sealed indexes with platform artifacts and fixture versions.
- [ ] Separate empty platform roots for stable, canary and secret-input installs.
- [ ] An environment variable containing a required secret.
- [ ] A strict compatibility fixture whose selected plugin is incompatible with the platform.

## Steps

| # | Action | Expected |
|---|---|---|
| S-181.1 | Run `kb-create plan --index STABLE_INDEX --platform-channel stable --policy compatible --platform-root STABLE_ROOT --json`, apply that request, then run `kb-create status`, `plan`, and `update` at `STABLE_ROOT`, `STABLE_ROOT/current`, and the physical version root; after each plan and update, run status at the same spelling | Plan JSON resolves channel `stable` to an exact platform version and artifact hashes. The apply result reports `shim.linked` and the canonical `shim.owner`; the owner is the first validated installation holding the shared command. Each receipt-backed status reports channel `stable`, that exact installed version, and the same shim owner; `linked` is true only when the stable root is that owner. Plan and update accept all three spellings as the same installation and preserve its Gateway address and single registry row without another allocation. Status after each plan and update reports the same shim ownership; every invocation leaves the `kb` shim owned by that first installation. |
| S-181.2 | Run `kb-create plan --index CANARY_INDEX --platform-channel canary --policy compatible --platform-root CANARY_ROOT --json`, apply that request, then run `kb-create status --platform-root CANARY_ROOT --json` | Plan JSON resolves channel `canary` to an exact platform version and artifact hashes; the receipt-backed status reports channel `canary` and that exact installed version. |
| S-181.3 | Run `kb-create apply --index INDEX --platform-channel stable --platform-root SECRET_ROOT --secret-env gateway.bootstrap.password=ADMIN_PASSWORD --json` with `ADMIN_PASSWORD` set, then inspect stdout, the request, the active receipt, `$KB_HOME`, and every file under `SECRET_ROOT` | Apply succeeds; no serialized output or file under `SECRET_ROOT` or `$KB_HOME` contains the secret value or environment-variable name. This includes plans, requests, receipts, rendered config, Gateway registry, logs, version directories, and temporary or backup files. The non-secret request may identify the required secret by ID only. |
| S-181.4 | Starting with a separate empty `OFFLINE_ROOT`, run an online `kb-create apply --index INDEX --platform-channel stable --platform-root OFFLINE_ROOT --json` to fetch and checksum-verify its artifacts into that root's cache, then run `kb-create plan --index INDEX --platform-channel stable --offline --platform-root PATH --json` using the install root, `OFFLINE_ROOT/current`, and the physical active version root for `PATH` | The online apply succeeds; each offline plan reports `data.plan.request.source` as `offline`; every artifact reports `resolvedFrom: "cache"` and omits `resolvedUrl`, so each spelling uses the same shared cache without registry/network resolution. |
| S-181.5 | Save the active receipt, then run `kb-create plan --index INCOMPATIBLE_INDEX --plugins fixture-plugin@VERSION --policy strict --platform-root ROOT --json` where the fixture is outside the strict compatibility matrix | Planning fails with the typed incompatibility error naming the rejected package and correction hint. The active receipt and installed files remain unchanged because refusal precedes apply. |
| S-181.6 | On the installed journey launcher, run `kb-create install --input REQUEST --index INDEX --platform-channel stable --platform-root EMPTY_ROOT --secret-env operator.unknownSecret=ENV --json`, repeat with `apply` and a second empty root, then run `update --index UPDATE_INDEX --platform-channel stable --platform-root INSTALLED_ROOT --secret-env operator.unknownSecret=ENV --json` | Each command exits 2 with `KB_INSTALL_SECRET_INPUT_INVALID` and identifies `operator.unknownSecret`. Install and apply write no files under their empty roots. Update leaves the active receipt, rendered config, and private secret-state file byte-identical. No output contains the environment-variable name or its value. |
| S-181.7 | Starting from an installer-owned empty `EMPTY_ROOT`, select an unused explicit loopback Gateway URL and pass it to the cache source plan, online cache priming install, offline install, offline reapply, and missing-artifact retry; prime each checksum-verified package and binary into its V2 cache, then run `kb-create install --offline --index INDEX --platform-channel stable --platform-root EMPTY_ROOT --gateway-url GATEWAY_URL --json` where the selected platform declares generated secret inputs; rerun `kb-create apply --offline` against that active root with the same Gateway URL; finally repeat with one cache artifact missing or corrupt | Initial install's generated-secret replan resolves from the canonical install-root cache and writes packages into the initial staging directory; the receipt is activated at the stable root and records that root and Gateway URL. Reapply resolves from the same shared cache and writes to the active version root while preserving that Gateway URL. With a missing or corrupt artifact, the CLI returns `KB_INSTALL_OFFLINE_ARTIFACT_MISSING` with the exact artifact and `details.cachePath`, without a diagnostic-contract violation. An unrelated listener on the default automatic port does not change these cache results. |

## Pass criteria

Channel selection and offline/secret inputs apply to a fresh install request.
The related update-channel and installed-version behavior remains owned by
S-023, S-024 and S-052; S-053 owns update and general compatibility checks.
This case covers install-time selection and request sealing only.
