# @kb-labs/clickup

> Manage ClickUp tasks, lists, spaces, and folders from CLI and REST API.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-clickup%20%7C%20tasks%20%7C%20productivity-lightgrey)

---

## Overview

ClickUp plugin brings your task management into the KB Labs CLI and REST API.
Create tasks from the terminal, post comments after a release, query your
backlog in automation scripts, and manage your entire workspace hierarchy
without leaving the keyboard.

---

## Features

- Full task lifecycle: create, update, delete, search
- Comment management: list and add comments
- Workspace hierarchy browser: spaces → folders → lists
- List management: create, update, delete, browse tasks and statuses
- Folder and space management
- JSON output on every command for scripting and agent use
- REST API for Studio integration and programmatic access

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Environment variables**

| Variable | Required | Description |
|----------|----------|-------------|
| `CLICKUP_API_KEY` | Yes | ClickUp personal API token |
| `CLICKUP_TEAM_ID` | Yes | Your ClickUp workspace (team) ID |

Get your API key at **ClickUp → Settings → Apps**.

---

## Installation

```bash
pnpm kb marketplace install @kb-labs/clickup
```

---

## Commands

### Workspace

```bash
kb clickup workspace show                   # full hierarchy: spaces → folders → lists
kb clickup workspace show --json            # slim JSON
kb clickup workspace show --json --full     # raw API response
```

### Tasks

```bash
kb clickup task search "bug"
kb clickup task search --status "in progress" --list listId --json
kb clickup task get    <taskId>
kb clickup task create --list <listId> --name "Fix login bug" --priority 2
kb clickup task update <taskId> --status "in review" --priority 1
kb clickup task delete <taskId> --force
```

### Comments

```bash
kb clickup task comments list <taskId>
kb clickup task comments add  <taskId> --text "Fixed in branch feature/x"
```

### Lists

```bash
kb clickup task list    <listId>
kb clickup status list <listId>
kb clickup list create   --folder <folderId> --name "Backlog"
kb clickup list update   <listId> --name "Sprint 5"
kb clickup list delete   <listId> --force
```

### Folders

```bash
kb clickup folder create --space <spaceId> --name "Q3 Sprint"
kb clickup folder update <folderId> --name "Q4 Sprint"
kb clickup folder delete <folderId> --force
```

### Spaces

```bash
kb clickup space create --name "Engineering" --color "#ff0000"
kb clickup space update <spaceId> --name "Backend"
kb clickup space delete <spaceId> --force
```

**All commands accept `--json` for slim output and `--json --full` for raw API response.**

---

## Configuration

```jsonc
{
  // Environment variables are the recommended approach
  // CLICKUP_API_KEY and CLICKUP_TEAM_ID can also be set in kb.config.json:
  "clickup": {
    "apiKey": "pk_...",
    "teamId": "12345678"
  }
}
```

---

## REST API

Requires the `gateway` plugin.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/plugins/clickup/workspace` | Full workspace hierarchy |
| `GET` | `/v1/plugins/clickup/tasks/search` | Search tasks |
| `GET` | `/v1/plugins/clickup/tasks/:id` | Task detail |
| `POST` | `/v1/plugins/clickup/lists/:listId/tasks` | Create task |
| `PATCH` | `/v1/plugins/clickup/tasks/:id` | Update task |
| `DELETE` | `/v1/plugins/clickup/tasks/:id` | Delete task |
| `GET` | `/v1/plugins/clickup/lists/:listId/tasks` | Tasks in list |
| `GET` | `/v1/plugins/clickup/lists/:listId/statuses` | List statuses |
| `GET` | `/v1/plugins/clickup/tasks/:id/comments` | Task comments |
| `POST` | `/v1/plugins/clickup/tasks/:id/comments` | Add comment |
| `POST` | `/v1/plugins/clickup/spaces` | Create space |
| `PATCH` | `/v1/plugins/clickup/spaces/:id` | Update space |
| `DELETE` | `/v1/plugins/clickup/spaces/:id` | Delete space |
| `POST` | `/v1/plugins/clickup/spaces/:id/folders` | Create folder |
| `PATCH` | `/v1/plugins/clickup/folders/:id` | Update folder |
| `DELETE` | `/v1/plugins/clickup/folders/:id` | Delete folder |
| `POST` | `/v1/plugins/clickup/folders/:id/lists` | Create list in folder |
| `POST` | `/v1/plugins/clickup/spaces/:id/lists` | Create folderless list |
| `PATCH` | `/v1/plugins/clickup/lists/:id` | Update list |
| `DELETE` | `/v1/plugins/clickup/lists/:id` | Delete list |

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Network | `api.clickup.com` | ClickUp REST API |
| Environment | `CLICKUP_API_KEY`, `CLICKUP_TEAM_ID` | Authentication |
| Quotas | 30 sec timeout, 128 MB RAM | API calls |

---

## Changelog

### 0.1.0

- Initial release: task, comment, workspace, list, folder, space commands + REST API

---

## License

MIT
