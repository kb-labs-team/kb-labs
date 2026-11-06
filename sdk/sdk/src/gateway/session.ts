/**
 * @module cli-core/gateway/session
 *
 * Manages human-user session credentials stored in ~/.kb/session.json.
 * Separate from CredentialsManager (~/.kb/credentials.json, machine identity)
 * — see the module doc on SessionCredentials in ./types.js for why.
 * File permissions: 0o600 (owner read/write only).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SessionCredentials, ISessionManager } from './types.js';
import { isSavedCredentialBase, readSavedAuthFile } from './saved-auth-file.js';

/** Resolve the one canonical human-session path for the current CLI user. */
export function sessionFilePath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.kb', 'session.json');
}

export class SessionManager implements ISessionManager {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? sessionFilePath();
  }

  getFilePath(): string {
    return this.filePath;
  }

  async load(): Promise<SessionCredentials | null> {
    return readSavedAuthFile(this.filePath, '.kb/session.json', isSessionCredentials);
  }

  async save(session: SessionCredentials): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(session, null, 2), 'utf-8');
    // chmod 600 — owner read/write only
    await fs.chmod(this.filePath, 0o600);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.filePath);
    } catch {
      // file doesn't exist — ok
    }
  }

}

function isSessionCredentials(value: unknown): value is SessionCredentials {
  if (!isSavedCredentialBase(value)) return false;
  const record = value as SessionCredentials;
  return (record.email === undefined || typeof record.email === 'string')
    && (record.tenantId === undefined || typeof record.tenantId === 'string');
}
