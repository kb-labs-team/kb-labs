# kb-create: declarative flow engine and scenario catalog

> **Status:** implementation-ready draft; awaiting architecture approval
> **Created:** 2026-07-25
> **Scope:** replace the current scenario-specific Go wizard/installer logic with a declarative flow engine for humans and agents, plus a direct deterministic install path for CI.
> **Compatibility:** no backward-compatibility layer; existing scenarios are migrated to the new contract.

## Goal

Make `kb-create` a generic runtime with two orchestration paths over one
installation core:

1. **Scenario flow** for humans and agents. The product team describes
   `commit`, `release`, `custom`, and `plugin-author` as JSON: pages, sections,
   fields, defaults, component choices, capability providers, completion text,
   and recovery policies.
2. **Direct install** for CI. CI supplies plugins, services, adapters, and an
   optional config file. It never evaluates a scenario, asks a question, or
   applies product-flow defaults.

The Go implementation should contain only generic primitives:

- catalog compilation, loading, and validation;
- page/field rendering;
- answer-source resolution and condition evaluation;
- capability resolution;
- install-plan compilation;
- plan execution;
- structured events and errors;
- common human/agent flow semantics;
- deterministic direct-install semantics.

There must be no `if intent == ...` branches in the engine or installer.

For identical resolved component/provider/config inputs, scenario flow and
direct install must compile the same `InstallPlan` and `planHash`.

## Product and architectural decisions

### 1. JSON is the product contract

The scenario manifest is the source of truth for the user journey. It owns:

- scenario identity and copy;
- pages, sections, and fields;
- defaults and conditional visibility;
- user choices;
- requested components and provider preferences;
- references to consent/data-boundary policies;
- safe command references and completion handoff;
- scenario-specific recovery routing.

All component facts remain in the existing component manifests emitted by
services, plugins, and adapters. A scenario references component IDs; it does
not duplicate package names, `requires`, `provides`, runtime ports, or
`configSection` values. Component/provider manifests also own their config
schema, defaults, secret requirements, and semantic config bindings.

### 2. One catalog is consumed at runtime

Before publishing/building `kb-create`, the platform produces an aggregated
catalog containing:

```text
component manifests + package/release metadata
  → normalized components, capabilities, providers, config schemas
scenario manifests
  → pages, fields, defaults, selection, recovery, completion references
```

The launcher embeds or loads this catalog. It must be self-contained for
pre-install validation: it cannot depend on discovering packages in
`node_modules` after installation to decide whether the selected scenario is
valid.

The component manifests remain the canonical source; aggregation is a release
artifact, not a second hand-maintained model.

### 3. Human, Agent, and CI are separate drivers

The three modes do not share an orchestration shell:

```text
Human:
  scenario → TTY answers → flow engine → InstallRequest

Agent:
  scenario → structured input requests/answers → flow engine → InstallRequest

CI:
  flags/config/catalog defaults → DirectInstallCompiler → InstallRequest
```

Human and Agent use the same scenario graph, field definitions, defaults,
conditions, and validation. They differ in how input requests and flow events
are transported.

CI does not load or evaluate scenario pages. Its contract is deliberately
small and deterministic:

```bash
kb-create install \
  --plugins='plugin:@kb-labs/release' \
  --services='service:state-daemon' \
  --adapters='cache=adapter:state-broker' \
  --config=.kb/install.ci.json \
  --output=json
```

CI input precedence is fixed:

```text
explicit CLI flags
  → direct-install config file
  → generated catalog defaults
```

Environment variables may provide declared secrets and package-manager
credentials, but must not silently change component/provider selection.
Missing required values fail with a complete structured report; CI never
prompts or waits for stdin.

### 4. The flow engine owns Human/Agent behavior

Scenario JSON selects generic controls and supplies content. It does not define
keyboard handling, navigation, loading animations, error layouts, or retry
behavior.

Human and Agent drivers use the same flow semantics:

```text
HumanDriver: interactive TUI input + terminal event presentation
AgentDriver: structured input requests + JSON/NDJSON events
future WebDriver: web input + web event presentation
```

An input source and an event presenter are separate contracts. A driver may
implement both, but the engine does not assume that rendering a question also
produces its answer.

### 5. The installer executes a compiled plan

The installer never resolves product intent. Scenario flow and direct install
both produce an `InstallRequest`. The shared resolver/compiler turns it into a
fully resolved `InstallPlan`; the installer executes the plan and reports
structured progress/errors.

```text
scenario + answers ───────────────┐
                                  ├→ InstallRequest
CI flags/config/defaults ─────────┘
  → component/capability resolution
  → InstallPlan
  → confirmation
  → executor
  → config + readiness checks
```

Confirmation is a Human/Agent flow concern. Direct CI install executes only
when the invocation itself explicitly authorizes execution; a plan-only command
never mutates state.

## Manifest contracts

### Scenario manifest

```json
{
  "schema": "kb.scenario/1",
  "id": "commit",
  "title": "Prepare my commits",
  "description": "Create a reviewable commit plan from current changes.",

  "pages": [
    {
      "id": "provider",
      "title": "AI provider",
      "description": "Choose how commit messages should be generated.",
      "sections": [
        {
          "id": "llm",
          "title": "Language model",
          "fields": [
            {
              "id": "providers.llm",
              "type": "provider",
              "capability": "llm",
              "label": "Provider",
              "allowNone": true,
              "configure": true,
              "sources": [
                { "from": "invocation" },
                { "from": "scenarioDefault", "value": "none" }
              ]
            }
          ]
        }
      ]
    },
    {
      "id": "review",
      "type": "summary",
      "title": "Ready to install"
    }
  ],

  "selection": {
    "plugins": ["plugin:@kb-labs/commit"]
  },

  "resolution": {
    "providerPreferences": {
      "cache": ["adapter:state-broker", "adapter:redis-cache"],
      "storage": ["adapter:fs-storage"]
    }
  },

  "completion": {
    "commandRef": "plugin:@kb-labs/commit#commit.generate",
    "title": "Your commit plan is ready to generate"
  }
}
```

