# Definition of done (shared by worker and reviewer)

The reviewer judges your round against THIS list and nothing else. Read it before you design anything, and self-check against it before you finish. Each item below was found by review at least once and cost a full extra round.

## 1. Design gate — write it BEFORE code

Start your report section with a design table. Fill it in before editing source:

| root cause | single owner (package/module/file) | rail type | why it is not a shape rail or a copy |

The allowed rail types are:
- **structured data or contract** — the wrong thing cannot be expressed;
- **type brand / public type** — the wrong thing does not compile;
- **single generator** — one producer; consumers read its output, and a golden/drift test guards it;
- **behavioural absence check** — the test runs the real thing in the real file set and observes that the bad outcome is absent.

If none fits, stop and write a PLAN-QUESTION. Do not improvise.

## 2. Rejected constructions (each one = REWORK)

1. **Shape rails.** Any regex, substring or identifier heuristic over source text, prose or file names used as a guard or classifier. This includes scanning `main.go` or imports to decide what something is.
2. **Two declarations that must agree.** For example `credential` + `secret`, or a hand list mirroring a registry or `root.go`. Keep one declaration, and derive everything else from it.
3. **Hand copies of another component's output.** Fixtures, golden data, command lists, schemas or lock files written by hand in a different language or package than their producer. The producer generates them, and a drift test proves equality. This includes error message and hint text quoted in journey assertions or case rows: the error catalogue owns that text. Assertions render it from the catalogue, and cases cite the code.
4. **A second owner.** Duplicate implementations (two redactors, two validators), or each class computing its own path or cache location. Exactly one owner exists, and everyone else calls it.
5. **Aliases and compat.** Extra export subpaths pointing at the same files, a removed field still being read, fallbacks, re-exports from old locations.
6. **Test-only bypasses.** Hooks in production code for tests, or tests seeding state through a production writer that is supposed to refuse it. Seed through the owner's fixture instead.
7. **A public contract wider than the guarantee.** For example, a public type that accepts results the boundary never produced.
8. **Silent catches, ignored inputs, exception or allow lists, per-name special cases.**
9. **A fix that does not change the recorded difference.** Before writing code, quote the exact field that differed in the evidence (expected vs actual). The change must alter exactly that, or explain why the expectation was wrong.

## 3. Reality checks — prove it where it runs

- **Container / installed root.** Anything the journey runner or the installed platform reads at runtime must exist in THAT file set: the runner image COPY set or the installed root. Host-only success is not evidence. Run the reduced-tree or import rails.
- **Import order / process start.** New module edges must pass the fresh-interpreter first-import rail.
- **Dependents.** After changing a public type or signature, type-check the full dependent closure (`corepack pnpm -r --filter '...[<base>]' type-check`).
- **Dependency edges.** If the design needs a new package dependency, a lockfile change or `pnpm install`, stop BEFORE coding and report a PLAN-QUESTION. You cannot install it.
- **Shared resources.** Never write to the real HOME, `~/.local/bin`, lockfiles or Git metadata.

## 4. Evidence

- **Case first, then red tests, then code.** Show red-before-green for each new test.
- **Mutation per rail.** Remove or break the rail and show the test goes red. Restore it and show green.
- **Claims.** Claim a case row only if its evidence actually runs. A row you do not prove stays unclaimed, and a row explicitly out of scope (for example S-203.6) is never claimed.
- **Release-case edits need a journey claim (added 2026-10-21 after x105/x108).** If you add or change an expectation in a case whose frontmatter is `release: true`, the same diff must include the installed journey step that claims that exact row. Unit/integration tests do not satisfy it. If the row cannot be proven at journey level in this task, put the expectation in a `release: false` case instead and say so in the report.
- **Unknowns.** If a cause is unknown, write OPEN and name the exact evidence the next run must capture. Never guess.
- **One status.** The report has exactly one status line and one open-issues list. Earlier rounds' statuses must not contradict the final one.
- **Error UX.** An error's next step is exactly the command that helps, derived from the invocation or registry owner and never formatted by hand. A command that exits non-zero with no output is a finding.

