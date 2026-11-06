import { ImapFlow, type FetchMessageObject } from 'imapflow';
import type { Email, EmailSlim, Folder } from '../contracts/index.js';
import type { AccountConfig } from './env.js';
import { InboxError } from './error.js';

// ─── connection helper ────────────────────────────────────────────────────────

async function withImap<T>(config: AccountConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
    // Fail fast — CLI commands should not hang
    connectionTimeout: 10_000,
  });

  try {
    await client.connect();
  } catch (err) {
    throw wrapImapError(err);
  }

  try {
    return await fn(client);
  } catch (err) {
    throw err instanceof InboxError ? err : wrapImapError(err);
  } finally {
    try { await client.logout(); } catch { /* ignore logout errors */ }
  }
}

function wrapImapError(err: unknown): InboxError {
  if (err instanceof InboxError) { return err; }

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (/authenticationfailed|invalid credentials|login failed/i.test(lower)) {
    return new InboxError('IMAP_AUTH_FAILED', msg, err);
  }
  if (/econnrefused|enotfound|etimedout|connect/i.test(lower)) {
    return new InboxError('IMAP_CONNECT_FAILED', msg, err);
  }
  if (/timeout/i.test(lower)) {
    return new InboxError('IMAP_TIMEOUT', msg, err);
  }
  if (/no such mailbox|mailbox not found|doesn't exist/i.test(lower)) {
    return new InboxError('IMAP_MAILBOX_NOT_FOUND', msg, err);
  }

  return new InboxError('INTERNAL_ERROR', msg, err);
}

// ─── address parsing ──────────────────────────────────────────────────────────

function parseAddresses(raw: unknown): Array<{ name?: string; address: string }> {
  if (!raw || !Array.isArray(raw)) { return []; }
  return (raw as Array<{ name?: string; address?: string }>)
    .filter(a => a.address)
    .map(a => ({ ...(a.name ? { name: a.name } : {}), address: a.address! }));
}

// ─── list ─────────────────────────────────────────────────────────────────────

export interface ListMessagesOptions {
  folder?: string;
  unreadOnly?: boolean;
  since?: Date;
  limit?: number;
}

export async function listMessages(config: AccountConfig, opts: ListMessagesOptions = {}): Promise<EmailSlim[]> {
  const folder = opts.folder ?? 'INBOX';
  const limit = opts.limit ?? 50;

  return withImap(config, async client => {
    await client.mailboxOpen(folder).catch(() => {
      throw new InboxError('IMAP_MAILBOX_NOT_FOUND', `Folder "${folder}" not found. Use kb inbox folder list to list available folders.`);
    });

    // Build search criteria
    const searchCriteria: Record<string, unknown> = {};
    if (opts.unreadOnly) { searchCriteria['unseen'] = true; }
    if (opts.since) { searchCriteria['since'] = opts.since; }

    const hasFilters = Object.keys(searchCriteria).length > 0;
    const uids: number[] = hasFilters
      ? await client.search(searchCriteria, { uid: true }) as number[]
      : await client.search({ all: true }, { uid: true }) as number[];

    if (!uids.length) { return []; }

    // Take last N (most recent) — IMAP UIDs are ascending
    const sliced = uids.slice(-limit);

    const results: EmailSlim[] = [];

    for await (const msg of client.fetch(sliced, {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
    }, { uid: true })) {
      const envelope = (msg as FetchMessageObject).envelope;
      if (!envelope) { continue; }

      const flags = [...((msg as FetchMessageObject).flags ?? [])];
      const hasAttachments = hasAttachmentParts((msg as FetchMessageObject).bodyStructure);

      results.push({
        uid: (msg as FetchMessageObject).uid,
        subject: envelope.subject ?? '(no subject)',
        from: parseAddresses(envelope.from)[0] ?? { address: '' },
        date: envelope.date ? new Date(envelope.date).toISOString() : new Date(0).toISOString(),
        folder,
        unread: !flags.includes('\\Seen'),
        flagged: flags.includes('\\Flagged'),
        hasAttachments,
      });
    }

    // Sort most recent first
    return results.sort((a, b) => b.date.localeCompare(a.date));
  });
}

function hasAttachmentParts(structure: unknown): boolean {
  if (!structure) { return false; }
  const s = structure as { type?: string; disposition?: { type?: string }; childNodes?: unknown[] };
  if (s.disposition?.type?.toLowerCase() === 'attachment') { return true; }
  if (s.childNodes) { return s.childNodes.some(hasAttachmentParts); }
  return false;
}

// ─── get ──────────────────────────────────────────────────────────────────────

export interface GetMessageOptions {
  folder?: string;
  withAttachments?: boolean;
}

