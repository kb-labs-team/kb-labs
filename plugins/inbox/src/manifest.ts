import { cmd, group, mergeCliGroups, GET, POST, PATCH, DELETE, combinePermissions } from '@kb-labs/sdk';
import { INBOX_BASE_PATH, INBOX_ROUTES } from './contracts/index.js';

const permissions = combinePermissions()
  .withEnv([
    'INBOX_ACCOUNTS',
    'INBOX_ACCOUNT_*',  // covers all account vars: _USER, _PASS, _IMAP_HOST, etc.
  ])
  .withNetwork({
    tcp: { connect: ['imap.yandex.ru:993', 'smtp.yandex.ru:465', 'smtp.yandex.ru:587'] },
  })
  .withQuotas({ timeoutMs: 30_000, memoryMb: 128 })
  .build();

export const manifest = {
  schema: 'kb.plugin/3' as const,
  id: '@kb-labs/inbox',
  version: '0.1.0',

  display: {
    name: 'Inbox',
    description: 'Manage email via IMAP/SMTP — list, search, send, move, delete from CLI and REST API',
    tags: ['email', 'inbox', 'imap', 'smtp', 'productivity'],
  },

  permissions,

  cli: mergeCliGroups(
    group({ path: 'inbox', describe: 'Email management', category: 'Mail' }, [
      cmd('inbox list', './commands/mail-list.js#default', 'List emails in a folder')
        .read()
        .flags({
          folder:  { type: 'string',  description: 'Folder to list (default: INBOX)' },
          unread:  { type: 'boolean', description: 'Show only unread messages' },
          since:   { type: 'string',  description: 'Filter by age: 24h, 7d, 2w or ISO date' },
          limit:   { type: 'number',  description: 'Max results (default: 50)' },
          account: { type: 'string',  description: 'Account name or index (default: first)' },
          json:    { type: 'boolean', description: 'Output JSON' },
          full:    { type: 'boolean', description: 'Full JSON (requires --json)' },
        })
        .examples(['kb inbox list', 'kb inbox list --unread --since 24h', 'kb inbox list --folder Work --account personal --json']),

      cmd('inbox get', './commands/mail-get.js#default', 'Get full email content by uid')
        .read()
        .flags({
          folder:      { type: 'string',  description: 'Folder containing the message (default: INBOX)' },
          attachments: { type: 'boolean', description: 'Include attachment list' },
          account:     { type: 'string',  description: 'Account name or index' },
          json:        { type: 'boolean', description: 'Output JSON' },
          full:        { type: 'boolean', description: 'Full JSON (requires --json)' },
        })
        .examples(['kb inbox get 42', 'kb inbox get 42 --attachments --json', 'kb inbox get 42 --folder Sent --account work']),

      cmd('inbox thread show', './commands/mail-thread.js#default', 'Get full email thread by uid')
        .read()
        .flags({
          folder:  { type: 'string',  description: 'Folder (default: INBOX)' },
          account: { type: 'string',  description: 'Account name or index' },
          json:    { type: 'boolean', description: 'Output JSON' },
          full:    { type: 'boolean', description: 'Full JSON (requires --json)' },
        })
        .examples(['kb inbox thread show 42', 'kb inbox thread show 42 --json']),

      cmd('inbox search', './commands/mail-search.js#default', 'Search emails by from, subject, body, or text')
        .read()
        .flags({
          from:    { type: 'string',  description: 'Filter by sender' },
          subject: { type: 'string',  description: 'Filter by subject' },
          body:    { type: 'string',  description: 'Filter by body text' },
          text:    { type: 'string',  description: 'Full-text search (subject + body)' },
          folder:  { type: 'string',  description: 'Folder to search (default: INBOX)' },
          since:   { type: 'string',  description: 'Filter by age: 24h, 7d, 2w or ISO date' },
          limit:   { type: 'number',  description: 'Max results (default: 20)' },
          account: { type: 'string',  description: 'Account name or index' },
          json:    { type: 'boolean', description: 'Output JSON' },
          full:    { type: 'boolean', description: 'Full JSON (requires --json)' },
        })
        .examples([
          'kb inbox search --from boss@company.com',
          'kb inbox search --subject "invoice" --since 30d --json',
          'kb inbox search --text "urgent" --limit 5 --json',
        ]),

      cmd('inbox send', './commands/mail-send.js#default', 'Send an email')
        .mutate()
        .flags({
          to:      { type: 'string',  description: 'Recipient address (required)' },
          subject: { type: 'string',  description: 'Subject (required)' },
          body:    { type: 'string',  description: 'Message body (required)' },
          cc:      { type: 'string',  description: 'CC address' },
          bcc:     { type: 'string',  description: 'BCC address' },
          account: { type: 'string',  description: 'Account name or index' },
          json:    { type: 'boolean', description: 'Output JSON' },
        })
        .examples([
          'kb inbox send --to user@example.com --subject "Hello" --body "Hi there"',
          'kb inbox send --to user@example.com --subject "Report" --body "..." --account work --json',
        ]),

      cmd('inbox thread send', './commands/mail-reply.js#default', 'Reply to an email by uid (preserves thread)')
        .mutate()
        .flags({
          body:    { type: 'string',  description: 'Reply body (required)' },
          folder:  { type: 'string',  description: 'Folder containing the original (default: INBOX)' },
          account: { type: 'string',  description: 'Account name or index' },
          json:    { type: 'boolean', description: 'Output JSON' },
        })
        .examples(['kb inbox thread send 42 --body "Thanks, will do"', 'kb inbox thread send 42 --body "On it" --account work --json']),

      cmd('inbox message update', './commands/mail-move.js#default', 'Move an email to a folder')
        .mutate()
        .flags({
          folder:  { type: 'string',  description: 'Destination folder (required)' },
          from:    { type: 'string',  description: 'Source folder (default: INBOX)' },
          account: { type: 'string',  description: 'Account name or index' },
          json:    { type: 'boolean', description: 'Output JSON' },
        })
        .examples(['kb inbox message update 42 --folder Work', 'kb inbox message update 42 --folder Archive --from Sent --json']),

      cmd('inbox message set', './commands/mail-mark.js#default', 'Mark an email as read, unread, spam, or flagged')
        .mutate()
        .flags({
          read:      { type: 'boolean', description: 'Mark as read' },
          unread:    { type: 'boolean', description: 'Mark as unread' },
          spam:      { type: 'boolean', description: 'Mark as spam and move to Junk' },
          flagged:   { type: 'boolean', description: 'Flag the message' },
          unflagged: { type: 'boolean', description: 'Remove flag' },
          folder:    { type: 'string',  description: 'Folder (default: INBOX)' },
          account:   { type: 'string',  description: 'Account name or index' },
          json:      { type: 'boolean', description: 'Output JSON' },
        })
        .examples(['kb inbox message set 42 --read', 'kb inbox message set 42 --spam', 'kb inbox message set 42 --flagged --json']),

      cmd('inbox delete', './commands/mail-delete.js#default', 'Delete an email (moves to Trash)')
        .mutate()
        .flags({
          folder:  { type: 'string',  description: 'Folder containing the message (default: INBOX)' },
          account: { type: 'string',  description: 'Account name or index' },
          json:    { type: 'boolean', description: 'Output JSON' },
        })
        .examples(['kb inbox delete 42', 'kb inbox delete 42 --folder Spam --json']),

      cmd('inbox folder list', './commands/mail-folders.js#default', 'List available folders/mailboxes')
        .read()
        .flags({
          account: { type: 'string',  description: 'Account name or index' },
          json:    { type: 'boolean', description: 'Output JSON' },
        })
        .examples(['kb inbox folder list', 'kb inbox folder list --account work --json']),

      cmd('inbox account list', './commands/mail-accounts.js#default', 'List configured email accounts')
        .read()
        .category('Config')
        .flags({
          json: { type: 'boolean', description: 'Output JSON' },
        })
        .examples(['kb inbox account list', 'kb inbox account list --json']),
    ]),
  ),

  rest: {
    basePath: INBOX_BASE_PATH,
    routes: [
      GET(INBOX_ROUTES.MESSAGES,       './rest/handlers/list-handler.js#default'),
      GET(INBOX_ROUTES.MESSAGE,        './rest/handlers/get-handler.js#default'),
      GET(INBOX_ROUTES.MESSAGE_THREAD, './rest/handlers/thread-handler.js#default'),
      GET(INBOX_ROUTES.SEARCH,         './rest/handlers/search-handler.js#default'),
      POST(INBOX_ROUTES.MESSAGES,      './rest/handlers/send-handler.js#default',  { input: { zod: '@kb-labs/inbox/contracts#SendMessageSchema' } }),
      POST(INBOX_ROUTES.MESSAGE_REPLY, './rest/handlers/reply-handler.js#default', { input: { zod: '@kb-labs/inbox/contracts#ReplyMessageSchema' } }),
      PATCH(INBOX_ROUTES.MESSAGE_MOVE, './rest/handlers/move-handler.js#default',  { input: { zod: '@kb-labs/inbox/contracts#MoveMessageSchema' } }),
      PATCH(INBOX_ROUTES.MESSAGE_MARK, './rest/handlers/mark-handler.js#default',  { input: { zod: '@kb-labs/inbox/contracts#MarkMessageSchema' } }),
      DELETE(INBOX_ROUTES.MESSAGE,     './rest/handlers/delete-handler.js#default'),
      GET(INBOX_ROUTES.FOLDERS,        './rest/handlers/folders-handler.js#default'),
      GET(INBOX_ROUTES.ACCOUNTS,       './rest/handlers/accounts-handler.js#default'),
    ],
  },
};