## 5. Self-review before you finish

End your round with a `Self-review` table that has one row per item in sections 2–4. Each row is marked `ok` (with file:line evidence), `n/a` (with the reason) or `debt` (named explicitly). The round is not done while any row is unaddressed.

## Build outputs (orchestrator rule, 2026-10-16)

Never delete `dist/` (or other build outputs) in a worktree, including ones you built yourself for prerequisites. The orchestrator's outside-sandbox Docker and process runs consume them; deleting them forces a full rebuild in dependency order.

Temporary binaries you place under `/tmp` are yours to remove.

## Dependent closure build (added 2026-10-19 after j82)
A change to any package's exports must build AND type-check its full dependent closure (devkit affected build), with the command and result in the report. "Unrelated" failures in that closure are not accepted without proof they fail identically on the base.

## Environment and stopping (added 2026-10-21 after x110/x113)
- Put Node 24 first on PATH for every command (`PATH="$HOME/.nvm/versions/node/v24.18.1/bin:$PATH"`). The login shell resolves Node 20, which fails with KB_NODE_VERSION_UNSUPPORTED; results from it are not evidence.
- You may build an isolated installed root yourself: `bash e2e/journey/prepare-candidate.sh` under a fresh temp HOME (KB_PLATFORM_ROOT, KB_HOME, KB_NET_OFFSET, GOFLAGS, KB_JOURNEY_PACKAGES_READY unset). "No isolated installed root" is not a reason to stop.
- PARTIAL with no reproduction attempt and no code is REWORK. Stop early only with a PLAN-QUESTION (a design fork or a needed dependency edge), stated as a question.
- Run test suites to completion; an interrupted suite is not a result.
- Installer port selection is `--gateway-url http://127.0.0.1:<port>` on `kb-create install|plan|apply` (all service ports derive from it); `KB_NET_OFFSET` in the caller environment does NOT select installer ports. Pick a port from 4500-9900 in steps of 100, run `plan --json` first and verify every planned port, then install.
- Never let an installed platform you start bind the default ports (Gateway :4000 family). Before `kb-create install`/`start`, select an isolated network offset through the product's own flag/config and verify the planned ports. If the product ignores it, stop that command immediately and report it as a product defect (2026-10-21: an isolated install bound 127.0.0.1:4000 and `kb-create stop` failed with KB_HOST_STOP_FAILED).
- Plugin/platform boundary (owner rule, 2026-10-21): the platform never ships or depends on plugin packages (anything under `plugins/**`); plugins attach only through manifests and are loaded dynamically; plugins reach the platform only through the public `@kb-labs/sdk`. Never close a release-graph or dependency hole by adding plugin-family packages to platform membership or by giving a plugin a new edge to a platform internal. A plugin's own family packages ship with the plugin, not with the platform. If a fix seems to need crossing the boundary, stop and report it as a PLAN-QUESTION.

## Deployment topologies (owner, 2026-10-22)
Platform code must stay correct in all three modes: local (one host process + project runtimes), cloud team (container per service, ADR-0037), and k8s company (Helm, Deployment per service; not formally supported before release, never precluded). A service address comes only from the gateway/receipt/config resolution owner and IServiceTransport. Nothing may assume in-process composition, KB_NET_OFFSET-derived ports, or host-injected env/argv outside local-only launch code. Reviewers check every change to service discovery, command registration, composition, or the enabled-service set against all three.

## Release 1 scope freeze (owner, 2026-10-22)
Release 1 is local-only (see docs/product/decisions.md, Release 1). New cases are `release: false` by default until Release 1 ships; only the orchestrator, with owner approval, flips a case into Release 1. The container execution mode, the secured/team mode, and cloud/k8s are release 2.
