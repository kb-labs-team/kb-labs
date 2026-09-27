# ADR-0022: External Harnesses as KB Agent Sub-agents

**Date:** 2026-09-26
**Status:** Proposed
**Deciders:** KB Labs Team
**Last Reviewed:** 2026-09-26
**Reviewers:** —
**Tags:** [agents, architecture, orchestration, integrations]

> **Note:** Tags are mandatory. Minimum 1 tag, maximum 5 tags. See approved tags list in [DOCUMENTATION.md](../../../../docs/DOCUMENTATION.md#adr-tags).

## Context

KB Labs already has an internal agent loop and sub-agent delegation. Model
providers are configured through the existing LLM configuration and are out of
scope for this decision. The missing extension point is the ability for a KB
orchestrator to delegate a bounded child task to an external agent harness such
as Claude Code or Codex CLI.

The external harness owns its own model/tool loop. KB Labs must not replace that
loop or depend on a vendor's private transcript format. At the same time, the
KB orchestrator must be able to combine harnesses: for example, ask Codex to
implement a change, then ask Claude Code to review it, and synthesize both
results. Harnesses do not need a direct peer-to-peer protocol; KB is the
mediator and source of task/session continuity.

The Vetka POC provides prior art: a vendor-neutral harness runner, per-CLI
adapters that normalize output events, executor-based routing, and a
session-bound MCP bridge for platform tools. This decision carries those
boundaries into KB Labs while integrating at the existing sub-agent spawn seam.

The initial harness package contains Claude Code and Codex CLI. Other harnesses
such as Cursor can be added as needed. Model providers and model selection
remain on the existing LLM configuration path and are not part of this
protocol.

## Decision

### Harness adapter boundary

An LLM provider supplies model API calls to the KB-native loop. An external
harness is an independently running agent runtime (usually a CLI) that owns its
own loop. Adding Claude Code or Codex as harnesses must not change model
configuration, `ILLM`, or the LLM router.

The extension unit is an external harness adapter. The initial built-in
adapters are `claude-code` and `codex-cli`. A product/model name alone is not a
harness; it is in scope only when there is an agent runtime that KB can launch
or connect to.

### Sub-agent dispatch

The existing KB sub-agent request is the logical input to dispatch. The
orchestrator resolves an execution target (KB-native or a registered external
harness) and applies the same parent-child lifecycle, nesting limit, execution
limits where measurable, cancellation, and result collection rules. Since a
CLI may not expose token usage or enforce a model-call budget, the dispatcher
must not claim a token cap it cannot enforce. External harnesses are not
alternate top-level session owners.

Harness selection is an orchestration decision, not a per-child manual CLI
step. The orchestrator receives user instructions and repository guidance
(including `AGENTS.md`) as normal prompt context; no harness-specific parser or
out-of-band `AGENTS.md` routing configuration is introduced. The orchestrator
may choose not to delegate. When it does delegate, the existing sub-agent tool
accepts an optional harness choice alongside its other task options; omission
leaves the choice to the orchestrator/default execution path. Prompt guidance
may express preferences (for example, use Codex for implementation and Claude
Code for independent review), and the orchestrator decides whether and how to
apply them. A direct user choice must not be silently overridden. The runtime
checks that a selected harness is installed and supports the requested
execution mode; if unavailable, it reports that clearly rather than silently
substituting another harness. The normal path requires no manual harness flags
or interactive selection.

Conceptual dispatch shape:

```ts
type HarnessTask = {
  executionId: string;
  parentExecutionId: string;
  task: string;
  workingDirectory: string;
  context: { messages: MessageRef[]; notes: NoteRef[]; artifacts: ArtifactRef[] };
  limits: { deadline: string; maxTurns?: number; maxOutputBytes?: number };
  access: { allowedTools: string[]; mode: 'read-only' | 'workspace-write' };
  // Runtime control channel; not serialized into the task payload.
  signal: AbortSignal;
};

interface ExternalHarnessAdapter {
  readonly id: string;
  run(task: HarnessTask, events: HarnessEventSink): Promise<HarnessResult>;
}

type HarnessResult = {
  status: 'completed' | 'failed' | 'cancelled' | 'timed-out';
  summary: string;
  artifacts: ArtifactRef[];
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number };
  error?: { code: string; message: string };
};
```

This is a protocol sketch, not a requirement to expose these exact TypeScript
names publicly. Task data crossing package boundaries must use shared agent
contracts and serializable values; the cancellation signal is a runtime control
channel. Process handles, credentials, and vendor-specific objects remain
inside the adapter/runtime.

### Events and harness-to-harness communication

The adapter translates vendor output into a small stable event vocabulary:

- `started` / `accepted`
- `progress` (optional, bounded, presentation-safe summary)
- `message` (optional user-visible response or clarification request)
- `artifact` (typed reference, not embedded file bytes)
- `completed`, `failed`, `cancelled`, or `timed-out`

Every event is bound to the child execution ID and receives a KB-generated
sequence/event ID and timestamp. Raw vendor events and full transcripts are not
the orchestration or UI contract. Adapters may retain bounded, redacted
diagnostic details for logs, but must not leak secrets or unbounded output.

Inter-harness communication is mediated by the parent orchestrator. A parent
may pass a prior child's summary, selected messages, notes, or artifact
references into a later child task. It should not forward an entire vendor
transcript by default. This enables workflows such as implement → review →
revise while keeping vendor formats isolated.

### Session, artifacts, access, and process lifecycle

KB owns parent/child execution identity, task status, normalized events,
handoff context, and artifact references. A harness's local conversation ID or
CLI session memory is optional adapter-private resume metadata, never the source
of truth. Continuation across harnesses uses the KB task context and selected
artifacts, not an assumed portable vendor transcript.

Files and other large outputs are stored or referenced as artifacts. The
parent receives a bounded summary plus typed references to changed files,
patches, tests, reports, or logs. Do not return base64/file contents or a raw
conversation dump through the parent context.

Each child receives a resolved working directory and explicit access mode. The
adapter must honor cancellation and deadline, terminate its child
process/process group, and apply a bounded termination grace period. Output and
stderr are bounded; malformed events must not crash the parent event stream or
be interpreted as successful completion.

KB tool capabilities are passed through the platform's existing tool authority
(for example, a session-bound MCP bridge) when supported. The adapter does not
mint permissions. If a harness uses its own local tools, the selected local
execution mode and its trust boundary must be explicit. A Git worktree is a
workspace boundary, not a security sandbox. Do not run untrusted repository
code with ambient credentials or imply that the harness is isolated unless
the execution environment actually provides isolation. Credentials remain in
the user's harness installation or an approved credential boundary; never put
them in prompts, session context, events, or artifacts.

Keep three concerns independent:

- **Harness** selects the agent runtime (KB-native, Claude Code, Codex CLI, and
  future adapters).
- **Tool transport** determines how capabilities are exposed (in-process
  ToolPack today; a session-scoped MCP bridge or another transport may be added).
- **Execution location** determines where the task runs (the current local
  working directory today; a worktree, container, or remote worker may be added).

The shared sub-agent policy describes semantic capabilities, not vendor tool
names. A runtime/transport resolves that policy to concrete tools and enforces
it. The current KB-native path resolves built-in presets to its tool allowlist;
external CLI adapters still use their own native tools and do not yet enforce
the KB capability policy. Do not describe those tools as equivalent until a
bridge or equivalent enforcement path exists. Adding an execution location
must not be encoded as a harness ID or overloaded into tool transport; it will
need its own workspace, isolation, credential, and cleanup contract.

Initial support is local/supervised execution of installed Claude Code and
Codex CLIs. Remote/multi-tenant execution, credential brokering, and a claim of
strong sandboxing are explicitly not implied by this protocol.

### Package and extension shape

Keep the shared contract and dispatcher vendor-neutral. Put process launching,
CLI argument construction, output parsing, feature declarations, and
vendor-specific error mapping in adapters. The initial distribution contains
the Claude Code and Codex adapters; a future harness is added by implementing
the adapter contract and passing the same conformance suite, not by adding
vendor branches to the orchestrator.

An adapter may declare optional features (streaming events, MCP tool bridge,
resume support, usage reporting, cancellation support). The dispatcher checks
features before relying on them and has a defined fallback when an optional
feature is absent. The baseline contract requires bounded task execution,
terminal status, summary, artifact references, and cancellation/deadline
handling.

## Consequences

### Positive

- KB-native agents and external harnesses become interchangeable child
  execution targets from the parent's point of view, while retaining different
  runtime implementations.
- The orchestrator can compose harness strengths without implementing a
  Codex-to-Claude or Claude-to-Codex protocol.
- Each new harness requires a focused adapter and conformance tests; the core
  dispatcher and session contract remain stable.

### Negative

- External CLI output is not guaranteed to provide exact usage, structured
  artifacts, resumability, or fine-grained progress. These remain optional
  capabilities and must not be inferred when absent.
- Local CLI execution is useful but is not by itself a security boundary.
- Harness-specific process control, permissions, and behavior require ongoing
  adapter maintenance as CLIs change.

### Alternatives Considered

- **Replace the KB-native runtime with an external harness.** Rejected because
  it would make the external CLI the top-level session owner and prevent KB
  orchestration from coordinating different harnesses as child agents.
- **Treat each harness as an LLM provider.** Rejected because a harness owns an
  agent loop and tool execution, while an LLM provider only serves model calls
  to the existing KB loop.
- **Define direct peer-to-peer protocols between harnesses.** Rejected because
  it multiplies vendor integrations and couples their session formats. KB
  mediation keeps handoff, policy, and continuity in one place.

## Implementation

The local Claude Code and Codex CLI adapter path and normalized sub-agent
events are implemented. The shared capability policy is being introduced for
KB-native dispatch; it is not yet an enforcement boundary for external CLIs.
Next implementation slices should:

1. Add the vendor-neutral adapter contract and dispatcher at the existing
   sub-agent spawn boundary, with an optional harness selection in the
   sub-agent tool's existing options. Repository instructions remain prompt
   context; no dedicated parser is added.
2. Add conformance coverage for fake-process success, launch/exit errors,
   malformed output, cancellation, deadlines, bounded output, selected and
   unavailable harnesses, and handoff context. Verify prompt context can guide
   the orchestrator's tool choice without adding an `AGENTS.md` parser.
3. Add opt-in local smoke tests for an orchestrator-selected implement → review
   handoff between the two CLIs when installed.
4. Define an adapter-neutral tool bridge that maps semantic capabilities to
   native tools or MCP tools and fails closed when required capabilities
   cannot be enforced.
5. Separately define execution-location lifecycle (local, worktree, container,
   remote) before implementing any non-local mode.

The conformance suite uses a fake CLI/process so it runs in CI without installed
vendor tools. Revisit this decision before adding remote/multi-tenant execution
or claiming isolation stronger than the configured environment provides.

## References

- Vetka POC prior art: `/Users/kirillbaranov/Desktop/work/DIT/initiatives/llm-hub/vetka-poc/apps/agent-runtime/src/harness-adapter.ts` and `docs/agent-runtime-integration.md` (local reference, not available to all contributors).
- Vetka POC lessons learned: `/Users/kirillbaranov/Desktop/work/DIT/initiatives/llm-hub/vetka-poc/docs/lessons-learned-mvp.md` (local reference, not available to all contributors).
- [Agent spawn contract](../../contracts/src/spawn.ts)
- [Agent spawner interface](../../sdk/src/spawner.ts)
- [Agent sub-agent orchestrator](../../core/src/agents/orchestrator.ts)

---

**Last Updated:** 2026-09-26
**Next Review:** —