export async function getMessage(config: AccountConfig, uid: number, opts: GetMessageOptions = {}): Promise<Email> {
  const folder = opts.folder ?? 'INBOX';

  return withImap(config, async client => {
    await client.mailboxOpen(folder).catch(() => {
      throw new InboxError('IMAP_MAILBOX_NOT_FOUND', `Folder "${folder}" not found.`);
    });

    let found: Email | null = null;

    for await (const msg of client.fetch([uid], {
      uid: true,
      flags: true,
      envelope: true,
      source: true,
    }, { uid: true })) {
      const envelope = (msg as FetchMessageObject).envelope;
      if (!envelope) { continue; }

      const flags = [...((msg as FetchMessageObject).flags ?? [])];
      const source = (msg as FetchMessageObject).source?.toString('utf8') ?? '';

      // Basic text extraction from raw source
      const { text, html, attachments } = parseBody(source);

      found = {
        uid: (msg as FetchMessageObject).uid,
        messageId: envelope.messageId ?? undefined,
        subject: envelope.subject ?? '(no subject)',
        from: parseAddresses(envelope.from)[0] ?? { address: '' },
        to: parseAddresses(envelope.to),
        cc: parseAddresses(envelope.cc),
        date: envelope.date ? new Date(envelope.date).toISOString() : new Date(0).toISOString(),
        folder,
        flags,
        text,
        html,
        attachments: opts.withAttachments ? attachments : undefined,
        inReplyTo: envelope.inReplyTo ?? undefined,
        references: (envelope as unknown as { references?: string[] }).references ?? undefined,
      };
    }

    if (!found) {
      throw new InboxError('MESSAGE_NOT_FOUND', `Message uid=${uid} not found in "${folder}". Refresh with: kb inbox list --folder ${folder}`);
    }

    return found;
  });
}

function parseBody(source: string): { text?: string; html?: string; attachments: Array<{ filename: string; contentType: string; size: number }> } {
  // Minimal MIME parsing — extract plain text and html parts
  // For production quality, a proper MIME parser (mailparser) would be used
  // This gives agents usable text content from the raw source
  const textMatch = source.match(/Content-Type: text\/plain[^\r\n]*[\r\n]+([\s\S]*?)(?=\r?\n--|\r?\n\r?\n--)/i);
  const htmlMatch = source.match(/Content-Type: text\/html[^\r\n]*[\r\n]+([\s\S]*?)(?=\r?\n--|\r?\n\r?\n--)/i);

  const text = textMatch?.[1] != null ? decodeBodyPart(textMatch[1]) : undefined;
  const html = htmlMatch?.[1] != null ? decodeBodyPart(htmlMatch[1]) : undefined;

  const attachments: Array<{ filename: string; contentType: string; size: number }> = [];
  const attachRe = /Content-Disposition: attachment[^\r\n]*(?:\r?\n[^\r\n]+)*\r?\n\s*filename="([^"]+)"/gi;
  const typeRe = /Content-Type: ([^\s;]+)/i;
  let m: RegExpExecArray | null;
  while ((m = attachRe.exec(source)) !== null) {
    const filename = m[1] ?? '';
    const typeMatch = source.slice(Math.max(0, m.index - 200), m.index).match(typeRe);
    attachments.push({ filename, contentType: typeMatch?.[1] ?? 'application/octet-stream', size: 0 });
  }

  return { text, html, attachments };
}

function decodeBodyPart(raw: string): string {
  // Strip transfer-encoding headers and return body
  return raw.replace(/^[^\r\n]*[\r\n]+/gm, '').trim();
}

// ─── thread ───────────────────────────────────────────────────────────────────

export async function getThread(config: AccountConfig, uid: number, opts: GetMessageOptions = {}): Promise<Email[]> {
  const folder = opts.folder ?? 'INBOX';

  const root = await getMessage(config, uid, { folder });

  if (!root.inReplyTo && !root.messageId) { return [root]; }

  return withImap(config, async client => {
    await client.mailboxOpen(folder).catch(() => {
      throw new InboxError('IMAP_MAILBOX_NOT_FOUND', `Folder "${folder}" not found.`);
    });

    // Search for messages with matching references
    const targetId = root.messageId ?? root.inReplyTo;
    if (!targetId) { return [root]; }

    const uids = await client.search({ header: { 'References': targetId } }, { uid: true }) as number[];
    const selfUids = await client.search({ header: { 'Message-ID': targetId } }, { uid: true }) as number[];

    const allUids = [...new Set([...uids, ...selfUids, uid])].sort((a, b) => a - b);

    const messages: Email[] = [];
    for (const u of allUids) {
      try {
        const msg = await getMessage(config, u, { folder });
        messages.push(msg);
      } catch {
        // Skip individual missing messages
      }
    }

    return messages.sort((a, b) => a.date.localeCompare(b.date));
  });
}

// ─── search ───────────────────────────────────────────────────────────────────

export interface SearchMessagesOptions {
  from?: string;
  subject?: string;
  body?: string;
  text?: string;
  folder?: string;
  since?: Date;
  limit?: number;
}

