# @kb-labs/inbox

> Manage email via IMAP/SMTP from CLI, agents, and REST API.

![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/kb--labs-%3E%3D0.1.0-orange)
![tags](https://img.shields.io/badge/tags-email%20%7C%20imap%20%7C%20smtp%20%7C%20productivity-lightgrey)

---

## Overview

Inbox plugin brings email into the KB Labs CLI and agent stack.
List, search, send, reply, move, and delete messages without leaving the terminal.
Every command outputs structured JSON — agents and workflows can compose them freely.
Supports multiple accounts (Yandex, Gmail, any IMAP/SMTP provider).

The plugin is intentionally atomic: it provides primitives only.
Classification, summarisation, routing logic — that's your agent or workflow.

---

## Features

- List, get, search emails (by from / subject / body / text)
- Full thread retrieval (In-Reply-To + References chain)
- Send and reply with correct thread headers
- Move, mark (read / unread / spam / flagged), delete
- Folder listing
- Multi-account support via env vars — no rebuild required to add accounts
- JSON output on every command for agent and scripting use
- REST API for programmatic access

---

## Requirements

**KB Labs platform** `>= 0.1.0`

**Yandex Mail setup** (one-time):

1. Settings → **Почтовые программы** → enable IMAP access
2. Yandex ID → **Security** → **App passwords** → create a password for "Mail"
3. Use the generated password (not your account password) as `_PASS`

For Gmail, Outlook, or any other provider: use their IMAP/SMTP settings and app password.

**Environment variables**

```bash
# List of account names (comma-separated, case-insensitive)
INBOX_ACCOUNTS=work,personal

# Per-account vars — replace WORK with your account name
INBOX_ACCOUNT_WORK_USER=me@yandex.ru
INBOX_ACCOUNT_WORK_PASS=<app-password>
INBOX_ACCOUNT_WORK_IMAP_HOST=imap.yandex.ru
INBOX_ACCOUNT_WORK_IMAP_PORT=993        # optional, default: 993
INBOX_ACCOUNT_WORK_SMTP_HOST=smtp.yandex.ru
INBOX_ACCOUNT_WORK_SMTP_PORT=465        # optional, default: 465
```

The wildcard `INBOX_ACCOUNT_*` is declared in the manifest — adding a new account only requires updating `.env`, no plugin rebuild needed.

**Common IMAP/SMTP hosts**

| Provider | IMAP | SMTP |
|----------|------|------|
| Yandex | `imap.yandex.ru:993` | `smtp.yandex.ru:465` |
| Gmail | `imap.gmail.com:993` | `smtp.gmail.com:465` |
| Outlook | `outlook.office365.com:993` | `smtp.office365.com:587` |

---

## Installation

```bash
pnpm kb marketplace install @kb-labs/inbox
```

---

## Commands

The `--account` flag accepts an account name (`work`) or index (`0`). Defaults to the first account.

### Read

```bash
# List emails
kb inbox list
kb inbox list --unread
kb inbox list --since 24h                        # also: 7d, 2w, ISO date
kb inbox list --folder Sent --limit 20 --json

# Get full email content
kb inbox get <uid>
kb inbox get <uid> --attachments --json

# Get full thread
kb inbox thread show <uid>
kb inbox thread show <uid> --json

# Search
kb inbox search --from boss@company.com
kb inbox search --subject "invoice" --since 30d
kb inbox search --text "urgent" --limit 5 --json

# List folders
kb inbox folder list
kb inbox folder list --account work --json

# List configured accounts
kb inbox account list
kb inbox account list --json
```

### Write

```bash
# Send email
kb inbox send --to user@example.com --subject "Hello" --body "Hi there"
kb inbox send --to user@example.com --subject "Report" --body "..." --cc cto@co.com

# Reply (preserves In-Reply-To + References)
kb inbox thread send <uid> --body "Thanks, will do"

# Move to folder
kb inbox message update <uid> --folder Work
kb inbox message update <uid> --folder Archive --from Sent

# Mark
kb inbox message set <uid> --read
kb inbox message set <uid> --unread
kb inbox message set <uid> --spam           # moves to Junk folder
kb inbox message set <uid> --flagged
kb inbox message set <uid> --unflagged

# Delete (moves to Trash)
kb inbox delete <uid>
```

**All commands accept `--json` for structured output.**

---

## Multi-account usage

```bash
kb inbox list --account work
kb inbox list --account personal
kb inbox list --account 0            # by index

kb inbox send --to x@y.com --subject "Hi" --body "..." --account personal
```

---

## JSON output format

Every command returns a consistent envelope:

```jsonc
// Success
{ "ok": true, "result": [...] }

// Error — agents read "code" to decide next steps
{
  "ok": false,
  "error": {
    "code": "IMAP_AUTH_FAILED",
    "message": "Invalid credentials for work@yandex.ru",
    "hint": "Create an app-password in Yandex ID settings and set INBOX_ACCOUNT_WORK_PASS"
  }
}
```

**Error codes**

| Code | Meaning | Hint |
|------|---------|------|
| `ENV_MISSING` | Account vars not set | Which vars to add |
| `ACCOUNT_NOT_FOUND` | `--account X` not in config | Run `kb inbox account list` |
| `IMAP_AUTH_FAILED` | Wrong password | Create app-password in Yandex ID |
| `IMAP_CONNECT_FAILED` | Can't reach IMAP server | Check host/port |
| `IMAP_TIMEOUT` | Connection timed out | Retry |
| `IMAP_MAILBOX_NOT_FOUND` | Folder doesn't exist | Run `kb inbox folder list` |
| `MESSAGE_NOT_FOUND` | UID stale | Refresh with `kb inbox list` |
| `SMTP_AUTH_FAILED` | SMTP auth error | Check app-password |
| `SMTP_CONNECT_FAILED` | Can't reach SMTP server | Check host/port |
| `SMTP_INVALID_RECIPIENT` | Bad `--to` address | Verify email |
| `VALIDATION_ERROR` | Missing or wrong flags | See hint in output |

---

## Agent usage example

```bash
# Agent flow: triage unread emails
kb inbox list --unread --since 24h --json          # get all unread
kb inbox get <uid> --json                          # read specific email
kb inbox message set <uid> --spam                         # mark as spam
kb inbox message update <uid> --folder Work                  # file to folder
kb inbox thread send <uid> --body "On it, will follow up tomorrow"
```

---

## REST API

Requires the `gateway` plugin.

Base path: `/v1/plugins/inbox`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/messages` | List emails (`?folder=&unread=&since=&limit=&account=`) |
| `GET` | `/messages/:uid` | Get email (`?folder=&attachments=&account=`) |
| `GET` | `/messages/:uid/thread` | Get thread |
| `GET` | `/search` | Search (`?from=&subject=&body=&text=&since=&limit=&account=`) |
| `POST` | `/messages` | Send email |
| `POST` | `/messages/:uid/reply` | Reply to email |
| `PATCH` | `/messages/:uid/move` | Move to folder |
| `PATCH` | `/messages/:uid/mark` | Mark (read/unread/spam/flagged/unflagged) |
| `DELETE` | `/messages/:uid` | Delete (moves to Trash) |
| `GET` | `/folders` | List folders |
| `GET` | `/accounts` | List configured accounts |

---

## Permissions

| Category | Scope | Reason |
|----------|-------|--------|
| Network (TCP) | `imap.yandex.ru:993`, `smtp.yandex.ru:465/587` | IMAP/SMTP connections |
| Environment | `INBOX_ACCOUNTS`, `INBOX_ACCOUNT_*` | Account configuration |
| Quotas | 30 sec timeout, 128 MB RAM | Connection + fetch |

---

## Changelog

### 0.1.0

- Initial release: list, get, thread, search, send, reply, move, mark, delete + REST API
- Multi-account support via `INBOX_ACCOUNT_*` wildcard env
- Structured error codes with agent-readable hints

---

## License

MIT
