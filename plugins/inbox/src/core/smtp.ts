import nodemailer from 'nodemailer';
import type { AccountConfig } from './env.js';
import { InboxError } from './error.js';

export interface SendOptions {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
  from?: string;
}

export interface ReplyOptions {
  body: string;
  originalMessageId?: string;
  originalReferences?: string[];
  originalSubject: string;
}

function createTransport(config: AccountConfig) {
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.user, pass: config.pass },
    connectionTimeout: 10_000,
    socketTimeout: 10_000,
  });
}

function wrapSmtpError(err: unknown): InboxError {
  if (err instanceof InboxError) { return err; }

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (/authenticationfailed|auth failed|535/i.test(lower)) {
    return new InboxError('SMTP_AUTH_FAILED', msg, err);
  }
  if (/econnrefused|enotfound|connect/i.test(lower)) {
    return new InboxError('SMTP_CONNECT_FAILED', msg, err);
  }
  if (/invalid recipient|550|551|no such user/i.test(lower)) {
    return new InboxError('SMTP_INVALID_RECIPIENT', msg, err);
  }

  return new InboxError('INTERNAL_ERROR', msg, err);
}

export async function sendMessage(config: AccountConfig, opts: SendOptions): Promise<{ messageId: string }> {
  const transport = createTransport(config);

  try {
    const info = await transport.sendMail({
      from: opts.from ?? config.user,
      to: opts.to,
      cc: opts.cc,
      bcc: opts.bcc,
      subject: opts.subject,
      text: opts.body,
    });

    return { messageId: info.messageId ?? '' };
  } catch (err) {
    throw wrapSmtpError(err);
  } finally {
    transport.close();
  }
}

export async function replyMessage(config: AccountConfig, original: ReplyOptions, body: string): Promise<{ messageId: string }> {
  const transport = createTransport(config);

  // Build References header: original References + original Message-ID
  const refs = [
    ...(original.originalReferences ?? []),
    ...(original.originalMessageId ? [original.originalMessageId] : []),
  ].join(' ');

  const subject = original.originalSubject.startsWith('Re:')
    ? original.originalSubject
    : `Re: ${original.originalSubject}`;

  try {
    const info = await transport.sendMail({
      from: config.user,
      subject,
      text: body,
      inReplyTo: original.originalMessageId,
      references: refs || undefined,
      headers: {},
    });

    return { messageId: info.messageId ?? '' };
  } catch (err) {
    throw wrapSmtpError(err);
  } finally {
    transport.close();
  }
}
