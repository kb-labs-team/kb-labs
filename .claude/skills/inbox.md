---
name: inbox
description: Working with the Inbox plugin — email via IMAP/SMTP, CLI commands, multi-account, error handling
globs:
  - "plugins/inbox/**"
  - "**/inbox*"
---

# Inbox Plugin

Plugin for managing email via IMAP/SMTP from CLI and REST API.
Packages: `@kb-labs/inbox/contracts`, `@kb-labs/inbox/core`, `@kb-labs/inbox`.

## Accounts (KB Labs / Kirill)

```
job   → kirillBaranovJob@yandex.ru   imap.yandex.ru:993 / smtp.yandex.ru:465
```

Run `pnpm kb inbox account list --json` to see all configured accounts.

## Env vars

```
INBOX_ACCOUNTS=job                          # comma-separated account names
INBOX_ACCOUNT_JOB_USER=kirillBaranovJob@yandex.ru
INBOX_ACCOUNT_JOB_PASS=<app-password>
INBOX_ACCOUNT_JOB_IMAP_HOST=imap.yandex.ru
INBOX_ACCOUNT_JOB_IMAP_PORT=993
INBOX_ACCOUNT_JOB_SMTP_HOST=smtp.yandex.ru
INBOX_ACCOUNT_JOB_SMTP_PORT=465
```

Wildcard `INBOX_ACCOUNT_*` is declared in the manifest — adding a new account requires only `.env` update, no plugin rebuild.

## Commands

All commands accept `--json`. `--account` accepts name (`job`) or index (`0`), defaults to first.

### Read

```bash
pnpm kb inbox list [--folder INBOX] [--unread] [--since 24h|7d|2w|ISO] [--limit 50] [--account job]
pnpm kb inbox get <uid> [--folder INBOX] [--attachments] [--account job]
pnpm kb inbox thread show <uid> [--folder INBOX] [--account job]
pnpm kb inbox search [--from addr] [--subject text] [--body text] [--text text] [--folder] [--since] [--limit 20]
pnpm kb inbox folder list [--account job]
pnpm kb inbox account list
```

### Write

```bash
pnpm kb inbox send --to addr --subject "..." --body "..." [--cc addr] [--bcc addr] [--account job]
pnpm kb inbox thread send <uid> --body "..." [--folder INBOX] [--account job]
pnpm kb inbox message update <uid> --folder Work [--from INBOX] [--account job]
pnpm kb inbox message set <uid> --read|--unread|--spam|--flagged|--unflagged [--folder INBOX] [--account job]
pnpm kb inbox delete <uid> [--folder INBOX] [--account job]
```

## JSON output

Every command returns a consistent envelope — always check `ok` first:

```jsonc
// Success
{ "ok": true, "result": [...] }

// Error — read "code" to decide what to do next
{ "ok": false, "error": { "code": "IMAP_AUTH_FAILED", "message": "...", "hint": "..." } }
```

**Error codes**

| Code | Meaning | Agent action |
|------|---------|--------------|
| `ENV_MISSING` | Account vars not set | Stop, ask user to configure |
| `ACCOUNT_NOT_FOUND` | `--account X` not in config | Run `kb inbox account list` to check |
| `IMAP_AUTH_FAILED` | Wrong password | Stop, ask user to create app-password |
| `IMAP_CONNECT_FAILED` | Can't reach IMAP server | Check host/port, retry once |
| `IMAP_TIMEOUT` | Connection timed out | Retry after short wait |
| `IMAP_MAILBOX_NOT_FOUND` | Folder doesn't exist | Run `kb inbox folder list` to get valid names |
| `MESSAGE_NOT_FOUND` | UID stale | Re-run `kb inbox list` to refresh UIDs |
| `SMTP_AUTH_FAILED` | SMTP auth error | Stop, ask user to check app-password |
| `SMTP_CONNECT_FAILED` | Can't reach SMTP server | Check SMTP host/port |
| `SMTP_INVALID_RECIPIENT` | Bad `--to` address | Validate the address |
| `VALIDATION_ERROR` | Missing/wrong flags | Read `hint` field for what to fix |

