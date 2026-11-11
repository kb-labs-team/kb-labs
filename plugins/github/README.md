# @kb-labs/github

> GitHub integration — fetch issues, post comments, create branches and PRs from workflows.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-github%20%7C%20integration%20%7C%20workflow-lightgrey)

---

## Overview

GitHub plugin provides workflow handlers for common GitHub operations — fetch
an issue, post a comment, create a branch, open a PR. Designed to be composed
into KB Labs workflows (e.g. "fetch issue → create branch → run agent → open PR").

---

## Features

- Fetch issue details by number
- Post comments on issues and PRs
- Create branches from any base ref
- Create pull requests with optional issue linking
- Designed as workflow handlers — composes with any KB Labs workflow

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Environment variables**

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_WORKFLOW_TOKEN` | Yes | GitHub personal access token or Actions token |

Token needs: `repo` scope (issues, PRs, branches).

---

## Installation

```bash
pnpm kb marketplace install @kb-labs/github
```

---

## Workflow Handlers

This plugin registers workflow handlers — use them in KB Labs workflow definitions:

| Handler ID | Description |
|------------|-------------|
| `fetch-issue` | Fetch a GitHub issue by number |
| `post-comment` | Post a comment on an issue or PR |
| `create-branch` | Create a branch from a base ref |
| `create-pr` | Create a pull request, optionally linked to an issue |

**Example workflow step:**

```yaml
steps:
  - id: fetch-issue
    handler: github/fetch-issue
    input:
      owner: my-org
      repo: my-repo
      issue: 42

  - id: create-pr
    handler: github/create-pr
    input:
      owner: my-org
      repo: my-repo
      title: "Fix: issue #42"
      head: feature/fix-42
      base: main
      issue: 42
```

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Network | `api.github.com` | GitHub REST API |
| Environment | `GITHUB_WORKFLOW_TOKEN` | Authentication |

---

## Changelog

### 0.1.0

- Initial release: fetch-issue, post-comment, create-branch, create-pr handlers

---

## License

MIT
