import { useEnv } from '@kb-labs/sdk';
import type { AccountInfo } from '../contracts/index.js';
import { InboxError } from './error.js';

export interface AccountConfig {
  name: string;
  user: string;
  pass: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
}

/**
 * Returns a list of account names from INBOX_ACCOUNTS env var.
 * INBOX_ACCOUNTS=work,personal
 */
function getAccountNames(): string[] {
  const raw = useEnv('INBOX_ACCOUNTS');
  if (!raw) { return []; }
  return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

/**
 * Read config for a single named account from env vars.
 * Vars: INBOX_ACCOUNT_{NAME}_USER, INBOX_ACCOUNT_{NAME}_PASS,
 *       INBOX_ACCOUNT_{NAME}_IMAP_HOST, INBOX_ACCOUNT_{NAME}_IMAP_PORT,
 *       INBOX_ACCOUNT_{NAME}_SMTP_HOST, INBOX_ACCOUNT_{NAME}_SMTP_PORT
 */
function readAccountConfig(name: string): AccountConfig {
  const prefix = `INBOX_ACCOUNT_${name}`;
  const user = useEnv(`${prefix}_USER`);
  const pass = useEnv(`${prefix}_PASS`);
  const imapHost = useEnv(`${prefix}_IMAP_HOST`);
  const smtpHost = useEnv(`${prefix}_SMTP_HOST`);

  if (!user || !pass || !imapHost || !smtpHost) {
    const missing = [
      !user && `${prefix}_USER`,
      !pass && `${prefix}_PASS`,
      !imapHost && `${prefix}_IMAP_HOST`,
      !smtpHost && `${prefix}_SMTP_HOST`,
    ].filter(Boolean).join(', ');

    throw new InboxError(
      'ENV_MISSING',
      `Account "${name.toLowerCase()}" is missing required env vars: ${missing}`,
    );
  }

  const imapPortRaw = useEnv(`${prefix}_IMAP_PORT`) ?? '993';
  const smtpPortRaw = useEnv(`${prefix}_SMTP_PORT`) ?? '465';

  return {
    name: name.toLowerCase(),
    user,
    pass,
    imap: { host: imapHost, port: parseInt(imapPortRaw, 10) },
    smtp: { host: smtpHost, port: parseInt(smtpPortRaw, 10) },
  };
}

/**
 * Resolve account config by name or index (default: first account).
 * Throws InboxError with actionable hints if not found.
 */
export function resolveAccount(nameOrIndex?: string): AccountConfig {
  const names = getAccountNames();

  if (names.length === 0) {
    throw new InboxError(
      'ENV_MISSING',
      'No accounts configured. Set INBOX_ACCOUNTS=work,personal and account vars.',
    );
  }

  if (!nameOrIndex) {
    // Default: first account
    return readAccountConfig(names[0]!);
  }

  // Try by name first (case-insensitive)
  const byName = names.find(n => n === nameOrIndex.toUpperCase());
  if (byName) { return readAccountConfig(byName); }

  // Try by index
  const idx = parseInt(nameOrIndex, 10);
  if (!isNaN(idx) && idx >= 0 && idx < names.length) {
    return readAccountConfig(names[idx]!);
  }

  throw new InboxError(
    'ACCOUNT_NOT_FOUND',
    `Account "${nameOrIndex}" not found. Available: ${names.map(n => n.toLowerCase()).join(', ')}`,
  );
}

/**
 * Returns info for all configured accounts (no passwords).
 */
export function listAccounts(): AccountInfo[] {
  const names = getAccountNames();
  return names.map((name, index) => {
    const prefix = `INBOX_ACCOUNT_${name}`;
    const user = useEnv(`${prefix}_USER`) ?? '(not set)';
    const imapHost = useEnv(`${prefix}_IMAP_HOST`) ?? '(not set)';
    const imapPortRaw = useEnv(`${prefix}_IMAP_PORT`) ?? '993';
    return {
      name: name.toLowerCase(),
      user,
      imapHost,
      imapPort: parseInt(imapPortRaw, 10),
      // index for --account flag
      _index: index,
    } as AccountInfo & { _index: number };
  });
}
