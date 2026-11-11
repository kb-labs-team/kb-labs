---
id: S-278
title: CLI terminal color follows terminal capability and overrides
persona: developer
area: cli
priority: P2
status: planned
release: false
modes: [local]
surfaces: [cli]
---

## User value

A developer can read CLI output clearly in a terminal or a redirected log, and can explicitly control color when automation needs it.

## Preconditions

- `kb-devkit` is available on `PATH`.
- The workspace can run the `node-engine-policy` check.

## Steps

| # | Action | Expected |
|---|---|---|
| S-278.1 | Run `kb-devkit check --only node-engine-policy` in a terminal with `NO_COLOR` empty, `FORCE_COLOR` empty, and `TERM=xterm-256color`; repeat with stdout piped and the same environment | Terminal output uses ANSI color; piped output contains no ANSI color. |
| S-278.2 | Run `FORCE_COLOR=1 TERM=dumb kb-devkit check --only node-engine-policy` with stdout piped | Output uses ANSI color even though stdout is a pipe and `TERM` is `dumb`. |
| S-278.3 | Run the command in a terminal with `FORCE_COLOR=1` and non-empty `NO_COLOR`; then repeat with `FORCE_COLOR=0` and empty `NO_COLOR` | Both outputs contain no ANSI color; non-empty `NO_COLOR` takes precedence over forced color. |