`release`, `custom`, and `plugin-author` use the same schema. Their difference
is data, not engine code.

`commandRef` resolves against the selected plugin's command manifest. Command
path, description, operation type, required capabilities/inputs, and data
boundary come from that command declaration. Scenario JSON may add
outcome-oriented completion copy, but cannot redefine command safety or
requirements.

### Common field contract

Initial field types:

```text
directory
choice
multiChoice
provider
text
secret
confirm
```

Every field has a stable `id`, typed value, label, optional description, and
validation metadata. The engine supports:

```text
sources
visibleWhen
enabledWhen
requiredWhen
validation
```

Every field declares its own ordered value sources. There is no global,
mode-dependent default precedence hidden in Go:

```json
{
  "id": "project.dir",
  "type": "directory",
  "sources": [
    { "from": "invocation" },
    { "from": "detector", "id": "cwd" },
    { "from": "scenarioDefault", "value": "." }
  ]
}
```

Human and Agent use these sources identically. A direct CI install has its own
fixed request precedence and does not evaluate scenario field sources.

Fields only collect and validate values. They never write files, mutate config,
or install packages. Provider/component manifests declare secret/config
requirements; the plan compiler turns resolved values into `SecretBinding` and
`ConfigPatch` actions. Secrets are never placed in persisted flow state,
install state, event payloads, or logs.

### Restricted expressions

Conditions use a small JSON predicate AST so references can be validated when
the catalog is built:

```json
{
  "all": [
    { "ref": "answers.providers.llm", "op": "neq", "value": "none" },
    { "ref": "facts.project.isGitRepository", "op": "eq", "value": true }
  ]
}
```

Supported nodes are `all`, `any`, `not`, `present`, `eq`, `neq`, `in`, and
typed comparisons. References may target `answers`, detected `facts`, resolved
`providers`, and normalized `error` state. No string expression parser,
JavaScript, Go, shell, or arbitrary code is evaluated from JSON.

### Component and capability resolution

The generated catalog joins component manifests with package/release metadata.
Existing manifests do not consistently contain install coordinates, and their
internal version may differ from `package.json`; the catalog compiler must make
that mismatch explicit rather than silently choosing one.

```json
{
  "schema": "kb.catalog/1",
  "catalogVersion": "2.107.0",
  "engine": {
    "schema": "kb.flow/1"
  },
  "components": {
    "plugin:@kb-labs/commit": {
      "kind": "plugin",
      "manifestId": "@kb-labs/commit",
      "package": "@kb-labs/commit",
      "packageVersion": "2.107.0",
      "manifestDigest": "sha256:..."
    }
  }
}
```

Canonical component identity is namespaced (`plugin:`, `service:`, `adapter:`,
`binary:`). Scenario references and dependencies use only canonical IDs. Short
launcher aliases such as `commit` or `review` are not a second identity system;
human-friendly names are presentation metadata.

The compiler records provenance and rejects:

- duplicate canonical IDs;
- package/manifest identity conflicts;
- unexplained package/manifest version conflicts;
- missing install coordinates;
- unsupported catalog/flow schema;
- non-deterministic catalog output.

No backward-compatible parser is required. An unsupported schema fails early
with `CATALOG_SCHEMA_UNSUPPORTED`.

The resolver reads requirements from component manifests:

```text
selected plugin commit
  → requires storage, cache
  → storage provider: fs
  → cache provider: state-broker
  → state-broker requires state-daemon
  → add adapter/service/package/config bindings
```

Capability requirements and provider declarations are structured. A plain
`"cache"` requirement is insufficient because different consumers need
different semantics:

```json
{
  "requires": [
    {
      "capability": "cache",
      "features": ["kv", "ttl", "patterns"],
      "durability": "ephemeral-ok",
      "distribution": "single-node-ok"
    }
  ]
}
```

```json
{
  "provides": [
    {
      "capability": "cache",
      "features": ["kv", "ttl", "patterns"],
      "durability": "ephemeral",
      "distribution": "single-node"
    }
  ]
}
```

A provider may contribute:

- one or more capabilities;
- packages;
- required services;
- adapter bindings;
- environment requirements;
- config fragments;
- readiness checks.

The resolver must fail before package installation if a required capability has
no valid provider or if the graph contains an unknown ID or cycle.

StateBroker may be the preferred minimal cache provider for local scenarios
only after its adapter manifest truthfully declares the implemented feature
set. The current StateBroker contract does not implement the complete `ICache`
surface (notably sorted-set and atomic operations), so it must not advertise
those features. A consumer requiring them resolves to Redis or fails before
installation. StateBroker must not silently satisfy `durableState` unless it
has a persistent backend.

## Flow runtime contracts

### Input requests, answer sources, and events

The engine is a pure state machine around three transport-neutral contracts:

```go
type AnswerSource interface {
	Resolve(ctx context.Context, request InputRequest) (AnswerResult, error)
}

type EventSink interface {
	Emit(ctx context.Context, event FlowEvent) error
}

type FlowEngine interface {
	Advance(ctx context.Context, state FlowState) (Transition, error)
}
```

`InputRequest` contains the field schema, current non-secret value, validation
constraints, allowed options, and why the value is needed. `AnswerResult` is
one of:

```text
resolved(value, source)
missing
cancelled
invalid(validation errors)
```

Every answer, regardless of source, passes through the same field validator.
Renderers never validate independently.

### Common UI kit contract

The engine does not render Bubble Tea widgets directly. It projects the active
page into a transport-neutral `ScreenModel`:

```go
type ScreenModel struct {
	ID          string
	Title       string
	Description string
	Sections    []SectionModel
	Actions     []ActionModel
	Errors      []UIError
}

type FieldModel struct {
	ID, Label, Description, Placeholder string
	Kind                               ControlKind
	Required, Secret                   bool
	Value                              RedactedValue
	Options                            []OptionModel
	Errors                             []UIError
}
```

