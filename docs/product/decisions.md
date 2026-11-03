# Product decisions log

## 2026-10-31

### SQLite vector search breaks equal-score ties by record ID

SQLite vector search orders equal cosine similarity scores by stable record ID
ascending. This makes the returned order deterministic across database query
plans and reopenings. Case: S-281.4.

### Stock embeddings and vector storage are local-install defaults

Fresh Release 1 installs select the bundled OpenAI-compatible embeddings
entrypoint and the bundled SQLite vector-store entrypoint through their adapter
manifests' `defaultFor` declarations. OpenAI credentials remain optional during
installation and host startup; adapter listing and doctor report a missing key,
and the first embeddings request returns the typed credentials error with the
platform config command. The SQLite vector store persists beneath each
registered project's durable state directory and uses brute-force cosine
search for small local indexes. Its
scale limits are documented; larger indexes can bind another provider.
`snapshotManager` remains optional and unconfigured because no active Release 1
case requires it. This supersedes the embeddings and vector-store portion of
[Persistent adapter defaults and analytics persistence disclosure](#persistent-adapter-defaults-and-analytics-persistence-disclosure).
Cases: S-054.1, S-054.2, S-054.4, S-054.6, S-054.24, S-054.25.

This log records the product decisions behind the case catalog (`docs/qa/scenarios/`). Cases state *what* the product does. This log records *why* a boundary sits where it does, so a later change of mind can be made deliberately, starting with a new entry and a case change.

The current cross-cutting product invariants and their enforcement status are listed in [invariants.md](./invariants.md).

Each entry names the decision, the reason, and the cases that encode it. When a decision changes, add a new dated entry that supersedes the old one; don't rewrite history.

## 2026-10-29

### Auto-advance review and landing outcomes follow durable side effects

A review child with no valid verdict is a decision-needed outcome for both the child and its parent, committed through one transition and one orchestrator event; recovery does not recreate an already escalated review. For auto-advance acceptance, commit-only landing must succeed before the accepted advancement and event become durable. A landing refusal is escalated without accepted status. Scheduler recovery re-derives the worker run after the atomic rework handoff from its persisted run identity, so a restarted scheduler consumes the resumed worker result. The crash matrix observes all kb-runner durable state writes through `runnerStateStore`; clikit run-record internals remain covered at the Start API boundaries because their write is owned by clikit. Case: S-237.149.

## 2026-10-27

### macOS process ownership uses an inherited run-token descriptor

macOS does not expose environment strings for Apple platform binaries through
`kern.procargs2`, so the run environment marker cannot prove ownership of
commands such as `/bin/sh` and `/bin/sleep` after exec and detachment. Each
supervised command therefore inherits a run-unique file descriptor; the process
owner matches the descriptor's vnode device and inode for same-UID processes
across process inventory snapshots. This survives exec of platform binaries,
setsid, and reparenting. A readable environment marker and recorded PID/start
identity remain additional evidence. Foreign-UID unreadable candidates remain
visible as potential setuid owners but are not accepted without other ownership
proof. A recorded process that closes the token and loses its marker remains
visible as unverified. A process that closes every inherited descriptor before
it is observed and then detaches cannot be attributed after that point. Cases:
S-237.1, S-237.7.
## 2026-10-23

### Built-in scenario plugins are Marketplace install specs

A scenario plugins entry is the same install spec a user types into Marketplace. Marketplace resolves that spec through the rendered source order (Registry first, then an explicit npm fallback), and records the requested spec beside the canonical entity identity read from the installed manifest. Release 1's npm-only Commit install spec is @kb-labs/commit, and the installed manifest resolves to the same identity. An install spec can include a version or range; the receipt preserves that requested spec separately from the manifest identity. If all sources report not-found, a plain Marketplace install retains KB_PLUGIN_NOT_FOUND and records the sources tried. kb-create wraps Marketplace failures for scenario installs in KB_MARKETPLACE_INSTALL_FAILED, preserving the original Marketplace error code and message as the cause. The retry command uses the exact install spec. Cases: PC-001.4, S-039.1, S-051.2, S-268.9, S-268.13, S-268.14.

### Host exclusivity follows claimed resources, not machine identity

Independent install roots may run at the same time when they hold different
resources. Each root owns its resolved Gateway address and service ports. A
start or apply is refused with `KB_HOST_ALREADY_RUNNING` only when the requested
host needs a Gateway address or port held by another verified live host; the
diagnostic names that root and PID after process identity verification. A
stopped root retains its allocation, and stale or malformed root indexes remain
diagnosed by the index owner. Cases: PC-001.10, PC-001.12, PC-001.16, S-025.8.

### Marketplace npm endpoints come from platform source configuration

The npm source URL is explicit in the installed platform configuration: Release 1 declares npmjs, and `kb-create --marketplace-npm-url` replaces it for a mirror. Marketplace resolution does not inherit npmrc or `NPM_CONFIG_REGISTRY`; those settings affect package-manager operations but must not silently change the source used to resolve Marketplace identities. This keeps the URL visible in status/doctor and stable across updates. Cases: S-268.6, S-268.12.

## 2026-10-22

### Release 1 is local-only

Release 1 supports local macOS and Linux development. It includes plugins,
the public SDK and default adapters, workflows, marketplace management, and
in-process, subprocess, and worker-pool plugin execution. Container execution
and secured access (users, authentication, invites, and tokens) are Release 2.
Several local repositories remain separate projects. The release headline gates
only the local lane; the secured lane continues to run and report as
non-gating. The cases below define the Release 1 promise:

1. Install the platform with one command and start Studio without manual setup:
   PC-001, PC-002, S-040, S-120, S-125, S-181.
2. Install Commit from the marketplace and create AI commits in the selected
   repository: S-010, S-160, S-182, S-123.
3. Find, install, update, enable, disable, pin, and uninstall plugins:
   S-010, S-011, S-012, S-047, S-050, S-182.
4. Run workflows with inputs, inspect history, logs, and failures, cancel,
   rerun, and schedule them from CLI and Studio: S-002, S-007, S-008, S-009,
   S-021, S-022, S-029, S-044, S-056, S-143, S-184.
5. Scaffold a plugin on the public SDK, check compatibility, configure default
   adapters, and run it in supported Release 1 execution modes: S-003, S-048,
   S-053, S-054, S-186, S-240, S-241, S-242, S-243, S-246, S-247.
6. Update, roll back, uninstall safely, receive typed errors with next steps,
   and diagnose the platform: PC-001, S-023, S-024, S-025, S-050, S-051,
   S-053, S-258.
7. Use multiple isolated local repositories as projects: S-043, S-124, S-187.
8. Inspect analytics and platform, plugin, and workflow logs from CLI and
   Studio: S-009, S-044, S-121, S-191, S-270.

The Release 2 case list is S-039, S-042, S-045, S-046, S-052, S-055, S-100,
S-101, S-102, S-103, S-104, S-105, S-106, S-107, S-108, S-140, S-188, S-189,
S-190, S-245, S-253, and S-266. The S-266 case is landing from x128 and will
be marked `release: false` there. There is no existing docs roadmap page in
this checkout, so no new roadmap page is introduced.

### Release 1 Marketplace defaults use npm until the public Registry is deployed

Every Release 1 install renders `marketplace.sources` from the platform release
configuration. Its default list is `[npm]`, so a fresh local install works before
the public Registry is deployed. A Marketplace source explicitly supplied at
install time overrides that default and persists across updates. Once the public
Registry is live, changing the release-owned default to Registry-first is a
separate owner decision. Case: S-268.9.

## 2026-10-21

### Marketplace management is built in; the publishing registry is optional

Plugin and adapter installation is a platform capability: every installed
platform includes the marketplace service and the built-in `kb marketplace`
command group. The marketplace talks to package registries as a client. The
marketplace-registry backend serves publisher operations and self-hosted
deployments, so it is released and operated as a separate optional service,
not included in the default installed service graph. The host still composes
the consumer marketplace service directly. Cases: S-252, S-264.

## 2026-10-20

### Release sealing checks install scenarios without requiring operator input

The release sealer validates built-in install scenarios against each candidate
index for artifact and compatibility resolution. A required configuration
value or secret that the operator has not supplied does not make that index
invalid; the resolver still refuses the install or update until the value is
provided. Other scenario resolution failures, including missing artifacts and
incompatible releases, still fail sealing. Update-only requirements remain on
their staged update index and do not appear in the base index. Cases: S-023.12,
S-214.11.

## 2026-10-16

### D49 — MCP tool calls are durably audited with user and token identity

Every MCP `tools/call` admitted in secured mode carries the authenticated user
and API token identifiers into one durable platform audit record. The record
contains project, tool, outcome, correlation ID, and timestamp, but no tool
arguments or secrets. Local mode has no token identifier and records a null
token ID. Audit records share the platform audit collection with Gateway auth
events; analytics remain a separate signal. A secured forwarded identity
without its token ID is refused before tool dispatch. Permissions remain the
stub defined in the existing project MCP decision. Cases: S-253.3.

### Worker pool health includes startup and replacement recovery

The shared `kb.health/1` execution component reports resolved execution mode,
pool capacity, and the latest worker start or replacement failure. Health is
degraded when no worker is available, startup has failed, or replacement
failure leaves fewer live workers than the configured minimum. A failed pool
start is retried before the pool serves work; a half-started pool is not
published. Cases: S-241.

## 2026-10-15

### Human lifecycle translation publishes acknowledged progress

The event daemon is the sole translator from runner lifecycle JSONL to the
human-facing event stream. It publishes a cursor only after each translated
event has been appended. A lag notice begins after five seconds so short
scheduling delays do not look like a stalled translator, while sustained
backlog becomes visible. A dead daemon is reported through its runner-owned
`lost` state in `kb-runner ps`; a second heartbeat would duplicate the runner's
identity-based liveness owner. Every translated human line keeps its existing
prefix and ends with the source run tag and one-based runner event position,
so identical prose from separate runs remains tied to a single event. Cases:
S-237.15.

### D41: resource pressure queues work and reports the wait

When free disk is below a run's admission budget, the run stays queued/blocked
and visible in `kb-runner ps`; admission does not refuse or fail the run. On
the blocked transition the human stream emits one `LOW DISK` line with the run,
required and available bytes, and the `retire-stream.sh <accepted-stream>`
remedy. Cases: S-237.10, S-237.16.

### Cutover refuses while a ROOT is busy

The orchestrator quiesces a ROOT before replacing its launcher scripts. Cutover
refuses when any process from the install manifest is running in that ROOT, or
when the legacy batch lock exists. It checks the manifest inventory before and
after the atomic per-file replacements; if a launcher starts during installation,
the new watcher is not started and the operator waits for the run to finish
before retrying. The recorded event watcher is stopped by its verified identity
before the initial busy inventory. Completed legacy `.exit` files are imported
once; in-flight legacy agents are not migrated. The old reap helper remains
until the post-install inventory passes, then is removed because `kb-runner`
owns process-tree cleanup. Case: S-237.18.

### D42 — Host pressure admission follows level and cost class

When no resource-costed run is active, admission does not wait on the memory
or CPU quota or live available-memory check because no work under this
admission system can release memory. Host-pressure admission is level-aware:
normal admits both cost classes, memory warn admits light work and holds heavy
work, and critical pressure holds both. The governor retains its pressure
hysteresis and light concurrency limits; held work reports the pressure sample,
current level, and when that level began. An unknown sample preserves the last
known level for two minutes; once that sample is stale, the effective level is
unknown, which admits light work and holds heavy work until a known sample
updates the state. A held unknown-pressure run reports when pressure became
unknown. Slots, gates, FIFO, and disk admission remain enforced. When another
resource-costed run is active, memory/CPU quota and live available memory both
gate admission. If live available memory cannot be read, quota admission remains
authoritative and the resource notice reports the failed signal and OS reason.
Cases: S-237.29, S-237.38, S-237.53, S-237.74.

### D43 — kb-runner cleanup protects against accidents, not deliberate same-user races

kb-runner supervises processes and resources; it is not a sandbox. A run has
the same user authority as the cleaner, so cleanup guarantees prevent accidents
rather than contain a deliberately racing process. Registered paths are created
exclusively and checked against their owner nonce; scratch is created by the
keeper and checked against its recorded device and inode. Cleanup never follows
symlinks, including a replaced scratch root or a symlinked parent
present when cleanup starts, never resolves a deletion outside configured
cleanup roots, and refuses and reports identity mismatches. Deliberate same-user
TOCTOU races during the final filesystem syscall are outside the guarantee.
Cases: S-237.43–S-237.44.

## 2026-10-13

### Installation identity is validated at the shared boundary

Gateway allocation, registry claims, and the `kb` shim use the installation ID
from a validated version-root layout. An absent layout can request a new
Gateway allocation but cannot identify an existing registry row. Uninstall
captures its receipt's validated installation ID before removing the layout,
then releases that row by ID. A shim target that cannot resolve to a validated
installation is foreign, even when it resembles a managed path; apply and
doctor leave it untouched and doctor explains the target and the deliberate
remove and recreate commands. A shim belonging to another validated
installation also stays in place until the user deliberately switches it.
Cases: PC-001.10–PC-001.11, S-025.9, S-181.1.

## 2026-10-12

### Bootstrap credentials stop being startup credentials after first-admin completion

The bootstrap password only creates an unfinished first-admin account. Once the account is active, later user-driven password changes are independent of bootstrap configuration; the Gateway does not compare the stored bootstrap secret against an active user's credential. After the installer records completion, the host receives no bootstrap-password environment variable. Readiness counts an admin only through an operational configured identity provider. Cases: S-222.

### Gateway readiness follows configured identity methods

An active tenant administrator is usable when a configured login method can authenticate that user: the configured email-password provider needs its credential, while a configured redirect provider resolves an authenticated provider email to an active user in the tenant. A secured install with no bootstrap email does not require a bootstrap-completion marker; Gateway readiness and `kb-create doctor` report the configured sign-in path. Cases: S-100, S-222.

## 2026-10-11

### The chosen install directory is the complete installation container

The user-provided install root is a real directory containing `versions/`, a
relative `current` symlink, and declared installer state. Only `current`
changes during a version switch. There are no sibling version directories or
implicit user-data directories. Mutable runtime state that must survive a
switch is stored once under the install root and linked into each version;
sealed version roots never copy mutable state. Host process, supervisor,
control, update queue, and lifecycle-lock state lives at
`state/installer/host`. Lifecycle operations write outside the container only
to the install shim location selected by the invoked launcher and the existing
per-user Gateway registry and CLI diagnostic log. Uninstall removes
contract-owned entries, then removes the install root only when no foreign
entries remain. This supersedes the sibling-directory location below.
Cases: PC-001.5, PC-001.17, PC-003, S-023.10, S-023.16, S-023.17, S-050.5,
S-050.6, S-050.8, S-223.

### Version-root updates recover to the last healthy installation

Fresh installation creates a stable platform-root link and a versioned tree in
the `versions/` directory inside the user-chosen install root. Update
verification is offline while a host is running; starting a staged host could
bind the same service ports or open live project state. Update never restarts
services. It keeps the active root, last healthy root, and any tree still used
by a running host, pruning other version roots. If no healthy start was ever
recorded, the prior active root is the recovery root. A failed restart restores
that root; a successful restart records the new healthy root and then prunes
the former recovery root. Update, restart, and rollback refuse roots outside
this layout with a typed reinstall hint; they do not migrate legacy roots.
Uninstall removes the stable link and the entire owned version-root directory.
Cases: PC-001.5, PC-001.13, S-023.3, S-023.15, S-023.16, S-024.6,
S-050.5, S-050.6, S-223.

## 2026-10-09

### First-administrator disclosure is recorded after a successful result write

A secured install with a first-admin email and no supplied password generates a
password and seeds the administrator. The installer records disclosure only
after a result containing that credential was successfully written. Failures
before the result write leave the credential eligible for the next successful
install or apply result. A crash after the write and before the marker can show
the credential again on retry; avoiding that duplicate is less important than
avoiding lockout when the only generated password was never delivered. The
password remains in the platform secret store and is absent from the plan,
receipt, logs, and diagnostics. If the disclosure marker exists or the password
is absent, a later result gives the administrator's email and the exact
stop/recovery/start sequence without a password. `kb-create doctor --recover`
remains for account recovery after installation. Cases: PC-001, S-040, S-100,
S-222.

### Marketplace integrity pins may bypass registry freshness for the pinned artifact

For an urgent workspace security fix, add only the exact `package@version` to
`minimumReleaseAgeExclude` in the root `pnpm-workspace.yaml`, with the reason
recorded in the change. Remove the exception once the release-age window has
passed; do not use a package-wide wildcard.

The Marketplace npm source may exclude one exact package version from
`minimumReleaseAge` only when the request resolves to an exact version with
catalog integrity and pnpm records that same tarball integrity after install.
Marketplace coalesces versions for a package into one union selector and keeps
all unrelated selectors unchanged. Transitive packages remain subject to the
release-age policy. This supersedes the earlier rule that Marketplace never
edits package-manager configuration: Marketplace owns only its exact integrity
pin in `minimumReleaseAgeExclude`; kb-create remains the owner of sealed
platform `overrides`. The npm source writes the workspace file at the root it
installs into (normally platform root for adapters, or project root where the
npm source is used there); kb-create writes the sealed platform root. Cases:
S-054.11, S-220.1, S-220.4, S-220.5.

### Marketplace versions are immutable and installed versions only move forward

Cases: S-026.5, S-054.11, S-220.6–S-220.9.

A published package version is immutable. Republishing an existing version is a conflict; publishers must bump the version. The package identity is its exact version and integrity. Installing the same installed version with different registry integrity is treated as tampering and must not mutate the installed package or lock. Marketplace updates must resolve to a strictly higher version than the installed pin; equal and lower versions return a catalogued refusal naming the installed version. Plugin pins keep integrity and the optional platform signature as sibling fields so signature verification can be added without changing the lock shape. Signature verification remains a follow-up.

## 2026-10-07

### Credentials are kept per Gateway origin; the marketplace is a KB Labs Gateway

The official marketplace will be a hosted KB Labs Gateway in secured mode, using
the platform's own accounts, sessions, and API tokens. The CLI therefore keeps
saved credentials keyed by Gateway origin, uses each one only at the origin that
issued it, and lets a user stay signed in to several Gateways at once. Public
plugin installs need no credential. A team's private or paid plugins are fetched
by the host with the installation's marketplace credential, so members only
authenticate to their own platform. Author actions use a personal author
credential scoped to the author's plugin scopes; CI uses short-lived, scope-limited
publish credentials. Cases: S-216, S-217 (planned).

### Plugin lock keys are the manifest IDs

The canonical plugin identity is `id` from the package's `kb.plugin/3` manifest,
including its scope. Every platform and project marketplace lock uses that exact
ID as its plugin key; package names and shortened release-index IDs are not
alternate identities. The release-index sealer rejects a plugin artifact whose
ID differs from its manifest ID before producing a sealed index. CLI JSON
stdout contains one result envelope, while discovery diagnostics stay on
stderr. Cases: S-010.3, S-179.14, S-203.1.

### Offline plans show artifact resolution per artifact

`kb-create plan --offline` exposes the actual source selected for each resolved
artifact. An artifact is marked `resolvedFrom: "cache"` only when its
checksum-verified cache entry exists; the plan omits a resolved network URL in
that case. An offline plan with a missing or corrupt cache entry fails during
planning, before apply. Online plans identify registry resolution explicitly.
This keeps offline selection inspectable without treating the request flag as
proof of where the artifacts can be fetched. Case: S-181.4.

## 2026-10-01

### Project membership comes from the platform registry

`kb project add <path>` registers the canonical path regardless of whether the repository contains `.kb/`. The platform does not create files in the user's repository during registration, and a repository's `.kb/` directory is not the authority for whether it is a project. Project configuration and state ownership are tracked as separate follow-up work.
Cases: S-043, S-124, S-187.

### Adapters and LLM settings are platform-only

Adapter bindings, adapter options, LLM credentials, and model selection are
configured once in platform config and apply to every registered project.
Projects may attach plugins at project scope, but cannot configure or override
adapters. A project config containing `platform.adapters` or
`platform.adapterOptions` fails with typed code `KB_ADAPTER_PROJECT_SCOPE` and
an actionable hint to move those fields to the platform config. This removes
project-level adapter configuration from the config schema/loader, CLI, REST,
Studio, health, doctor, and user documentation.
Cases: S-017, S-018, S-048; S-200 is historical and superseded by S-048.

### Plugin settings are platform-owned and project-scoped

Plugin defaults are layered with platform defaults and per-project overrides.
Project config is stored by `projectId` in platform state; the platform never
reads project plugin settings from `.kb/kb.config.*` in the consumer
repository. `kb config` resolves project scope from cwd, Studio edits the
selected project, invalid values are checked against the plugin's declared
settings schema, and removing a project archives its config for restoration
when the same deterministic project ID is registered again. The SDK currently
has no plugin settings-schema declaration; use the existing manifest
`SchemaRef` for the planned declaration rather than adapter `configSchema`.
Cases: S-043, S-124, S-196, S-204.

### Cases are the product specification

The case catalog is the product truth for code, tests and docs. Work is case-first TDD: case → e2e claim (red) → integration and unit tests → implementation. See [ADR-0050](../adr/0050-product-cases-are-the-specification.md).

### Release scope: platform core plus the Commit plugin

Plugins don't ship with the platform. Users install them from the marketplace by choice. Release cases cover the platform core and the Commit plugin installed from the marketplace. Other plugins (Review, Mind, Agents, Release, QA, Inbox, ClickUp, Steward, DevLink, Site Tools, Quality) remain marketplace plugins outside the release contour; their roster will be decided separately.
Cases: S-010, S-011, S-012, S-047, S-123, S-160.

### Supported operating systems: Linux and macOS

Windows is not supported, so no Windows installer is shipped. A macOS journey lane is required once CI is available again.
Cases: S-053.

### No self-registration

The first administrator bootstraps the platform and has an offline recovery path (`kb-create doctor --recover`). Users join only through admin invites. Members see no user administration and are denied direct access to it. Machine registration for host agents is not human self-registration: it stays admin-gated and outside the release.
Cases: S-100, S-104.6, S-105, S-106, S-107, S-108.

### Roles, invites, reset links and API tokens

- Two roles:
  - `admin`: everything, including inviting admins or members;
  - `member`: projects, plugins and workflows, with no user management.
- Admins can change roles. The last active admin can't be disabled or demoted.
- Invites are valid for 7 days, reset links for 24 hours, and both are single-use. Admins generate a reset link and share it themselves; email delivery comes later through the notifier adapter.
- API tokens inherit the user's role, can have an optional expiry, and are revocable.
Cases: S-101 to S-108.

### Built-in local adapter defaults

A built-in default adapter pack ships with the platform. Every capability that something local can serve without external dependencies gets a default: storage (filesystem), cache, logs, state and queues. LLM and vector store have no default, because a local one can't be guaranteed. Features that need them fail with a typed "adapter required" error and a `kb adapter bind` hint.
Cases: S-047, S-048, S-160.2, S-123.

### Commit plugin without an LLM

Generating a commit plan needs an LLM, so without a bound LLM adapter the Commit plugin returns the typed "LLM adapter required" error instead of silently falling back to a heuristic plan. The release journey binds a deterministic test LLM adapter through normal adapter configuration; that adapter is test infrastructure, not a product shortcut.
Cases: S-160, S-123.

### Scheduling: workflow, job, cron

- A **workflow** is an automation scenario, a **job** is a background task, and a **cron** is a schedule.
- A cron is its own entity in `.kb/crons/<id>.yml`: schedule, timezone (default UTC), enabled, and a target (`workflow: <id>` with input, or a job).
- Missed runs are not caught up.
- Crons are managed through `kb workflow crons list|enable|disable`, the Studio Crons page and `/api/v1/crons`. Plugin manifest crons stay.
- The old `.kb/jobs` inline-workflow schedule is removed without compatibility.
- A project with enabled schedules keeps its runtime warm.
- Workflow run records persist through the storage adapter.
Cases: S-044 and the cron cases.

### Workflow operations in the release

Cancel and rerun are release behavior. Restart-from-step and approvals are active but don't gate a release. Inbound webhook triggers are not supported: there is no public ingress, authentication or retry contract, so the unreachable `on.webhook` trigger shape is removed.
Cases: S-008, S-143, S-144, S-145, S-032 (historical).

### Project MCP

- Commands of installed plugins automatically become project MCP tools.
- In secured mode, access uses the user's API token with that user's role.
- Tool failures are `CallToolResult` values with `isError: true`, the ADR-0049 envelope as `structuredContent`, and a `"<code>: <message> — <hint>"` text line; protocol errors stay JSON-RPC errors.
- Project MCP is release; agent sessions and host-agent registration are not.
Cases: S-045, S-140, S-141, S-142.

### Platform update and rollback

- Two compatibility policies:
  - `strict`: the exact release matrix;
  - `compatible`: semver ranges, the installer default.
- Update checks every installed plugin and adapter from the receipt and refuses, naming the one that would break.
- Updates move forward only. N+1 patch, N+1 minor, and matrix-admitted jumps across releases are supported; downgrades are refused with `KB_UPDATE_DOWNGRADE_REFUSED`. Rollback is recovery to a saved snapshot, not an update path.
- Update stages a side-by-side installation and verifies artifact checksums, materialized manifests, rendered config, and doctor checks before an atomic active-version switch. Before the switch, failure leaves the active installation byte-for-byte unchanged and removes the staged tree.
- Update never stops or restarts services. The old installed version remains intact until services restart and is retained as the rollback target. The result gives the exact restart command; status and doctor show running and installed versions plus pending services. A stopped host starts the new installed version.
- A failed health check after restart automatically restores the previous snapshot and starts the previous version. Manual rollback to a named saved snapshot remains supported.
- Plans and results list each component from -> to, release notes for each intervening release from the sealed index, download size, added/removed packages, phase progress, and durations. Each platform release entry carries markdown `releaseNotes`, keeping notes self-contained and available offline; release flow population belongs to r05 (see planned S-214.10).
- Update never interrupts work. Before restart, the platform-owned in-flight-work query returns workflow runs, service jobs, and long-command registrations as `{ kind, id, owningService }`, based on platform state rather than process inspection. Non-interactive restart refuses with `KB_RESTART_WORK_IN_FLIGHT` and a hint to wait or rerun with `--interrupt`; interactive mode asks whether to wait or proceed.
- Retain the active version, previous version, and at most two recovery snapshots. Prune older versions and snapshots only after the new version restarts healthy. Doctor reports disk use of retained versions and snapshots; there is no byte cap.
- The update result and status/doctor JSON share `pendingRestart: { services: [{ id, runningVersion }], installedVersion, command }`; it is absent when nothing is pending. Human output lists affected services and the command.
- `status` and `doctor` show the channel and the exact version.
- Installing and updating from the canary channel is supported.
Cases: S-023, S-024, S-052, S-053, S-194.

### Recovery hints on installed platforms

Error hints on an installed platform point to `kb-create status` and `kb-create doctor --platform-root <path>`. They don't point to `kb-dev`, which is a development tool.
Cases: S-125, S-100.

### Installed artifact manifests come from the sealed plan

`kb-create` materializes each selected package's `kb-create.manifest.json` from that artifact's config requirements in the sealed release index after every pnpm operation that can replace package directories, including install, update, and snapshot restore. The release tarball stays unchanged, so its published bytes and sealed checksum remain the same; doctor reads the exact metadata the installer resolved and recorded in its receipt. pnpm links `node_modules/<package>` into its virtual store, so a later `pnpm install` can replace that directory and remove launcher-written files.
Cases: S-054.2, S-024.5.

### Studio first tier

The first-tier Studio pages are the current dashboard (described as it is), analytics, observability, user administration, projects, workflows, the marketplace, and the Commit plugin page as proof that marketplace plugins load.
Cases: S-020, S-046, S-106 to S-108, S-120 to S-125.

### History retention

There is no retention policy for run history yet.

### Developer tooling comes last

kb-dev and kb-devkit are functionally solid and need cases and tests only. kb-deploy and kb-monitor need stabilization. Deployment and container cases (S-004, S-034 to S-038) stay planned and outside the release until that phase.

### One UX outcome contract across every surface

All TypeScript and Go CLIs and HTTP/MCP machine results use `{ok:true,data,meta?}` for success and `{ok:false,error}` for failure. Failures use the existing platform `ErrorEnvelope` and `KB_*` catalog; unknown failures use `KB_RUNTIME_UNEXPECTED` with a correlation ID and a stack only in structured logs. CLI exit codes are shared: 0 for a normally completed command call, 2 for invalid usage/input, and 1 for other operation failures. A normal return, including void, verifies completion of the command call only; any product postcondition is owned by its case. Human errors use one renderer for code, message, known cause, and next step. Registry-driven coverage is required across commands, HTTP routes, MCP tools, and Studio error boundaries.
Cases: S-203.

### Workspace CLI resolves configured adapters from the workspace

In a monorepo development checkout, configured adapter packages resolve directly from pnpm workspace package roots only when the platform-owned config contains `"platform": { "mode": "development" }`. This explicit marker is absent from kb-create's rendered installed-platform config; a retained `pnpm-workspace.yaml` does not enable workspace resolution. The root package does not mirror every adapter binding as a dependency, because that duplicates `.kb/kb.config.jsonc` and can drift. Adapter classification follows the KB manifest, and only configured platform adapters resolve from the platform workspace. A bound invalid package returns typed `KB_HOST_ADAPTER_UNAVAILABLE`; if the package is absent from both workspace and lock, the error directs the operator to `kb marketplace install <package> --scope platform`. An unbuilt workspace adapter returns the build command `pnpm build`.
Cases: S-179.5, S-179.6, S-179.7, S-179.8, S-179.9, S-179.10, S-179.11, S-179.12.

## 2026-10-02

### System CLI commands declare startup scope

Every registered system CLI command declares whether startup requires a
registered project. Plugin commands are always project-scoped because plugins
attach to projects (ADR-0052). Global help without a command and version are
platform-scoped global flags. `project show` is platform-scoped and resolves an
explicit reference itself, or looks up cwd when no reference is given; an
unknown cwd returns `KB_PROJECT_UNKNOWN`. Scope and auth exemption remain
independent declarations.
Cases: S-124, S-054.17, PC-002.6.

### Platform CLI authentication gate

The platform owns one deny-by-default authentication gate at each entry point. CLI wraps every system and plugin command before dispatch; only its platform-owned auth/help/version/bootstrap/diagnostic allowlist bypasses the gate. Plugins and services declare no auth metadata. The Gateway authenticates globally before routing to registered services, project runtimes, or plugin REST handlers; only explicit public routes pass anonymously. Unmatched Gateway paths reach the shared not-found boundary and return its catalogued 404, including in secured mode. Manifest-declared webhook routes are authenticated by their declared webhook verifier (secret, HMAC, or custom validator), not by a user session; undeclared paths cannot bypass the gateway gate by resembling webhook routes. MCP authenticates at its transport boundary before session or tool dispatch and retains HTTP 401 for unauthenticated clients. In all entry points, authentication precedes permissions and product preconditions. Local mode is a no-op. Authenticated authorization failures use `KB_AUTH_FORBIDDEN` with the permission the Gateway checked, or a catalog message that does not name a role when no permission is available.

A CORS preflight (`OPTIONS` with `Access-Control-Request-Method`) receives only a CORS response and never dispatches to a session, tool, service, or plugin handler; ordinary OPTIONS requests remain authenticated.

`/health/auth` is a self-guarded loopback operator route: the platform gate lets only this exact route reach its own checks for loopback peer, loopback Host, and absent forwarding headers. Every other caller receives the same HTTP 404 and catalogued `KB_RUNTIME_RESOURCE_NOT_FOUND` envelope as an unknown Gateway path (only `correlationId` may differ), before readiness is computed; no readiness details are disclosed. `/health`, `/health/adapters`, and `/ready` remain public because health probes need coarse readiness before login. `/auth/token` remains public because its client-credential body is the proof used to obtain a machine session. Public marketplace-registry package-list, package-metadata, and package-stats GET routes remain available without a user session; package visibility still goes through `canAccess`, using the optional identity forwarded by the Gateway when present.

Owner intent (2026-10-02): “главное сделать платформенно (чтобы все подключенные плагины сразу получали защиту от доступа) без необходимости добавлять что-то в потребитель. по сути для разных точек разная защита — CLI - общая обертка над всеми командами (до вызова команды идет проверка авторизация и только после доступ), gateway - тоже все запросы не публичные перехватывает и отдает ошибку до того как запрос дойдет до сервисов. ну и MCP аналогично”

Cases: S-007.4, S-041.7 to S-041.10, S-041.12, S-255.7 to S-255.10, S-045.5, S-104, S-140.6.

### Persistent adapter defaults and analytics persistence disclosure

"The idea is that the user has no headache at the base level and doesn't need to configure everything from scratch. Instead of an InMemory fallback, the minimum is FS/SQLite or something cheap and easy to install. No local databases with lots of replicas are needed, but later the user can replace adapters with the ones they need."

Fresh local and secured installs resolve the SQLite analytics adapter from the shipped platform release index, so a fresh install displays real aggregate stats with durable persistence and no volatility notice. If no persistent analytics binding resolves, the runtime can use its in-memory analytics buffer; Studio then states that those real stats cover only the current host process and reset on restart, and shows the catalog-owned `KB_ANALYTICS_PERSISTENCE_VOLATILE` hint for configuring a persistent adapter. Each adapter declares persistence through its structured stats capability; Studio does not infer it from provider names. Defaults are replaceable through `kb adapter bind <slot> <package>`; replacing a provider does not migrate or delete data held by the previous provider. An available persistent adapter must never be silently replaced by an InMemory fallback. OpenAI remains the implicit LLM provider; its adapter can construct without a key and reports `KB_ADAPTER_CREDENTIALS_MISSING` only when used. Missing credentials for optional capabilities are warning-severity doctor findings and do not make an otherwise healthy install fail; use reports the typed credentials error. Adapter manifests may declare required credential options as secret values with environment sources; these credentials may be missing at construction, while required structural options such as a service map exclude a provider from implicit defaults. Embeddings and vector store remain unconfigured and return typed adapter-required errors without configured providers. Durable account, workflow, KV, and document data survives a host restart. Doctor diagnosis is read-only; `kb-create doctor --fix` is the explicit repair operation for missing installed manifest projections. Cases: S-121.6, S-275.1.

The sealed base install includes `@kb-labs/adapters-openai` so the runtime can
select it through `defaultFor: { llm: ["llm"] }` without writing an explicit
`platform.adapters.llm` binding. Each `defaultFor` entry maps a platform slot
to package entry-point path segments; an empty array selects the package root.
With `OPENAI_API_KEY` unset, adapter list and doctor report the missing
credential as a warning; an LLM request returns the typed credentials error.
Cases: S-054.1, S-054.2, S-054.9, S-054.10, S-054.11, S-272.1.

### 2026-10-01: Explicit token kinds and lifecycle contract changes

Every JWT carries an explicit token kind. User access, user refresh, machine access, and machine refresh tokens use distinct `type` values, and each verifier accepts only its own kind. There is no compatibility for tokens issued before this contract. When an update crosses this contract change, saved user sessions become invalid and the CLI reports `KB_AUTH_REQUIRED` with the `kb auth login` hint so users can sign in again. Machine credentials are re-established automatically: hosts register and obtain fresh machine tokens on start, including after rollback to a release that does not recognize the new token contract. Cases: S-041.4, S-023, S-024.

### 2026-10-06: Saved user sessions survive same-contract platform lifecycle changes

A saved CLI user session survives platform update, rollback, and host restart while the token contract remains unchanged. If a host rejects a saved token, protected commands return `KB_AUTH_REQUIRED` with the login hint. The host machine connection still authenticates from stored machine registration credentials on every start. No legacy token compatibility path is retained. This supersedes the 2026-10-01 lifecycle expectation for updates that do not change the token contract. Cases: S-041.4, S-023, S-024.

### 2026-10-06: Diagnostic reports succeed and gates return structured findings

Commands whose purpose is to inspect and report (doctor, diag, logs diagnose,
registry diagnostics, and equivalent report commands) succeed even when they
find problems. Their result is `{status: "healthy"|"degraded"|"unhealthy", ...report}`
inside the success `data`, and they exit 0; this follows the existing doctor
decision that diagnosis is read-only. Gate commands such as validate and sync
that reject an operation return a catalogued failure envelope and put findings
in its `error.diagnostics` array (`code`, `message`, `severity`, optional
`path`, `line`, and `hint`). `error.details` remains a flat string map of
identifiers and must not encode objects or arrays as JSON strings. The shared
human renderer presents the same diagnostic records as a list.
Cases: S-203.1, S-203.2.

### 2026-10-06: Command handlers return data and throw typed failures

Every system and plugin CLI handler returns plain command data or a typed
plugin-contracts `CommandFailure`; the shared command boundary creates the
ADR-0049 result envelope exactly once. A handler returning a success-envelope
shaped object is a contract violation, and payload fields such as `ok` remain
payload data. Both handler types use the same `CommandFailure` for catalogued
operation failures. Known
actionable conditions retain their catalogued code and matching next-step hint;
only unexpected failures use `KB_RUNTIME_UNEXPECTED`. The platform
`toErrorEnvelope` is the only TypeScript error normalizer and accepts typed
platform errors through a shared structural contract without depending on
higher-level command packages. Structured findings use `error.diagnostics`;
error details remain a flat string map and are never JSON-encoded objects.
Cases: S-203.1, S-203.2.

### Platform members: core plugins only

The platform includes built-in capabilities: `workflow` (the CLI for the workflow service), `marketplace` (installing plugins) and `scaffold` (plugin authoring). Commit, Review, Quality, Release and Steward are marketplace plugins and are not platform members. This applies the 2026-10-01 release-scope decision to the release configuration (`release.flows.platform.platformMembers`) and to the journey candidate. Before this change, the journey candidate didn't install the workflow CLI at all, so `kb workflow …` was unknown on installed platforms.
Cases: S-006, S-008, S-010, S-160.

### 2026-10-01: Platform installs seal runtime peer dependencies

The platform release index includes every runtime peer dependency reachable
from its installed platform members and SDK, recursively. SDK peers are shared
platform copies for all plugins, so the platform install owns those artifacts;
plugins do not install their own copies. The release sealer derives this set
from the exact staged package manifests and published `dist` imports. Internal
imports must resolve through a declared dependency or a peer sealed in the
platform set; external packages resolve through the npm dependency graph.
Packages imported at runtime remain peers when the host provides the
shared copy; ordinary package dependencies remain dependencies. The SDK does
not bundle peer packages such as `shared-tool-kit` and `shared-command-kit` as
special cases.

The release sealer analyzes SDK exports except subpaths declared in
`kbLabs.release.nonRuntimeEntrypoints`; test and build helper subpaths are
omitted there, while new exports remain runtime by default. Optional SDK peers
are consumer-provided and are not platform members.
If a declared runtime entrypoint statically imports an optional peer, sealing
fails so runtime code cannot rely on a package the platform does not provide.

Cases: S-003.1, S-054.2.

### Adapter installs preserve sealed platform artifacts

Platform adapters remain installed in the platform root because runtime adapter discovery reads their package paths from the platform marketplace lock. Before adding an adapter, marketplace records exact `file:.kb/v2/cache/packages/*.tgz` dependencies as pnpm overrides, so pnpm cannot replace sealed packages while resolving the new adapter. Plugin packages continue to use the shared extension store at both scopes.
Cases: S-010.1, S-054.11.

### The gateway-to-service secret is required and installer-managed

`GATEWAY_INTERNAL_SECRET` is required by the gateway, REST API, and marketplace-registry in every mode because each service boundary denies requests without the shared value. A fresh local or secured kb-create install generates it in the private secret store, passes it to every protected service, and retains the same value through update and rollback. Container and team deployments provide the required variable through their deployment secret configuration; startup fails with `KB_CONFIG_SECRET_MISSING` when it is absent. Users of kb-create never enter this secret manually.
Cases: S-038.1 to S-038.7.

### Superseding decision: kb-create owns sealed artifact overrides

The installed platform's package-manager configuration belongs to kb-create,
which seals the release artifacts. Install and update write an override for
every sealed package to its exact cached `file:` archive; snapshots include
`pnpm-workspace.yaml`, so rollback restores the previous pins. Marketplace
never edits package-manager configuration. A platform without a required pin
gets a typed error directing its operator to `kb-create update` rather than an
automatic repair. This keeps direct and transitive instances of a sealed
package on the same artifact and makes lifecycle recovery deterministic.
Cases: S-010.1, S-054.11, S-054.12.

### One storage default

`@kb-labs/adapters-fs` is the only adapter that declares itself the default for `storage`. `@kb-labs/data-store` stays installable and bindable, but two defaults made install resolution ambiguous.
Cases: S-047, S-048.

### 2026-10-20: Keep implicit storage project-scoped

The fresh-install release config selects the filesystem adapter without writing
`platform.adapterOptions.storage`; the adapter manifest supplies its implicit
`<KB_HOME>/state/<projectId>/storage` path. A user-selected relative storage
path remains platform data and is configured explicitly.
Cases: S-048.2, S-054.1, S-054.21.

### 2026-10-20: Release defaults have a release-owned config source

The developer workspace config and the fresh-install release config have
different owners and purposes. `.kb/kb.config.jsonc` retains the explicit
workspace storage directory; `tools/kb-create/config/platform-release.jsonc`
is the release producer's source for the config sealed into a fresh install and
leaves implicit storage to the adapter manifest. Release tooling reads that
source directly instead of deriving it by filtering developer settings. Cases:
S-054.1, S-054.21, S-179.5.

### Marketplace plugins never mutate the sealed platform dependency graph

Marketplace plugin entry packages use the shared extension store at both project
and platform scope. The selected scope still controls the marketplace lock and
visibility; it does not decide whether pnpm may rewrite the installed platform's
package graph. Platform adapters remain installed in the platform graph because
the host resolves them as platform runtime providers. This supersedes ADR-0048
D1's platform-scope plugin placement, which predates sealed installed receipts.
Cases: S-010.1, S-123.1.

### Proposed: sealed service lifecycle after installation — needs owner confirmation

Recommend selective service installation from the platform's sealed release
index, with `kb-create service add|enable|disable` operating on the installed
receipt. Adding a service should resolve only artifacts in a verified index,
preserve the existing service set on failure, and record a snapshot before
changing the installation. Enabling or disabling a service should update the
host's managed service state and make its associated CLI plugin available or
unavailable with it where a service has an associated CLI plugin. Updates
preserve the installed service set and enabled states; rollback restores both
from the snapshot. Platform-root operators
manage local installs; secured-mode service changes require a platform
administrator. This avoids paying the package, install, and operational cost
of every official service on every install while retaining a convenient path to
add services later. Marketplace installation remains the plugin mechanism and
does not own service artifacts.

Cases: S-194. This is a proposal only; confirm the command and secured-mode
authorization surface before implementation.

### 2026-10-02: CLI config absence is valid; present broken config is an error

Platform and project config layers are optional. An installed platform can use
its built-in adapter manifests when it has no user-written platform config, and
a source checkout can omit `platform.mode`; absence does not imply malformed
configuration or trigger a setup error. When a config file is present but
cannot be read, parsed, or validated, CLI startup returns a shared typed config
error before running a command. It must not silently replace that configuration
with NoOp adapters. Adapter initialization degradation remains governed by
S-054.2 and is not covered by this config-load decision.

System logs query platform and host records without project registration.
Project-specific workflow log views remain scoped to their selected project.
`mcp config` stays project-scoped because its URL and result contain the
registered project identity. `docs generate-cli-reference` stays
project-scoped because it writes documentation into the project tree. The
simple `hello` command is platform-scoped because it reads no project state and
writes no project files. `config get`, `config set`, and `config show` are
project-context commands: their default/effective view includes project state,
while explicit `--scope platform|project` selects the corresponding user config
file from any registered project cwd. Platform adapter changes require an
explicit host restart, which `config set --scope platform` reports as the exact
next command.

Cases: PC-002.7, S-003.7, S-017.5, S-018.3, S-054.2, S-054.18, S-199.6,
S-201.1–S-201.2, S-203.7–S-203.8.

## 2026-10-08

### Plugin discovery fails closed on an unusable governance policy

An absent optional config leaves plugin governance unset. Once a config file is
present, an unreadable, malformed, or wrongly typed `plugins.allow` or
`plugins.block` policy is a discovery diagnostic and cannot be treated as an
empty policy. Discovery fails closed for marketplace-installed third-party
packages in the affected scope, while first-party, linked, and workspace
plugins remain available for development and platform operation. Plugin
manifests are recognized only through `kb.manifest` or `kb.plugin.json`; a
package entry point is not evidence that a package is a plugin. Declared
manifest modules export one named `manifest`; loaders, build emitters, and
diagnostic commands do not fall back to a default export or module namespace.
Entity kind comes only from the registered `schema` value. First-party status
comes from discovery provenance: workspace and linked candidates, plus entries
shipped in the platform-scope lock; npm package names do not grant an exemption.
Config diagnostics retain their original code and repair hint, followed by a
doctor command with the affected scope. The governance behavior is proved in
installed local and secured journeys with a registered project and the
marketplace-published `@kb-labs/e2e-analytics-emitter` fixture. Cases: S-203.25.

### CLI authentication has one session owner

The CLI auth-session owner selects a saved human session before a machine
credential when a caller accepts either kind. A caller that requires one kind
requests that kind explicitly; an unusable or wrong-origin preferred session
does not silently fall through to another identity. REST, platform auth
preflight, and SSE accept either kind, with the human session preferred. The
owner enforces issuing-origin isolation, refresh, verification, and safe
Gateway error decoding for every caller. Login and logout use the same owner.
Cases: S-005, S-031, S-041, S-042, S-100.

## 2026-10-07

### 2026-10-07: Human CLI passwords stay out of process arguments

`kb auth login` accepts `--password-stdin` for automation and prompts securely
when a human omits `--password`. Auth catalog hints show the login command
without a password argument. There is no password environment-variable
fallback. When no TTY is available, a missing required password is invalid
usage; the CLI exits 2 and gives the exact `--password-stdin` command. Cases:
S-007.4, S-010.6, S-031.4, S-041.6, S-041.7.

### 2026-10-07: CLI Gateway routing follows the installed platform root

The CLI resolves a local installed Gateway from the active platform root's
verified URL in `.kb/v2/receipt.json`. Only `KB_GATEWAY_URL` explicitly
overrides an installed receipt; `GATEWAY_PORT`, `GATEWAY_HOST`, and
`KB_NET_OFFSET` select the workspace listener only when there is no installed
receipt. The Gateway's public `/health/identity` response exposes only the
non-secret installation ID. A mismatch reports the local platform root and
both installation IDs, never a remote filesystem path. Client roots continue
to use their saved session Gateway URL.

The installation ID is generated once for a platform root, persisted as
`installation.id` alongside launcher secrets, and recorded as `installationId`
in every V2 receipt. Update, rollback, and restart preserve it;
the kb-create host launcher passes it to the Gateway as
`KB_INSTALLATION_ID`. An installed Gateway without a matching launcher identity
does not start. A receipt without this field is unavailable and must be updated
or reinstalled; the transaction-specific receipt `id` is not a platform
identity.

Saved user sessions and machine credentials may be used only with the Gateway
origin that issued them. If the selected Gateway origin differs, CLI API
calls do not send or refresh those credentials and return `KB_AUTH_REQUIRED`
with a login hint for the selected Gateway.
Cases: PC-001.12, S-054.12, S-203.22–S-203.23.

## 2026-10-06

### Enabled plugin identity must match its manifest

An enabled marketplace lock entry whose canonical package/plugin ID differs
from `ManifestV3.id` is invalid and contributes no commands or other entities.
Discovery retains a typed diagnostic, CLI unknown-command output points to
`kb marketplace plugins doctor --scope <scope>`, and plugin doctor lists the
failed enabled entry. No silent continue is allowed. Cases: S-203.21.

### Gateway authentication exposes only safe rejection categories

Protected Gateway rejections may include `details.reason` only from the closed
set `expired`, `invalid`, `unknown-issuer`, `inactive`, and `revoked`. Missing
or invalid credentials use `KB_AUTH_REQUIRED`; expired, revoked, and inactive
credentials use their catalogued actionable auth code. The Gateway logs the
same category with the request correlation ID. It never returns raw verifier
messages, token claims, token IDs, or secret material. Cases: S-203.20.

### Plugin command declarations have one shared schema

The `@kb-labs/plugin-contracts` CLI declaration schema is the source of truth
for the SDK authoring types, CLI registration, and discovery. CLI flag names
use lowercase letters, digits, and hyphens; choices apply only to string
flags. Invalid first-party declarations fail the workspace manifest test and
enabled invalid plugins receive a retained discovery diagnostic. Discovery
and CLI execution use one handler-path resolver. Cases: S-203.21.

### Gateway credential failures use catalogued actionable codes

Missing and invalid credentials remain `KB_AUTH_REQUIRED`. Expired access
credentials use `KB_AUTH_TOKEN_EXPIRED`; revoked sessions and inactive users
use their own catalogued codes. Safe `details.reason` values remain available
for automation. The CLI renders the returned catalog envelope and fills its
Gateway URL template from the saved auth context. KB-signed JWTs use an
explicit issuer; tokens without that issuer require a fresh login. Cases:
S-203.20.

### macOS user temp directories are valid plugin workspaces

The hardcoded filesystem boundary denies operating-system paths such as `/etc`,
`/usr`, and system-owned `/var` content. macOS places the current user's private
temporary directory under `/var/folders`, often exposed through `/var` while
resolving to `/private/var`; that directory is valid project cwd and output
storage. Resolve paths through symlinks before checking the boundary and exempt
only paths inside the canonical macOS user temp directory. Other `/var` paths
remain denied.
Cases: S-210.

### Product analytics excludes raw adapter operation telemetry

`IAnalytics` stores product actions and usage that answers a product question.
Raw cache, storage, and vector-store calls are adapter telemetry and must not
be written as analytics events. LLM and embeddings events remain because their
usage and cost inform product usage. Adapter errors belong in contextual
operational logs; operation counts and latency belong in metrics where the
runtime exposes a metrics registry. The current core platform has no shared
adapter metrics registry, so it does not synthesize analytics or per-call log
events as a substitute. Local SQLite analytics retains 90 days by default;
`platform.adapterOptions.analytics.retentionDays` overrides the age in days.
Cases: S-002, S-121, S-191.

## 2026-10-07

### Team members install a client profile

`kb-create apply --service-profile client` installs the CLI and the user's
`kb` shim without declaring services, writing host runtime configuration, or
starting a host. The client profile shares the installer with host profiles
and uses the existing shim ownership rules. The single-host guard applies only
to profiles that run a host, so client installation succeeds beside a running
host. `kb-create status` and `doctor` report `profile: client` as healthy without
expecting a host. The member then signs in with `kb auth login --gateway-url
<url> --email <member>` and uses the secured team Gateway. Cases: S-005.1,
S-005.6–S-005.7.

### One `kb` command belongs to one live platform root

The user has one managed `kb` command. Shim ownership is the validated
installation identity, so an install root, its `current` path, and its active
version path identify the same owner. Applying another platform leaves the
shim with its current owner while that installation has a valid V2 receipt.
Apply takes the shim when it is absent, already points to the requested
installation, or points to a managed target whose receipt is no longer valid.
JSON reports the canonical installation root when apply leaves the shim in
place, and human output gives the direct CLI path for the new root. Uninstall
removes the shim only when the uninstalling installation owns it; uninstall
does not guess a replacement owner. A target that cannot be mapped to a
validated installation is foreign and remains untouched. Doctor names the link
and target, explains why it is foreign, and tells the user to inspect it before
removing that exact link and running doctor fix for the intended installation.
User-owned files at the shim path are never modified. The decision is enforced
at the shared `shim` ownership boundary used by apply, uninstall, and doctor.
Cases: PC-001.10–PC-001.11, S-025.9.

### Installed host roots receive distinct Gateway addresses by default

When a machine installs another host profile without `--gateway-url`, kb-create
reuses the release Gateway address if no installed root claims it. Otherwise it
allocates the next free 100-port offset. The allocated origin is stored in the
resolved plan and receipt; every declared service port and transport URL uses
that same offset. A stopped root retains its claim; only uninstall releases it.
Update, rollback, and restart preserve the allocation. The
shim identifies only its current owner, and the host PID record identifies
only a currently running root; neither enumerates installed roots. Project
registry entries do not identify platform roots. A machine-level launcher
registry therefore records all successfully applied root and Gateway pairs for
subsequent allocations. An occupied port owned by a non-KB process fails
planning with `KB_INSTALL_PORT_IN_USE` and a `--gateway-url` hint. An explicit
`--gateway-url` remains the operator override. Cases:
PC-001.10, PC-001.12, PC-001.16.

### 2026-10-30: automatic Gateway allocations stay within the local port domain

When kb-create selects a Gateway address automatically, it uses 100-port
boundaries from 4000 through 9900 and accounts for the selected service graph.
Every nonzero derived service port must remain below the conventional
ephemeral-port boundary shared by supported Linux and macOS environments. If
the remaining registered addresses cannot satisfy that constraint, planning
fails with no allocation instead of choosing an ephemeral service port.
Explicit `--gateway-url` remains the operator override. Cases: PC-001.10,
PC-001.16.

### Destructive confirmation without a TTY is invalid usage

Destructive `kb-create` operations require explicit `--yes` when no terminal is
available. Missing confirmation is invalid command usage and exits 2; a
terminal cancellation remains an operation cancellation and exits 1. A shared
confirmation boundary applies this rule to uninstall, rollback, and account
recovery before any destructive action runs.
Cases: S-050.3–S-050.4, S-024.4, S-203.12.

### Required interactive input never uses a silent default

When a CLI or plugin asks for required input and its execution context has no
interactive responder, it fails with `KB_RUNTIME_INPUT_INVALID` instead of
accepting a prompt default. CLI prompts without a TTY exit 2 and give the exact
command for supplying input through a supported flag or stdin. Plugin prompts
in workflow, Studio, REST, MCP, and worker execution fail at the prompt
boundary; callers must pass the value as explicit workflow or request input.
Cases: S-041.6, S-215.1.

### Release compatibility versions

The first release stamps one lockstep version across platform packages, the SDK,
and release binaries. The `kb.release-compatibility/2` matrix is the only
compatibility gate: the release index records each artifact's actual version and
its exact relations, and the catalog accepts a candidate only when those
relations are present. Independent versions later are a release-flow data
change; the installer, catalog, and index preparer do not add a second equality
rule. Cases: S-214.8–S-214.9.

## 2026-10-09

### Per-root host lifecycle starts cleanly

V2 host process state belongs to its platform root. Existing host processes
tracked only by the former shared `~/.kb/launcher/host.pid` location are not
migrated into per-root state; users must stop and start those hosts with the
current launcher. No compatibility reader or migration shim is maintained.
Cases: PC-001.10, PC-001.12, PC-001.16.

## 2026-10-11

### Project registration belongs to the user after bootstrap

A first install registers its selected project through the Gateway as the first
administrator created by that install, without saving a CLI session. Local and
secured installs use the same host-owned project API. Later install/apply calls
may keep the recorded project selection or omit it; a different non-empty
selection is refused before apply so the user can authenticate and register it
explicitly. Duplicate registration of the same canonical path returns the
existing record unless a conflicting name was requested. Update never
registers projects. Cases: S-124.14, S-187.9–S-187.12, S-224.1.

## 2026-10-12

### Project identity is owned by the registry

The installer preserves the selected project path as an absolute lexical
spelling and sends it to the Gateway project registry. The registry owns the
project ID and canonical path; the receipt stores the selected spelling and
both registry values, and success output uses the registry identity. On a
later install/apply, a non-empty selection matches only when its absolute
lexical spelling equals the receipt's selected or canonical path. Other
spellings, including aliases that resolve to the same directory, are refused
before apply and can be settled through `kb project add` and `kb project show`.
Receipt schema v3 requires this identity for projects selected by the prior
install; older receipt schemas are unavailable and must be reinstalled with the
current launcher rather than guessed or migrated. Cases: S-187.10–S-187.12,
S-224.3.

## 2026-10-13

### Bootstrap credentials end with their first disclosure

The generated first-administrator password is a one-time secret. The result
writer records disclosure and erases both stored password names in one atomic
replacement of the shared secret file. A completed install may use the
credential only until that disclosure is recorded, which includes retrying
first-install project registration after a failed result. Recovery generates a
replacement and shows it without storing it. Later install/apply/update/rollback
operations never log in as the first administrator. Only the original install
invocation may use the credential to register its selected project. A receipt
with project identity confirms that install recorded registration; without
that identity, a later command succeeds with a notice and the exact commands
for the user to register under their own login. Cases: S-100.1, S-100.2,
S-222.11–S-222.12.

Only an installer-generated first-administrator password is serialized once
to disclose a credential the user cannot otherwise know. When the operator
supplies that password through a secret reference, the result reports
`firstAdmin.state="supplied"` and the administrator email without a password
field; the value and source environment-variable name never enter installer
output or persisted artifacts. The provenance is stored atomically with the
bootstrap password and survives retries until the successful result removes
the supplied value. Cases: S-100.1, S-181.3.

### S-203.26 verifies plugin failure correlation through the installed boundary

A plain error thrown by an installed plugin command is governed by S-203.3 and
returns `KB_PLUGIN_COMMAND_FAILED`, names the plugin and command, and carries a
correlation ID. S-203.26 therefore uses a packaged journey fixture plugin to
prove the second-process structured-log round trip for that contract. Uncatalogued
platform failures remain `KB_RUNTIME_UNEXPECTED` and are tested at the platform
error boundary. Cases: S-203.3, S-203.26.