## Typical agent flows

### Triage inbox

```bash
# 1. Get unread emails for last 24h
pnpm kb inbox list --unread --since 24h --json

# 2. Read important ones in full
pnpm kb inbox get <uid> --json

# 3. Act on each: move, mark, reply, delete
pnpm kb inbox message update <uid> --folder Work --json
pnpm kb inbox message set <uid> --spam --json
pnpm kb inbox thread send <uid> --body "..." --json
pnpm kb inbox delete <uid> --json
```

### Find a specific email

```bash
pnpm kb inbox search --from sender@example.com --since 7d --json
pnpm kb inbox search --subject "invoice" --limit 5 --json
pnpm kb inbox thread show <uid> --json   # get full conversation context
```

### Daily digest

```bash
pnpm kb inbox list --since 24h --json --limit 100   # all mail for last day
# summarise result, report important items to user
```

## Key rules for agents

- **UIDs are session-scoped** — a UID fetched from `kb inbox list` may change after folder operations. Re-fetch if needed.
- **Never delete without reading** — always `get` before `delete` to confirm the right message.
- **Use `--since` to scope** — on large inboxes always add `--since` to avoid fetching thousands of messages.
- **Spam flow** — `mark --spam` moves to Junk automatically if the folder exists. No need to `move` separately.
- **Reply preserves thread** — `reply` sets In-Reply-To + References headers automatically. Don't use `send` for replies.
- **Folder names are case-sensitive** — use `kb inbox folder list` to get exact names before `move`.

## Code structure

```
plugins/inbox/
├── contracts/src/
│   ├── types.ts      # Email, EmailSlim, Folder, AccountInfo, EmailAddress, EmailAttachment
│   ├── schemas.ts    # Zod: SendMessageSchema, ReplyMessageSchema, MoveMessageSchema, MarkMessageSchema
│   └── routes.ts     # INBOX_BASE_PATH, INBOX_ROUTES
├── core/src/
│   ├── env.ts        # resolveAccount(nameOrIndex?), listAccounts() — via useEnv() from SDK
│   ├── error.ts      # InboxError class + InboxErrorCode union type
│   ├── imap.ts       # withImap(), listMessages(), getMessage(), getThread(), searchMessages(),
│   │                 # moveMessage(), markMessage(), deleteMessage(), listFolders()
│   └── smtp.ts       # sendMessage(), replyMessage()
└── entry/src/
    ├── commands/     # one file per command: mail-list, mail-get, mail-thread, mail-search,
    │                 # mail-send, mail-reply, mail-move, mail-mark, mail-delete, mail-folders, mail-accounts
    ├── rest/handlers/ # REST handlers mirroring CLI commands
    ├── utils/
    │   ├── error.ts  # handleError(), rethrowForRest(), validationError re-export
    │   └── slim.ts   # slimEmail(), formatDate(), formatFrom()
    └── manifest.ts   # plugin manifest v3 with wildcard env + TCP permissions
```

## Error handling pattern

```ts
import { handleError, validationError } from '../utils/error.js';

// 1. Validate args — before try/catch
const uid = parseInt(rawUid, 10);
if (isNaN(uid)) {
  validationError(ctx, 'uid must be a number', 'Usage: kb inbox get <uid>', input.flags.json);
  return { exitCode: 1, result: null };
}

// 2. Core call in try/catch
try {
  const account = resolveAccount(input.flags.account);
  const result = await getMessage(account, uid, { folder: input.flags.folder ?? 'INBOX' });
  if (input.flags.json) { ctx.ui?.json?.({ ok: true, result }); }
  else { /* human output */ }
  return { exitCode: 0, result };
} catch (err) {
  handleError(ctx, err, input.flags.json);
  return { exitCode: 1, result: null };
}
```