The first engine UI vocabulary is fixed: `text`, `textarea`, `secret`,
`select`, `multiselect`, `confirm`, `path`, and `number`. A scenario cannot
register a custom widget or attach rendering code. If a new interaction is
needed, it becomes a reusable UI-kit control with behavior and accessibility
tests shared by every driver.

The UI model is derived from flow state and is never authoritative. It may
contain current non-secret values, but secret values are always omitted or
redacted. Field errors, page errors, recovery actions, disabled states, and
the primary/back actions are part of the same model. Human TUI, Agent JSON,
and a future web/IDE presenter consume this model; none implements validation,
visibility, defaults, or navigation independently.

The presenter boundary is:

```text
flow state → ScreenModel → presenter
answer event ← presenter
```

This keeps the common UX behavior identical while allowing Human to use
keyboard navigation, Agent to use structured JSON, and CI to skip screens
entirely.

`FlowEvent` is the single observable protocol:

```text
flow.started
page.entered
input.requested
input.resolved
input.rejected
resolution.started
plan.ready
action.started
action.progress
action.completed
action.failed
flow.failed
flow.completed
```

Event payloads are versioned, structured, and secret-redacted.

### Human driver

The Human driver combines a TTY `AnswerSource` with a terminal `EventSink`.
It renders common pages/sections/fields, handles keyboard navigation, and
submits answers back to the engine. Back navigation restores prior answers and
recomputes all derived state from the first changed value.

### Agent driver

The Agent driver has no TTY assumptions. It exposes the same scenario as a
machine-readable request/response flow:

```bash
kb-create flow inspect --scenario=commit --output=json
kb-create flow plan --scenario=commit --answers=answers.json --output=json
kb-create flow apply --plan=.kb/plans/<plan-id>.json --output=ndjson
```

`inspect` returns scenario metadata and required/optional inputs. `plan`
returns either a compiled plan or `FLOW_INPUT_REQUIRED` with all unresolved
`InputRequest` objects. Agents can revise answers and call `plan` again without
side effects. `apply` accepts only a previously compiled plan whose catalog
digest, input hash, and project/platform roots still match.

This avoids a second Agent-specific scenario format and avoids requiring a
long-lived interactive protocol.

### Direct CI install contract

CI bypasses `FlowEngine`, pages, fields, completion handoff, and scenario
defaults. It creates a direct request:

```go
type DirectInstallRequest struct {
	Plugins       []ComponentSelector
	Services      []ComponentSelector
	Adapters      map[string]ProviderSelector
	Binaries      []ComponentSelector
	ConfigFile    string
	PlatformDir   string
	ProjectDir    string
	Registry      string
	CatalogDigest string
}
```

`kb-create install` accepts only direct-install inputs. It performs:

```text
parse flags/config
  → normalize canonical component IDs
  → apply generated catalog defaults
  → validate complete request
  → resolve component/capability graph
  → compile InstallPlan
  → execute or emit plan
```

CI invariants:

- no TTY detection or prompts;
- no scenario loading;
- no consent inferred from defaults;
- no component choice inferred from environment variables;
- stable JSON/NDJSON output and exit codes;
- all missing/invalid inputs reported together when possible;
- same request + catalog digest produces the same plan hash.

### Flow state

```go
type FlowState struct {
	ScenarioID string
	PageID     string
	Values     map[string]TypedValue
	Answers    map[string]AnswerMeta
	Resolved   ResolutionState
	Status     FlowStatus
}
```

`FlowState` contains user choices and derived values, but never raw secrets.
It is checkpointed after safe transitions so an interrupted install can resume
without replaying completed external work.

Flow checkpoints belong only to Human/Agent scenario orchestration. Execution
checkpoints belong to the shared action journal and are used by every mode,
including CI.

### Flow status

```text
idle
collecting
reviewing
resolving
executing
failed
repairing
retrying
completed
cancelled
```

Failure is a normal state, not an unstructured process exit.

### Generic UI behavior

The UI kit owns:

```text
next/back/cancel navigation
inline validation
page progress
summary rendering
secret masking
spinner/progress output
error presentation
retry/repair actions
checkpoint resume
success handoff
```

Scenario manifests may choose titles, copy, fields, and allowed recovery
actions. They may not implement custom navigation or custom error screens.

Page kinds and field kinds are separate vocabularies. `summary`, `progress`,
`result`, and `error` are page kinds; `text`, `secret`, `choice`,
`multiChoice`, `directory`, `confirm`, and `provider` are field kinds. A
concept cannot be both a page and a field.

## Error and recovery contracts

```go
type FlowError struct {
	Code       string
	Kind       ErrorKind
	Message    string
	Detail     string
	PageID     string
	FieldID    string
	ActionID   string
	Component  string
	Retryable  bool
	Recoveries []RecoveryAction
	Cause      error
}
```

Error kinds:

```text
input
validation
resolution
compatibility
dependency
preflight
install
filesystem
network
permission
config
healthcheck
cancelled
internal
```

Recovery actions are generic:

```text
back
retry
repair
doctor
select-provider
edit-value
resume
cancel
```

The interactive renderer shows a human explanation, cause, and available
actions. The JSON renderer emits the same error code, kind, context, and
recoveries. Component/scenario metadata may add a contextual hint, but cannot
change the shared layout or interaction model.

All raw errors pass through a shared `ErrorClassifier`. Scenario conditions
never inspect package-manager strings or Go error types. The normalized flow
context exposes:

```text
error.last.code
error.last.kind
error.last.component
error.last.actionId
error.attempt
error.history
```

Scenarios may react through declarative policies:

```json
{
  "onError": [
    {
      "when": { "ref": "error.last.code", "op": "eq", "value": "NETWORK_UNAVAILABLE" },
      "offer": ["retry", "cancel"]
    },
    {
      "when": { "ref": "error.last.code", "op": "eq", "value": "CAPABILITY_UNRESOLVED" },
      "goto": "providers",
      "offer": ["edit-value", "cancel"]
    }
  ]
}
```

Policies may select a page and allowed recovery actions; they cannot define a
custom error component or execute arbitrary operations. CI does not evaluate
scenario `onError`: it emits the structured execution error and exits with the
stable mapped status code.

