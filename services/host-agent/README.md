# @kb-labs/host-agent

> Workspace Agent — connect your machine to the KB Labs platform for remote execution.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-workspace--agent%20%7C%20gateway%20%7C%20remote--execution-lightgrey)

---

## Overview

Workspace Agent registers your local machine with a KB Labs Gateway and keeps a
persistent connection so the platform can dispatch plugin executions to your
workspace. This lets you run plugins in the context of your local files,
environment, and credentials — from anywhere a Gateway can reach.

---

## Features

- One-time registration with a Gateway — writes credentials to `~/.kb/agent.json`
- Connection status inspection via IPC
- List all registered agents from the Gateway
- Required for remote plugin execution and container dispatch modes

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Environment variables**

| Variable | Required | Description |
|----------|----------|-------------|
| `KB_GATEWAY_URL` | No | Override gateway URL (default: from `~/.kb/agent.json`) |

---

## Installation

```bash
kb workspace register --gateway https://gateway.example.com
```

---

## Commands

### Setup (run once)

```bash
kb workspace register --gateway http://localhost:4000
kb workspace register --gateway https://gateway.kblabs.dev --name my-laptop --workspace ~/projects/my-app
```

### Status

```bash
kb workspace status           # connection status, hostId, capabilities
kb workspace status --json
```

### List connected agents

```bash
kb workspace list             # all registered agents in the Gateway
kb workspace list --json
kb workspace list --gateway https://gateway.kblabs.dev
```

**Full command reference**

| Command | Description |
|---------|-------------|
| `kb workspace register` | Register this machine with a Gateway |
| `kb workspace status` | Show connection status |
| `kb workspace list` | List all connected agents |

The Workspace Agent command group is built into the platform CLI.

**`workspace register` flags**

| Flag | Description |
|------|-------------|
| `--gateway` | Gateway URL (required) |
| `--name` | Agent display name |
| `--workspace` | Workspace directory to register |

---

## Artifacts

| Path | Description |
|------|-------------|
| `~/.kb/agent.json` | Agent credentials and configuration |

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Filesystem (rw) | `.kb/**`, `~/.kb/**` | Credentials and state |
| Environment | `HOME`, `USER`, `KB_GATEWAY_URL` | Agent identity and config |
| Quotas | 30 sec timeout, 128 MB RAM | Lightweight registration |

---

## Changelog

### 0.2.0

- Renamed commands: `agent:*` → `workspace:*` (legacy aliases kept)

### 0.1.0

- Initial release: register, status, list commands

---

## License

MIT
