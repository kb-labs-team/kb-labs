# Case-Driven Evidence and Runtime Matrix — North-Star Plan

**Status:** Direction accepted; delivery plan for review
**Date:** 2026-11-23
**Scope:** Daily product dogfood, declarative installation and configuration contracts, QA evidence, runtime matrix, and CI journey execution. This document proposes a delivery plan; it does not approve a release-scope change or itself change product behavior.

## Goal

Make KB Labs usable as a daily development platform and make every release-readiness statement traceable from a user-visible case and step to the exact installed candidate, configuration inputs, runtime profile, test result, and retained diagnostics. The dogfood loop covers installation and update, multiple registered projects, workflows and cron schedules, project-scoped plugins, agents where in the approved product scope, and inspection of logs and analytics. The same product contract must be reachable through the public `kb-create` user path and CI/agent transports.

Keep product correctness and evidence completeness as separate verdicts: a failed behavior is a product failure; missing, mismatched, partial, or untrustworthy evidence is an evidence failure. Neither may be hidden by a green result from another profile. Infrastructure readiness (schema, planner, CI runners and artifacts) is also separate from product readiness (supported behaviors work end to end).

## Accepted direction

The owner accepted the following scope boundary on 2026-11-23:

- Do not add execution-model declarations to `PC-001`. Its steps verify installer, plan/apply, host, and diagnostic behavior; they do not assert that a plugin executes through a particular model. The current case schema only supports step-level `executionModels` (`in-process`, `subprocess`, `worker-pool`), so declaring one for an installer step would misstate the product contract.
- Keep `PC-001`'s existing case-level `modes` and `surfaces`, and its Node 24 environment requirement, as their current sources. Release 1's local macOS/Linux promise comes from the product decision. The current case schema does not express per-step OS or runtime applicability; do not simulate that missing schema with an invented table or derive coverage from declarations.
- Use existing `S-243.6` and `S-243.7` execution-model declarations as the narrow declaration example. They remain expectations evaluated as `NOT EVALUATED`; they are not run evidence.
- The next evidence milestone is to connect the already implemented `kb.qa-case-run/v3` evidence path to the real installer journey and coverage gate, starting with the existing `PC-001.2` artifact-producing path. A declaration alone never makes a step covered.

This direction does not approve new product behavior, new supported profiles, or a release-scope change.

## User-facing invariants

These invariants are the proposed acceptance boundary for implementation. Where a current accepted case or ADR is stricter, that source remains authoritative.

1. **The case is the product contract.** `docs/qa/scenarios/` defines observable behavior, stable step IDs, prerequisites, and applicable user surfaces. Automation metadata must not replace user actions and expected outcomes.
2. **Installation is declarative and public.** User intent compiles to a portable `InstallRequest` and a resolved plan of typed resources/actions, then passes through the public `kb-create` plan/apply/verify path. Wizard, JSON/request file, CLI flags, CI, and agent transports share validation, resolution, execution and recovery. Scenarios collect/validate user choices; they do not run arbitrary shell scripts or invent a second installation engine.
3. **Setup remains manifest-owned.** Typed actions and resources reference declared package requirements, capabilities, configuration paths and artifact intents. There is no shell escape hatch, arbitrary unvalidated file write, transitive-manifest service discovery, or hidden service topology. Resolve compatibility before side effects; verify generated config and service graph before reporting success.
4. **The candidate is immutable and identifiable.** Platform artifacts, including OS-specific artifacts, are selected from one manifest and verified by digest. Evidence records manifest/index identity and resolved artifact digests; it must not infer the installed candidate from a mutable tag or ambient package cache.
5. **Configuration layers have one writer and visible precedence.** Generated topology/config is installer/host-owned; platform user config is changed through the validated config operation; project scope remains project-specific and follows the accepted scope contract. Update preserves platform user choices and project-scoped state, while regenerating only owned outputs. Evidence identifies effective config provenance without copying secret values.
6. **Projects remain isolated.** Registering a repository does not require or create a `.kb/` directory in it. Plugin installs and runtime state are scoped to the selected project where supported. Adapter bindings/options and LLM credentials remain platform-owned; plugin settings and project data follow their accepted project-scoped ownership rules.
7. **Marketplace roles do not blur.** Marketplace is the consumer/install client; Hub is the author publishing and package lifecycle surface; Registry is an optional Marketplace/publishing service; Verdaccio is local/CI package-registry infrastructure. A local Verdaccio success is not proof of Hub publication or public Registry resolution. Marketplace URLs and source order come from explicit platform configuration, not ambient npm configuration.
8. **Secrets are references, never evidence payloads.** Requests, reports, logs and config snapshots may retain secret references and redacted provenance, but never credential values, tokens, generated passwords or secret-bearing environment values.
9. **Profiles are explicit.** A claim runs only for declared mode, OS, Node/runtime, surface and backend cells. An inapplicable cell is `NOT REQUIRED` only when the case contract says so; an unexecuted required cell is not a pass.
10. **Independent work continues after a failure.** Independent journey groups and CI shards run without fail-fast cancellation. The final verdict lists all observed failures and separately identifies missing artifacts, cancellations, timeouts and infrastructure failures.
11. **Partial evidence stays partial.** A filtered or selected run cannot satisfy a full release gate. A complete run cannot borrow a pass from a different mode, runtime, OS, surface or candidate identity.