Example:

```json
{
  "ok": false,
  "error": {
    "code": "CAPABILITY_UNRESOLVED",
    "kind": "compatibility",
    "message": "No provider resolved for capability cache.",
    "fieldId": "providers.cache",
    "recoveries": ["select-provider", "back", "doctor"]
  }
}
```

## InstallPlan contract

Both orchestration paths converge on one normalized request:

```go
type InstallRequest struct {
	Schema              string
	Source              PlanSource
	CatalogDigest       string
	ProjectRoot         string
	PlatformRoot        string
	Registry            string
	Components          []CanonicalComponentID
	ProviderPreferences map[CapabilityID][]CanonicalComponentID
	ProviderOverrides   map[CapabilityID]CanonicalComponentID
	Values              map[ValueID]TypedValue
	Secrets             map[ValueID]SecretRef
	ConfigOverrides     []ConfigPatch
}
```

`InstallRequest` contains no pages, labels, navigation, scenario ID, or CLI
flags. It is the stable boundary between orchestration and installation.
Scenario completion metadata is carried beside the request and attached only
to presentation after the installation plan is compiled.

```go
type InstallPlan struct {
	ID            string
	Schema        string
	CatalogDigest string
	InputHash     string
	PlanHash      string
	ProjectRoot   string
	PlatformRoot  string
	Source        PlanSource
	Summary       PlanSummary
	Actions       []PlanAction
	Assembly      ConfigAssembly
	Completion    *CompletionPlan
}
```

`Source` is `scenario` or `direct-install`. `Completion` is present only for
scenario plans. The plan is deterministic and inspectable before execution.
The summary page renders `PlanSummary` in user terms; diagnostics and CI render
the action graph.

`planHash` is computed only from execution-relevant canonical data:

```text
catalog digest
project/platform roots
resolved components/providers/versions
redacted value digests
config patches
ordered action DAG
```

It excludes presentation copy, Human/Agent driver metadata, timestamps,
progress, and completion text. Therefore equivalent Human, Agent, and direct CI
inputs can produce the same `planHash`.

```go
type PlanAction struct {
	ID          string
	Kind        ActionKind
	DependsOn   []string
	Inputs      map[string]ValueRef
	InputHash   string
	Retry       RetryPolicy
	Rollback    RollbackPolicy
	Sensitive   bool
}
```

Executor operations are generic:

```text
installPackage
installBinary
enableService
bindAdapter
writeSecret
writeConfig
writeArtifact
createFromTemplate
writeWorkflow
runCheck
```

There are no scenario-specific executor methods.

Each action handler implements a reconciliation contract:

```go
type ActionHandler interface {
	Check(ctx context.Context, action PlanAction) (ActionState, error)
	Apply(ctx context.Context, action PlanAction) (ActionResult, error)
	Verify(ctx context.Context, action PlanAction) error
	Rollback(ctx context.Context, action PlanAction, result ActionResult) error
}
```

Rollback is declared only for actions with a real safe compensation. An action
without compensation is marked `rollback: none`; the engine must not pretend a
package-manager or external operation is transactional.

The executor persists an action journal:

```text
pending → checking → applying → verifying → completed
                                  └──────→ failed
completed → rolling-back → rolled-back | rollback-failed
```

Journal records contain action ID, input hash, status, attempts, timestamps,
redacted outputs, and normalized error. `resume` re-checks completed actions
and continues only when plan/catalog/root hashes still match.

The executor acquires project/platform flow locks before mutating state so two
install/apply processes cannot write the same config or package tree
concurrently.

## Config rendering contract

`kb.config.json`/`kb.config.jsonc` and every installation artifact are one
derived output graph. The engine must not treat the runtime config as a
special string template and must not let individual installer steps write
sidecar files independently. The source of truth is the resolved component
catalog plus the completed `InstallRequest`; scenarios only collect values.

The engine compiles semantic config data, not strings:

```go
type ConfigPlan struct {
	Patches []ConfigPatch
	Outputs []ConfigOutput
}

type ConfigPatch struct {
	ID        string
	Scope     ConfigScope
	Operation PatchOperation
	Path      JSONPointer
	Value     ValueRef
	SchemaRef string
	Owner     string
}

type ConfigOutput struct {
	Scope  ConfigScope
	Path   string
	Format string
}
```

`ConfigPlan` is part of a larger, deterministic artifact assembly:

```go
type ConfigAssembly struct {
	Config  ConfigPlan
	Files   []ArtifactWrite
	Secrets []SecretBinding
}

type ArtifactWrite struct {
	ID          string
	Root        ArtifactRoot // platform, project, or explicit workspace root
	Path        PathTemplate // resolved only after facts and answers are known
	Format      ArtifactFormat // json, jsonc, yaml, dotenv, text, binary
	Source      ArtifactSource // template, value, generated, copy
	Value       ValueRef
	TemplateRef string
	Mode        ArtifactMode // create, replace, merge, appendUnique
	Owner       string
	Overwrite   OverwritePolicy
	Permissions uint32
	Required    bool
}
```

`ArtifactWrite` covers all files produced by an install or scenario: the
platform runtime config, the project pointer config, `.env`, workflows,
`.gitignore` additions, generated manifests, service files, plugin templates,
and user-selected output files. A component declares artifact intents and
config bindings in its manifest; the installer only resolves and executes
them. There is no second Go list of “special files”.

Paths are explicit and safe by construction:

- `platform` and `project` roots are the only implicit roots;
- an `explicit workspace` root must be approved by the request and is still
  checked with `filepath.Rel`/realpath containment after symlink resolution;
- absolute paths, `..` escapes, symlink escapes, and writes outside the
  declared root are rejected before any mutation;
- a path template may use typed values and approved facts, but never arbitrary
  shell expansion or environment interpolation;
- path collisions are a validation error unless all writers have the same
  owner and an explicit merge policy;
- every artifact has a stable ID, owner, source digest, resolved path, and
  input hash in the plan/journal.