export async function searchMessages(config: AccountConfig, opts: SearchMessagesOptions): Promise<EmailSlim[]> {
  const folder = opts.folder ?? 'INBOX';
  const limit = opts.limit ?? 20;

  return withImap(config, async client => {
    await client.mailboxOpen(folder).catch(() => {
      throw new InboxError('IMAP_MAILBOX_NOT_FOUND', `Folder "${folder}" not found.`);
    });

    const criteria: Record<string, unknown> = {};
    if (opts.from) { criteria['from'] = opts.from; }
    if (opts.subject) { criteria['subject'] = opts.subject; }
    if (opts.body) { criteria['body'] = opts.body; }
    if (opts.text) { criteria['text'] = opts.text; }
    if (opts.since) { criteria['since'] = opts.since; }

    if (Object.keys(criteria).length === 0) {
      throw new InboxError('VALIDATION_ERROR', 'At least one search filter is required: --from, --subject, --body, or --text');
    }

    const uids = await client.search(criteria, { uid: true }) as number[];
    if (!uids.length) { return []; }

    const sliced = uids.slice(-limit);
    const results: EmailSlim[] = [];

    for await (const msg of client.fetch(sliced, {
      uid: true,
      flags: true,
      envelope: true,
      bodyStructure: true,
    }, { uid: true })) {
      const envelope = (msg as FetchMessageObject).envelope;
      if (!envelope) { continue; }

      const flags = [...((msg as FetchMessageObject).flags ?? [])];
      results.push({
        uid: (msg as FetchMessageObject).uid,
        subject: envelope.subject ?? '(no subject)',
        from: parseAddresses(envelope.from)[0] ?? { address: '' },
        date: envelope.date ? new Date(envelope.date).toISOString() : new Date(0).toISOString(),
        folder,
        unread: !flags.includes('\\Seen'),
        flagged: flags.includes('\\Flagged'),
        hasAttachments: hasAttachmentParts((msg as FetchMessageObject).bodyStructure),
      });
    }

    return results.sort((a, b) => b.date.localeCompare(a.date));
  });
}

// ─── move ─────────────────────────────────────────────────────────────────────

export async function moveMessage(config: AccountConfig, uid: number, fromFolder: string, toFolder: string): Promise<void> {
  return withImap(config, async client => {
    await client.mailboxOpen(fromFolder).catch(() => {
      throw new InboxError('IMAP_MAILBOX_NOT_FOUND', `Folder "${fromFolder}" not found.`);
    });

    await client.messageMove([uid], toFolder, { uid: true });
  });
}

// ─── mark ─────────────────────────────────────────────────────────────────────

export type MarkAction = 'read' | 'unread' | 'spam' | 'flagged' | 'unflagged';

export async function markMessage(config: AccountConfig, uid: number, folder: string, action: MarkAction): Promise<void> {
  return withImap(config, async client => {
    await client.mailboxOpen(folder).catch(() => {
      throw new InboxError('IMAP_MAILBOX_NOT_FOUND', `Folder "${folder}" not found.`);
    });

    switch (action) {
      case 'read':
        await client.messageFlagsAdd([uid], ['\\Seen'], { uid: true });
        break;
      case 'unread':
        await client.messageFlagsRemove([uid], ['\\Seen'], { uid: true });
        break;
      case 'flagged':
        await client.messageFlagsAdd([uid], ['\\Flagged'], { uid: true });
        break;
      case 'unflagged':
        await client.messageFlagsRemove([uid], ['\\Flagged'], { uid: true });
        break;
      case 'spam': {
        // Move to Junk/Spam folder and mark as seen
        const junk = await findJunkFolder(client);
        if (junk) {
          await client.messageMove([uid], junk, { uid: true });
        } else {
          await client.messageFlagsAdd([uid], ['\\Seen', '\\Flagged'], { uid: true });
        }
        break;
      }
    }
  });
}

async function findJunkFolder(client: ImapFlow): Promise<string | null> {
  const list = await client.list();
  const junk = list.find(f =>
    f.specialUse === '\\Junk' ||
    /^(spam|junk|unwanted)/i.test(f.name),
  );
  return junk?.path ?? null;
}

// ─── delete ───────────────────────────────────────────────────────────────────

export async function deleteMessage(config: AccountConfig, uid: number, folder: string): Promise<void> {
  return withImap(config, async client => {
    await client.mailboxOpen(folder).catch(() => {
      throw new InboxError('IMAP_MAILBOX_NOT_FOUND', `Folder "${folder}" not found.`);
    });

    // Move to Trash if available, otherwise flag as deleted and expunge
    const trash = await findTrashFolder(client);
    if (trash && trash !== folder) {
      await client.messageMove([uid], trash, { uid: true });
    } else {
      await client.messageFlagsAdd([uid], ['\\Deleted'], { uid: true });
      await client.mailboxClose();
    }
  });
}

async function findTrashFolder(client: ImapFlow): Promise<string | null> {
  const list = await client.list();
  const trash = list.find(f =>
    f.specialUse === '\\Trash' ||
    /^(trash|deleted|корзина)/i.test(f.name),
  );
  return trash?.path ?? null;
}

// ─── folders ─────────────────────────────────────────────────────────────────

export async function listFolders(config: AccountConfig): Promise<Folder[]> {
  return withImap(config, async client => {
    const list = await client.list();
    return list.map(f => ({
      name: f.name,
      path: f.path,
      flags: f.flags ? [...f.flags] : [],
      specialUse: f.specialUse ?? undefined,
    }));
  });
}
