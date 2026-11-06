---
name: clickup
description: Use the KB Labs ClickUp plugin to inspect and manage ClickUp workspaces, tasks, comments, lists, folders, and spaces.
globs:
  - "plugins/clickup/**"
---

# ClickUp

Use the installed/local KB Labs CLI. The plugin requires `CLICKUP_API_KEY` and `CLICKUP_TEAM_ID`; never print either value.

Start by discovering IDs and valid statuses:

```bash
kb clickup workspace show --json
kb clickup status list <listId> --json
kb clickup task search "<query>" --json
```

## Tasks

```bash
kb clickup task get <taskId> --json
kb clickup task list <listId> --status "in progress" --json
kb clickup task create --list <listId> --name "<name>" --desc "<description>"
kb clickup task update <taskId> --status "done"
kb clickup task comments list <taskId> --json
kb clickup task comments add <taskId> --text "<comment>"
```

## Workspace structure

```bash
kb clickup space create --name "<name>"
kb clickup folder create --space <spaceId> --name "<name>"
kb clickup list create --folder <folderId> --name "<name>"
kb clickup list create --space <spaceId> --name "<name>"  # folderless list
```

- Use `--json` for structured output; add `--full` only when the slim response lacks data.
- Confirm intent before a destructive command: `task delete` accepts `--yes`; space, folder, and list deletion use `--force`.
- The current CLI uses space-separated paths, not the legacy `clickup:task-get` form.