The canonical runtime config output is selected by the target runtime and is
normally `<platform>/.kb/kb.config.jsonc`; JSON is supported as a format where
the runtime accepts it. The filename and scope are manifest/config metadata,
not assumptions hidden in `scaffold`. The project output is a separate
user-owned pointer artifact and is never silently replaced.

Config values are assembled through typed bindings rather than raw text:

```go
type ConfigBinding struct {
	ID        string
	Scope     ConfigScope
	Path      JSONPointer
	Value     ValueRef
	SchemaRef string
	Owner     string
	Merge     PatchOperation
	Optional  bool
}
```

Bindings may source values from resolved components/providers, defaults,
answers, facts, generated paths, or secret references. Secrets are represented
as environment/file references and are never serialized into the runtime
config, flow state, redacted plan, or normal diagnostics. Generated paths are
resolved once against the canonical roots so the same value feeds both
`kb.config.jsonc` and dependent artifacts.

Assembly order is fixed and visible in the plan:

```text
catalog defaults
  → request values and provider resolution
  → config bindings and artifact intents
  → collision/scope/schema/path validation
  → in-memory config + artifact materialization
  → redacted diff and checksums
  → atomic writes
  → read-back validation
```

The generated config must therefore contain the complete effective setup:
selected components, adapter/provider packages and options, service
endpoints, execution settings, generated project/platform paths, and any
scenario-specific values that are declared by manifests. A page may ask for a
value, but it cannot directly append JSON or write a file. The same assembly is
used by Human, Agent, and direct CI; only the value source and event transport
change.

Patch operations are a fixed set: `set`, `merge`, `appendUnique`, and `remove`.
Scope is `platform`, `project`, or `secret-env` and must obey ADR-0012/0013
ownership rules.

Component/provider config schemas provide defaults, descriptions, secret
markers, and validation. Scenario manifests reference fields/providers; they
do not repeat config comments or defaults. The renderer owns commas, escaping,
stable ordering, comments, and atomic temp-file replacement.

Before a write, the engine:

1. applies patches to an in-memory JSON document;
2. resolves and validates every artifact path against its declared root;
3. detects path collisions and ownership/overwrite violations;
4. validates the result against referenced schemas, artifact formats, and
   scope policy;
5. produces a redacted config/artifact diff for plan/diagnostics;
6. writes all outputs atomically with a journal (or writes nothing in
   `--plan-only`);
7. reads and validates the written config and checks artifact checksums.

Scenario manifests cannot concatenate complete `kb.config.jsonc` text.
They also cannot call `os.WriteFile`, create arbitrary paths, or encode
installation-specific defaults that belong to component/provider manifests.

## Facts, validators, consent, and secrets

### Detectors and validators

Project/environment knowledge is exposed as generic named facts:

```text
project.root
project.isGitRepository
project.hasChanges
project.packageManager
project.isPublishable
environment.os
environment.arch
environment.hasTTY
```

Detectors are Go implementations registered by stable ID with typed output
schemas. Scenarios may read facts but cannot call arbitrary Go functions.
Expensive facts are evaluated lazily and cached for one flow revision.

Validators follow the same rule. Built-ins include `required`, `enum`,
`kebabCase`, `absolutePath`, `directoryWritable`, and schema validation.
Component manifests may declare validation requirements by ID; Human, Agent,
and direct CI requests use the same validators.

### Consent and data boundaries

Consent is a first-class field/policy type, not a custom page and not a boolean
silently inferred from `--yes`:

```json
{
  "id": "consent.llmDiff",
  "type": "confirm",
  "policyRef": "data-boundary:git-diff-to-llm-provider",
  "requiredWhen": {
    "ref": "providers.llm",
    "op": "neq",
    "value": "none"
  }
}
```

The referenced policy supplies what data leaves the machine, destination,
purpose, retention, and local/skip alternatives. Human and Agent flows must
record an explicit acceptance tied to the policy digest.

Direct CI install does not execute business commands and therefore does not
accept scenario consent. If direct installation itself requires an external
data boundary, CI must provide an explicit policy acceptance in its config;
catalog defaults can never grant consent.

### Secret handling

Secret values live in an in-memory `SecretStore` and are referenced by opaque
`SecretRef` values. They never appear in:

- `FlowState` checkpoints;
- serialized plans;
- action journals;
- event payloads;
- config diffs;
- logs or error details.

Agent/CI JSON accepts secret references or declared environment-variable
sources, not secret values in ordinary output payloads. The secret writer
resolves a `SecretRef` only while executing the owning action.

Supported secret references are explicit:

```text
env       — resolve a named environment variable at apply time
keychain  — resolve an OS keychain entry at apply time
ephemeral — in-memory value valid only for the current process
```

A serialized plan may contain `env` or `keychain` references. It may contain
the identifier of an `ephemeral` reference, but such a plan is applyable only
inside the process that compiled it. A later `flow apply` fails with
`SECRET_SOURCE_UNAVAILABLE` and requests a new reference; it never serializes
the missing secret as a workaround.

## CLI and direct-install config contract

Command ownership:

```text
kb-create
  Human scenario picker/runner

kb-create flow inspect|plan|apply
  Agent scenario protocol

kb-create install
  Direct deterministic install for CI/operators

kb-create doctor|continue
  Shared diagnostics and recovery over flow/action state

kb-create update|rollback|uninstall
  Direct lifecycle plan compilers over installed provenance/action journals;
  no scenario pages
```

`kb-create install --config` reads a direct-install request file, not a
scenario and not an already-rendered runtime `kb.config.jsonc`:

```json
{
  "schema": "kb.install/1",
  "plugins": ["plugin:@kb-labs/release"],
  "services": ["service:state-daemon"],
  "adapters": {
    "cache": "adapter:state-broker"
  },
  "config": [
    {
      "scope": "platform",
      "operation": "set",
      "path": "/adapterOptions/cache/url",
      "value": "http://127.0.0.1:7777"
    }
  ],
  "secrets": {
    "NPM_TOKEN": { "fromEnv": "NPM_TOKEN" }
  }
}
```

