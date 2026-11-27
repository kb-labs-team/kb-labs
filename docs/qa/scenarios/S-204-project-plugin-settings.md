---
id: S-204
title: Projects — Configure plugin settings independently
persona: solo-developer
area: config
priority: P1
status: planned
release: false
modes: [local, secured]
surfaces: [cli, studio]
---

## Goal

Configure a plugin once for the platform, override its settings for one
registered project, and edit project settings from either CLI or Studio without
adding KB Labs files to a repository.

## Prerequisites

- [ ] One platform with Commit attached to both projects, a second plugin
  available to attach, and two registered Git repositories, Project A and
  Project B.
- [ ] Project A and Project B have distinct IDs and clean working trees.

## Steps

| # | Action | Expected |
|---|---|---|
| S-204.1 | Set the platform Commit settings with `kb config set --scope platform plugins.commit.scope.scopes '[{"id":"shared","label":"Shared","path":"."}]' --json`, then inspect `kb config get plugins.commit.scope.scopes --json` from both project roots | Each JSON result contains the `shared` value and reports its source as `platform`. Neither repository is changed. |
| S-204.2 | From Project A, run `kb config set plugins.commit.scope.scopes '[{"id":"a","label":"Project A","path":"."}]' --json`, then run `kb config get plugins.commit.scope.scopes --json` from both project roots | Project A's JSON result contains `a` with source `project`; Project B contains the inherited `shared` value with source `platform`. The change affects only Project A. Both repository working trees remain clean. |
| S-204.3 | Attach the second plugin to Project A only, then inspect the project plugin lists for A and B | The second plugin is available in Project A and absent from Project B; its attachment does not change B. |
| S-204.4 | In Studio select Project A, edit a Commit setting, then select Project B and inspect the same setting | Studio saves the value for the selected project. Project B shows its own effective value and does not inherit Project A's override. |
| S-204.5 | Set an invalid Commit setting through `kb config set` and submit the same invalid value in Studio | Both surfaces reject the write with `KB_PLUGIN_SETTINGS_INVALID`, identify the invalid setting, and give a hint to provide a value matching the Commit plugin's declared settings schema. The previous value and both repositories remain unchanged. |
| S-204.6 | Remove Project A with `kb project remove <project-a-id> --yes --json`, then register the same path again | The active registration is removed and its project configuration is archived. Registering the same canonical path restores that archived configuration for the deterministic project ID; the repository remains untouched. |
| S-204.7 | With platform access mode configured as `local`, from a directory outside every registered project run `kb project show --json` | The command fails with the typed `KB_PROJECT_UNKNOWN` error and the hint `kb project add`; it does not infer project identity from repository files or create files in the directory. |
| S-204.8 | From a directory outside every registered project, run `kb config get plugins.commit.scope.scopes --scope platform --json` and `kb config set plugins.commit.scope.scopes '[]' --scope platform --json` | Both commands operate on platform settings without requiring or inventing a project. The read reports only the platform file; the write validates and updates only the platform layer. |
| S-204.9 | From a directory outside every registered project, run `kb config get plugins.commit.scope.scopes --json` and `kb config set plugins.commit.scope.scopes '[]' --json` | Both commands return the ADR-0049 error envelope with code `KB_PROJECT_UNKNOWN` and hint `kb project add`; no project config is created or changed. |
| S-204.10 | Put conflicting values in `<project>/.kb/kb.config.json` and `<project>/.kb/overlays/conflict.jsonc`, then run `kb config get plugins.commit.scope.scopes --json` from that registered project | Both repository values are ignored. The result comes from the platform/project store using the declared layer precedence, and both repository files are left unchanged. |
| S-204.11 | With no platform or project override for a Commit setting, run `kb config get plugins.commit.llm.maxTokens --json`, then set a platform value and a project value in turn | The first result uses the manifest default and reports `manifest`; the next results report `platform` and then `project`. Each higher layer replaces only the conflicting setting while retaining other object defaults. |
| S-204.12 | From a registered project, run `kb config set commit.llm.enabled true --json` | The command exits non-zero with `KB_CONFIG_INVALID`; the message identifies `commit.llm.enabled` as a path that is invalid at project scope and explains that project plugin settings use `plugins.<configSection>.<key>`. Its hint gives the runnable correction `kb config set plugins.commit.llm.enabled true`. No config file is changed. |
| S-204.13 | Install a plugin package that declares a settings schema from its own Zod 3 dependency. From a registered project, set a valid value, then submit an invalid value and a value that stalls its validator through `kb config set`. Read the setting after each write. | The valid write succeeds. A rejected or stalled validator returns `KB_PLUGIN_SETTINGS_INVALID` and leaves the prior value intact. The plugin schema module loads and validates in a separate process with a bounded lifetime. |

## Dependencies

- [S-043](S-043-project-registry-and-isolation.md) covers project plugin
  attachment and extension isolation.
- [S-124](S-124-project-management-studio-and-cli.md) covers registration and
  removal without changing repository or runtime-state files.
- [S-196](S-196-multiple-projects-current-context.md) covers current-project
  resolution by CLI cwd and the Studio project selector.
