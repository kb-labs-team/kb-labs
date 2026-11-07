---
id: S-285
title: Local installer defaults and retries
persona: solo-developer
area: install
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## Goal

Install a local platform using the saved release index and platform defaults, and recover from invalid input without losing the original command.

## Steps

| # | Action | Expected |
|---|--------|----------|
| S-285.1 | Save the verified release index in the installer location and run `kb-create plan --platform-root "$PLATFORM_ROOT" --json` | The plan uses the saved index and the release-declared Gateway and adapter defaults. |
| S-285.2 | Plan against a release index that declares a Gateway health URL but has no Gateway transport entry, first without and then with `--gateway-url http://127.0.0.1:5500` | Both plans succeed. The first uses the declared Gateway origin; the second uses the selected origin and shifted service ports. Each plan's Gateway transport address agrees with its host health URL. |
| S-285.3 | Request installer help and plan with an unknown scenario | Help and the error list the built-in scenario IDs from the scenario catalog. |
| S-285.4 | Cause a request validation error with multiple flags, including secret-bearing arguments | The retry preserves user-supplied flags in order and replaces secret values with named environment variable placeholders, without disclosing secrets or adding defaults. |
| S-285.5 | Install using a binary mirror supplied by flag, environment or the saved installer source | The installer downloads the indexed assets from the selected source, verifies their sealed digests, records the resolved source in the receipt, and reports the attempted URL on failure. |
| S-285.6 | Observe the terminal JSONL record after a failed install | Its success flag agrees with its nonzero exit code. |
| S-285.7 | Install a release with a configured npm registry and binary source | Every selected artifact is fetched from its configured source and verified against its sealed digest; a download failure identifies the attempted URL and recovery source. |
| S-285.8 | Observe a failed JSONL install | The failure appears once with its nonzero terminal exit status. |
| S-285.9 | Install with an empty platform Corepack home and a configured npm registry | The installer provisions its pinned pnpm inside the platform root using that registry; a provisioning failure identifies the version, source and `--registry`. |
| S-285.10 | Start an installed platform from a different working directory | The host validates adapter options against the manifests in the installed platform and reports any validation failure with its reason. |
| S-285.11 | Install without `KB_HOME` using an isolated home directory | Launcher and project registry state stay inside the platform root; an explicit `KB_HOME` selects the alternative location. |
| S-285.12 | Install when the destination for the `kb` command contains an unrelated file | The installer preserves the file and reports how to select another destination. |
| S-285.13 | Install locally and inspect status | Install output and status identify the Studio URL reported by the running host and offer a useful next step. |
| S-285.14 | Install with `--registry` and inspect Marketplace sources | The npm Marketplace source uses the selected registry unless an explicit Marketplace npm source was supplied. |
| S-285.15 | Install a native dependency with an isolated home | Native build cache files remain inside the platform root. |
| S-285.18 | Provision the package manager and observe a subprocess failure | The diagnostic includes bounded, redacted stderr evidence when stderr is present. |
| S-285.17 | Request Gateway health with Studio mounted and with Studio disabled | Health reports the mounted Studio URL only when Studio is mounted; status and install use the reported URL. |
| S-285.19 | With `HOME` and `KB_HOME` set to separate isolated directories, bootstrap Gateway CLI credentials and use CLI credentials and session operations | Gateway and CLI read and write credentials and session only under `KB_HOME`; `HOME/.kb` remains absent. |