CLI list/map flags replace the corresponding config-file selection when
present; scalar flags replace their scalar field. Catalog defaults add only
declared baseline core packages and default providers required by the direct
request. They never add a scenario bundle.

The normalized merged result is printed by `--plan-only --output=json`, so CI
can audit exactly which defaults were applied.

## Proposed Go package boundaries

```text
internal/catalog
  generated catalog types, loader, validator, digest

internal/flow
  pure scenario reducer, transitions, predicates, facts, validation

internal/ui
  headless ScreenModel, control vocabulary, redaction, common actions/errors

internal/flow/driver/human
  Bubble Tea AnswerSource + terminal EventSink

internal/flow/driver/agent
  JSON answer source + JSON/NDJSON event sink

internal/directinstall
  flags/config/default merge → InstallRequest

internal/resolve
  component graph + feature-aware capability/provider resolution

internal/plan
  InstallRequest → deterministic action DAG + planHash

internal/executor
  action handlers, scheduler, locks, journal, retry/resume/rollback

internal/configrender
  ConfigPatch validation, scope policy, JSON/JSONC rendering, atomic writes

internal/secrets
  in-memory SecretStore and redacted SecretRef handling

internal/diagnostics
  structured doctor/continue inspection over catalog, flow, plan, journal
```

Dependencies flow downward:

```text
cmd/drivers → flow or directinstall → resolve → plan → executor
                                               ├→ configrender
                                               └→ secrets
all packages → catalog contracts + structured errors/events
```

`flow` must not import Human/Agent drivers. `resolve`, `plan`, and `executor`
must not import scenarios, pages, CLI flags, or Bubble Tea.

## Source and persistence layout

Proposed source artifacts:

```text
tools/kb-create/schemas/
  kb.catalog.schema.json
  kb.scenario.schema.json
  kb.install.schema.json
  kb.event.schema.json
  kb.error.schema.json
  kb.plan.schema.json

tools/kb-create/scenarios/
  commit.json
  release.json
  custom.json
  plugin-author.json

tools/kb-create/internal/catalog/
  catalog.generated.json
  embed.go
  validate.go
```

`catalog.generated.json` is generated and never hand-edited. Component details
continue to originate from emitted package manifests and package/release
metadata; only scenario UX lives under `scenarios/`.

Runtime persistence:

```text
platformDir/.kb/install.json
  current installed provenance and catalog digest

platformDir/.kb/kb-create/runs/<plan-id>/journal.json
  action execution journal

projectDir/.kb/kb-create/flows/<flow-id>/state.json
  Human/Agent non-secret flow checkpoint

projectDir/.kb/kb-create/plans/<plan-id>.json
  optional serialized redacted plan

platformDir/.kb/kb-create/locks/install.lock
projectDir/.kb/kb-create/locks/flow.lock
  process ownership and stale-lock metadata
```

All state/journal/plan files are written atomically with `0600` permissions.
Locks carry PID, process start identity, host, timestamp, and plan/flow ID so a
stale lock can be diagnosed and safely reconciled.

## Implementation plan

### Phase 0 — freeze contracts with executable fixtures

- [ ] Add JSON schemas and Go types for catalog, scenario, pages, fields,
      predicates, facts, providers, direct install, errors, events,
      `InstallRequest`, action DAG, config/artifact assembly, config bindings,
      safe path templates, and journals.
- [ ] Extend component/command manifest schemas where required for canonical
      identity, feature-level requirements/provides, config bindings, secret
      metadata, command requirements, and data-boundary references.
- [ ] Add package/release provenance and canonical-ID rules.
- [ ] Define stable JSON/NDJSON events, error codes, and exit-code mapping.
- [ ] Add declarative fixtures for `commit`, `release`, `custom`, and
      `plugin-author`.
- [ ] Add direct CI fixtures for flags-only, config-only, and mixed precedence.
- [ ] Add golden expected `InstallRequest`, `InstallPlan`, and `planHash`
      outputs for every fixture.
- [ ] Add golden config/artifact manifests for every fixture, including
      platform/project scope, generated paths, `.env`, workflows, and an
      arbitrary user-approved artifact path.
- [ ] Document the explicit breaking cutover: no old intent schema is accepted.

Exit criteria: every current scenario and direct CI install can be represented
without scenario-specific Go procedures, and expected plans exist as
reviewable fixtures.

### Phase 1 — deterministic catalog compiler

- [ ] Create a catalog compiler that reads emitted component manifests,
      package metadata, binary release metadata, provider declarations, and
      scenario manifests.
- [ ] Normalize canonical IDs and install coordinates.
- [ ] Validate package/manifest identity and version consistency.
- [ ] Validate all component, command, provider, template, fact, validator,
      config-schema, and scenario references.
- [ ] Validate duplicate IDs, predicate paths, capability/provider cycles,
      feature compatibility, and missing required metadata.
- [ ] Produce stable ordering, catalog digest, and reproducible output.
- [ ] Embed the generated catalog in `kb-create`.
- [ ] Make catalog generation/validation a build and release gate.

Exit criteria: changing a component manifest changes the generated catalog
deterministically; malformed or drifting manifests fail before `kb-create`
builds.

### Phase 2 — pure flow engine and machine protocol

- [ ] Create the pure flow reducer and immutable transition model.
- [ ] Implement `AnswerSource`, `InputRequest`, `AnswerResult`, `EventSink`,
      and versioned `FlowEvent`.
- [ ] Implement per-field ordered sources and common validation.
- [ ] Implement structured predicates and dependency tracking.
- [ ] Implement typed facts/detectors with lazy evaluation.
- [ ] Implement non-secret flow checkpoints and revision invalidation.
- [ ] Implement normalized `FlowError`, `ErrorClassifier`, and declarative
      `onError` transitions.
- [ ] Implement headless `ScreenModel` and common control vocabulary with
      secret redaction, field/page errors, recovery actions, and presenter
      conformance fixtures.
- [ ] Implement Agent `inspect` and `plan` commands before any TUI work.

Exit criteria: scenario fixtures can be completed headlessly, unresolved
inputs are returned as structured requests, and identical answers produce
identical resolved state.

