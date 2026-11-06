import type { Email, EmailSlim } from '../contracts/index.js';

export function slimEmail(email: Email): EmailSlim {
  return {
    uid: email.uid,
    subject: email.subject,
    from: email.from,
    date: email.date,
    folder: email.folder,
    unread: !email.flags.includes('\\Seen'),
    flagged: email.flags.includes('\\Flagged'),
    hasAttachments: (email.attachments?.length ?? 0) > 0,
  };
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();

  if (diff < 60_000) { return 'just now'; }
  if (diff < 3_600_000) { return `${Math.floor(diff / 60_000)}m ago`; }
  if (diff < 86_400_000) { return `${Math.floor(diff / 3_600_000)}h ago`; }
  if (diff < 7 * 86_400_000) { return `${Math.floor(diff / 86_400_000)}d ago`; }

  return d.toLocaleDateString();
}

export function formatFrom(from: { name?: string; address: string }): string {
  return from.name ? `${from.name} <${from.address}>` : from.address;
}
