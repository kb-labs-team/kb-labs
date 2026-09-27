# Contributing to KB Labs

Thank you for your interest in contributing! KB Labs is an open-source project and we welcome contributions of all kinds — bug fixes, features, docs, plugins, and adapters.

## Getting Started

```bash
git clone https://github.com/kb-labs-team/kb-labs.git
cd kb-labs
pnpm install          # ~20 seconds, one lockfile
pnpm build            # build all packages
pnpm check            # verify everything passes
```

That's it. No submodules, no special setup scripts.

## Development Workflow

### 1. Find or create an issue

Check [existing issues](https://github.com/kb-labs-team/kb-labs/issues) or create one. For non-trivial changes, discuss the approach in the issue first.

### 2. Create a branch

```bash
git checkout -b feat/your-feature    # or fix/, docs/, refactor/
```

### 3. Make your changes

```bash
# Work on a specific package
pnpm --filter @kb-labs/your-package dev

# Build + test what you changed
pnpm build:affected
pnpm check:affected
```

### 4. Commit

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(mind): add semantic reranking to search results
fix(gateway): handle timeout on upstream connection
docs(contributing): add plugin development section
refactor(core): simplify config loading
```

### 5. Submit a PR

```bash
git push -u origin feat/your-feature
```

Then open a Pull Request on GitHub. The PR template will guide you through the checklist.

## Project Structure

```
core/          Foundation (types, runtime, config, plugin system)
sdk/           Public API for plugin authors
cli/           The `kb` command
shared/        Shared utilities
plugins/       All optional functionality
adapters/      Pluggable backends (OpenAI, Redis, MongoDB, etc.)
studio/        Web UI
tools/         Go binaries (kb-devkit, kb-dev)
```

### Dependency Layers

```
Layer 0:  core/
Layer 1:  sdk/  shared/
Layer 2:  cli/  adapters/
Layer 3:  plugins/
Layer 4:  studio/
```

Dependencies flow **strictly downward**. A package in `core/` must never import from `plugins/`.

### Plugin Structure

Every plugin follows the same pattern:

```
plugins/your-plugin/
├── entry/              Manifest + CLI commands + Studio pages (thin wiring)
├── contracts/          Types only, zero runtime dependencies
├── core/               Business logic
├── daemon/             (optional) HTTP service
└── docs/adr/           Architecture decisions
```

## What to Contribute

### Good first issues

Look for issues labeled [`good first issue`](https://github.com/kb-labs-team/kb-labs/labels/good%20first%20issue).

### Adapters

Adding a new adapter is a great way to contribute. Adapters are self-contained and follow a simple interface:

```
adapters/
├── llm-openai/          # existing
├── llm-anthropic/       # you could add this!
├── storage-postgresql/  # or this!
```

Each adapter implements an interface from `core/contracts/`. No changes to core needed.

### Plugins

Build your own plugin using the SDK:

```bash
# Scaffold a new plugin
pnpm kb plugin create my-plugin

# Or manually: create plugins/my-plugin/ with entry/, contracts/, core/
```

### Documentation

Every module has its own `docs/` directory. ADRs (Architecture Decision Records) help us track why decisions were made. See `docs/templates/adr-template.md` for the format.

## Quality Standards

### Before submitting

```bash
pnpm check:affected      # build + lint + type-check + test (only changed packages)
```

### Key rules

- **All internal deps use `workspace:*`** — never `link:` or pinned versions
- **Types go in `contracts/`** — not in `core/` or `entry/`
- **No `as any`, `@ts-ignore`** — fix the root cause
- **No stub/mock files as workarounds** — fix the underlying issue
- **Build with `pnpm build`** (uses kb-devkit) — not `pnpm -r run build`

### Workspace health

```bash
pnpm health              # health score A-F
pnpm ws:check            # check all packages against conventions
pnpm ws:fix              # auto-fix safe violations
```

## Running Services Locally

If your change involves backend services:

```bash
pnpm dev:start           # start all services
pnpm dev:start backend   # or just backend group
pnpm dev:status          # check what's running
pnpm dev:logs workflow   # tail logs
```

Services: Gateway (:4000), REST API (:5050), Workflow (:7778), Marketplace (:5070), State (:7777).

## Architecture Decisions

For non-trivial architectural changes, add an ADR:

```bash
cp docs/templates/adr-template.md core/docs/adr/XXXX-your-decision.md
# or plugins/your-plugin/docs/adr/ for plugin-specific decisions
```

Cross-cutting decisions go in `docs/adr/`. Module-specific decisions go in `<module>/docs/adr/`.

## Getting Help

- **Issues**: [GitHub Issues](https://github.com/kb-labs-team/kb-labs/issues)
- **Context**: [CLAUDE.md](CLAUDE.md) has full platform context
- **Code search**: `pnpm kb mind search --text "your question"` (requires Mind plugin + Qdrant)

## License

By contributing, you agree that your contributions will be licensed under the same licenses as the project — [MIT](LICENSE-MIT) for core, [KB-Public](LICENSE-KB-PUBLIC) for ecosystem.
