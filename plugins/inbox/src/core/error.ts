export type InboxErrorCode =
  | 'ENV_MISSING'            // INBOX_ACCOUNTS or account vars not set
  | 'ACCOUNT_NOT_FOUND'      // --account X does not exist in config
  | 'IMAP_AUTH_FAILED'       // wrong password or app-password not created
  | 'IMAP_CONNECT_FAILED'    // cannot reach IMAP server
  | 'IMAP_TIMEOUT'           // connection timed out
  | 'IMAP_MAILBOX_NOT_FOUND' // folder/mailbox does not exist
  | 'MESSAGE_NOT_FOUND'      // uid not found in folder
  | 'SMTP_AUTH_FAILED'       // SMTP auth error
  | 'SMTP_CONNECT_FAILED'    // cannot reach SMTP server
  | 'SMTP_INVALID_RECIPIENT' // invalid recipient address
  | 'VALIDATION_ERROR'       // bad flags or arguments
  | 'INTERNAL_ERROR';        // unexpected error

export class InboxError extends Error {
  override readonly name = 'InboxError';

  constructor(
    public readonly code: InboxErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
  }
}
