export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
}

export interface Email {
  uid: number;
  messageId?: string;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  date: string;           // ISO 8601
  folder: string;
  flags: string[];        // e.g. \Seen, \Flagged, \Answered
  text?: string;
  html?: string;
  attachments?: EmailAttachment[];
  inReplyTo?: string;
  references?: string[];
}

export interface EmailSlim {
  uid: number;
  subject: string;
  from: EmailAddress;
  date: string;
  folder: string;
  unread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
}

export interface Folder {
  name: string;
  path: string;
  flags: string[];
  specialUse?: string;    // e.g. \Inbox, \Sent, \Trash, \Junk
}

export interface AccountInfo {
  name: string;
  user: string;
  imapHost: string;
  imapPort: number;
}