### Phase 3 — shared resolver and action-DAG compiler

- [ ] Define `InstallRequest` as the only input to the shared install core.
- [ ] Compile scenario state into `InstallRequest`.
- [ ] Compile direct CI flags/config/defaults into `InstallRequest` without
      loading scenarios.
- [ ] Resolve component dependencies and structured capability features.
- [ ] Add truthful StateBroker and Redis provider manifests.
- [ ] Resolve package, service, adapter, secret, config, and readiness actions.
- [ ] Resolve all manifest-declared config bindings and artifact intents from
      the same effective values and canonical roots.
- [ ] Compile a deterministic action DAG and `planHash`.
- [ ] Reject unresolved/incompatible requirements before execution.

Exit criteria: scenario and direct inputs that resolve to the same components
produce byte-equivalent action DAGs and the same `planHash`.

### Phase 4 — generic executor, journal, and config engine

- [ ] Implement the action-handler registry and `Check/Apply/Verify/Rollback`
      contract.
- [ ] Implement dependency scheduling with deterministic event order.
- [ ] Implement project/platform locks.
- [ ] Implement action journals, retries, resume validation, and honest
      rollback behavior.
- [ ] Implement `SecretStore` and secret bindings.
- [ ] Implement schema-aware `ConfigPatch` and `ConfigAssembly`.
- [ ] Implement typed value/path resolution, artifact collision detection,
      root/symlink containment, overwrite policies, and atomic multi-artifact
      rendering for JSON/JSONC/YAML/dotenv/text outputs.
- [ ] Make `kb.config.jsonc` and project pointer generation regular manifest
      artifacts; remove duplicated special-case writes from scaffold/installer.
- [ ] Enforce platform/project config ownership from ADR-0012/0013.
- [ ] Emit structured progress/errors through `EventSink`.
- [ ] Add plan-only execution that performs no mutations.

Exit criteria: executor contains no scenario IDs, can resume a partial plan,
and leaves a validated, checksum-matched config/artifact set or an actionable
journaled failure. `--plan-only` shows every output path and redacted content
diff without touching the filesystem.

### Phase 5 — direct deterministic CI path

- [ ] Rebuild `kb-create install` around `DirectInstallRequest`.
- [ ] Support `--plugins`, `--services`, `--adapters`, `--binaries`,
      `--config`, platform/project roots, registry, and output mode.
- [ ] Implement precedence: flags → config file → generated catalog defaults.
- [ ] Reject scenario-only flags on `install`.
- [ ] Guarantee no prompts, TTY reads, ANSI output in JSON mode, or hidden
      component choices from environment variables.
- [ ] Return all request validation errors together where possible.
- [ ] Add `--plan-only` and NDJSON execution events.

Exit criteria: clean CI can deterministically plan/install from flags or a
checked-in config without any scenario runtime.

### Phase 6 — first vertical scenario through Agent

- [ ] Implement `commit` scenario in the new manifest.
- [ ] Resolve command completion through `commandRef`, not duplicated text.
- [ ] Resolve cache requirements by feature and prefer StateBroker only when
      compatible.
- [ ] Implement LLM provider configuration, secret binding, and consent policy.
- [ ] Run `inspect → answers → plan → apply → completion` through Agent JSON.
- [ ] Verify the resulting plan against the direct-install equivalent.

Exit criteria: `commit` is end-to-end complete without TUI and without
scenario-specific Go logic.

### Phase 7 — common Human UI kit

- [ ] Implement generic page kinds and field controls over the pure engine.
- [ ] Implement shared keyboard navigation, back/revision, inline validation,
      summary, progress, cancellation, errors, retry, repair, and completion.
- [ ] Keep rendering and answer collection behind Human driver adapters.
- [ ] Add terminal layout/golden tests for narrow, normal, and non-color
      terminals.
- [ ] Run the same `commit` scenario through Human TUI and assert the same
      resolved state and `planHash` as Agent mode.

Exit criteria: Human and Agent differ only by driver; validation, transitions,
resolution, plan, errors, and recovery semantics are shared.

### Phase 8 — migrate remaining scenarios and cut over

- [ ] Implement `release`.
- [ ] Implement `plugin-author` using a generic catalog template action.
- [ ] Implement `custom` using generic component/provider selectors.
- [ ] Rebuild `doctor`, `continue`, retry, and repair on flow/action state.
- [ ] Rebuild `update` as a direct lifecycle `InstallRequest` derived from
      installed provenance plus the target catalog.
- [ ] Rebuild `rollback` from journaled/snapshotted action outputs; fail
      explicitly when an action has no safe compensation.
- [ ] Rebuild `uninstall` as a direct removal plan with explicit destructive
      confirmation in Human mode and an explicit authorization flag in CI.
- [ ] Keep lifecycle commands scenario-free while reusing resolver, plan,
      executor, config, errors, locks, and journals.
- [ ] Remove `Intent`, `IntentBundle`, `IntentStep`, old wizard stages,
      scenario-specific installer branches, reconciliation warnings, and old
      manifest parser.
- [ ] Reject old manifest schemas with one clear error.

Exit criteria: all launcher scenarios run only through the new engine, CI uses
only direct install, and no old flow is reachable.

### Phase 9 — conformance and launch proof

- [ ] Run every scenario through Human and Agent sources with equivalent
      answers and compare state/plan hashes.
- [ ] Run direct CI requests equivalent to each resolved scenario and compare
      installation action graphs.
- [ ] Test invalid catalog, invalid answers, missing input, missing provider,
      feature mismatch, network failure, package failure, healthcheck failure,
      config failure, cancellation, concurrent invocation, retry, resume, and
      rollback failure.
- [ ] Audit stdout/stderr/JSON/NDJSON and stable exit codes.
- [ ] Audit secret redaction across state, plans, journals, events, diffs, and
      logs.
- [ ] Run clean-machine Linux/macOS coverage for the currently supported
      release targets.

Exit criteria: every failure has an actionable structured outcome, every mode
is deterministic for its inputs, and the launcher never reports success with
an unresolved required capability.

