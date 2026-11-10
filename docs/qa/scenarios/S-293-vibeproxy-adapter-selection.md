---
id: S-293
title: Select the installed VibeProxy adapter for platform LLM calls
persona: solo-developer
area: platform-core
priority: P1
status: planned
release: false
modes: [local]
surfaces: [cli, agent]
---

## User value

A platform owner can select the installed VibeProxy adapter in platform config, use its local Anthropic Messages-compatible endpoint, and avoid silently choosing a paid model.

## Preconditions

- [ ] `@kb-labs/adapters-vibeproxy` is installed into the platform from its marketplace source.
- [ ] The platform has a fake endpoint implementing VibeProxy's Anthropic Messages protocol available for the adapter call.

## Steps

| # | Action | Expected |
|---|---|---|
| S-293.1 | Set `platform.adapters.llm` to `@kb-labs/adapters-vibeproxy` and set `platform.adapterOptions.llm.baseURL` and `platform.adapterOptions.llm.model` in platform config | The platform accepts the selection from platform config; project config does not participate. |
| S-293.2 | Load the installed adapter through the host runtime adapter loader and issue an LLM request using VibeProxy's Anthropic Messages protocol to the configured endpoint | The loader selects the adapter from the installed platform root; the Messages API response is returned and the configured model is requested. |
| S-293.3 | Select the installed adapter without configuring `model`, then construct it through the runtime adapter loader | Construction fails with catalogued error `KB_ADAPTER_CONFIG_REQUIRED` for `platform.adapterOptions.llm.model`; no model fallback is selected, and the catalogue-derived hint gives the config-set command for that key. |
| S-293.4 | Attempt to uninstall the adapter while platform config selects it for `llm` | Uninstall is refused with `KB_MARKETPLACE_ADAPTER_SELECTED`; its catalogued hint gives the `kb adapter unbind llm` command. |