## Verified current state

The following describes `master` at `478c20d` (PR #673) as inspected on 2026-11-23. It records merged implementation, not completion of the proposed release gate.

| Area | Existing fact | Gap relevant to this plan |
|---|---|---|
| Case catalog | [`docs/qa/README.md`](../qa/README.md) defines stable steps and metadata including priority, status, `release`, `modes` (`local`/`secured`) and `surfaces` (`cli`/`studio`/`api`/`agent`). | The metadata does not yet declare a complete OS/runtime/backend evidence matrix or a per-cell evidence policy. |
| QA claims and coverage | `plugins/qa/src/contracts/types/cases.ts` defines `kb.qa-case-run/v2` and `kb.qa-case-run/v3`. Evidence mode accepts candidate identity, run profile, redacted configuration/log references and digests; coverage compares each run with an independently supplied `kb.qa-evidence-plan/v1` and reports behavior and evidence separately. `S-315` covers passing/failing, missing, mismatched, unsafe-path and digest cases. | The v3 envelope and CLI exist, but the release installer workflow still invokes legacy coverage without `--evidence` or an independent evidence plan. The evidence plan compares declared candidate/profile values; it is not yet a complete case-by-cell planner. |
| Case inventory and declarations | `S-314`, `plugins/qa/src/core/cases/inventory.ts`, and PR #669 inventory claims, case metadata, and step-level `executionModels`. PR #671 documents that declarations are expectations with `NOT EVALUATED`; no run result or OS coverage is inferred. | OS, runtime, request/config provenance, and candidate identity remain undeclared case dimensions. Execution-model declarations are intentionally limited to steps that exercise plugin execution. |
| Journey selection | `e2e/journey/select_from_cases.py` resolves selected cases/steps to registered runners and prerequisites. Partial scoreboards are identified and are not full-run evidence. | Selection is not yet a general contract connecting every approved profile cell to exactly one runner and an evidence-plan entry. |
| CI shard behavior | `journey-batch.yml`, `reusable-installer-journey.yml`, and `e2e-platform.yml` use non-fail-fast matrices. The installer candidate is built from a source SHA, runs case journeys on Linux, and has a separate native macOS installer smoke job. [PR #672](https://github.com/kb-labs-team/kb-labs/pull/672) isolates installer-run cache identity by source SHA. [PR #673](https://github.com/kb-labs-team/kb-labs/pull/673) adds phase/package timing and raises candidate preparation timeout to 45 minutes. | The coverage job restores service result artifacts and calls `qa coverage show` without `--evidence`; its current local/secured loop does not yet enforce the accepted Release 1 local gate separately from supplemental secured evidence. It is not a unified profile/evidence planner. Native macOS currently runs a smoke, not the complete installer case matrix. |
| Manual run evidence | [`docs/qa/TESTING-STRATEGY.md`](../qa/TESTING-STRATEGY.md) and [`docs/qa/runs/TEMPLATE.md`](../qa/runs/TEMPLATE.md) document release/index identity, case/step, mode, command/result, logs, diagnostics, OS and Node. | Manual records remain useful observations; they do not replace a checked v3 evidence run or fill missing matrix cells automatically. |
| Installer and configuration | `PC-001` contains detailed install, provenance, `receipt`, `logPath`, and diagnostics expectations. ADR-0012/0013 define platform/project scope; ADR-0047 defines generated, platform-user, project-user and overlay layers, provenance, and one writer per file. `docs/product/decisions.md` holds current product boundaries. | QA evidence should link to exact request, plan, effective config provenance, and sealed artifact identity while keeping secrets redacted. Apply/update must prove it preserves platform user choices and project-scoped state, while regenerating only generated outputs. |
| Declarative setup | `tools/kb-create/v2/README.md` and `docs/adr/0028`, `0032`, `0035` describe shared request/resolver/apply paths, typed plan/action execution, manifest requirements, config patches and artifact intents. Scenario V2 collects product axes/validated fields and compiles into `InstallRequest`; it deliberately has no shell actions or arbitrary writes. | End-to-end product assurance must exercise the public `kb-create` path, not only internal resolver/owner APIs or a fixture-only helper. Typed setup must preserve the narrow manifest-owned boundary. |
| Daily use | Product decisions and cases cover project registration/isolation (`S-043`, `S-124`, `S-187`), cron/run-history/logs (`S-044`, `S-056`), analytics (`S-121`, `S-191`), and agent/MCP flows (`S-045`, `S-141`). Multiple-project workflow isolation and project analytics also have planned cases. | A single reusable dogfood journey should prove the cross-feature path and state continuity. Several agent cases remain non-release or planned; do not imply they are already in the release promise. |
| Config layers | ADR-0047 defines generated, platform-user, project-user and overlay layers, provenance, and one writer per file. Platform user configuration is distinct from generated runtime output; project scope has separate semantics, including platform-state-backed plugin settings in the current product decision. | Acceptance must explicitly check preservation of platform user config during update, generated output regeneration, and project scope/isolation. Do not collapse these into “installer-owned platform defaults vs project config.” |
| Marketplace lifecycle risk | [PR #631](https://github.com/kb-labs-team/kb-labs/pull/631) describes an incomplete managed-generation foundation: owner/helper tests exist, but production install routes and all platform writers are not yet unified under the transaction owner. The PR says its tests do not establish a real product-host journey or production atomicity. | Treat it as a concrete unresolved integration/safety risk, not as a shipped safety guarantee. See risks below and require the stated route inventory, lock/recovery review, public journey and security review before enabling that path. |
| Runtime policy | `S-260`, `PC-001`, and root `package.json` identify Node 24 as the supported runtime major; Release 1's product decision supports local macOS and Linux. | The current inventory intentionally reports OS/runtime applicability as undeclared. Recording actual runtime and policy in evidence remains separate from declaring per-step applicability; adding majors or OSes requires a product decision. |

## Dogfood journey: desired product proof

The dogfood journey is a user-visible product scenario, not an infrastructure smoke test. It should start from the public `kb-create` install path and exercise the daily loop on a clean, isolated platform with two independent repositories:

1. Install from a sealed candidate through `kb-create install`; inspect the resolved plan, generated service graph, active configuration provenance, receipt, and health.
2. Set a platform user configuration value through the public config operation. Register two projects without requiring or creating repository `.kb/` files. Confirm both inherit platform-only adapter bindings and that a project-scoped plugin/settings change remains isolated to its chosen project.
3. Update the platform through `kb-create update`. Verify platform user config, project registration, project-scoped plugin state, durable data, and the supported host lifecycle are preserved; verify generated topology follows the new plan. Exercise a refused update and recovery as separately observable outcomes.
4. In one project, install/use a plugin, run a workflow, create and inspect a cron, restart the host, and inspect the same run history and logs. Confirm the other project's plugin/workflow/cron state is unchanged.
5. Inspect analytics in CLI/Studio from persisted events and usage records, with persistence state disclosed accurately. Do not treat operational adapter telemetry as product analytics.
6. If agents are in the approved product promise, run the agent task/session flow in a selected project, inspect its outputs and logs, and prove project isolation and recovery. If not approved, report that cell as out of scope; do not silently imply current agent cases are release requirements.

This journey should be decomposed into stable cases/steps and executable claims rather than maintained as a monolithic test script. Existing cases provide partial coverage: `S-043` / `S-124` / `S-187` for projects, `S-044` / `S-056` for schedules/history, `S-121` / `S-191` for analytics, and `S-045` / `S-141` for MCP/agent flows. The journey requires reviewing planned/non-release cases and adding only the missing user expectations first.

## Proposed evidence contract

Add a versioned evidence envelope around existing claims and coverage rather than overloading a pass/fail claim with environmental details. The precise schema and compatibility policy are implementation decisions for Milestone 1.

Each execution record should be able to identify:

- case ID and stable step ID, claim ID/kind, runner and source revision;
- status (`PASS`, `FAIL`, `NOT RUN`, `NOT COVERED`, `NOT REQUIRED`, plus explicit infrastructure/cancel/timeout cause where needed);
- declared profile dimensions: mode, OS/architecture, Node/runtime policy and actual version, surface, and backend where applicable;
- immutable candidate identity: release index/manifest digest and resolved artifact identity/digests;
- configuration evidence: request/plan identity, effective config source/provenance, and redacted config digest or artifact reference;
- log and diagnostic artifact references, retention/availability state, and safe failure summary;
- selection metadata: full versus partial, selected claims, prerequisites, and the reason for omitted cells.

Do not put raw environment dumps or secret-bearing config into the envelope. Prefer bounded structured artifacts and digests over copying large logs into the coverage JSON. Existing consumers of `kb.qa-case-run/v2` and `kb.qa-case-coverage/v1` need an explicit versioning/migration plan; no silent schema reinterpretation.

## Proposed matrix and shard model

The matrix is sparse and case-driven, not the cartesian product of every environment dimension. The case declares required cells or points to a profile; a planner expands only registered claims and their declared prerequisites.

| Dimension | Candidate source of truth | Planning rule |
|---|---|---|
| Mode | Case `modes` plus approved release gate policy | Keep `local` and `secured` separate. `local` is required for Release 1; `secured` is useful for additional coverage but is not a required Release 1 cell or a blocking gate. |
| OS/architecture | Case profile plus artifact manifest support | Release 1 supports macOS and Linux. Distinguish native host execution from Linux-container execution and run supported OS cells where relevant to the case and artifact. Windows is outside this supported-OS scope. |
| Execution model | Case profile plus registered runner capabilities | Release 1 supports in-process, subprocess, and worker-pool execution. Include a model in a cell when the behavior under test uses it; do not expand cases to irrelevant execution models. |
| Node/runtime | Root Node policy and case requirements | Record actual version and supported-major policy. Do not fan out across unsupported majors. |
| Surface | Case `surfaces` and registered claim ownership | Run the claims that own the declared CLI/Studio/API/agent behavior; do not infer a surface from the CI job name. |
| Backend/deployment | Case prerequisites (for example execution backend or container topology) | Include only where the user-visible behavior depends on it; identify the selected backend in evidence. |

Shard on ownership boundaries that can fail independently (case/claim runner, profile, or domain suite). Each shard owns isolated roots, ports, mutable resources, artifact namespace and cleanup. A shared producer may build a candidate once, but every consumer must verify that it received the producer's immutable candidate. Independent shards use non-fail-fast execution; an aggregator evaluates all shard conclusions and artifacts.

Affected selection may reduce PR feedback only when the selector can prove that all affected claims and dependents are selected. Global catalog/schema/planner/CI changes and unowned paths should select the safe broader set. Affected evidence is diagnostic feedback, not a substitute for a complete release matrix.

## Milestones

Delivery has two tracks with a hard join at the release gate. The milestones below separate merged foundations from work still required to make the release workflow consume and enforce evidence. Infrastructure estimates are intentionally limited to the next bounded pilot; broader matrix and product work require decomposition.

### Product contract and dogfood track — estimate after case-gap review

| Milestone | Scope and outputs | Exit criteria |
|---|---|---|
| P0. Approve the product contour | Review the daily dogfood journey, release cases, supported OS/runtime artifacts, project scopes, plugin/adapter/service boundaries, agent inclusion, and release modes. Record approved scope in decisions and cases. | The product promise identifies required cells. Release 1 requires local mode; secured mode may add useful coverage but is not a blocking gate. Supported operating systems are macOS and Linux. |
| P1. Public declarative setup | Ensure wizard, direct flags/JSON, CI, and agent transport compile to the same request/plan and invoke the public `kb-create` path. Add/complete typed resource/action contracts for platform bundle/services, plugins, adapters, config patches, and artifact intents. Keep scenarios as validated user-choice flows; no arbitrary shell actions. | Public plan/apply/verify behavior matches the accepted case; bad capability, config, artifact, or topology inputs fail before unsafe side effects; generated config and service graph are verified before success. |
| P2. Config and scope lifecycle | Prove generated vs platform-user vs project-user/overlay ownership and precedence, including platform user config preservation on apply/update, project registration without repo writes, platform-only adapter configuration, and project-scoped plugin state. | Tests and cases establish the exact config provenance and update semantics; no writer overwrites another layer; project A operations cannot mutate project B state. |
| P3. Daily-use vertical journey | Complete the install → two projects → scoped plugin/config → workflow/cron → restart/history/logs → analytics loop; add an agent task/session segment only if approved in P0. Include healthy and failure/recovery paths. | Journey runs through supported public entry points against the real installed host and sealed candidate; every transition is visible, durable as promised, and isolated by project. Product defects discovered here get their own estimates and case-first changes. |
| P4. Marketplace transaction safety | Inventory all platform-mutating writers, define one transaction/lock owner and recovery semantics, route supported production paths through it, and independently review process identity, durability, lock ordering, old-generation host behavior, package scripts, and security. | Public install/update/list/doctor flows prove atomicity and recovery on a real host. Do not enable an incomplete helper-only foundation as if it made all writers atomic. |

**Product readiness has no credible single-day estimate yet.** It depends on the P0 case-gap audit, implementing the typed setup and config lifecycle, and closing the transaction safety risks. Do not add product work to the infrastructure estimates below or claim that infrastructure completion means the product is ready.

### Evidence and CI infrastructure track

| Milestone | Status | Scope and outputs | Exit criteria |
|---|---|---|---|
| I0. Source-backed obligation inventory | **Merged in part** (#669, #671). Inventory reports step claims, declared modes/surfaces, execution-model declarations and their `NOT EVALUATED` status. | Use the inventory to find undeclared dimensions; do not treat declaration completeness as test coverage. OS/runtime/config/candidate evidence remain gaps. |
| I1. Evidence envelope and producer | **Implemented in part** (`S-315`, `kb.qa-case-run/v3`, evidence-plan CLI, and the `PC-001.2` journey evidence producer). | The CLI rejects missing, unsafe, mismatched or digest-invalid evidence while keeping behavior and evidence verdicts separate. This is implementation-level readiness, not proof that hosted candidate runs consume the envelope. |
| I1a. Hosted evidence pilot | **Next, bounded pilot.** Upload the existing `PC-001.2` v3 run record and redacted config/log artifacts from one sealed Linux candidate run; construct the expected plan independently from the producer result; evaluate via `qa coverage show --evidence`. Keep this as an explicit pilot result alongside the existing gate. | A hosted passing and failing result retain artifacts; candidate/profile mismatch, missing artifact, and bad digest remain `INCOMPLETE`; no declaration is promoted to a run result. The pilot proves only its named Linux/Node 24/CLI/local cell and does not satisfy macOS or the complete release gate. Estimate: 2–4 person-days, subject to the existing artifact shape and runner access. |
| I2. Evidence policy and matrix contract | Define how accepted case scope maps to required cells, how `NOT REQUIRED` is justified, and how observed runner profile is checked against that expectation. Decide/version any schema extension before adding OS/runtime fields to cases. | Every approved cell has one registered owner; missing/empty selection is incomplete; no cell is inferred from a job name, source claim, or declaration alone. PC-001 remains free of plugin execution-model rows. |
| I3. Release-gate aggregation | Feed the independent expected plan and v3 records from every required shard into aggregate coverage; separate Release 1 local blocking results from supplemental secured results, while retaining both. | Candidate, profile, case/step and artifact identity agree across producer and consumer; all failures, cancellations, timeouts and missing artifacts appear in the aggregate. A partial selection cannot pass the full gate. |
| I4. Native profile expansion | Extend the native macOS smoke to the approved case cells and bind Linux/macOS evidence to the same immutable candidate where relevant. Preserve the measured phase and runner-duration signals from PR #673. | Required supported OS cells execute natively; an inapplicable cell is explicit; all run records and diagnostics are retained on failure. |

Only I1a has a planning estimate because it has a bounded case, artifact path and existing CLI. Estimate I2–I4 after I1a exposes the actual CI artifact and runner constraints. These estimates exclude product remediation and the separate product-contour work above.

## Acceptance criteria

### Product and installer

- Human wizard, request-file, and CI paths use the same portable request contract and shared resolver/apply semantics.
- The user-facing installation route is the public `kb-create` command and its supported JSON/request interface; tests of private resolver/owner helpers are useful layers but cannot substitute for a public installed-host journey.
- For the same request, manifest and supported profile, all entry points produce equivalent resolved plans, including generated service/config topology.
- Setup is expressed with typed, manifest-backed resources/actions and artifact intents. Scenario definitions collect validated user intent; they do not become arbitrary command scripts or a second installer engine.
- OS-specific artifact choice is explicit, manifest-owned, and digest-verified before activation; no selection depends on ambient `node_modules` or a mutable registry tag.
- `kb-create apply` and `update` preserve platform user config and project scopes according to ADR-0012/ADR-0047, regenerate only generated outputs, retain project state, and return verifiable plan/receipt/log/diagnostic links. Evidence identifies sources/provenance and never serializes secret values.
- Project registration and daily operations prove isolation across at least two projects: plugins/settings, workflow/cron state, logs and analytics filters follow their documented owners. Adapter bindings/options remain platform-only.
- Marketplace consumption, Hub publishing, optional Registry service, and Verdaccio CI/local registry are separately exercised and reported. Registry not-found and source-order failures remain diagnosable; a Verdaccio fixture does not count as public Hub/Registry proof.
- Daily dogfood journey exercises install/update, two projects, scoped plugin/config work, workflow and cron, restart and history/logs, analytics, and agent behavior only if that behavior is in approved release scope.
- Existing `PC-001` guarantees remain covered: clean roots, sealed artifact identity, receipt/log path, safe failure diagnostics, and ownership-safe recovery. Configuration-specific and daily-use regression claims are added/updated before user-visible behavior changes.

### QA coverage and evidence

- Every release case step has an explicit claim owner or is reported `NOT COVERED`; unknown IDs are errors.
- A run can be mapped to exact case/step, source revision, candidate digest, declared and actual profile, request/plan/config provenance, and retained logs/diagnostics.
- `PASS` requires a successful run for that exact required cell. Missing artifacts, mode/runtime/OS mismatch, failed steps, timeout, cancellation, and runner loss cannot be coerced into PASS.
- `NOT REQUIRED` is produced only from declared applicability. A missing required cell remains incomplete and fails release readiness.
- Full release evaluation rejects partial/filtered evidence and refuses to combine evidence across incompatible candidate identities or profile cells.
- Evidence contains no secret values; automated redaction checks cover logs, request/config artifacts, and summaries.

### CI execution

- Each selected claim is assigned to one registered executable runner per required cell; prerequisites run first and are visible in results.
- Independent shards use `fail-fast: false`, upload results and diagnostics under an always-run condition, and are all represented in the aggregate even if one fails.
- Aggregation checks both the structured shard artifact and the enclosing CI job conclusion. Missing artifact, job failure, cancellation, timeout, and infrastructure error each have a named outcome.
- The affected selector handles rename paths, global planner/schema/CI changes, and unowned paths safely; a selection cannot silently become empty or be treated as a full run.
- Release-candidate gating runs against sealed, production-shaped artifacts. Local warm-cache journeys remain useful developer feedback but cannot stand in for sealed release evidence.

## Risks and decisions to resolve

| Risk / open decision | Why it matters | Proposed handling |
|---|---|---|
| Secured mode is optional for Release 1. | Running secured cells adds coverage and CI cost, but is not necessary to establish the Release 1 gate. | Keep local cells required. Add secured runs where useful as supplementary, non-blocking coverage; never let their absence block Release 1. |
| Native OS coverage costs materially more than Linux-container coverage. | Container execution on macOS does not prove native macOS behavior, and Linux cannot validate OS-specific package selection. | Release 1 supports both macOS and Linux; add native jobs for relevant supported cells and report inapplicable cells explicitly as not required. |
| Execution models have different runner and lifecycle behavior. | A behavior may depend on whether work runs in-process, in a subprocess, or in a worker pool. | Treat all three models as supported in Release 1 and include each only in case cells where it is relevant. |
| Existing case schemas, run JSON, and historic artifacts may not have provenance fields. | Silent migration could make old runs appear stronger than they are. | Version schemas; label legacy evidence as incomplete for new dimensions; do not retroactively infer missing profile facts. |
| Config snapshots can contain credentials or user-specific paths. | Evidence retention must not leak secrets or private data. | Prefer structured provenance and redacted digests; validate redaction at artifact boundaries. |
| Larger matrices can make feedback slow and flaky. | More jobs alone do not improve evidence quality. | Keep the matrix sparse, shard by isolated ownership, measure duration/resource use, and fix flakes at their resource owner. |
| Managed Marketplace mutation is not yet a platform-wide transaction guarantee. | PR #631 reports an incomplete foundation: legacy Marketplace/sync/update/other writers are not all routed through one owner; full lock/crash recovery and old-generation host behavior need independent review; fixture helper tests are not a live public product journey. Marketplace helper code runs with user account privileges and is not a sandbox for malicious packages/manifests. | Keep production routes disabled until writer inventory/routing, crash recovery and process identity review, helper/catalog postconditions, security/architecture review, and the actual public install journey pass. Treat lifecycle-script execution as a separate supply-chain/security decision. |
| Test registry roles can be conflated. | Hub publication, Marketplace resolution, optional Registry deployment, and Verdaccio's temporary package registry have different contracts and authentication/source behavior. | Name the system under test in every case and result. Test Hub author operations, Marketplace consumer operations, and Verdaccio packaging independently; do not infer one from another. |

## Sources and implementation touchpoints

- Product truth and workflow: [`docs/qa/README.md`](../qa/README.md), [`docs/qa/TESTING-STRATEGY.md`](../qa/TESTING-STRATEGY.md), [`docs/qa/user-journey-e2e.md`](../qa/user-journey-e2e.md).
- Installer scenarios: [`PC-001`](../qa/scenarios/PC-001-clean-install.md), [`S-260`](../qa/scenarios/S-260-runtime-node-engine.md); daily-use evidence includes [`S-043`](../qa/scenarios/S-043-project-registry-and-isolation.md), [`S-044`](../qa/scenarios/S-044-workflow-run-history-logs-cron.md), [`S-056`](../qa/scenarios/S-056-workflow-history-survives-restart.md), [`S-121`](../qa/scenarios/S-121-studio-analytics.md), [`S-141`](../qa/scenarios/S-141-agent-session-lifecycle.md), plus planned multiple-project cases. Update/add case claims before implementing user-visible contract changes.
- Product decisions and configuration ownership: [`docs/product/decisions.md`](../product/decisions.md), [`ADR-0012`](../adr/0012-platform-project-scope.md), [`ADR-0013`](../adr/0013-installer-config-placement.md), [`ADR-0047`](../adr/0047-config-layers-generated-vs-user.md).
- Declarative install: [`kb-create V2 README`](../../tools/kb-create/v2/README.md), [`ADR-0028`](../adr/0028-human-and-agent-frontends-share-the-engine.md), [`ADR-0032`](../adr/0032-config-assembly-and-artifact-intents.md), [`ADR-0035`](../adr/0035-breaking-cutover-for-the-new-installer-contract.md).
- QA contracts, inventory, and evidence pilot: [`S-314`](../qa/scenarios/S-314-case-evidence-inventory.md), [`S-315`](../qa/scenarios/S-315-case-step-evidence-envelope.md), `plugins/qa/src/contracts/types/cases.ts`, `plugins/qa/src/core/cases/inventory.ts`, and `plugins/qa/src/core/cases/coverage.ts`. The inventory and execution-model declaration foundations merged in [PR #669](https://github.com/kb-labs-team/kb-labs/pull/669) and [PR #671](https://github.com/kb-labs-team/kb-labs/pull/671).
- Journey planner/runners: `e2e/journey/select_from_cases.py`, `e2e/journey/dispatch_registry.py`, `e2e/journey/batch.sh`.
- Hosted execution: `.github/workflows/journey-batch.yml`, `.github/workflows/reusable-installer-journey.yml`, `.github/workflows/e2e-platform.yml`, `.github/workflows/e2e-affected.yml`; candidate artifact preparation is timed in [PR #673](https://github.com/kb-labs-team/kb-labs/pull/673).
- Installer implementation and tests: `tools/kb-create/`; preserve current manifest, receipt, config ownership, update, diagnostics and secret-handling contracts. Review [PR #631](https://github.com/kb-labs-team/kb-labs/pull/631) as risk evidence, not as a production-ready route or completed atomicity proof.

No source-to-doc sitemap or generated example is changed by this plan. If implementation later changes docs-site content or its source mappings, follow `docs-source-sync` for those files.
