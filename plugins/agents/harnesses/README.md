# Agent harness adapters

`@kb-labs/agent-harnesses` contains vendor-specific launch and output
normalization for local external agent CLIs. The parent orchestrator and its
sub-agent contract remain vendor-neutral.

Initial adapters:

- `codex-cli` — Codex CLI `exec --json`
- `claude-code` — Claude Code `--print --output-format stream-json`

Add a harness by defining its identifier in the shared agent contracts,
implementing its launch and event parser, registering it in the adapter map,
and extending adapter conformance tests. It must not add routing logic to
`agent-core` or change the model-provider configuration.

These adapters launch installed local CLIs with the user's existing local
authentication. They do not provide cloud execution or a security sandbox.