## Testing strategy

### Contract tests

- catalog schema validation;
- deterministic catalog generation and digest;
- package/manifest identity and version provenance;
- all scenario references resolve;
- every meaningful scenario branch compiles;
- all component feature requirements resolve through a compatible provider;
- no capability/provider cycles;
- command/config/template references resolve;
- unsupported old schemas fail clearly;
- no secrets in serialized state, plans, journals, events, diffs, or logs.

### Engine unit tests

- predicate AST evaluation and invalid-reference rejection;
- ordered per-field source resolution;
- Human and Agent answer-source equivalence;
- conditional visibility/requiredness;
- page navigation;
- revision invalidation after Back/edit;
- error transitions;
- retry/repair/resume semantics;
- deterministic request/plan compilation;
- action-DAG ordering and cycle rejection;
- config-patch scope and schema enforcement.
- config/artifact assembly from one resolved value set;
- platform/project ownership and generated-path containment;
- arbitrary approved artifact paths, collision detection, and overwrite policy;
- atomic multi-artifact writes with read-back/checksum verification;

### Driver and presenter tests

- every field type;
- inline validation;
- summary output;
- error/recovery output;
- terminal layout at narrow/normal widths;
- Agent inspect/plan machine protocol;
- CI emits no prompts or ANSI in JSON mode;
- Human and Agent drivers produce equivalent state from equivalent answers;
- stdout/stderr and stable exit-code contracts.

### End-to-end tests

- direct CI flags-only install;
- direct CI config-only install;
- direct CI flag/config/default precedence;
- `commit` with StateBroker cache;
- `commit` with Redis cache;
- `release` with and without LLM key;
- `custom` component selection;
- `plugin-author` template creation;
- package-manager failure and retry;
- service healthcheck failure and doctor path;
- config validation/write failure;
- interrupted install and continue;
- concurrent install lock;
- stale plan/catalog/root rejection;
- honest rollback failure.

### Runtime acceptance gate

An installation is not successful when packages merely exist in
`node_modules`. Before `agent apply` can report success for a scenario with a
runtime plugin, the engine must be able to run the following deterministic
checks in the target project:

1. The generated platform and project configs parse and resolve to the same
   platform root.
2. Every configured adapter package imports and its factory can be created
   with the generated `adapterOptions` shape.
3. The selected plugin is discovered from the installed package and its
   declared commands are registered.
4. Required external capabilities are classified separately into
   `ready`, `missing-secret`, `unreachable`, and `invalid-config`; an
   unreachable provider must not be reported as a successful ready install.
5. A scenario-specific dry-run command can be executed without mutating the
   repository. The result, provider status, and recovery hint are recorded in
   the structured journal, with secrets redacted.

This gate is a separate verification phase in the plan, not a hidden shell
command in a handler. It is skipped only for components whose manifests
declare no runtime contract.

## Explicit non-goals

- no backward-compatible interpretation of the old intent schema;
- no arbitrary code execution from JSON;
- no scenario-specific UI components in the first engine version;
- no scenario evaluation in `kb-create install` CI mode;
- no requirement that Human and Agent share presentation code;
- no second manually maintained component catalog;
- no post-install-only compatibility warnings for required capabilities;
- no direct rendering of complete config files from scenario strings;
- no secret values in serializable flow/execution structures;
- no claim that every action is transactional or rollbackable.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Manifest becomes an untyped programming language | Small fixed step/field/operation vocabulary and schema validation |
| Catalog drifts from package manifests | Generate catalog from emitted component manifests in build/release |
| Generic UI becomes too restrictive | Add new reusable field/operation types only after a real scenario needs them |
| StateBroker is mistaken for a complete/durable cache | Feature-level capability declarations plus durability/distribution constraints |
| Human and Agent behavior drifts | Same flow reducer, validators, predicates, fixtures, and plan-hash conformance |
| CI accidentally inherits product logic | DirectInstallRequest bypasses scenario loading entirely |
| Failed installs become hard to resume | Action journal, `Check/Apply/Verify`, hashes, locks, and idempotent reconciliation |
| Product copy leaks technical internals | Keep user copy in scenario JSON and technical details in expandable diagnostics |
| Config engine becomes untyped map manipulation | Schema-referenced patches, scope policy, redacted diff, atomic write and read-back validation |
| Config and artifacts drift apart | One `ConfigAssembly` in `InstallPlan`; all outputs derive from the same resolved values, roots, and input hash |
| Arbitrary paths damage the workspace | Explicit root approval, normalized/realpath containment, collision checks, plan-only preview, and atomic writes |

## Completion criteria

- [ ] Four existing scenarios are fully declarative.
- [ ] Human and Agent run the same scenario state machine and validation.
- [ ] Human pages use the common UI kit.
- [ ] Human, Agent, and diagnostic presenters consume the same `ScreenModel`;
      no presenter owns validation or navigation logic.
- [ ] Agent mode supports inspect/plan/apply without TTY.
- [ ] CI direct install never loads scenarios or prompts.
- [ ] All errors use the common structured error/recovery contract.
- [ ] Scenario and CI paths converge at `InstallRequest`.
- [ ] Installer receives only compiled action-DAG `InstallPlan` objects.
- [ ] Component compatibility comes from component manifests and catalog
      resolution, not hardcoded Go rules.
- [ ] StateBroker is selected only for requirements matching its declared
      feature/durability/distribution contract.
- [ ] `kb.config.jsonc`, project pointer, `.env`, workflows, and declared
      arbitrary-root artifacts are rendered from one validated `ConfigAssembly`.
- [ ] Every output path is visible in plan mode, stays within its approved
      root, has an ownership/overwrite decision, and is verified after write.
- [ ] Equivalent Human/Agent/direct inputs produce the same `planHash`.
- [ ] Plans, events, journals, diffs, and logs contain no secret values.
- [ ] No old scenario flow is reachable.
- [ ] Clean-machine and failure-path E2E tests pass.
- [ ] Runtime acceptance verifies adapter bootstrap, plugin discovery, and
      provider readiness before reporting a successful installation.
