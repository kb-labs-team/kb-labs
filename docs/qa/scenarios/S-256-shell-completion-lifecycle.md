---
id: S-256
title: CLI — install and remove shell completion
persona: solo-developer
area: cli
priority: P2
status: planned
release: false
modes: [local, secured]
surfaces: [cli]
---

## Goal

Install shell completion with a visible profile-file location, confirm repeat installs are idempotent, and remove the installed completion without changing unrelated user files.

## Prerequisites

- [ ] A clean user profile for the selected shell, with a working `kb` command.
- [ ] Use a disposable user account or isolated home directory for the file-state checks.

## Steps

| # | Action | Expected |
|---|---|---|
| S-256.1 | Run `kb completion install bash`, `kb completion install zsh`, and `kb completion install fish`, one shell per clean profile | The terminal identifies the exact profile file it modifies. Bash writes only the selected `.bashrc`; fish writes only `~/.config/fish/config.fish`; zsh writes the selected `.zshrc` and the generated `~/.config/kb/completion.zsh`. No other files are changed. |
| S-256.2 | Run the same `kb completion install <shell>` command a second time and compare the profile before and after | The command reports that the profile is already configured; the completion and alias markers each occur once and no duplicate lines are added. |
| S-256.3 | Use the completion removal path for the selected shell, then inspect the profile and generated files | The completion and alias additions are removed without deleting unrelated profile content; the generated zsh completion file is removed when the selected shell is zsh. **This is a failing claim today:** `kb completion` has no uninstall or removal path. |
| S-256.4 | Invoke the CLI completion candidate command as `kb __complete marketplace plugin` | The candidate `marketplace plugins` is written as a newline-delimited result byte to stdout; stderr contains no candidates or diagnostics. |

## Decision note

**D53:** Installing completion is the user's initiative to write the shell profile. The command shows which profile file it changes, repeat installation is idempotent, and an uninstall or removal path exists. No files outside the user's chosen locations are changed without that initiative.

## Source

The completion command, profile selection, idempotence markers, and zsh static-file path are in `cli/commands/src/commands/system/completion.ts`. That command currently supports printing or installing completion but does not register a removal operation.
